import type { NodeId, SegmentId } from '@world/ids';
import { type PoseEnds, vehiclePoseEnds } from './pose';
import type { BodyPart, PedView } from './people/view';
import { type Casualty, takeCasualties, takeWounds } from './people/casualties';
import type { SignalController } from './signals/fsm';
import type { SignalPlan } from './signals/plan';
import type { TrainView } from './transit/transit';
import { ARCHETYPES } from './vehicles/archetypes';
import type { KerbStop } from './vehicles/kerbStops';
import { WheelOdometer, indicatorSide, pathCurvature } from './vehicles/shown';
import type { Vehicle, VehicleId } from './vehicles/state';
import type { PersonAgeClass } from './people/view';
import type { SimWorld } from './world';

/** THE TICK AS THE PAGE DRAWS IT: the simulation's state as plain numbers, and the few records that changed (`SimMirror`) */

/** Numbers a vehicle takes in `SimFrame.vehicles` and `SimFrame.parked`, at the offsets of `VF`. */
export const VEHICLE_STRIDE = 20;
/** A vehicle's numbers: its body at the last two ticks (centre, heading, lane-change yaw), its state, what it shows. */
export const VF = {
  id: 0, x0: 1, y0: 2, h0: 3, yaw0: 4, x1: 5, y1: 6, h1: 7, yaw1: 8, flags: 9,
  v: 10, prevV: 11, age: 12, seats: 13, segment: 14, indicator: 15, curvature: 16, odometer: 17, archetype: 18, lot: 19,
} as const;
/** `VF.flags`: the last tick's body is there to blend from; off the road (`Vehicle.free`); its driver shot dead. */
export const VEHICLE_BEFORE = 1;
export const VEHICLE_FREE = 2;
export const VEHICLE_SLAIN = 4;

/** Numbers a person takes in `SimFrame.peds`, at the offsets of `PF`. */
export const PED_STRIDE = 15;
export const PF = {
  id: 0, x: 1, y: 2, heading: 3, px: 4, py: 5, pheading: 6, v: 7, turnV: 8, age: 9, kerbWait: 10, gestureT: 11, segment: 12, ground: 13, walking: 14,
} as const;
export const PED_GROUNDS = ['footway', 'crossing', 'open'] as const;

/** What a vehicle carries that changes seldom: its paint, its people, its doors and the kerb stop under way. */
export interface VehicleLook {
  readonly id: VehicleId;
  readonly color: string;
  readonly people: readonly number[];
  readonly peopleAge: readonly PersonAgeClass[];
  readonly doors: readonly number[];
  readonly kerbStop: KerbStop | null;
}

/** A signalised junction's groups, as the heads are placed from them (`render/signals.ts`); null: it has no signal now. */
export interface JunctionSignal {
  readonly node: NodeId;
  readonly groups: readonly { readonly id: number; readonly segments: readonly SegmentId[] }[] | null;
}

/** A signal's plan as the heads read it: each stage's green groups. */
export interface ShownPlan {
  readonly id: number;
  readonly stages: readonly { readonly greenGroups: readonly number[] }[];
}

/** A signal's state this tick: its plan (`ShownPlan.id`), its stage and its sub-phase. */
interface SignalShown {
  readonly node: NodeId;
  readonly plan: number;
  readonly stage: number;
  readonly sub: string;
}

/** The city's numbers the panels show. */
export interface FrameStats {
  readonly vehicles: number;
  readonly lotsMoving: number;
  readonly peds: number;
  readonly controllers: number;
  readonly trips: number;
  readonly lost: number;
  readonly speedSum: number;
  readonly queued: number;
}

export interface SimFrame {
  readonly tick: number;
  readonly minutes: number;
  /** The vehicles on the roads, in id order. */
  readonly vehicles: Float64Array;
  readonly vehicleCount: number;
  /** The cars standing in bays: those that came (and, `parkedWhole`, all of them) and those that moved there this tick. */
  readonly parked: Float64Array;
  readonly parkedCount: number;
  readonly parkedWhole: boolean;
  readonly parkedGone: readonly VehicleId[];
  /** The looks of the vehicles new to the page or whose look changed (`VehicleLook`). */
  readonly looks: readonly VehicleLook[];
  readonly peds: Float64Array;
  readonly pedCount: number;
  /** Each person new to the page or whose look changed: every field not in `peds`. */
  readonly pedLooks: readonly { readonly id: number; readonly look: PedLook }[];
  /** The junctions whose signal came or went (null: every junction of the map, `signalsWhole`), and the plans new to the page. */
  readonly junctions: readonly JunctionSignal[];
  readonly signalsWhole: boolean;
  readonly plans: readonly ShownPlan[];
  readonly signals: readonly SignalShown[];
  readonly trains: readonly TrainView[];
  /** The bullet wounds and the people struck since the last frame (`people/casualties.ts`). */
  readonly wounds: readonly { readonly id: number; readonly part: BodyPart; readonly fromX: number; readonly fromY: number }[];
  readonly casualties: readonly Casualty[];
  readonly stats: FrameStats;
}


/** A person's fields written as numbers (`PF`), kept apart from its look. */
export const PED_NUMBERS: Readonly<Record<string, true>> = {
  id: true, x: true, y: true, heading: true, prev: true, v: true, turnV: true, age: true, kerbWait: true, segment: true, ground: true, walking: true,
};

/** Writes the page's frame of a world after its ticks, keeping what the page already has */
export class FrameWriter {
  private readonly odometer = new WheelOdometer();
  /** Each vehicle sent last frame: its seats, whether its look was moving (doors, a kerb stop), its archetype. */
  private readonly sent = new Map<VehicleId, { seats: number; busy: boolean; people: number; archetype: number }>();
  private parkedSerial = -1;
  /** Each person's look as last sent: the fields' own values, compared by identity (`lookMoved`). */
  private readonly pedSent = new Map<number, PedLook>();
  private signalSerial = -1;
  private readonly planIds = new WeakMap<SignalPlan, number>();
  private nextPlan = 1;
  private readonly signalSent = new Map<NodeId, { plan: number; stage: number; sub: string }>();
  private vehicles: Float64Array<ArrayBuffer> = new Float64Array(64 * VEHICLE_STRIDE);
  private parked: Float64Array<ArrayBuffer> = new Float64Array(64 * VEHICLE_STRIDE);
  private peds: Float64Array<ArrayBuffer> = new Float64Array(64 * PED_STRIDE);

  /** A new map, or a page that has nothing: everything is sent again. */
  reset(): void {
    this.sent.clear();
    this.parkedSerial = -1;
    this.pedSent.clear();
    this.signalSerial = -1;
    this.signalSent.clear();
  }

  write(w: SimWorld): SimFrame {
    const looks: VehicleLook[] = [];
    const present = new Set<VehicleId>();
    let speedSum = 0, queued = 0;
    // The traffic.
    const road = w.vehiclesInIdOrder();
    this.vehicles = room(this.vehicles, road.length * VEHICLE_STRIDE);
    let n = 0;
    for (const v of road) {
      if (this.put(w, v, this.vehicles, n * VEHICLE_STRIDE, looks)) n++;
      present.add(v.id);
      speedSum += v.v;
      if (v.v < 0.5) queued++;
    }
    // The cars standing in bays: what came and went, and those that may move there.
    const log = w.ambient.parkedSince(this.parkedSerial);
    const whole = log === null;
    const parkedGone: VehicleId[] = [];
    const parkedNow = new Set<Vehicle>(whole ? w.ambient.parked : []);
    if (log) for (const { car, added } of log) {
      if (added) parkedNow.add(car);
      else { parkedNow.delete(car); if (!w.ambient.isParked(car)) parkedGone.push(car.id); }
    }
    for (const car of w.ambient.movers) parkedNow.add(car);
    this.parkedSerial = w.ambient.parkedSerial;
    this.parked = room(this.parked, parkedNow.size * VEHICLE_STRIDE);
    let p = 0;
    for (const car of parkedNow) {
      if (!w.ambient.isParked(car)) continue;
      if (this.put(w, car, this.parked, p * VEHICLE_STRIDE, looks)) p++;
    }
    for (const car of w.ambient.parked) present.add(car.id);
    // Those gone from the page's view: their records let go.
    for (const id of this.sent.keys()) if (!present.has(id)) { this.sent.delete(id); this.odometer.forget(id); }

    const peds = this.writePeds(w.pedViews);
    const signals = this.writeSignals(w);
    return {
      tick: w.clock.tick,
      minutes: w.city.minutes(w),
      vehicles: this.vehicles, vehicleCount: n,
      parked: this.parked, parkedCount: p, parkedWhole: whole, parkedGone,
      looks,
      peds: this.peds, pedCount: peds.count, pedLooks: peds.looks,
      ...signals,
      trains: w.city.transit.trains(),
      wounds: takeWounds(w),
      casualties: takeCasualties(w),
      stats: {
        vehicles: w.vehicles.size, lotsMoving: w.city.lots.moving(), peds: w.pedViews.length, controllers: w.controllers.size,
        trips: w.completedTrips, lost: w.entryDemandLost, speedSum, queued,
      },
    };
  }

  /** A vehicle's numbers at `at`, its look when the page has not got it; false when it has no pose this tick. */
  private put(w: SimWorld, v: Vehicle, out: Float64Array, at: number, looks: VehicleLook[]): boolean {
    const archetype = ARCHETYPES.indexOf(v.archetype);
    const busy = v.doors.length > 0 || v.kerbStop !== null;
    const was = this.sent.get(v.id);
    if (!was || was.archetype !== archetype || was.seats !== v.seats || was.busy || busy || was.people !== v.people.length) {
      looks.push({ id: v.id, color: v.color, people: [...v.people], peopleAge: [...v.peopleAge], doors: [...v.doors], kerbStop: v.kerbStop && { ...v.kerbStop, person: v.kerbStop.person && { ...v.kerbStop.person } } });
    }
    this.sent.set(v.id, { seats: v.seats, busy, people: v.people.length, archetype });
    if (!poseEnds(w, v, out, at)) return false;
    const free = v.free;
    let flags = out[at + VF.flags]!;
    if (free) flags |= VEHICLE_FREE;
    if (v.slain) flags |= VEHICLE_SLAIN;
    out[at + VF.id] = v.id;
    out[at + VF.flags] = flags;
    out[at + VF.v] = v.v;
    out[at + VF.prevV] = v.prev.v;
    out[at + VF.age] = v.age;
    out[at + VF.seats] = v.seats;
    const lane = free ? undefined : w.lanelet(v.lanelet);
    out[at + VF.segment] = lane?.segment ?? (lane ? w.connector(lane.id)?.inSegment : undefined) ?? -1;
    out[at + VF.indicator] = free ? 0 : indicatorSide(w, v);
    out[at + VF.curvature] = free ? 0 : pathCurvature(w, v);
    out[at + VF.odometer] = this.odometer.advance(v);
    out[at + VF.archetype] = archetype;
    out[at + VF.lot] = free?.lot ?? -1;
    return true;
  }

  private writePeds(views: readonly PedView[]): { count: number; looks: { id: number; look: PedLook }[] } {
    this.peds = room(this.peds, views.length * PED_STRIDE);
    const out = this.peds;
    const looks: { id: number; look: PedLook }[] = [];
    const seen = new Set<number>();
    let k = 0;
    for (const ped of views) {
      const at = k++ * PED_STRIDE;
      out[at + PF.id] = ped.id;
      out[at + PF.x] = ped.x; out[at + PF.y] = ped.y; out[at + PF.heading] = ped.heading;
      out[at + PF.px] = ped.prev.x; out[at + PF.py] = ped.prev.y; out[at + PF.pheading] = ped.prev.heading;
      out[at + PF.v] = ped.v; out[at + PF.turnV] = ped.turnV; out[at + PF.age] = ped.age; out[at + PF.kerbWait] = ped.kerbWait;
      out[at + PF.gestureT] = ped.gesture?.t ?? 0;
      out[at + PF.segment] = ped.segment ?? -1;
      out[at + PF.ground] = PED_GROUNDS.indexOf(ped.ground);
      out[at + PF.walking] = ped.walking ? 1 : 0;
      const sent = this.pedSent.get(ped.id);
      if (!sent || lookMoved(ped, sent)) {
        this.pedSent.set(ped.id, lookOf(ped, false));
        looks.push({ id: ped.id, look: lookOf(ped, true) });
      }
      seen.add(ped.id);
    }
    for (const id of this.pedSent.keys()) if (!seen.has(id)) this.pedSent.delete(id);
    return { count: k, looks };
  }

  private writeSignals(w: SimWorld): Pick<SimFrame, 'junctions' | 'signalsWhole' | 'plans' | 'signals'> {
    const log = w.signalChangesSince(this.signalSerial);
    this.signalSerial = log.serial;
    const whole = log.nodes === null;
    const junctions: JunctionSignal[] = [];
    for (const node of whole ? w.junctionNodesInOrder() : new Set(log.nodes)) {
      const junction = w.graph.junctions.get(node);
      const shown = junction?.signalised && w.controller(node);
      junctions.push({ node, groups: shown ? junction.groups.map((g) => ({ id: g.id, segments: [...g.segments] })) : null });
    }
    if (whole) this.signalSent.clear();
    const plans: ShownPlan[] = [];
    const signals: SignalShown[] = [];
    const live = new Set<NodeId>();
    for (const c of w.signalisedControllers()) {
      live.add(c.node);
      const plan = this.planOf(c, plans);
      const was = this.signalSent.get(c.node);
      if (was && was.plan === plan && was.stage === c.stageIndex && was.sub === c.sub) continue;
      this.signalSent.set(c.node, { plan, stage: c.stageIndex, sub: c.sub });
      signals.push({ node: c.node, plan, stage: c.stageIndex, sub: c.sub });
    }
    for (const node of this.signalSent.keys()) if (!live.has(node)) this.signalSent.delete(node);
    return { junctions, signalsWhole: whole, plans, signals };
  }

  private planOf(c: SignalController, plans: ShownPlan[]): number {
    let id = this.planIds.get(c.plan);
    if (id === undefined) {
      id = this.nextPlan++;
      this.planIds.set(c.plan, id);
      plans.push({ id, stages: c.plan.stages.map((s) => ({ greenGroups: [...s.greenGroups] })) });
    }
    return id;
  }
}

/** The body's two ends (`vehiclePoseInto` at the last tick and at this one), and whether there is a tick to blend from. */
function poseEnds(w: SimWorld, v: Vehicle, out: Float64Array, at: number): boolean {
  const free = v.free;
  if (free) {
    out[at + VF.x0] = free.px; out[at + VF.y0] = free.py; out[at + VF.h0] = free.pangle; out[at + VF.yaw0] = 0;
    out[at + VF.x1] = free.x; out[at + VF.y1] = free.y; out[at + VF.h1] = free.angle; out[at + VF.yaw1] = 0;
    out[at + VF.flags] = VEHICLE_BEFORE;
    return true;
  }
  const ends = POSE_ENDS;
  if (!vehiclePoseEnds(w, v, ends)) return false;
  out[at + VF.x0] = ends.x0; out[at + VF.y0] = ends.y0; out[at + VF.h0] = ends.h0; out[at + VF.yaw0] = ends.yaw0;
  out[at + VF.x1] = ends.x1; out[at + VF.y1] = ends.y1; out[at + VF.h1] = ends.h1; out[at + VF.yaw1] = ends.yaw1;
  out[at + VF.flags] = ends.before ? VEHICLE_BEFORE : 0;
  return true;
}
const POSE_ENDS: PoseEnds = { x0: 0, y0: 0, h0: 0, yaw0: 0, x1: 0, y1: 0, h1: 0, yaw1: 0, before: false };

/** A person's fields that are not the numbers of `peds`. */
export type PedLook = Readonly<Record<string, unknown>>;

/** A person's look: every field but the numbers of `peds`; `sending`: its gesture copied (the page writes its clock). */
function lookOf(ped: PedView, sending: boolean): PedLook {
  const look: Record<string, unknown> = {};
  for (const key in ped) {
    if (PED_NUMBERS[key]) continue;
    const value = (ped as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    look[key] = sending && key === 'gesture' && value ? { ...(value as object), t: 0 } : value;
  }
  return look;
}

/** Whether a field of the look was set anew, came or went since `sent`: compared by identity, never by serialising. */
function lookMoved(ped: PedView, sent: PedLook): boolean {
  let n = 0;
  for (const key in ped) {
    if (PED_NUMBERS[key]) continue;
    const value = (ped as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (sent[key] !== value) return true;
    n++;
  }
  let m = 0;
  for (const key in sent) if (sent[key] !== undefined) m++;
  return n !== m;
}

/** `out` with room for `n` numbers: grown twice over when short, never shrunk. */
function room(out: Float64Array<ArrayBuffer>, n: number): Float64Array<ArrayBuffer> {
  return out.length >= n ? out : new Float64Array(Math.max(n, out.length * 2));
}

