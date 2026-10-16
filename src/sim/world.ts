import { Rng } from '@core/rng';
import { JournalCursor } from '@world/derived';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { type Connector, type GraphChange, type JunctionTopology, type Lanelet, type LaneletId, LaneletGraph } from '@world/lanelets';
import { ChangeLog } from '@core/changeLog';
import { NetworkLength } from '@world/networkLength';
import { LaneGrid } from './agents/laneGrid';
import { LaneReaches } from './routing/laneReach';
import { ConflictIndex, type BodyClass, WAITING } from '@world/conflictPoints';
import { type ChosenTurn, TurnPlan } from '@world/junctionTurns';
import type { PairMeasurer } from '@world/conflictTable';
import { SimClock } from './clock';
import { ClaimTable } from './intersections/claims';
import type { Vehicle, VehicleId } from './vehicles/state';
import { type SignalController, type SignalDeps, createController, rebuildController, seekFixed } from './signals/fsm';
import { type CrossingId, makeCrossingId } from './signals/plan';
import type { AuditIssue } from './audit';
import { SidewalkGraph } from './peds/sidewalk';
import { SignalPostIndex } from './peds/signalPostIndex';
import { hasDownstreamStorage } from './intersections/spillback';
import { CrossingSpans } from './intersections/crossingSpans';
import { m } from '@world/units';
import { DT } from './params';

/** How far before its line a bus asks for priority, world units (V5). */
const BUS_REACH = m(90);

/** What the signals read of the world (`SignalDeps`), and the reservations by node, which wake a sleeping one (`SimWorld.signalsAsleep`). */
export type WorldSignalDeps = SignalDeps & { readonly reserved: () => ReadonlyMap<NodeId, ReadonlySet<number>> };
import type { CrossingStates } from './crossings/state';
import type { PedView } from './people/view';
import type { PedestrianEngine } from './people/engine';
import { City } from './city/city';
import { AmbientWorld } from './ambient/ambient';
import { Walkways, type WalkGraph } from '@world/walkways';
import { mainRoadLegs, type SignalSettings } from '@world/roads/rules';
import { FlowStats } from './roads/flowStats';
import { type AutoControl, ControlAdvisor } from './roads/controlAdvisor';
import { rebuildWork } from '@world/rebuildWork';
/** The body class a signal plan is protected for: an ordinary car. */const CAR_CLASS: BodyClass = 1;

/** Nobody walks until an engine is installed (`SimWorld.usePedestrianEngine`). */
const NO_PEDESTRIANS: PedestrianEngine = {
  kind: 'people',
  beginTick() {}, dispatch() {}, step() {}, rebind() {}, publish() {}, audit() {}, reset() {},
  bridge: { hailable: () => null, board: () => null, alight: () => false, anyoneWithin: () => false },
};

/** A queue is counted this far back from the stop line. */
const DEMAND_QUEUE_REACH = m(80);
/** Moving vehicles are counted when they will arrive within this, seconds. */
const DEMAND_HORIZON = 12;
/** A head this close, or arriving within the passage time, keeps a green alive. */
const DEMAND_AT_LINE = m(8);
const DEMAND_PASSAGE = 3;
/** Seconds of waiting that double a queued vehicle's weight. */
const DEMAND_WAIT_WEIGHT = 30;

/** Vehicles occupying one lanelet, kept sorted by ascending arc position. */
export interface LaneletRuntime {
  readonly id: LaneletId;
  /** Ascending by `s`; index 0 is nearest the entry, last is nearest the exit. */
  order: VehicleId[];
  /** Vehicles whose body still overlaps this lane while they slide out of it. */
  shadows: VehicleId[];
  /** A retired lanelet still carrying agents: no new entries accepted. */
  ghost: boolean;
  /** Tick at which a ghost was created, so it can be force-collected. */
  ghostSince: number;
}

/** The world's random streams, one per consumer, forked by tag so a new consumer reshuffles no other (`core/rng.ts`). */
export interface SimStreams {
  readonly spawnVehicles: Rng;
  readonly spawnPeds: Rng;
  readonly driver: Rng;
  readonly route: Rng;
  readonly gap: Rng;
  readonly pedParams: Rng;
  readonly courtesy: Rng;
  readonly signalOffsets: Rng;
  /** The People engine's own stream (`people/people.ts`). */
  readonly people: Rng;
  readonly occupancy: Rng;
  /** The lots' cars (`agents/lotTraffic.ts`), the lorries (`agents/lorryTraffic.ts`) and the scenery's life (`ambient/ambient.ts`). */
  readonly lots: Rng;
  readonly lorries: Rng;
  readonly ambient: Rng;
}

/** The streams of a world seeded `seed`: what a new world starts with, and a reset starts again from. */
function forkStreams(seed: number): SimStreams {
  const root = new Rng(seed);
  return {
    spawnVehicles: root.fork('spawnVehicles'),
    spawnPeds: root.fork('spawnPeds'),
    driver: root.fork('driver'),
    route: root.fork('routeChoice'),
    gap: root.fork('gapAcceptance'),
    pedParams: root.fork('pedParams'),
    courtesy: root.fork('courtesy'),
    signalOffsets: root.fork('signalOffsets'),
    occupancy: root.fork('occupancy'),
    people: root.fork('people'),
    // DO NOT give the lots, the lorries or the scenery a fixed seed of their own again
    lots: root.fork('lots'),
    lorries: root.fork('lorries'),
    ambient: root.fork('ambient'),
  };
}

/** What `SimWorld.rt` answers for a lane nobody has been on: empty, not a ghost, frozen against writes. */
const NO_RUNTIME: LaneletRuntime = Object.freeze({
  id: '' as LaneletId,
  order: Object.freeze([]) as unknown as VehicleId[],
  shadows: Object.freeze([]) as unknown as VehicleId[],
  ghost: false,
  ghostSince: 0,
});

/** Everything the simulation owns. */
export class SimWorld {
  readonly clock = new SimClock();
  readonly graph = new LaneletGraph();
  readonly conflicts = new ConflictIndex();
  readonly sidewalks = new SidewalkGraph();
  /** The traffic signal posts by place, kept from the junctions' controls (`signalChangesSince`): the walkers keep clear of them. */
  readonly signalPosts = new SignalPostIndex();
  readonly claims = new ClaimTable();

  /** @mapWide Every vehicle on the map. */
  readonly vehicles = new VersionedMap<VehicleId, Vehicle>();
  /** What moves the people (`people/engine.ts`); everything else reaches them through it. */
  pedEngine: PedestrianEngine = NO_PEDESTRIANS;
  /** The vehicle model: Drive v2 (`drive/*`), the only one (the plain-IDM legacy model was taken out on 2026-10-08). */
  driveModel = 'v2' as const;
  /** @mapWide One per lanelet a vehicle (or its shadow) has been on; written only through `runtimeFor`. */
  readonly runtime = new Map<LaneletId, LaneletRuntime>();
  readonly controllers = new Map<NodeId, SignalController>();
  /** DOING LESS (phase 1) */
  doLess = true;
  /** Lanes with a vehicle on them: written only by `enterLanelet`/`exitLanelet`, the only writers of `order`. */
  readonly occupied = new Set<LaneletId>();
  /** What the car being integrated was clearing as its step began: integration's own scratch, filled per car (`integrate.ts`). */
  readonly clearancesAtStart = new Set<Vehicle['clearingConnectors'][number]>();
  /** DO NOT find them by walking the fleet: three passes over every vehicle of the map each tick */
  private readonly maybeHolders = new Set<Vehicle>();
  /** Runtime lanes no longer in the graph (an edit took them): stage 7's work list (`collectGhosts`). */
  readonly ghostCandidates = new Set<LaneletId>();
  /** Signals asleep (`signalsAsleep`): rested in green with nobody near on their last step. */
  private readonly asleep = new Set<SignalController>();
  private asleepSince = { roads: -1, junctions: -1 };

  /** @mapWide What vehicles, signals and the audit may know about the people at each crossing (`crossings/state.ts`). */
  readonly crossingStates: CrossingStates = new Map();
  /** @mapWide Every person as the renderer and the counters see them */
  readonly pedViews: PedView[] = [];
  /** @mapWide Every person on the map, by id. */
  readonly pedViewById = new Map<number, PedView>();
  /** Stretch of each zebra that each movement drives over. */
  readonly crossingSpans = new CrossingSpans();

  /** Tick at which each junction last admitted a vehicle. */
  readonly lastAdmission = new Map<NodeId, number>();
  /** The lane that last sent a vehicle into each lane two or more lanes merge into, for the zipper */
  readonly mergeTurn = new Map<LaneletId, LaneletId>();
  /** Cumulative link entries since the current simulation session began. */
  readonly segmentVolume = new Map<number, number>();
  /** Vehicles an hour into each junction from each leg, as a trend. */
  get flow(): FlowStats { return this.flowStats; }
  private flowStats = new FlowStats();
  /** The control each junction left on "automatic" gets from its flows. */
  get advisor(): ControlAdvisor { return this.controlAdvisor; }
  private controlAdvisor = new ControlAdvisor();

  /** The world's random streams, forked from its seed (`reset` forks them again). */
  get rng(): SimStreams { return this.streams; }
  private streams: SimStreams;

  nextVehicleId = 1;
  /** The next person's id, kept by the world as the vehicles' are */
  nextPersonId = 1;
  /** The summed length of the roads, kept by what each rebuild changed (`world/networkLength.ts`). */
  readonly roadLength = new NetworkLength();
  /** The lanes by place, kept by what each build of the lane graph changed (`agents/laneGrid.ts`). */
  readonly laneGrid = new LaneGrid();
  /** The road ends each lane reaches, per body class, kept by what each edit changed (`routing/laneReach.ts`). */
  readonly laneReaches = new LaneReaches();
  /** Per-world population timer; simulations must never influence each other. */
  vehicleSpawnClock = 0;
  /** Traffic waiting to come in at each boundary entry lane */
  /** Per entry: the next arrival, the rate it was drawn at, and the arrivals waiting outside. */
  readonly entryDemand = new Map<LaneletId, { next: number; rate: number; waiting: number[] }>();
  /** Arrivals turned away because an entry's outside queue was full. */
  entryDemandLost = 0;
  /** Vehicles that reached the boundary exit chosen for their trip. */
  completedTrips = 0;
  /** User-facing density multipliers; topology and physics remain unchanged. */
  trafficIntensity = 1;
  pedestrianIntensity = 1;
  /** How many cars and how many people on foot the player wants on the map (the panel's Traffic and People, `main.ts`). */
  trafficCount: number | null = null;
  pedestrianCount: number | null = null;
  /** The game's way (`main.ts`): the panel's Traffic and People are shares of the city's own density */
  followCity = false;
  /** Shared demand multiplier for the current simulation period. */
  demandMultiplier = 1;
  /** Traffic from outside: cars at the map's edge entries, people at doors and road ends (set by `City.step`). */
  edgeTraffic = true;
  /** The city's services - the time of day, the public transport (`sim/city/city.ts`) - stepped by the pipeline. */
  readonly city = new City();
  /** The life of the scenery: people and traffic made round the view (`sim/ambient`). */
  readonly ambient = new AmbientWorld();
  /** Share of the population ceilings this device carries (1, or `NARROW_SCREEN_SHARE` on a narrow screen). */
  populationShare = 1;
  /** Where the player is looking, world units */
  focus: {
    readonly x: number; readonly y: number; readonly r: number; readonly detail: boolean;
    /** Playing (`play.ts`), the camera looks along the ground from behind the player and sees far down the street, past `r` */
    readonly view?: { readonly ex: number; readonly ey: number; readonly dx: number; readonly dy: number; readonly cos: number; readonly far: number } | null;
  } | null = null;

  auditEnabled = false;
  auditLevel: 'cheap' | 'full' = 'cheap';
  /** Ticks between audits: every tick in the specs; the game checks once a second (`main.ts`). */
  auditEvery = 1;
  readonly issues: AuditIssue[] = [];

  /** Topology revision the indices were last built from. */
  topologyRevision = -1;
  /** Revision the vehicle half was last built from (`rebuildVehicleTopology`). */
  vehicleTopologyRevision = -1;
  constructor(
    readonly doc: RoadDoc,
    readonly net: Network,
    private readonly seed = 0x5eed,
  ) {
    this.streams = forkStreams(seed);
  }

  /** Switches the model that moves the people. */
  usePedestrianEngine(engine: PedestrianEngine): void {
    this.crossingStates.clear();
    this.pedViews.length = 0;
    this.pedViewById.clear();
    this.pedEngine = engine;
    engine.rebind(this);
  }

  /** Forgets every agent and everything learned about the previous map. */
  reset(): void {
    this.vehicles.clear();
    this.maybeHolders.clear();
    this.runtime.clear();
    this.claims.clear();
    this.controllers.clear();
    this.planInputs.clear();
    // What was built from the graph is gone: the next rebuild builds it whole, as a new world's first.
    this.graph.forget();
    this.prepGraph?.forget();
    // The kerbs and zebras of the old map
    this.sidewalks.clear();
    this.walkSeen = null;
    this.vehiclesBound = null;
    this.signalPosts.reset();
    this.staleJunctions(null);
    this.occupied.clear();
    this.ghostCandidates.clear();
    this.asleep.clear();
    this.crossingStates.clear();
    this.pedViews.length = 0;
    this.pedViewById.clear();
    this.lastAdmission.clear();
    this.mergeTurn.clear();
    this.segmentVolume.clear();
    this.entryDemand.clear();
    this.entryDemandLost = 0;
    this.completedTrips = 0;
    this.vehicleSpawnClock = 0;
    this.issues.length = 0;
    this.topologyRevision = -1;
    this.vehicleTopologyRevision = -1;
    // DO NOT keep them: the advisor turned the new map's junctions to signals it had measured on the old one
    this.flowStats = new FlowStats();
    this.controlAdvisor = new ControlAdvisor();
    this.streams = forkStreams(this.seed);
    this.forgetSignals();
    this.pedEngine.reset(this);
  }

  // ------------------------------------------------------------- accessors

  lanelet(id: LaneletId): Lanelet | undefined {
    return this.graph.lanelets.get(id);
  }

  requireLanelet(id: LaneletId): Lanelet {
    const l = this.graph.lanelets.get(id);
    if (!l) throw new Error(`SimWorld: unknown lanelet ${id}`);
    return l;
  }

  connector(id: string): Connector | undefined {
    return this.graph.connectors.get(id);
  }

  /** DO NOT create the runtime here: routing, lane changes and the inspector read every lane they look at through this */
  rt(id: LaneletId): LaneletRuntime {
    return this.runtime.get(id) ?? NO_RUNTIME;
  }

  /** A lane's runtime, made when a vehicle or its shadow first comes onto it: for `enterLanelet` and `addShadow` only. */
  private runtimeFor(id: LaneletId): LaneletRuntime {
    let r = this.runtime.get(id);
    if (!r) {
      r = { id, order: [], shadows: [], ghost: false, ghostSince: 0 };
      this.runtime.set(id, r);
      if (!this.graph.lanelets.has(id)) this.ghostCandidates.add(id);
    }
    return r;
  }

  veh(id: VehicleId): Vehicle | undefined {
    return this.vehicles.get(id);
  }

  controller(node: NodeId): SignalController | undefined {
    return this.controllers.get(node);
  }

  /** A vehicle that may now hold something at a junction (`maybeHolders`): for the writers of what it holds. */
  noteHolder(v: Vehicle): void {
    this.maybeHolders.add(v);
  }

  /** The vehicles holding or clearing a movement, or on a connector, now - in no set order */
  junctionHolders(): Vehicle[] {
    const out: Vehicle[] = [];
    for (const v of this.maybeHolders) {
      if (this.vehicles.get(v.id) !== v) { this.maybeHolders.delete(v); continue; }
      if (v.admittedConnector !== null || v.clearingConnectors.length > 0 || this.lanelet(v.lanelet)?.kind === 'connector') out.push(v);
      else this.maybeHolders.delete(v);
    }
    return out;
  }

  /** DO NOT sort the fleet again at each change of it */
  vehiclesInIdOrder(): readonly Vehicle[] {
    return this.vehicles.inKeyOrder();
  }

  junctionNodesInOrder(): readonly NodeId[] {
    this.refreshJunctionOrder();
    return this.junctionOrder.nodes.inKeyOrder();
  }

  /** The controllers stage 1 runs, in node order: those of the signalised junctions. */
  signalisedControllers(): readonly SignalController[] {
    this.refreshJunctionOrder();
    return this.junctionOrder.signalised.inKeyOrder();
  }

  /** Moves whenever the junctions or their controllers do (a topology rebuild, a control the advisor switched) */
  private junctionsVersion = 0;
  /** DO NOT sort and file every junction of the map again for an edit: only those it reached (`staleJunctions`). */
  private readonly junctionOrder = {
    nodes: new VersionedMap<NodeId, NodeId>(), signalised: new VersionedMap<NodeId, SignalController>(),
    /** The junction each approach lane leads into (`junctionsApproached`). */
    junctionOf: new Map<LaneletId, NodeId>(),
    /** The signal each approach lane and each crossing of a plan belongs to: what wakes it (`signalsAsleep`). */
    approachOf: new Map<LaneletId, SignalController>(), crossingOf: new Map<CrossingId, SignalController[]>(),
    /** What each junction filed above, taken out when it is filed again. */
    filed: new Map<NodeId, { readonly inbound: readonly LaneletId[]; readonly controller: SignalController | null; readonly crossings: readonly CrossingId[] }>(),
  };
  /** The junctions whose filing is out of date (`refreshJunctionOrder`); null: every one. */
  private junctionsStale: Set<NodeId> | null = null;

  /** These junctions, or their controllers, changed (null: any of them may have). */
  private staleJunctions(nodes: Iterable<NodeId> | null): void {
    this.junctionsVersion++;
    if (nodes === null) this.junctionsStale = null;
    else if (this.junctionsStale) for (const node of nodes) this.junctionsStale.add(node);
  }

  private refreshJunctionOrder(): void {
    const stale = this.junctionsStale;
    if (stale && stale.size === 0) return;
    this.junctionsStale = new Set();
    const order = this.junctionOrder;
    if (stale === null) {
      order.nodes.clear(); order.signalised.clear(); order.junctionOf.clear(); order.approachOf.clear(); order.crossingOf.clear(); order.filed.clear();
    }
    const nodes = stale ?? [...this.graph.junctions.keys()].sort((a, b) => a - b);
    for (const node of nodes) {
      rebuildWork.lanes++;
      if (stale) this.unfileJunction(node);
      this.fileJunction(node);
    }
  }

  /** A junction's lanes and crossings taken out of `junctionOrder` (its place in the node lists is `fileJunction`'s). */
  private unfileJunction(node: NodeId): void {
    const order = this.junctionOrder;
    const was = order.filed.get(node);
    if (!was) return;
    order.filed.delete(node);
    for (const lane of was.inbound) if (order.junctionOf.get(lane) === node) order.junctionOf.delete(lane);
    const c = was.controller;
    if (!c) return;
    for (const lane of was.inbound) if (order.approachOf.get(lane) === c) order.approachOf.delete(lane);
    for (const x of was.crossings) {
      const of = order.crossingOf.get(x);
      const at = of ? of.indexOf(c) : -1;
      if (at < 0) continue;
      of!.splice(at, 1);
      if (!of!.length) order.crossingOf.delete(x);
    }
  }

  /** A junction, as the graph and its controller stand now, filed in `junctionOrder`. */
  private fileJunction(node: NodeId): void {
    const order = this.junctionOrder;
    const junction = this.graph.junctions.get(node);
    if (!junction) { order.nodes.delete(node); order.signalised.delete(node); return; }
    if (!order.nodes.has(node)) order.nodes.set(node, node);
    for (const lane of junction.inbound) order.junctionOf.set(lane, node);
    const found = this.controllers.get(node);
    const c = found && junction.signalised ? found : null;
    const crossings: CrossingId[] = [];
    order.filed.set(node, { inbound: junction.inbound, controller: c, crossings });
    if (!c) { if (order.signalised.has(node)) order.signalised.delete(node); return; }
    if (order.signalised.get(node) !== c) order.signalised.set(node, c);
    for (const lane of junction.inbound) order.approachOf.set(lane, c);
    for (const stage of c.plan.stages) {
      for (const x of stage.pedWalk) {
        if (crossings.includes(x)) continue;
        crossings.push(x);
        const of = order.crossingOf.get(x);
        if (!of) order.crossingOf.set(x, [c]);
        else if (!of.includes(c)) of.push(c);
      }
    }
  }

  /** The junctions with a vehicle on one of their approaches, in node order: the only ones with a lane head to admit */
  junctionsApproached(): readonly NodeId[] {
    this.refreshJunctionOrder();
    const { junctionOf } = this.junctionOrder;
    const out = this.approached, seen = this.approachedSeen;
    seen.clear();
    let n = 0;
    for (const lane of this.occupied) {
      const node = junctionOf.get(lane);
      if (node === undefined || seen.has(node)) continue;
      seen.add(node);
      out[n++] = node;
    }
    out.length = n;
    return out.sort((a, b) => a - b);
  }
  private readonly approached: NodeId[] = [];
  private readonly approachedSeen = new Set<NodeId>();

  /** DO NOT wake them on the document's revision */
  signalsAsleep(deps: WorldSignalDeps): Set<SignalController> {
    const asleep = this.asleep;
    const roads = this.doc.changes.serialOf('roads', 'traffic');
    if (!this.doLess || this.asleepSince.roads !== roads || this.asleepSince.junctions !== this.junctionsVersion) {
      asleep.clear();
      this.asleepSince = { roads, junctions: this.junctionsVersion };
    }
    if (asleep.size === 0) return asleep;
    this.refreshJunctionOrder();
    const { approachOf, crossingOf } = this.junctionOrder;
    for (const lane of this.occupied) {
      const c = approachOf.get(lane);
      if (c) asleep.delete(c);
    }
    for (const x of this.crossingStates.keys()) {
      for (const c of crossingOf.get(x) ?? []) asleep.delete(c);
    }
    for (const node of deps.reserved().keys()) {
      const c = this.controllers.get(node);
      if (c) asleep.delete(c);
    }
    return asleep;
  }

  // -------------------------------------------------------------- topology

  /** @rebuild Rebuilds every derived index from the current network geometry. */
  rebuildTopology(): void {
    this.rebuildVehicleTopology();
    this.rebuildWalkTopology();
  }

  /** The first half of `rebuildTopology`: lanelets, conflict zones, claims and the signal controllers */
  /** A second lanelet graph, built from the same document, that is never run */
  private prepGraph: LaneletGraph | null = null;

  /** @rebuild The slow half of `rebuildVehicleTopology` ahead of time, in steps */
  *prepareVehicleTopology(measurer?: PairMeasurer): Generator<void | typeof WAITING, void> {
    const graph = this.prepGraph ??= new LaneletGraph();
    // DO NOT sweep them here: a generated city's turns held one frame 25 s (2026-10-15).
    const left = graph.turnPlan;
    if (left) left.recording = measurer?.chooseTurns !== undefined;
    graph.turnPlan = measurer?.chooseTurns ? left ?? new TurnPlan() : left;
    // DO NOT call `update` here: a whole build was one call.
    const changed = this.prepReach(yield* graph.updateSteps(this.doc, this.net, measurer ?? null));
    const plan = graph.turnPlan;
    if (plan && plan.asks.size > 0) {
      const keys = [...plan.asks.keys()];
      const answer: { turns?: readonly ChosenTurn[]; failed?: boolean } = {};
      measurer!.chooseTurns!(keys.map((k) => plan.asks.get(k)!), plan.surfaces).then(
        (turns) => { answer.turns = turns; },
        (error: unknown) => { console.warn('[traffic] the turn workers failed; the turns are chosen on the page', error); answer.failed = true; },
      );
      while (!answer.turns && !answer.failed) yield WAITING;
      keys.forEach((k, i) => { const turn = answer.turns?.[i]; if (turn) plan.chosen.set(k, turn); });
    }
    // The junctions that stood turns in, their movements shaped with them (none: nothing to do).
    graph.redoProvisional(this.doc, this.net);
    yield;
    // The new pairs of the junctions built again since a preparation last ran to its end
    yield* this.conflicts.prepare(graph, measurer, changed);
    yield;
    // The residents' walkways brought up to the network: only what the edit reached
    yield* this.walkways.updateSteps(this.net, measurer);
    this.prepReached = new Set();
  }

  /** DO NOT prepare only the last edit's: the junctions of the one given up had their pairs measured on the page at the swap. */
  private prepReached: Set<NodeId> | null = new Set();
  private prepReach(changed: GraphChange | null): ReadonlySet<NodeId> | null {
    if (changed === null || this.prepReached === null) this.prepReached = null;
    else for (const node of changed.junctions) this.prepReached.add(node);
    return this.prepReached;
  }

  /** The residents' walkways (`world/walkways.ts`), kept by what each edit changed. */
  private readonly walkways = new Walkways();
  /** The walkways of the network as it is now. */
  walkwaysNow(): WalkGraph {
    return this.walkways.update(this.net);
  }

  /** Builds the preparation graph with a map's load, so its first edit does not build it from nothing. */
  warmTopologyPrep(): void {
    const graph = this.prepGraph ??= new LaneletGraph();
    if (graph.current(this.net)) return;
    // A preparation's stand-in turns left (`prepareVehicleTopology`) are chosen here: no workers are asked.
    if (graph.turnPlan) graph.turnPlan.recording = false;
    this.prepReach(graph.update(this.doc, this.net));
    graph.redoProvisional(this.doc, this.net);
  }

  /** What each build of the lane graph changed */
  readonly topologyLog = new ChangeLog<GraphChange>();
  /** The lane graph's state the vehicles were last bound to (`rebindVehicles`); null: bind every one. */
  vehiclesBound: object | null = null;
  /** The topology's state the kerbs, zebras and spans were brought up to (`walkTopologySteps`). */
  private walkSeen: object | null = null;

  /** @rebuild Called when the network's traffic revision moved. */
  rebuildVehicleTopology(): void {
    // DO NOT build the graph, the conflicts, the controllers and the lanes' runtimes of the whole map for an edit
    const prep = this.prepGraph;
    const changed = prep?.current(this.net) ? this.graph.adopt(prep, this.doc, this.net) : this.graph.update(this.doc, this.net);
    this.topologyLog.push(changed);
    // No vehicle stands on the graph before this build: none is left to bind to it (`rebindVehicles`).
    if (this.vehicles.size === 0) this.vehiclesBound = this.topologyLog.state;
    if (changed === null) this.conflicts.build(this.graph); else this.conflicts.update(this.graph, changed.junctions);
    this.claims.dropMissing(this.conflicts);
    this.syncControllers(changed?.junctions ?? null);
    for (const segment of changed ? [...changed.segments] : [...this.segmentVolume.keys()]) {
      rebuildWork.lanes++;
      if (!this.doc.segment(segment as SegmentId)) this.segmentVolume.delete(segment);
    }
    this.vehicleTopologyRevision = this.net.trafficRevision;
    // DO NOT leave this to stage 7: the mark only ever went on, and a lane given back would stay dead to routes, bays
    for (const id of changed ? changed.lanelets : this.runtime.keys()) {
      const rt = this.runtime.get(id);
      if (!rt) continue;
      rebuildWork.lanes++;
      if (!this.graph.lanelets.has(id)) this.ghostCandidates.add(id);
      else if (rt.ghost) { rt.ghost = false; rt.ghostSince = 0; }
    }
    this.staleJunctions(changed?.junctions ?? null);
    // The controls the flows chose stay chosen across an edit (V5); a junction gone takes its own away.
    if (changed === null) {
      const nodes = new Set(this.graph.junctions.keys());
      rebuildWork.lanes += nodes.size;
      this.flow.keepOnly(nodes);
      this.advisor.forget(nodes);
    } else {
      const gone = new Set([...changed.junctions].filter((node) => !this.graph.junctions.has(node)));
      if (gone.size) { this.flow.drop(gone); this.advisor.drop(gone); }
    }
    // DO NOT forget the log here: every road drawn anywhere had every junction's posts and heads placed again.
    this.noteJunctionsReached();
    if (this.applyAutoControl(changed?.junctions)) this.syncControllers(changed?.junctions ?? null);
  }

  /** DO NOT read a junction's control off `topologyRevision` alone */
  private signalLog: NodeId[] = [];
  private signalLogBase = 0;
  private signalSerial = 0;

  /** The junctions whose signal came or went since `serial` (`signalLog`), and the serial now; `nodes` null */
  signalChangesSince(serial: number): { readonly serial: number; readonly nodes: readonly NodeId[] | null } {
    if (serial < this.signalLogBase || serial > this.signalSerial) return { serial: this.signalSerial, nodes: null };
    return { serial: this.signalSerial, nodes: this.signalLog.slice(serial - this.signalLogBase) };
  }

  private noteSignal(node: NodeId): void {
    this.signalLog.push(node);
    this.signalSerial++;
    // DO NOT forget the whole log here: a reader that had just read was sent to read every junction again.
    const most = 2 * Math.max(64, this.graph.junctions.size);
    if (this.signalLog.length > most) {
      const drop = this.signalLog.length - most / 2;
      this.signalLog.splice(0, drop);
      this.signalLogBase += drop;
    }
  }

  /** The roads' changes since the last rebuild (`noteJunctionsReached`). */
  private readonly roadsSeen = new JournalCursor(['roads']);

  /** The junctions at the ends of the segments the roads' changes reached, noted; the log forgotten when the diary cannot say. */
  private noteJunctionsReached(): void {
    const entries = this.roadsSeen.read(this.doc.changes);
    if (entries === null || entries.some((e) => e.rects === null)) { this.forgetSignals(); return; }
    for (const entry of entries) {
      for (const rect of entry.rects!) {
        for (const id of this.net.segmentCells.idsMeeting(rect)) {
          const segment = this.doc.segment(id);
          if (segment) { this.noteSignal(segment.a); this.noteSignal(segment.b); }
        }
      }
    }
  }

  private forgetSignals(): void {
    this.signalLog = [];
    this.signalLogBase = ++this.signalSerial;
  }

  /** The control a junction on "automatic" runs */
  private applyAutoControl(only?: Iterable<NodeId>): boolean {
    let changed = false;
    // The junctions built again keep no choice of the old graph's: only they are asked (`only`)
    const asked = only ? [...only].map((node) => [node, this.graph.junctions.get(node)] as const).filter((e): e is readonly [NodeId, JunctionTopology] => e[1] !== undefined) : this.graph.junctions;
    for (const [node, junction] of asked) {
      rebuildWork.lanes++;
      if (this.doc.node(node)?.control !== 'auto') continue;
      const choice = this.advisor.choice(node);
      if (!choice) continue;
      const signalised = choice === 'signal';
      if (junction.signalised === signalised) continue;
      this.graph.junctions.set(node, { ...junction, signalised });
      this.staleJunctions([node]);
      this.noteSignal(node);
      changed = true;
    }
    return changed;
  }

  /** Stage 0's measuring of the junctions */
  stepControlAdvisor(dt: number): void {
    this.flow.step(dt);
    if (!this.advisor.tick(dt)) return;
    let changed = false;
    for (const [node, junction] of this.graph.junctions) {
      const n = this.doc.node(node);
      if (!n || n.control !== 'auto' || n.incident.length < 3) continue;
      const main = mainRoadLegs(this.doc, node);
      let major = 0, minorMax = 0, minorTotal = 0;
      for (const seg of n.incident) {
        const rate = this.flow.rate(node, seg);
        if (main?.includes(seg)) major += rate;
        else { minorMax = Math.max(minorMax, rate); minorTotal += rate; }
      }
      const initial: AutoControl = junction.signalised ? 'signal' : 'priority';
      changed = this.advisor.evaluate(node, major, minorMax, minorTotal, initial, this.flow.measured) || changed;
    }
    if (changed && this.applyAutoControl()) this.syncControllers();
  }

  /** The second half: the footway graph and its crossings, and the controllers again */
  rebuildWalkTopology(): void {
    if (this.vehicleTopologyRevision !== this.net.trafficRevision) this.rebuildVehicleTopology();
    // DO NOT build them, nor sync every controller, for the whole map on an edit: every road drawn made the town's again.
    const changes = this.topologyLog.since(this.walkSeen);
    this.walkSeen = this.topologyLog.state;
    let nodes: Set<NodeId> | null = null;
    if (changes) {
      nodes = new Set();
      for (const change of changes) for (const node of change.junctions) nodes.add(node);
    }
    this.sidewalks.update(this.doc, this.net, this.graph, changes);
    this.crossingSpans.update(this, nodes);
    this.syncControllers(nodes);
    this.topologyRevision = this.net.trafficRevision;
  }

  /** Crossing ids at a node, one per incident segment. */
  crossingsAt(node: NodeId): CrossingId[] {
    const n = this.doc.node(node);
    // A junction, or a mid-block crossing (a two-road node the player put one on)
    if (!n || (n.incident.length < 3 && !(n.crossing && n.incident.length === 2))) return [];
    return n.incident
      .slice()
      .sort((a, b) => a - b)
      .map((seg) => makeCrossingId(node, seg))
      .filter((id) => this.sidewalks.crossings.has(id));
  }

  /** What the signal controllers read about the world, for one pass over them. */
  signalDeps(): WorldSignalDeps {
    const kept = (this.keptSignalDeps ??= this.makeSignalDeps());
    kept.fresh();
    return kept.deps;
  }
  private keptSignalDeps: { readonly deps: WorldSignalDeps; readonly fresh: () => void } | null = null;

  private makeSignalDeps(): { readonly deps: WorldSignalDeps; readonly fresh: () => void } {
    // Kept by the node and the very arrays asked about
    const demands = new Map<NodeId, Map<readonly number[], Map<readonly string[] | undefined, { active: number; score: number }>>>();
    const demandOf = (node: NodeId, groups: readonly number[], movements?: readonly string[]) => {
      let byGroups = demands.get(node);
      if (!byGroups) demands.set(node, byGroups = new Map());
      let byMovements = byGroups.get(groups);
      if (!byMovements) byGroups.set(groups, byMovements = new Map());
      let value = byMovements.get(movements);
      if (!value) {
        value = this.signalDemand(node, groups, movements);
        byMovements.set(movements, value);
      }
      return value;
    };
    /** Signal groups some vehicle holding an allocation must acquire next, by node. */
    let reserved: Map<NodeId, Set<number>> | null = null;
    const reservedGroups = (): Map<NodeId, Set<number>> => {
      if (reserved) return reserved;
      reserved = new Map();
      for (const vehicle of this.junctionHolders()) {
        const lane = this.lanelet(vehicle.lanelet);
        const ownsAllocation =
          vehicle.admittedConnector !== null ||
          vehicle.clearingConnectors.length > 0 ||
          lane?.kind === 'connector';
        if (!ownsAllocation) continue;
        // A soft Banker's intent does not occupy its future junctions.
        const next = vehicle.reservedConnectors[0];
        if (!next) continue;
        const connector = this.connector(next);
        if (!connector) continue;
        let groups = reserved.get(connector.node);
        if (!groups) {
          groups = new Set();
          reserved.set(connector.node, groups);
        }
        groups.add(connector.group);
      }
      return reserved;
    };
    const deps: WorldSignalDeps = {
      tick: () => this.clock.tick,
      connectorsOf: (id: string) => this.graph.connectors.get(id),
      // Each stage's yellow is timed for the fastest approach it releases (ITE kinematic equation, `plan.ts` `withAmbers`).
      approachSpeed: (lane: string) => this.graph.lanelets.get(lane)?.speedLimit ?? 0,
      // Conflicts between two CARS.
      conflictsOf: (id: string) => this.conflicts.refs(id)
        .filter((ref) => this.conflicts.points[ref.point]?.zone(id, CAR_CLASS, CAR_CLASS))
        .map((ref) => ref.other),
      pedestriansCrossing: (_node, crossings) =>
        crossings.some((x) => (this.crossingStates.get(x)?.occupants.length ?? 0) > 0),
      demandOn: (node, groups, movements) => demandOf(node, groups, movements).score > 0,
      demand: (node, groups, movements) => demandOf(node, groups, movements),
      pedestrianWait: (_node, crossings) => {
        let longest = 0;
        for (const x of crossings) longest = Math.max(longest, this.crossingStates.get(x)?.longestWait ?? 0);
        return longest;
      },
      pedestrianDemandOn: (_node, crossings) => crossings.some((x) => this.crossingStates.get(x)?.demand ?? false),
      settings: (node) => this.doc.node(node)?.signal,
      busNear: (node, groups) => this.busNear(node, groups),
      quiet: (c) => this.doLess && this.junctionQuiet(c, reservedGroups),
      reserved: reservedGroups,
      reservationDemandOn: (node, groups) => {
        const here = reservedGroups().get(node);
        return !!here && groups.some((group) => here.has(group));
      },
    };
    return { deps, fresh: () => { demands.clear(); reserved = null; } };
  }

  /** What a green for these groups would actually serve right now. */
  signalDemand(node: NodeId, groups: readonly number[], movements?: readonly string[]): { active: number; score: number } {
    const junction = this.graph.junctions.get(node);
    let active = 0;
    let score = 0;
    for (const laneId of junction?.inbound ?? []) {
      // An empty approach serves nobody: read before its group is looked up.
      const order = this.runtime.get(laneId)?.order;
      if (!order?.length) continue;
      const lane = this.graph.lanelets.get(laneId);
      const segment = lane?.segment;
      if (!lane || segment === undefined) continue;
      const group = junction?.groups.find((g) => g.segments.includes(segment));
      if (!group || !groups.includes(group.id)) continue;
      for (let i = order.length - 1; i >= 0; i--) {
        const v = this.vehicles.get(order[i] as number);
        if (!v) continue;
        const d = lane.length - v.s;
        const arrival = d / Math.max(v.v, 0.5);
        if (d > DEMAND_QUEUE_REACH && arrival > DEMAND_HORIZON) break;
        const next = this.graph.connectors.get(v.route[1] ?? '');
        if (!next || next.fromLane !== laneId) continue;
        if (movements && !movements.includes(next.id)) continue;
        if (i === order.length - 1) {
          if (!hasDownstreamStorage(this, v, next)) break;
          if (d <= DEMAND_AT_LINE || arrival <= DEMAND_PASSAGE) active++;
        }
        score += v.v < 0.5 ? 1 + v.waited / DEMAND_WAIT_WEIGHT : Math.max(0, 1 - arrival / DEMAND_HORIZON);
      }
    }
    return { active, score };
  }

  /** Nobody near a signal's junction (`SignalDeps.quiet`): its approaches empty, nobody at its crossings, nothing reserved there. */
  private junctionQuiet(c: SignalController, reserved: () => ReadonlyMap<NodeId, ReadonlySet<number>>): boolean {
    const junction = this.graph.junctions.get(c.node);
    if (!junction) return false;
    for (const lane of junction.inbound) if ((this.runtime.get(lane)?.order.length ?? 0) > 0) return false;
    for (const stage of c.plan.stages) {
      for (const x of stage.pedWalk) {
        const at = this.crossingStates.get(x);
        if (at && (at.occupants.length > 0 || at.demand || at.waitingFrom > 0 || at.waitingTo > 0)) return false;
      }
    }
    return !reserved().has(c.node);
  }

  /** Whether a bus is on an approach of `node`, within reach of its line, bound for a movement of one of these signal groups */
  busNear(node: NodeId, groups: readonly number[]): boolean {
    for (const laneId of this.graph.junctions.get(node)?.inbound ?? []) {
      const order = this.runtime.get(laneId)?.order;
      if (!order?.length) continue;
      const lane = this.lanelet(laneId);
      if (!lane || lane.kind !== 'link' || lane.to !== node) continue;
      for (const id of order) {
        const v = this.vehicles.get(id);
        if (!v || v.archetype.shape !== 'bus' || lane.length - v.s > BUS_REACH) continue;
        const next = v.route[v.route.indexOf(v.lanelet) + 1];
        const conn = next ? this.connector(next) : undefined;
        if (conn && conn.node === node && groups.includes(conn.group)) return true;
      }
    }
    return false;
  }

  /** Ticks since the world began, the common clock of fixed-time signals (V5). */
  private tickCount(): number {
    return this.clock.tick;
  }

  /** DO NOT rebuild every controller here */
  private syncControllers(only: ReadonlySet<NodeId> | null = null): void {
    const deps = this.signalDeps();
    // The junctions an edit built again (`LaneletGraph.update`), or every one
    const asked = only ? [...only].map((node) => [node, this.graph.junctions.get(node)] as const).filter((e): e is readonly [NodeId, JunctionTopology] => e[1] !== undefined) : this.graph.junctions;
    for (const [node, junction] of asked) {
      const crossings = this.crossingsAt(node);
      const existing = this.controllers.get(node);
      const settings = this.doc.node(node)?.signal;
      const inputs = this.planInputsOf(junction, crossings, settings);
      if (existing) {
        const was = this.planInputs.get(node);
        if (was && samePlanInputs(was, inputs)) continue;
        rebuildWork.signals++;
        rebuildController(existing, junction, crossings, deps);
        this.noteSignal(node);
        // A fixed-time signal back where the common clock says, with its offset (V5).
        if (settings?.mode === 'fixed') seekFixed(existing, settings, this.tickCount() * DT);
      } else {
        rebuildWork.signals++;
        // A deterministic per-node offset so neighbouring junctions do not all switch together.
        const offset = (node * 7.317) % 60;
        const created = createController(junction, crossings, deps, offset);
        if (settings?.mode === 'fixed') seekFixed(created, settings, this.tickCount() * DT);
        this.controllers.set(node, created);
        this.noteSignal(node);
      }
      this.planInputs.set(node, inputs);
    }

    for (const node of only ? [...only] : [...this.controllers.keys()]) {
      if (this.controllers.has(node) && !this.graph.junctions.has(node)) {
        this.controllers.delete(node);
        this.planInputs.delete(node);
        this.noteSignal(node);
      }
    }
    this.staleJunctions(only);
  }

  /** What each controller's plan was made from (`syncControllers`). */
  private readonly planInputs = new Map<NodeId, PlanInputs>();

  /** What a junction's plan is made from (`signals/plan.ts` buildSignalPlan): its approach groups and connectors */
  private planInputsOf(junction: JunctionTopology, crossings: readonly CrossingId[], settings: SignalSettings | undefined): PlanInputs {
    return {
      groups: junction.groups,
      connectors: junction.connectors.map((id) => this.graph.connectors.get(id)),
      signalised: junction.signalised,
      crossings: crossings.join(','),
      settings: settingsKey(settings),
    };
  }

  // ----------------------------------------------------------- lane order

  /** Inserts a vehicle into a lanelet's occupancy list, keeping it sorted. */
  enterLanelet(v: Vehicle, id: LaneletId, recordVolume = true): void {
    const rt = this.runtimeFor(id);
    if (!rt.order.includes(v.id)) rt.order.push(v.id);
    this.occupied.add(id);
    this.sortLane(rt);
    v.lanelet = id;
    const lane = this.lanelet(id);
    if (lane?.kind === 'connector') this.noteHolder(v);
    // A vehicle entering a junction's movement: the flow from its leg (V5).
    if (recordVolume && lane?.kind === 'connector' && lane.node !== undefined) {
      const from = this.lanelet(lane.fromLane ?? '')?.segment;
      if (from !== undefined) this.flow.record(lane.node, from);
    }
    if (recordVolume && lane?.kind === 'link' && lane.segment !== undefined) {
      this.segmentVolume.set(lane.segment, (this.segmentVolume.get(lane.segment) ?? 0) + 1);
    }
  }

  exitLanelet(v: Vehicle, id: LaneletId): void {
    const rt = this.runtime.get(id);
    if (!rt) return;
    const i = rt.order.indexOf(v.id);
    if (i >= 0) rt.order.splice(i, 1);
    if (rt.order.length === 0) this.occupied.delete(id);
  }

  sortLane(rt: LaneletRuntime): void {
    rt.order.sort((a, b) => {
      const va = this.vehicles.get(a);
      const vb = this.vehicles.get(b);
      return (va?.s ?? 0) - (vb?.s ?? 0) || a - b;
    });
  }

  /** The vehicle nearest the exit of a lanelet, or undefined. */
  laneHead(id: LaneletId): Vehicle | undefined {
    const order = this.rt(id).order;
    const last = order[order.length - 1];
    return last === undefined ? undefined : this.vehicles.get(last);
  }

  /** The vehicle nearest the entry of a lanelet, or undefined. */
  laneTail(id: LaneletId): Vehicle | undefined {
    const first = this.rt(id).order[0];
    return first === undefined ? undefined : this.vehicles.get(first);
  }

  /** Registers a vehicle's body as still occupying the lane it is leaving. */
  addShadow(v: Vehicle, lanelet: LaneletId, offset: number, clearAt: number): void {
    this.clearShadow(v);
    v.shadow = { lanelet, offset, clearAt };
    const rt = this.runtimeFor(lanelet);
    if (!rt.shadows.includes(v.id)) rt.shadows.push(v.id);
  }

  clearShadow(v: Vehicle): void {
    if (!v.shadow) return;
    const rt = this.runtime.get(v.shadow.lanelet);
    if (rt) {
      const i = rt.shadows.indexOf(v.id);
      if (i >= 0) rt.shadows.splice(i, 1);
    }
    v.shadow = null;
  }

  /** Every body in a lane with its front arc position there */
  bodiesIn(id: LaneletId): { vehicle: Vehicle; s: number }[] {
    const rt = this.rt(id);
    const out: { vehicle: Vehicle; s: number }[] = [];
    for (const vid of rt.order) {
      const v = this.vehicles.get(vid);
      if (v) out.push({ vehicle: v, s: v.s });
    }
    for (const vid of rt.shadows) {
      const v = this.vehicles.get(vid);
      if (v?.shadow?.lanelet === id) out.push({ vehicle: v, s: v.s + v.shadow.offset });
    }
    const lane = this.lanelet(id);
    if (lane) {
      for (const next of this.graph.exitsOf(id)) {
        for (const vid of this.rt(next).order) {
          const v = this.vehicles.get(vid);
          if (v && v.rearPath[0] === id && v.s < v.archetype.length) {
            out.push({ vehicle: v, s: lane.length + v.s });
          }
        }
      }
    }
    return out;
  }

  removeVehicle(v: Vehicle): void {
    this.maybeHolders.delete(v);
    this.clearShadow(v);
    this.exitLanelet(v, v.lanelet);
    this.claims.releaseAll(v.id);
    this.vehicles.delete(v.id);
  }

  report(issue: AuditIssue): void {
    this.issues.push(issue);
    if (this.issues.length > 512) this.issues.shift();
  }
}

/** What a controller's plan was made from (`SimWorld.planInputsOf`). */
interface PlanInputs {
  readonly groups: JunctionTopology['groups'];
  readonly connectors: readonly (Connector | undefined)[];
  readonly signalised: boolean;
  readonly crossings: string;
  readonly settings: string;
}

/** The player's settings of a signal as one string, field by field (`SignalSettings`). */
function settingsKey(s: SignalSettings | undefined): string {
  if (!s) return '';
  return `${s.mode ?? '-'}|${s.greens?.join(',') ?? '-'}|${s.offset ?? '-'}|${s.busPriority ? 1 : 0}`;
}

function samePlanInputs(a: PlanInputs, b: PlanInputs): boolean {
  if (a.groups !== b.groups || a.signalised !== b.signalised || a.crossings !== b.crossings || a.settings !== b.settings) return false;
  if (a.connectors.length !== b.connectors.length) return false;
  for (let i = 0; i < a.connectors.length; i++) if (a.connectors[i] !== b.connectors[i]) return false;
  return true;
}

/** A Map that counts its changes of membership, for caches over it, and keeps its values in the order of their keys */
class VersionedMap<K extends number, V> extends Map<K, V> {
  version = 0;
  private orderedKeys: K[] = [];
  private ordered: V[] = [];
  /** The list was handed out: the next change copies it first. */
  private shared = false;

  override set(key: K, value: V): this {
    this.version++;
    const had = super.has(key);
    super.set(key, value);
    this.own();
    const keys = this.orderedKeys;
    const at = had ? slotOf(keys, key) : keys.length && keys[keys.length - 1]! >= key ? slotOf(keys, key) : keys.length;
    if (had) this.ordered[at] = value;
    else { keys.splice(at, 0, key); this.ordered.splice(at, 0, value); }
    return this;
  }
  override delete(key: K): boolean {
    this.version++;
    const had = super.delete(key);
    if (had) {
      this.own();
      const at = slotOf(this.orderedKeys, key);
      this.orderedKeys.splice(at, 1);
      this.ordered.splice(at, 1);
    }
    return had;
  }
  override clear(): void {
    this.version++;
    super.clear();
    this.orderedKeys = [];
    this.ordered = [];
    this.shared = false;
  }

  /** The values in the order of their keys; the array is never changed after it is handed out. */
  inKeyOrder(): readonly V[] {
    this.shared = true;
    return this.ordered;
  }

  private own(): void {
    if (!this.shared) return;
    this.orderedKeys = this.orderedKeys.slice();
    this.ordered = this.ordered.slice();
    this.shared = false;
  }
}

/** Where `key` is, or would go, in ascending `keys` (the first not below it). */
function slotOf<K extends number>(keys: readonly K[], key: K): number {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]! < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}
