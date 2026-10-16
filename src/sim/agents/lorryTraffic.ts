import type { Building, BuildingId } from '@world/buildings/types';
import type { LaneletId } from '@world/lanelets';
import { m } from '@world/units';
import { DRIVER_NOISE, DT } from '../params';
import { vehiclePose } from '../pose';
import type { SimWorld } from '../world';
import { ARCHETYPES, bodyClassOfArchetype } from '../vehicles/archetypes';
import { createVehicle, snapshot, type Vehicle, type VehicleId } from '../vehicles/state';
import { makeDriver } from '../vehicles/driver';
import { planFrom } from '../routing/router';
import { chooseVehicleDestination } from '../routing/destination';
import { closeLane, laneClear, openLanes, type Closure } from '../vehicles/laneClosures';
import { CLOSURE_STOP } from '../vehicles/obstacles';
import { Shunt } from './manoeuvre';
import { buildYard, forgetYard, forgetYardsBut, keepYard, knownYard, type LorryWay, lorryOf, PLAN_BUDGET, type Yard, yardKey, type YardNeighbours, yardNeighbours, yardOf } from './lorryDocks';
import { gatedProperty, lanesInBox } from './parking';
import { BuildingsInOrder } from './buildingOrder';
import type { RoadDoc } from '@world/doc';
import { lorryDocks } from '@world/buildings/docks';
import type { Waypoint } from './hybridAStar';

/** Lorries to the works' loading docks: a lorry of the passing traffic is sent to a dock that has a way in and out */

/** Seconds between two looks for a lorry to send. */
const LOOK = 2;
/** Most lorries at the docks at once in the whole town. */
const MAX_LORRIES = 4;
/** Farthest a passing lorry is called from, and how long it has to reach the gate. */
const CALL_REACH = m(400);
const CALL_TIMEOUT = 180;
/** How far a vehicle's body centre can stand from the bounds of the lane it is on (its length and a lane change's offset). */
const CALL_PAD = m(30);
/** Seconds a lorry stands at the dock while it is unloaded. */
const UNLOAD_MIN = 45;
const UNLOAD_MAX = 120;
/** Body points within this of a lane's centre close it (half a wide lane and a hand). */
const LANE_HALF = m(2);
/** Kept clear before and after the stretch a lorry sweeps. */
const CLOSURE_MARGIN = m(1.5);
/** Speed a lorry joins its lane at. */
const JOIN_SPEED = m(1.5);
/** Seconds it waits for somebody on its way before going on (they step out of a vehicle's way, `walk.ts`). */
const ASK_WAY = 3;

type Phase = 'coming' | 'waiting' | 'arriving' | 'docked' | 'leaving' | 'joining';

interface Lorry {
  readonly id: VehicleId;
  readonly building: BuildingId;
  readonly dock: number;
  phase: Phase;
  /** The lorry as drawn off the road; null while it drives in the traffic. */
  body: Vehicle | null;
  shunt: Shunt | null;
  /** The two ways, in the world. */
  into: LorryWay;
  away: LorryWay;
  /** The lane it stops on before the gate and joins past it. */
  readonly lane: LaneletId;
  readonly stopAt: number;
  readonly joinAt: number;
  /** The stretches of lane its street part sweeps, coming and going. */
  readonly closeIn: Closure[];
  readonly closeOut: Closure[];
  /** Lanes closed now. */
  closed: boolean;
  t: number;
  stay: number;
  waited: number;
}

export class LorryTraffic {
  private readonly lorries = new Map<VehicleId, Lorry>();
  private clock = 0;
  /** The dock being planned now. */
  private planning: { building: BuildingId; dock: number } | null = null;
  /** Counters for probes. */
  sent = 0;
  docked = 0;
  left = 0;

  /** The world last stepped: a reset opens the lanes its lorries closed there. */
  private world: SimWorld | null = null;

  /** A different map (`LotTraffic.reset`, from `AmbientWorld.reset`) */
  reset(w: SimWorld | null = this.world): void {
    for (const lorry of this.lorries.values()) if (w) openLanes(w, lorry.id);
    this.lorries.clear();
    this.planning = null;
    this.making = null;
    this.neighbours = null;
    this.clock = 0;
  }

  /** Lorries driving off the road now. */
  moving(): number {
    let n = 0;
    for (const lorry of this.lorries.values()) if (lorry.phase === 'arriving' || lorry.phase === 'leaving' || lorry.phase === 'joining') n++;
    return n;
  }

  /** Whether a lorry is in, or about to swing into, a lot's yard (its cars wait meanwhile). */
  busy(building: number): boolean {
    for (const lorry of this.lorries.values()) if (lorry.building === building && lorry.phase !== 'coming') return true;
    return false;
  }

  /** For probes: each lorry's phase, building, dock and where its body is. */
  view(): { id: number; phase: Phase; building: number; dock: number; x: number; y: number; angle: number }[] {
    return [...this.lorries.values()].map((l) => ({
      id: l.id, phase: l.phase, building: l.building, dock: l.dock,
      x: l.body?.free?.x ?? NaN, y: l.body?.free?.y ?? NaN, angle: l.body?.free?.angle ?? NaN,
    }));
  }

  /** Stepped by the lots' traffic (`lotTraffic.ts`) each tick. `carsBusy`: whether a lot's own cars are moving now. */
  step(w: SimWorld, carsBusy: (building: number) => boolean): void {
    this.world = w;
    for (const lorry of [...this.lorries.values()]) {
      switch (lorry.phase) {
        case 'coming': this.coming(w, lorry); break;
        case 'waiting': this.waiting(w, lorry, carsBusy); break;
        case 'arriving': this.drive(w, lorry); break;
        case 'docked': this.unloading(lorry, carsBusy); break;
        case 'leaving': this.drive(w, lorry); break;
        case 'joining': this.drive(w, lorry); break;
      }
      lorry.t += DT;
    }
    // Drawn with the cars standing in bays, asked by set (`isParked`), not by a walk of every parked car.
    for (const lorry of this.lorries.values()) if (lorry.body && !w.ambient.isParked(lorry.body)) w.ambient.addParked(lorry.body);
    this.plan(w);
    this.clock += DT;
    if (this.clock < LOOK) return;
    this.clock = 0;
    if (this.lorries.size < MAX_LORRIES) this.call(w);
  }

  /** Sends a lorry to a dock now, standing on its lane at the stop before the gate (for probes and specs) */
  sendNow(w: SimWorld, building: BuildingId, dock: number): boolean {
    const b = w.doc.buildings.get(building);
    const truck = ARCHETYPES.find((a) => a.id === 'truck')!;
    const yard = b ? yardOf(w, b, lorryOf(truck)) : null;
    if (!yard || !yard.docks[dock]) return false;
    while (!yard.planned(dock)) yard.plan(dock, 1e6);
    const ways = yard.ways(dock);
    if (!ways) return false;
    const lane = w.lanelet(ways.gate.lane.lanelet);
    if (!lane) return false;
    const id = w.nextVehicleId++ as VehicleId;
    const v = createVehicle(id, truck, makeDriver(truck, () => w.rng.lorries.float()), truck.palette[0]!, lane.id, 0, w.clock.tick);
    const lorry = this.make(w, v, yard, dock, ways);
    lorry.phase = 'waiting';
    lorry.body = this.offRoad(w, v, ways.into.poses[0]!, building);
    this.lorries.set(id, lorry);
    this.sent++;
    return true;
  }

  // ------------------------------------------------------------ planning and calling

  /** The yards of the town and their docks, kept from the diary. */
  private readonly yardList = new YardList();
  private yards: readonly { building: BuildingId; docks: number }[] = [];

  /** Only which buildings have docks: a yard is worked out */
  private readYards(w: SimWorld): void {
    this.yards = this.yardList.read(w.doc);
    // The yards of buildings gone, or with no yard now, forgotten with them.
    const gone = this.yardList.gone;
    if (gone === null) forgetYardsBut(w, (id) => this.yardList.has(id as BuildingId));
    else for (const id of gone) forgetYard(w, id);
  }

  /** The yard being made, a slice a call */
  private making: { building: Building; key: string; steps: Generator<void, Yard, void> } | null = null;
  /** The lots and buildings near each yard (`yardNeighbours`), kept while they stand. */
  private neighbours: YardNeighbours | null = null;

  /** A building's yard, made a slice a call (`buildYard`): undefined while it is being made. */
  private yardFor(w: SimWorld, building: BuildingId, begin = true): Yard | null | undefined {
    const b = w.doc.buildings.get(building);
    if (!b) return null;
    const known = knownYard(w, b);
    if (known !== undefined) return known;
    if (!begin && this.making?.building !== b) return undefined;
    const key = yardKey(w);
    if (!this.making || this.making.building !== b || this.making.key !== key) {
      this.neighbours = yardNeighbours(w, this.neighbours);
      this.making = { building: b, key, steps: buildYard(b, key, w, lorryOf(ARCHETYPES.find((a) => a.id === 'truck')!), this.neighbours) };
    }
    const next = this.making.steps.next();
    if (!next.done) return undefined;
    this.making = null;
    keepYard(w, next.value);
    return next.value;
  }

  /** A slice of planning for the dock in hand (a slice of making its yard first). */
  private plan(w: SimWorld): void {
    const p = this.planning;
    if (!p) return;
    const yard = this.yardFor(w, p.building);
    if (yard === undefined) return;
    if (!yard || !yard.docks[p.dock]) { this.planning = null; return; }
    yard.plan(p.dock, PLAN_BUDGET);
    if (yard.planned(p.dock)) this.planning = null;
  }

  /** A yard with no lorry, a dock of it drawn; planned, it is sent the nearest passing lorry. */
  private call(w: SimWorld): void {
    this.readYards(w);
    // DO NOT filter every yard of the town for the few with a lorry: the draw skips their places in the list.
    const busy: number[] = [];
    for (const l of this.lorries.values()) {
      const at = this.yardList.indexOf(l.building);
      if (at !== undefined && !busy.includes(at)) busy.push(at);
    }
    const free = this.yards.length - busy.length;
    if (!free) return;
    let at = Math.floor(w.rng.lorries.float() * free);
    for (const b of busy.sort((x, y) => x - y)) if (b <= at) at++;
    const pick = this.yards[at]!;
    const dock = Math.floor(w.rng.lorries.float() * pick.docks);
    // DO NOT call `yardFor` to begin a yard here while `planning` names another building
    const yard = this.yardFor(w, pick.building, this.planning === null || this.planning.building === pick.building);
    if (yard === null) return;
    if (yard === undefined || !yard.planned(dock)) { this.planning ??= { building: pick.building, dock }; return; }
    const ways = yard.ways(dock);
    if (!ways) return;
    const gate = ways.gate;
    const lane = w.lanelet(gate.lane.lanelet);
    if (!lane) return;
    const stop = lane.centre.sampleAt(gate.stopAt).p;
    let best: Vehicle | null = null, bestD = CALL_REACH;
    // DO NOT walk the fleet: the vehicles on the lanes within reach (`SimWorld.vehiclesInBox`); a tie goes to the lower id.
    const reach = CALL_REACH + CALL_PAD;
    for (const v of w.vehiclesInBox(stop.x - reach, stop.y - reach, stop.x + reach, stop.y + reach)) {
      if (v.archetype.id !== 'truck' || v.commute || v.kerbStop || v.errand || this.lorries.has(v.id)) continue;
      if (v.lanelet === lane.id && v.s > gate.stopAt) continue;
      const pose = vehiclePose(w, v, 1);
      if (!pose) continue;
      const d = Math.hypot(pose.p.x - stop.x, pose.p.y - stop.y);
      if (d < bestD || (d === bestD && best !== null && v.id < best.id)) { bestD = d; best = v; }
    }
    if (!best) return;
    const v = best, was = v.destination;
    v.commute = { trip: -3, lanelet: lane.id, at: gate.stopAt + v.archetype.length / 2 };
    v.destination = lane.id;
    planFrom(w, v);
    if (v.destination !== lane.id) { v.commute = null; v.destination = was; planFrom(w, v); return; }
    this.lorries.set(v.id, this.make(w, v, yard, dock, ways));
    this.sent++;
  }

  private make(w: SimWorld, v: Vehicle, yard: Yard, dock: number, ways: NonNullable<ReturnType<Yard['ways']>>): Lorry {
    const gate = ways.gate;
    return {
      id: v.id, building: yard.building.id, dock, phase: 'coming', body: null, shunt: null,
      into: ways.into, away: ways.away, lane: gate.lane.lanelet, stopAt: gate.stopAt, joinAt: gate.joinAt,
      closeIn: closures(w, ways.into.poses.slice(0, ways.into.street + 1), v.id, yard.body.rear, v.archetype.length, v.archetype.width),
      closeOut: closures(w, ways.away.poses.slice(ways.away.street), v.id, yard.body.rear, v.archetype.length, v.archetype.width),
      closed: false, t: 0, stay: 0, waited: 0,
    };
  }

  // ------------------------------------------------------------ the phases

  private coming(w: SimWorld, lorry: Lorry): void {
    const v = w.vehicles.get(lorry.id);
    if (!v) { this.lorries.delete(lorry.id); return; }
    const c = v.commute;
    if (!c || lorry.t > CALL_TIMEOUT || (v.destination !== c.lanelet && v.lanelet !== c.lanelet)) { this.release(w, lorry, v); return; }
    if (v.lanelet !== c.lanelet || v.v > m(0.12) || v.s < c.at - m(2.5)) return;
    const pose = vehiclePose(w, v, 1);
    if (!pose) { this.release(w, lorry, v); return; }
    // Stopped before the gate: off the lane, standing where it stopped
    const start = lorry.into.poses[0]!;
    const rear = lorryOf(v.archetype).rear;
    const here: Waypoint = { x: pose.p.x - Math.cos(pose.angle) * rear, y: pose.p.y - Math.sin(pose.angle) * rear, angle: pose.angle, reverse: false };
    const ahead = (start.x - here.x) * Math.cos(pose.angle) + (start.y - here.y) * Math.sin(pose.angle);
    lorry.into = { poses: [{ ...here, reverse: ahead < 0 }, ...lorry.into.poses], street: lorry.into.street + 1 };
    w.removeVehicle(v);
    lorry.body = this.offRoad(w, v, here, lorry.building);
    lorry.phase = 'waiting';
    lorry.t = 0;
  }

  /** Stopped before the gate, until the street it sweeps is clear and the lot's cars are still. */
  private waiting(w: SimWorld, lorry: Lorry, carsBusy: (building: number) => boolean): void {
    lorry.body!.v = 0;
    if (carsBusy(lorry.building) || !this.closeIfClear(w, lorry, lorry.closeIn)) return;
    lorry.shunt = new Shunt(lorry.into.poses, lorryOf(lorry.body!.archetype).rear);
    lorry.phase = 'arriving';
    lorry.t = 0;
  }

  private unloading(lorry: Lorry, carsBusy: (building: number) => boolean): void {
    const body = lorry.body!;
    body.v = 0;
    const f = body.free!;
    setFree(body, { x: f.x, y: f.y, angle: f.angle });
    lorry.stay -= DT;
    if (lorry.stay > 0 || carsBusy(lorry.building)) return;
    lorry.shunt = new Shunt(lorry.away.poses, lorryOf(body.archetype).rear);
    lorry.phase = 'leaving';
    lorry.t = 0;
  }

  /** Along its way: arriving onto the dock, or leaving it for the lane. */
  private drive(w: SimWorld, lorry: Lorry): void {
    const body = lorry.body!, shunt = lorry.shunt!;
    const way = lorry.phase === 'arriving' ? lorry.into : lorry.away;
    // Leaving, the street begins at `street`: it waits there for the lanes to clear.
    const streetAt = shunt.distanceAt(way.street);
    if (lorry.phase === 'leaving' && shunt.s >= streetAt - 1e-6) {
      if (!this.closeIfClear(w, lorry, lorry.closeOut)) { body.v = 0; setFree(body, shunt.poseAt()); return; }
      lorry.phase = 'joining';
    }
    if (!this.mayGo(w, lorry, shunt)) { body.v = 0; setFree(body, shunt.poseAt()); return; }
    const v = shunt.speed();
    const before = shunt.s;
    shunt.advance(v * DT);
    if (lorry.phase === 'leaving') shunt.s = Math.min(shunt.s, streetAt);
    body.v = shunt.s > before ? v : 0;
    setFree(body, shunt.poseAt());
    // Arriving, the street is behind it once its whole body stands in the lot.
    if (lorry.phase === 'arriving' && lorry.closed && shunt.s >= streetAt) { openLanes(w, lorry.id); lorry.closed = false; }
    if (!shunt.done) return;
    if (lorry.phase === 'arriving') {
      lorry.phase = 'docked';
      lorry.stay = UNLOAD_MIN + w.rng.lorries.float() * (UNLOAD_MAX - UNLOAD_MIN);
      lorry.t = 0;
      this.docked++;
      return;
    }
    // On the lane past the gate: a vehicle of the traffic again.
    this.join(w, lorry);
  }

  private join(w: SimWorld, lorry: Lorry): void {
    const body = lorry.body!;
    openLanes(w, lorry.id);
    this.drop(w, lorry);
    const l = w.lanelet(lorry.lane);
    if (!l) return;
    const a = body.archetype;
    const id = w.vehicles.has(lorry.id) ? (w.nextVehicleId++ as VehicleId) : lorry.id;
    const v0 = l.speedLimit * a.speedFactor * w.rng.driver.range(DRIVER_NOISE.lo, DRIVER_NOISE.hi);
    const road = createVehicle(id, a, body.driver, body.color, l.id, v0, w.clock.tick);
    road.s = Math.min(l.length, lorry.joinAt + a.length / 2);
    road.v = JOIN_SPEED;
    road.prev = snapshot(road);
    w.vehicles.set(road.id, road);
    w.enterLanelet(road, l.id);
    road.destination = chooseVehicleDestination(w, l.id, bodyClassOfArchetype(a));
    planFrom(w, road);
    this.left++;
  }

  // ------------------------------------------------------------ helpers

  /** Closes the stretches the street part sweeps if nobody is on them or too near to stop; whether it did. */
  private closeIfClear(w: SimWorld, lorry: Lorry, stretches: readonly Closure[]): boolean {
    if (lorry.closed) return true;
    for (const c of stretches) if (!laneClear(w, c.lanelet, c.from, c.to, CLOSURE_STOP)) return false;
    for (const c of stretches) closeLane(w, c);
    lorry.closed = stretches.length > 0;
    return true;
  }

  /** Whether nobody stands where the lorry goes over the next few metres (its body as discs) */
  private mayGo(w: SimWorld, lorry: Lorry, shunt: Shunt): boolean {
    const a = lorry.body!.archetype;
    const r = a.width / 2 + m(0.5);
    let clear = true;
    for (let s = shunt.s; s <= Math.min(shunt.length, shunt.s + m(4)) && clear; s += m(1)) {
      const q = shunt.poseAt(s);
      const c = Math.cos(q.angle), sn = Math.sin(q.angle);
      for (let k = -2; k <= 2 && clear; k++) {
        const x = q.x + c * k * (a.length / 5), y = q.y + sn * k * (a.length / 5);
        // The people near the point (`PeopleBridge.anyoneWithin`, the walkers' grid), not every person of the map.
        if (w.pedEngine.bridge.anyoneWithin(w, x, y, r, null)) clear = false;
      }
    }
    if (clear) { lorry.waited = 0; return true; }
    lorry.waited += DT;
    return lorry.waited >= ASK_WAY;
  }

  private release(w: SimWorld, lorry: Lorry, v: Vehicle): void {
    this.lorries.delete(lorry.id);
    v.commute = null;
    v.destination = chooseVehicleDestination(w, v.lanelet, bodyClassOfArchetype(v.archetype));
    planFrom(w, v);
  }

  private drop(w: SimWorld, lorry: Lorry): void {
    this.lorries.delete(lorry.id);
    if (lorry.body) w.ambient.removeParked(lorry.body);
  }

  private offRoad(w: SimWorld, v: Vehicle, axle: Waypoint, lot: number): Vehicle {
    const rear = lorryOf(v.archetype).rear;
    const x = axle.x + Math.cos(axle.angle) * rear, y = axle.y + Math.sin(axle.angle) * rear;
    const body = createVehicle(v.id, v.archetype, v.driver, v.color, v.lanelet, 0, w.clock.tick);
    body.seats = 1;
    body.free = { x, y, angle: axle.angle, px: x, py: y, pangle: axle.angle, lot };
    return body;
  }
}

function setFree(body: Vehicle, p: { x: number; y: number; angle: number }): void {
  const f = body.free!;
  f.px = f.x; f.py = f.y; f.pangle = f.angle;
  f.x = p.x; f.y = p.y; f.angle = p.angle;
}


/** The stretches of lane a street part sweeps */
export function closures(w: SimWorld, poses: readonly Waypoint[], owner: number, rear: number, length: number, width: number): Closure[] {
  if (!poses.length) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poses) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const pad = length + LANE_HALF;
  const spans = new Map<LaneletId, { from: number; to: number }>();
  // DO NOT walk every lane of the map here.
  for (const lane of lanesInBox(w, x0 - pad, y0 - pad, x1 + pad, y1 + pad)) {
    for (let i = 0; i < poses.length; i += 2) {
      const p = poses[i]!;
      const c = Math.cos(p.angle), s = Math.sin(p.angle);
      const back = length / 2 - rear, front = length / 2 + rear, hw = width / 2;
      for (const [u, v] of [[-back, -hw], [-back, hw], [front, -hw], [front, hw], [(front - back) / 2, -hw], [(front - back) / 2, hw]] as const) {
        const q = { x: p.x + c * u - s * v, y: p.y + s * u + c * v };
        const hit = lane.centre.closestPoint(q);
        if (hit.distance > LANE_HALF) continue;
        const span = spans.get(lane.id);
        if (span) { span.from = Math.min(span.from, hit.s); span.to = Math.max(span.to, hit.s); }
        else spans.set(lane.id, { from: hit.s, to: hit.s });
      }
    }
  }
  return [...spans].map(([lanelet, span]) => ({ lanelet, from: Math.max(0, span.from - CLOSURE_MARGIN), to: span.to + CLOSURE_MARGIN, owner }));
}

/** A building with a yard a lorry is sent to: a car-gated property with loading docks. */
const hasYard = (b: Building): boolean => gatedProperty(b) !== null && lorryDocks(b).length > 0;

/** The town's yards and their docks, in the store's order (the lorries' draw follows it), kept from the diary */
export class YardList {
  private readonly kept = new BuildingsInOrder(hasYard);
  private readonly docks = new Map<BuildingId, number>();
  private list: { building: BuildingId; docks: number }[] = [];
  /** Each yard's place in `list`. */
  private readonly at = new Map<BuildingId, number>();
  /** The buildings the last `read` took out (gone, or with no yard now); null: it read the town whole. */
  gone: BuildingId[] | null = [];

  /** Whether a building has a yard, as of the last `read`. */
  has(id: BuildingId): boolean {
    return this.kept.has(id);
  }

  read(doc: RoadDoc): readonly { building: BuildingId; docks: number }[] {
    const delta = this.kept.update(doc);
    this.gone = delta === null ? null : [];
    if (delta !== null && delta.ids.length === 0) return this.list;
    if (delta === null) this.docks.clear();
    for (const id of delta === null ? this.kept.ids : delta.ids) {
      const b = doc.buildings.get(id);
      if (b && this.kept.has(id)) this.docks.set(id, lorryDocks(b).length);
      else { this.docks.delete(id); this.gone?.push(id); }
    }
    this.list = this.kept.ids.map((building) => ({ building, docks: this.docks.get(building)! }));
    this.at.clear();
    this.list.forEach((y, i) => this.at.set(y.building, i));
    return this.list;
  }

  /** A yard's place in the list of the last `read`. */
  indexOf(id: BuildingId): number | undefined {
    return this.at.get(id);
  }
}
