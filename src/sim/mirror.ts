import type { NodeId, SegmentId } from '@world/ids';
import { type PoseEnds, type PoseOut, blendPoseEnds } from './pose';
import type { BodyPart, PedView, PersonAgeClass } from './people/view';
import { CasualtyBook } from './people/casualties';
import type { TrainView } from './transit/transit';
import { ARCHETYPES, type Archetype } from './vehicles/archetypes';
import type { KerbStop } from './vehicles/kerbStops';
import type { IndicatorSide } from './vehicles/shown';
import type { VehicleId } from './vehicles/state';
import {
  type FrameStats, type JunctionSignal, type PedLook, type VehicleLook, PED_GROUNDS, PED_NUMBERS, PED_STRIDE, PF, type ShownPlan, type SimFrame,
  VEHICLE_BEFORE, VEHICLE_FREE, VEHICLE_SLAIN, VEHICLE_STRIDE, VF,
} from './frame';

/** THE SIMULATION AS THE PAGE SEES IT: one object per vehicle and per person, kept from frame to frame (`FrameWriter`) */

/** A vehicle as it is drawn: the fields of `Vehicle` the page reads, and what it shows (`sim/vehicles/shown.ts`). */
export interface ShownVehicle {
  readonly id: VehicleId;
  archetype: Archetype;
  color: string;
  /** Off the road: where it stands now (`x`, `y`, `angle`) and stood a tick before (`px`...), and its lot. */
  free: { x: number; y: number; angle: number; px: number; py: number; pangle: number; lot: number | undefined } | null;
  v: number;
  readonly prev: { v: number };
  age: number;
  seats: number;
  people: number[];
  peopleAge: PersonAgeClass[];
  doors: number[];
  kerbStop: KerbStop | null;
  slain: boolean;
  /** Its body at the last two ticks (`vehiclePoseEnds`). */
  readonly ends: PoseEnds;
  /** The road under it, for its height; undefined off the roads. */
  segment: SegmentId | undefined;
  indicator: IndicatorSide;
  /** The bend under its front axle, per world unit (`pathCurvature`). */
  curvature: number;
  /** Distance its wheels have rolled. */
  odometer: number;
}

/** A signal as the heads read it (`render/signals.ts`): its plan, stage and sub-phase. */
export interface ShownController {
  plan: ShownPlan;
  stageIndex: number;
  sub: string;
}

/** Side of the cells the vehicles are filed in for the draw and the bodies (`parkedIn`, `roadIn`), world units. */
const VEHICLE_CELL = 128;
/** The cell of a point, as one number (`VEHICLE_CELL` cells, ±2^15 of them each way). */
const cellKey = (ix: number, iy: number): number => (ix + 32768) * 65536 + (iy + 32768);
const cellOf = (x: number, y: number): number => cellKey(Math.floor(x / VEHICLE_CELL), Math.floor(y / VEHICLE_CELL));

/** A vehicle's pose `alpha` of the way through the tick, into `out`. */
export function shownPoseInto(v: ShownVehicle, alpha: number, out: PoseOut): void {
  blendPoseEnds(v.ends, Math.min(1, Math.max(0, alpha)), out);
}

export class SimMirror {
  tick = 0;
  minutes = 0;
  /** The vehicles on the roads, in id order. */
  readonly road: ShownVehicle[] = [];
  /** The cars standing in bays. */
  readonly parked = new Map<VehicleId, ShownVehicle>();
  /** Moves whenever a vehicle comes or goes (the casting of their people reads it, `render/agents.ts`). */
  fleetVersion = 0;
  /** Whether the last frame changed a signal's lamps or the junctions that have one. */
  signalsMoved = false;
  readonly pedViews: PedView[] = [];
  trains: readonly TrainView[] = [];
  /** The bullet wounds not yet drawn (`takeWounds`), and the people struck, as long as they are drawn. */
  readonly wounds: { id: number; part: BodyPart; fromX: number; fromY: number }[] = [];
  readonly casualties = new CasualtyBook();
  stats: FrameStats = { vehicles: 0, lotsMoving: 0, peds: 0, trips: 0, lost: 0, speedSum: 0, queued: 0 };
  private readonly vehicles = new Map<VehicleId, ShownVehicle>();
  /** The cars in bays by cell, and the cell each is filed in: the draw reads only the cells in view. */
  private readonly parkedCells = new Map<number, Set<ShownVehicle>>();
  private readonly parkedCell = new Map<VehicleId, number>();
  /** The vehicles on the roads by cell, filed when first asked in a tick (`roadIn`). */
  private readonly roadCells = new Map<number, ShownVehicle[]>();
  private roadFiled = -1;
  private readonly onRoad = new Set<VehicleId>();
  private readonly peds = new Map<number, PedView>();
  private readonly junctions = new Map<NodeId, JunctionSignal['groups']>();
  private readonly plans = new Map<number, ShownPlan>();
  private readonly controllers = new Map<NodeId, ShownController>();
  /** The junctions whose signal came or went, by serial (`signalChangesSince`). */
  private signalLog: NodeId[][] = [];
  private signalBase = 0;
  private junctionOrder: NodeId[] | null = null;

  /** The bullet wounds since the last call, taken. */
  takeWounds(): { id: number; part: BodyPart; fromX: number; fromY: number }[] {
    return this.wounds.splice(0);
  }

  /** Whether a vehicle is still on the page: on the roads or standing in a bay. */
  has(v: { readonly id: VehicleId }): boolean {
    return this.vehicles.get(v.id) === v;
  }

  take(frame: SimFrame): void {
    this.tick = frame.tick;
    this.minutes = frame.minutes;
    this.trains = frame.trains;
    this.stats = frame.stats;
    for (const wound of frame.wounds) if (this.wounds.length < 256) this.wounds.push(wound);
    this.casualties.add(frame.casualties);
    let changed = false;
    const looks = frame.looks.length ? new Map(frame.looks.map((l) => [l.id, l])) : null;
    for (const look of frame.looks) {
      const v = this.vehicles.get(look.id);
      if (!v) continue;
      v.color = look.color; v.people = [...look.people]; v.peopleAge = [...look.peopleAge]; v.doors = [...look.doors]; v.kerbStop = look.kerbStop;
    }
    // The roads: the list made again in the frame's order.
    const road = new Set<VehicleId>();
    this.road.length = 0;
    for (let k = 0; k < frame.vehicleCount; k++) {
      const v = this.read(frame.vehicles, k * VEHICLE_STRIDE, looks);
      road.add(v.id);
      this.road.push(v);
      if (!this.onRoad.has(v.id)) changed = true;
    }
    for (const id of this.onRoad) if (!road.has(id)) { changed = true; if (!this.parked.has(id)) this.vehicles.delete(id); }
    this.onRoad.clear();
    for (const id of road) this.onRoad.add(id);
    // The bays: what came, went and moved.
    if (frame.parkedWhole) {
      for (const id of this.parked.keys()) if (!road.has(id)) this.vehicles.delete(id);
      this.parked.clear();
      this.parkedCells.clear();
      this.parkedCell.clear();
      changed = true;
    }
    for (const id of frame.parkedGone) {
      if (!this.parked.delete(id)) continue;
      this.unfile(id);
      changed = true;
      if (!road.has(id)) this.vehicles.delete(id);
    }
    for (let k = 0; k < frame.parkedCount; k++) {
      const v = this.read(frame.parked, k * VEHICLE_STRIDE, looks);
      if (this.parked.get(v.id) !== v) { if (!this.parked.has(v.id)) changed = true; this.parked.set(v.id, v); this.unfile(v.id); }
      this.file(v);
    }
    // A vehicle on the roads that went into a bay is no longer on the list of the roads, and the other way round.
    for (const id of road) if (this.parked.delete(id)) this.unfile(id);
    if (changed) this.fleetVersion++;
    this.takePeds(frame);
    this.takeSignals(frame);
  }

  /** The cars in bays in the cells `inView` keeps (given each cell's box), into `out`. */
  parkedIn(inView: (minX: number, minY: number, maxX: number, maxY: number) => boolean, out: ShownVehicle[]): void {
    for (const [key, cars] of this.parkedCells) {
      const ix = Math.floor(key / 65536) - 32768, iy = (key % 65536) - 32768;
      if (inView(ix * VEHICLE_CELL, iy * VEHICLE_CELL, (ix + 1) * VEHICLE_CELL, (iy + 1) * VEHICLE_CELL)) for (const car of cars) out.push(car);
    }
  }

  /** The cars in bays whose cell meets the box. */
  *parkedNear(minX: number, minY: number, maxX: number, maxY: number): Generator<ShownVehicle> {
    for (let ix = Math.floor(minX / VEHICLE_CELL); ix <= Math.floor(maxX / VEHICLE_CELL); ix++) {
      for (let iy = Math.floor(minY / VEHICLE_CELL); iy <= Math.floor(maxY / VEHICLE_CELL); iy++) yield* this.parkedCells.get(cellKey(ix, iy)) ?? [];
    }
  }

  /** The vehicles on the roads whose cell (where they are at the end of the tick) meets the box: filed once a tick, when first asked. */
  *roadNear(minX: number, minY: number, maxX: number, maxY: number): Generator<ShownVehicle> {
    if (this.roadFiled !== this.tick) {
      this.roadFiled = this.tick;
      this.roadCells.clear();
      for (const v of this.road) {
        const key = cellOf(v.ends.x1, v.ends.y1);
        const list = this.roadCells.get(key);
        if (list) list.push(v);
        else this.roadCells.set(key, [v]);
      }
    }
    for (let ix = Math.floor(minX / VEHICLE_CELL); ix <= Math.floor(maxX / VEHICLE_CELL); ix++) {
      for (let iy = Math.floor(minY / VEHICLE_CELL); iy <= Math.floor(maxY / VEHICLE_CELL); iy++) yield* this.roadCells.get(cellKey(ix, iy)) ?? [];
    }
  }

  /** A car in a bay filed in the cell it stands in now. */
  private file(v: ShownVehicle): void {
    const key = v.free ? cellOf(v.free.x, v.free.y) : cellOf(v.ends.x1, v.ends.y1);
    const was = this.parkedCell.get(v.id);
    if (was === key) return;
    if (was !== undefined) this.unfile(v.id);
    this.parkedCell.set(v.id, key);
    const cars = this.parkedCells.get(key);
    if (cars) cars.add(v);
    else this.parkedCells.set(key, new Set([v]));
  }

  private unfile(id: VehicleId): void {
    const key = this.parkedCell.get(id);
    if (key === undefined) return;
    this.parkedCell.delete(id);
    const cars = this.parkedCells.get(key);
    if (!cars) return;
    for (const car of cars) if (car.id === id) { cars.delete(car); break; }
    if (!cars.size) this.parkedCells.delete(key);
  }

  /** Whether the last frame moved anything that can be seen: vehicles, cars parking, people, a signal's lamps, trains. */
  showsMotion(): boolean {
    const s = this.stats;
    return s.vehicles > 0 || s.peds > 0 || s.lotsMoving > 0 || this.signalsMoved || this.trains.length > 0;
  }

  /** The vehicle of the record at `at`, made when new, its numbers taken in. */
  private read(data: Float64Array, at: number, looks: ReadonlyMap<VehicleId, VehicleLook> | null): ShownVehicle {
    const id = data[at + VF.id]! as VehicleId;
    const archetype = ARCHETYPES[data[at + VF.archetype]!] ?? ARCHETYPES[0]!;
    let v = this.vehicles.get(id);
    if (!v || v.archetype !== archetype) {
      const look = looks?.get(id);
      v = {
        id, archetype, color: look?.color ?? '#808080', free: null, v: 0, prev: { v: 0 }, age: 0, seats: 0,
        people: look ? [...look.people] : [], peopleAge: look ? [...look.peopleAge] : [], doors: look ? [...look.doors] : [], kerbStop: look?.kerbStop ?? null,
        slain: false, ends: { x0: 0, y0: 0, h0: 0, yaw0: 0, x1: 0, y1: 0, h1: 0, yaw1: 0, before: false },
        segment: undefined, indicator: 0, curvature: 0, odometer: 0,
      };
      this.vehicles.set(id, v);
    }
    const flags = data[at + VF.flags]!;
    const e = v.ends;
    e.x0 = data[at + VF.x0]!; e.y0 = data[at + VF.y0]!; e.h0 = data[at + VF.h0]!; e.yaw0 = data[at + VF.yaw0]!;
    e.x1 = data[at + VF.x1]!; e.y1 = data[at + VF.y1]!; e.h1 = data[at + VF.h1]!; e.yaw1 = data[at + VF.yaw1]!;
    e.before = (flags & VEHICLE_BEFORE) !== 0;
    if (flags & VEHICLE_FREE) {
      const lot = data[at + VF.lot]!;
      const free = v.free ?? { x: 0, y: 0, angle: 0, px: 0, py: 0, pangle: 0, lot: undefined };
      free.px = e.x0; free.py = e.y0; free.pangle = e.h0; free.x = e.x1; free.y = e.y1; free.angle = e.h1; free.lot = lot < 0 ? undefined : lot;
      v.free = free;
    } else v.free = null;
    v.slain = (flags & VEHICLE_SLAIN) !== 0;
    v.v = data[at + VF.v]!;
    v.prev.v = data[at + VF.prevV]!;
    v.age = data[at + VF.age]!;
    v.seats = data[at + VF.seats]!;
    const segment = data[at + VF.segment]!;
    v.segment = segment < 0 ? undefined : segment as SegmentId;
    v.indicator = data[at + VF.indicator]! as IndicatorSide;
    v.curvature = data[at + VF.curvature]!;
    v.odometer = data[at + VF.odometer]!;
    return v;
  }

  private takePeds(frame: SimFrame): void {
    const looks = new Map(frame.pedLooks.map((l) => [l.id, l.look]));
    const seen = new Set<number>();
    this.pedViews.length = 0;
    const data = frame.peds;
    for (let k = 0; k < frame.pedCount; k++) {
      const at = k * PED_STRIDE;
      const id = data[at + PF.id]!;
      let ped = this.peds.get(id);
      const look = looks.get(id);
      if (!ped) {
        ped = { id, prev: { x: 0, y: 0, heading: 0 } } as unknown as PedView;
        this.peds.set(id, ped);
      }
      if (look !== undefined) takeLook(ped, look);
      const p = ped as { -readonly [K in keyof PedView]: PedView[K] };
      p.x = data[at + PF.x]!; p.y = data[at + PF.y]!; p.heading = data[at + PF.heading]!;
      const prev = p.prev as { x: number; y: number; heading: number };
      prev.x = data[at + PF.px]!; prev.y = data[at + PF.py]!; prev.heading = data[at + PF.pheading]!;
      p.v = data[at + PF.v]!; p.turnV = data[at + PF.turnV]!; p.age = data[at + PF.age]!; p.kerbWait = data[at + PF.kerbWait]!;
      if (p.gesture) p.gesture.t = data[at + PF.gestureT]!;
      const segment = data[at + PF.segment]!;
      p.segment = (segment < 0 ? undefined : segment) as PedView['segment'];
      p.ground = PED_GROUNDS[data[at + PF.ground]!] ?? 'footway';
      p.walking = data[at + PF.walking]! === 1;
      this.pedViews.push(ped);
      seen.add(id);
    }
    for (const id of this.peds.keys()) if (!seen.has(id)) this.peds.delete(id);
  }

  private takeSignals(frame: SimFrame): void {
    this.signalsMoved = frame.signalsWhole || frame.signals.length > 0 || frame.junctions.length > 0;
    if (frame.signalsWhole) { this.junctions.clear(); this.controllers.clear(); }
    for (const plan of frame.plans) this.plans.set(plan.id, plan);
    const nodes: NodeId[] = [];
    for (const j of frame.junctions) {
      if (j.groups) this.junctions.set(j.node, j.groups);
      else { this.junctions.delete(j.node); this.controllers.delete(j.node); }
      nodes.push(j.node);
    }
    for (const s of frame.signals) {
      const plan = this.plans.get(s.plan);
      if (!plan) continue;
      const c = this.controllers.get(s.node);
      if (c) { c.plan = plan; c.stageIndex = s.stage; c.sub = s.sub; }
      else this.controllers.set(s.node, { plan, stageIndex: s.stage, sub: s.sub });
    }
    if (frame.signalsWhole) { this.signalBase += this.signalLog.length + 1; this.signalLog = []; this.junctionOrder = null; }
    else if (nodes.length) { this.signalLog.push(nodes); this.junctionOrder = null; }
  }

  /** The junctions whose signal came or went since `serial`, and the serial now; nodes null: read them all. */
  signalChangesSince(serial: number): { readonly serial: number; readonly nodes: readonly NodeId[] | null } {
    const now = this.signalBase + this.signalLog.length;
    if (serial < this.signalBase || serial > now) return { serial: now, nodes: null };
    return { serial: now, nodes: this.signalLog.slice(serial - this.signalBase).flat() };
  }

  /** The signalised junctions, in node order. */
  junctionNodesInOrder(): readonly NodeId[] {
    return this.junctionOrder ??= [...this.junctions.keys()].sort((a, b) => a - b);
  }

  /** A signalised junction's groups, or undefined. */
  junctionGroups(node: NodeId): JunctionSignal['groups'] | undefined {
    return this.junctions.get(node) ?? undefined;
  }

  controller(node: NodeId): ShownController | undefined {
    return this.controllers.get(node);
  }
}

/** A person's look taken in: what it no longer has let go, what it has written, the hot numbers left as they are. */
function takeLook(ped: PedView, look: PedLook): void {
  const own = ped as unknown as Record<string, unknown>;
  for (const key of Object.keys(own)) if (!(key in look) && !PED_NUMBERS[key]) delete own[key];
  for (const key in look) own[key] = look[key];
}
