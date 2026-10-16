import { DT, JAM_GAP, STUCK_SECONDS } from './params';
import type { SimWorld } from './world';
import { stepController } from './signals/fsm';
import { longitudinalConstraints } from './vehicles/obstacles';
import {
  compactReservationChain,
  nextConnector,
  stepAdmission,
} from './intersections/admission';
import { integrateAll } from './vehicles/integrate';
import { stepDespawn, stepDispatch } from './vehicles/spawn';
import { stepLaneChange } from './vehicles/laneChange';
import { stepKerbStops } from './vehicles/kerbStops';
import { extend, planFrom, reconsiderRoute, repairRoute } from './routing/router';
import { snapshotInto, type Vehicle } from './vehicles/state';
import { runAudit } from './invariants';
import { signalStateFor } from './signals/query';
import { bodyClassOfArchetype } from './vehicles/archetypes';
import { m } from '@world/units';
import type { LaneletId } from '@world/lanelets';
import { rebuildWork } from '@world/rebuildWork';

export interface StepOptions {
  readonly traffic?: boolean;
  readonly pedestrians?: boolean;
  /** Milliseconds spent per stage, ADDED to on every step when given. */
  readonly timings?: Map<string, number>;
}

/** @perFrame One fixed simulation step. */
export function step(w: SimWorld, opts: StepOptions = {}): void {
  const traffic = opts.traffic ?? true;
  const pedestrians = opts.pedestrians ?? true;
  const timings = opts.timings;
  let mark = timings ? performance.now() : 0;
  const lap = timings
    ? (stage: string): void => {
      const now = performance.now();
      timings.set(stage, (timings.get(stage) ?? 0) + now - mark);
      mark = now;
    }
    : (): void => {};

  // 0. topology: the only place derived structure may change
  if (w.topologyRevision !== w.net.trafficRevision) {
    w.rebuildTopology();
    rebindAgents(w);
  }
  // The junctions' flows, and the control those on "automatic" get from them (V5).
  w.stepControlAdvisor(DT);
  lap('0 topology');

  // snapshot for render interpolation, into each vehicle's own `prev` (no object a vehicle a tick)
  for (const v of w.vehicles.values()) snapshotInto(v);
  w.pedEngine.beginTick(w);

  // 1. signals: the sole mutator of phase state.
  const deps = w.signalDeps();
  for (const c of w.signalsToStep(deps)) {
    tickWork.controllers++;
    if (stepController(c, deps) && w.doLess) w.restSignal(c);
  }
  lap('1 signals');

  // 2. routing and population
  stepDispatch(w, traffic);
  w.pedEngine.dispatch(w, pedestrians);
  // The residents' days: their trips start, their cars pull in (`sim/city`).
  w.city.step(w);
  // The scenery's people and traffic, made and taken away out of sight (`sim/ambient`).
  w.ambient.step(w);
  ensureVehicleRoutes(w);
  lap('2 dispatch+routes');
  // Lane choice sits between routing and constraints: it must see a settled route, and integration must see its verdict.
  if (traffic) stepLaneChange(w);
  lap('2b lane change');
  // Kerb stops: choosing where, and the doors and people once stopped.
  if (traffic) stepKerbStops(w);
  lap('2c kerb stops');

  // 3.
  if (pedestrians) w.pedEngine.step(w);
  lap('3 pedestrians');

  // 4. longitudinal constraints
  for (const v of w.vehiclesInIdOrder()) {
    v.constraints = longitudinalConstraints(w, v);
  }
  lap('4 constraints');

  // 5. intersection admission: denial appends a constraint, never a command
  if (traffic) stepAdmission(w);
  lap('5 admission');

  // 6. integration: the only writer of position and speed
  if (traffic) integrateAll(w);
  lap('6 integrate');

  // 7. cleanup
  stepDespawn(w);
  collectGhosts(w);
  runWatchdog(w);
  updateStallCounters(w);
  lap('7 cleanup');

  // 8. audit
  if (w.auditEnabled && w.clock.tick % w.auditEvery === 0) {
    for (const i of runAudit(w, w.auditLevel)) w.report(i);
  }
  lap('8 audit');

  // What the renderer and the counters see of the people this tick.
  w.pedEngine.publish(w);

  // 9. time: the only writer of the clock. Everything above read this tick.
  w.clock.tick++;
}

/** Re-binds agents to the rebuilt topology after a live edit. */
export function rebindAgents(w: SimWorld): void {
  rebindVehicles(w);
  rebindPeds(w);
}

/** @rebuild The vehicle half of `rebindAgents`, after `SimWorld.rebuildVehicleTopology`. */
export function rebindVehicles(w: SimWorld): void {
  // DO NOT rebind every vehicle of the map for an edit: each one's route was planned again (5 s for 1,200 cars on a 24 x 24 grid).
  const changes = w.topologyLog.since(w.vehiclesBound);
  w.vehiclesBound = w.topologyLog.state;
  let lanes: Set<LaneletId> | null = null;
  if (changes !== null) {
    lanes = new Set();
    for (const change of changes) for (const id of change.lanelets) lanes.add(id);
    if (lanes.size === 0) return;
  }
  for (const v of w.vehiclesInIdOrder()) {
    if (lanes && !boundTo(v, lanes)) continue;
    rebuildWork.vehicles++;
    // A shadow is a projection onto a sibling lane that may have been rebuilt with a different length
    w.clearShadow(v);
    const lane = w.lanelet(v.lanelet);
    if (!lane) {
      // The lanelet is gone.
      w.removeVehicle(v);
      continue;
    }
    v.s = Math.min(v.s, lane.length);
    w.enterLanelet(v, v.lanelet, false);

    const admitted = v.admittedConnector ? w.connector(v.admittedConnector) : undefined;
    const admissionStillValid =
      !!admitted &&
      ((lane.kind === 'link' && admitted.fromLane === lane.id) ||
        (lane.kind === 'connector' && admitted.id === lane.id));
    v.clearingConnectors = v.clearingConnectors.filter((token) =>
      Boolean(w.connector(token.connector)),
    );
    if (v.admittedConnector && !admissionStillValid) {
      w.claims.releaseConnector(v.id, v.admittedConnector, w.conflicts);
      v.admittedConnector = null;
    }

    reconcileReservedChain(w, v);
    if (!pinReservedRoute(w, v)) repairRoute(w, v);
    v.claims = [...w.claims.points(v.id)];
    v.firstRequestTick = null;
  }
}

/** Whether a vehicle stands on, holds, or is bound through one of these lanes or movements. */
function boundTo(v: Vehicle, lanes: ReadonlySet<LaneletId>): boolean {
  if (lanes.has(v.lanelet) || (v.shadow && lanes.has(v.shadow.lanelet))) return true;
  if (v.admittedConnector !== null && lanes.has(v.admittedConnector)) return true;
  if (v.destination !== null && lanes.has(v.destination)) return true;
  if (v.desiredLane !== null && lanes.has(v.desiredLane)) return true;
  if (v.movementIntent !== null && lanes.has(v.movementIntent)) return true;
  if (v.laneChange !== null && lanes.has(v.laneChange)) return true;
  if (v.laneIntent !== null && lanes.has(v.laneIntent)) return true;
  if ((v.commute && lanes.has(v.commute.lanelet)) || (v.kerbStop && lanes.has(v.kerbStop.lanelet))) return true;
  for (const id of v.route) if (lanes.has(id)) return true;
  for (const id of v.rearPath) if (lanes.has(id)) return true;
  for (const id of v.reservedConnectors) if (lanes.has(id)) return true;
  for (const token of v.clearingConnectors) if (lanes.has(token.connector)) return true;
  return false;
}

/** @rebuild The pedestrian half of `rebindAgents`, after `SimWorld.rebuildWalkTopology`. */
export function rebindPeds(w: SimWorld): void {
  w.pedEngine.rebind(w);
}

/** The work of the ticks: lanes stage 7 looked at, lanes retired, controllers stage 1 ran. */
export const tickWork = { cleanupLanes: 0, retired: 0, controllers: 0 };

/** Retires lanelets that no longer exist once their occupants have left. */
function collectGhosts(w: SimWorld): void {
  if (!w.doLess) {
    for (const [id, rt] of [...w.runtime]) {
      tickWork.cleanupLanes++;
      if (!w.graph.lanelets.has(id)) {
        if (rt.order.length === 0) { w.runtime.delete(id); tickWork.retired++; }
        else if (!rt.ghost) {
          rt.ghost = true;
          rt.ghostSince = w.clock.tick;
        }
      }
    }
    return;
  }
  for (const id of w.ghostCandidates) {
    tickWork.cleanupLanes++;
    const rt = w.runtime.get(id);
    if (!rt || w.graph.lanelets.has(id)) { w.ghostCandidates.delete(id); continue; }
    if (rt.order.length === 0) { w.runtime.delete(id); w.ghostCandidates.delete(id); tickWork.retired++; }
    else if (!rt.ghost) {
      rt.ghost = true;
      rt.ghostSince = w.clock.tick;
    }
  }
}

/** Accumulates, per tick, how long each vehicle has stood still with a green signal and nothing in its way. */
function updateStallCounters(w: SimWorld): void {
  for (const v of w.vehicles.values()) {
    const lane = w.lanelet(v.lanelet);
    if (!lane || lane.kind !== 'link' || !lane.controlled || v.v >= m(0.04)) {
      // BOTH counters reset here.
      v.greenStall = 0;
      v.greenDenied = 0;
      continue;
    }
    const conn = nextConnector(w, v);
    const c = conn && w.graph.junctions.get(conn.node)?.signalised ? w.controller(conn.node) : undefined;
    const green = conn && c ? signalStateFor(c, conn.group) === 'green' : false;
    const impeded = v.constraints.obstacles.some(
      (o) =>
        // The driver's standstill gap, as everywhere else that reads s0.
        (o.kind === 'vehicle' && o.gap < v.driver.s0 + m(1.2)) ||
        o.kind === 'yield' ||
        o.kind === 'conflict' ||
        o.kind === 'pedestrian' ||
        o.kind === 'spillback' ||
        // Stopped at the kerb on purpose, letting somebody out or in.
        o.kind === 'kerbStop',
    );
    v.greenStall = green && !impeded ? v.greenStall + DT : 0;

    // A second counter, deliberately blind to WHY the vehicle was refused.
    const signalised = conn ? w.graph.junctions.get(conn.node)?.signalised === true : false;
    // A car stopped at the kerb to let somebody out is not waiting for the green either.
    const heldByDesign = v.constraints.obstacles.some((o) => o.kind === 'spillback' || o.kind === 'kerbStop');
    v.greenDenied = green && signalised && !heldByDesign ? v.greenDenied + DT : 0;
  }
}

/** Diagnostic only. */
function runWatchdog(w: SimWorld): void {
  for (const v of w.vehicles.values()) {
    // Rear-clearance and ahead-of-route reservations can legitimately remain while a vehicle waits at another signal.
    if (!v.admittedConnector) continue;
    if (w.clock.since(v.lastMovedTick) > STUCK_SECONDS) {
      // Never release a resource while its physical holder is still present.
      if (
        w.auditEnabled &&
        w.auditLevel === 'cheap' &&
        !w.issues.some((i) => i.code === 'staleClaim' && i.subject === String(v.id))
      ) {
        w.report({
          code: 'staleClaim',
          tick: w.clock.tick,
          subject: String(v.id),
          detail: 'admitted vehicle immobile; reservation retained for safety',
        });
      }
    }
  }
}

/** Makes admission consume a real, connected route rather than a fallback. */
function ensureVehicleRoutes(w: SimWorld): void {
  for (const v of w.vehiclesInIdOrder()) {
    const lane = w.lanelet(v.lanelet);
    if (!lane) continue;

    // A driver who has been stuck long enough reconsiders
    reconsiderRoute(w, v);

    reconcileReservedChain(w, v);

    if (lane.kind === 'link' && v.admittedConnector) {
      const admitted = w.connector(v.admittedConnector);
      if (admitted?.fromLane === lane.id) {
        if (v.route[0] !== lane.id || v.route[1] !== admitted.id) {
          if (!pinReservedRoute(w, v)) {
            v.route = [lane.id, admitted.id, admitted.toLane];
            repairRoute(w, v);
          }
        }
        continue;
      }
      w.claims.releaseConnector(v.id, v.admittedConnector, w.conflicts);
      v.claims = [...w.claims.points(v.id)];
      v.admittedConnector = null;
    }

    // Arrived: on the lane it is going to, at the end of a road that leads off the map, nothing left to plan
    if (v.route.length === 1 && v.route[0] === lane.id && lane.kind === 'link' &&
        v.movementIntent === null && v.desiredLane === null && w.graph.exitsOf(lane.id).length === 0 &&
        (v.destination === lane.id ||
          (v.destination === null && w.graph.siblingLanes(lane.id).every((id) => w.graph.exitsOf(id).length === 0)))) continue;

    const next = v.route[1];
    const connected =
      v.route[0] === lane.id &&
      next !== undefined &&
      (lane.kind === 'link'
        ? w.connector(next)?.fromLane === lane.id
        : w.connector(lane.id)?.toLane === next);
    if (!connected) {
      if (!pinReservedRoute(w, v)) repairRoute(w, v);
      continue;
    }

    // A route that simply RAN OUT while the lane still has somewhere to go.
    if (v.route.length <= 1 && w.graph.exitsOf(lane.id).some((id) =>
      (w.connector(id)?.maxBodyClass ?? -1) >= bodyClassOfArchetype(v.archetype))) {
      planFrom(w, v);
      continue;
    }

    // A route that ends on a link too short to stop on (audit P1-46).
    const tail = w.lanelet(v.route[v.route.length - 1] ?? '');
    if (tail && tail.kind === 'link' && tail.id !== v.destination && tail.id !== lane.id &&
        tail.length < v.archetype.length + Math.max(JAM_GAP, v.driver.s0) &&
        w.graph.exitsOf(tail.id).length > 0) {
      extend(w, v);
    }
  }
}

/** Drops a reservation chain as a unit if a live edit broke any of its links. */
function reconcileReservedChain(w: SimWorld, v: Vehicle): boolean {
  const lane = w.lanelet(v.lanelet);
  if (!lane) return false;

  let expectedFrom: string | undefined;
  if (lane.kind === 'connector') {
    expectedFrom = w.connector(lane.id)?.toLane;
  } else if (v.admittedConnector) {
    const admitted = w.connector(v.admittedConnector);
    expectedFrom = admitted?.fromLane === lane.id ? admitted.toLane : undefined;
  } else {
    expectedFrom = lane.id;
  }

  let valid = expectedFrom !== undefined;
  for (const id of v.reservedConnectors) {
    const connector = w.connector(id);
    if (!connector || connector.fromLane !== expectedFrom) {
      valid = false;
      break;
    }
    expectedFrom = connector.toLane;
  }

  // Revalidate the refuge property too.
  const root = lane.kind === 'connector'
    ? w.connector(lane.id)
    : v.admittedConnector
      ? w.connector(v.admittedConnector)
      : v.reservedConnectors[0]
        ? w.connector(v.reservedConnectors[0])
        : undefined;
  if (valid && root) {
    const required = compactReservationChain(w, v, root);
    const expectedReservations =
      lane.kind === 'link' && !v.admittedConnector
        ? required?.map((connector) => connector.id)
        : required?.slice(1).map((connector) => connector.id);
    valid =
      expectedReservations !== undefined &&
      expectedReservations.length === v.reservedConnectors.length &&
      expectedReservations.every((id, index) => v.reservedConnectors[index] === id);
  }
  if (valid) return true;

  // Once the front entered the compound box
  if (lane.kind === 'connector' || v.clearingConnectors.length > 0) return false;

  for (const id of v.reservedConnectors) {
    w.claims.releaseConnector(v.id, id, w.conflicts);
  }
  v.reservedConnectors = [];

  // Before entry, an admission whose declared safe continuation disappeared can be cancelled.
  if (lane.kind === 'link' && v.admittedConnector) {
    w.claims.releaseConnector(v.id, v.admittedConnector, w.conflicts);
    v.admittedConnector = null;
  }
  v.claims = [...w.claims.points(v.id)];
  return false;
}

/** Reconstructs the route prefix pinned by the current grant and soft claim. */
function pinReservedRoute(w: SimWorld, v: Vehicle): boolean {
  const lane = w.lanelet(v.lanelet);
  if (!lane) return false;

  const prefix: string[] = [lane.id];
  let expectedLink: string | undefined;
  if (lane.kind === 'connector') {
    const current = w.connector(lane.id);
    if (!current) return false;
    expectedLink = current.toLane;
    prefix.push(expectedLink);
  } else {
    expectedLink = lane.id;
    if (v.admittedConnector) {
      const admitted = w.connector(v.admittedConnector);
      if (!admitted || admitted.fromLane !== expectedLink) return false;
      prefix.push(admitted.id, admitted.toLane);
      expectedLink = admitted.toLane;
    }
  }

  if (!v.admittedConnector && !v.reservedConnectors.length) return false;
  for (const id of v.reservedConnectors) {
    const connector = w.connector(id);
    if (!connector || connector.fromLane !== expectedLink) return false;
    if (prefix[prefix.length - 1] !== connector.fromLane) return false;
    prefix.push(connector.id, connector.toLane);
    expectedLink = connector.toLane;
  }

  const suffixAt = v.route.indexOf(expectedLink);
  const suffix = suffixAt >= 0 ? v.route.slice(suffixAt + 1) : [];
  v.route = [...prefix, ...suffix];
  // `repairRoute` deliberately reconstructs connector routes from scratch
  if (lane.kind === 'link') repairRoute(w, v);
  return true;
}

;
