import type { NodeId, SegmentId } from '@world/ids';
import type { BodyPart, Severable } from './people/view';
import { strandVehicle, type VehicleId } from './vehicles/state';
import type { Network } from '@world/network';
import type { PairMeasurer } from '@world/conflictTable';
import type { AuditIssue } from './audit';
import { laneGrid } from './agents/laneGrid';
import { FrameWriter, type SimFrame } from './frame';
import { SimMirror } from './mirror';
import { DT, SIM_FRAME_BUDGET_MS } from './params';
import { rebindAgents, step } from './pipeline';
import { PopulationGovernor } from './populationGovernor';
import { TopologyCatchUp } from './topologyCatchUp';
import type { SignalSettings } from '@world/roads/rules';
import { type JunctionTraffic, type SegmentTraffic, junctionTraffic, segmentTraffic } from './inspect';
import { greenWave } from './roads/greenWave';
import type { SimWorld } from './world';

/** WHAT THE PAGE ASKS THE SIMULATION, wherever it runs: the inspector's numbers and the green wave */

/** The traffic of a road or a junction (`sim/inspect.ts`): null where it is gone, undefined while the answer is on its way. */
export interface SimInspect {
  segment(id: SegmentId): SegmentTraffic | null | undefined;
  junction(id: NodeId): JunctionTraffic | null | undefined;
  /** The signals of the corridor through a junction timed as a green wave (`roads/greenWave.ts`). */
  greenWave(node: NodeId): Promise<ReadonlyMap<NodeId, SignalSettings>>;
}

/** The simulation on the page itself answers at once. */
function pageInspect(w: SimWorld): SimInspect {
  return {
    segment: (id) => segmentTraffic(w, id),
    junction: (id) => junctionTraffic(w, id),
    greenWave: (node) => Promise.resolve(greenWave(w, node)),
  };
}

/** What the page does to the simulation, wherever it runs: the pistol, the bomb, the ragdolls getting up */
export interface SimControl {
  /** A shot on somebody in one part of the body, from (fromX, fromY) (`PedestrianEngine.shot`): the wound, null when nobody was hit. */
  shoot(id: number, part: BodyPart, fromX: number, fromY: number): Promise<{ readonly killed: boolean; readonly severed: Severable | null } | null>;
  /** A blow at (x, y) (`PedestrianEngine.impact`): how many it killed. */
  impact(x: number, y: number, kill: number, scare: number): Promise<number>;
  /** A vehicle taken off the roads (blown up, its rider shot off). */
  removeVehicle(id: VehicleId): void;
  /** Its driver shot dead at the wheel (`strandVehicle`). */
  strand(id: VehicleId): void;
  /** Somebody a ragdoll held up again (`PedestrianEngine.getUp`). */
  getUp(id: number, x: number, y: number, heading: number, seconds: number, crawl?: boolean): void;
}

/** The simulation on the page itself does it at once. */
function pageControl(w: SimWorld): SimControl {
  return {
    shoot: (id, part, fromX, fromY) => Promise.resolve(w.pedEngine.shot?.(w, id, part, fromX, fromY) ?? null),
    impact: (x, y, kill, scare) => Promise.resolve(w.pedEngine.impact?.(w, x, y, kill, scare) ?? 0),
    removeVehicle: (id) => { const v = w.vehicles.get(id); if (v) w.removeVehicle(v); },
    strand: (id) => { const v = w.vehicles.get(id); if (v) strandVehicle(v); },
    getUp: (id, x, y, heading, seconds, crawl) => w.pedEngine.getUp?.(w, id, x, y, heading, seconds, crawl),
  };
}

/** The settings the player gives the simulation. */
export interface SimSettings {
  readonly paused: boolean;
  readonly speed: number;
  readonly trafficIntensity: number;
  readonly pedestrianIntensity: number;
  readonly demandMultiplier: number;
}

/** What the frame loop tells the simulation (`SimHost.advance`). */
export interface SimAdvance {
  /** Wall seconds since the last frame. */
  readonly wall: number;
  /** Held this frame: a node being dragged, an edit not drawn yet, the town not shown yet. */
  readonly hold: boolean;
  /** The town being put together unseen (`SceneHandle.opening`), and the world of an edit still being built (`worldBusy`). */
  readonly opening: boolean;
  readonly worldBusy: boolean;
  /** Where the last frame drawn looked (`SceneHandle.focus`). */
  readonly focus: SimWorld['focus'];
  /** The share of the population the screen allows (`NARROW_SCREEN_SHARE`). */
  readonly screenShare: number;
}

/** THE SIMULATION AS THE PAGE HOLDS IT: on the page (`PageSimHost`) or in a worker (`simWorkerHost.ts`) */
export interface SimHost {
  /** What is drawn of it, brought up to its last ticks. */
  readonly shown: SimMirror;
  readonly inspect: SimInspect;
  readonly control: SimControl;
  readonly settings: SimSettings;
  set(patch: Partial<SimSettings>): void;
  /** Its clock, seconds, and the city's minutes, as last drawn. */
  readonly time: number;
  readonly minutes: number;
  /** The share of the next tick the frame stands at (`SimClock.advance`), for the poses' blend. */
  readonly alpha: number;
  /** Runs the wall time of a frame, the document's changes taken in first; true while the traffic catches up with an edit (held). */
  advance(frame: SimAdvance): boolean;
  /** Whether the traffic is behind the network's traffic plan (the page then draws an edit before it catches up). */
  behind(trafficRevision: number): boolean;
  /** The traffic's topology rebuilt now, at once (a node drag dropped). */
  settle(): void;
  /** A different map: nothing of the old simulation carries over. */
  reset(): void;
  /** The simulation's own checks (`sim/invariants.ts`) so far. */
  issues(): readonly AuditIssue[];
  /** The measured cost of a tick, ms, and the share of the population kept (`PopulationGovernor`). */
  health(): { readonly stepMs: number; readonly share: number };
  /** The junctions' conflict zones kept from earlier sessions (`ConflictIndex.seed`), and those measured since the last call, to keep. */
  seedZones(kept: ReadonlyMap<string, Float64Array | null>): void;
  takeMeasured(): ReadonlyMap<string, Float64Array | null>;
  /** Probes: `seconds` of simulation at once, or one tick. */
  run(seconds: number): void;
  step(traffic: boolean, pedestrians: boolean): void;
  /** The world itself where it runs on the page (probes), null in a worker. */
  readonly world: SimWorld | null;
}

/** How a runner spends a frame: the most a frame's ticks may take, ms, and the cost of a tick the population is thinned past and filled again under. */
export interface RunnerBudget {
  readonly frameMs: number;
  readonly highMs: number;
  readonly lowMs: number;
}

/** On the page the drawing shares the frame (`SIM_FRAME_BUDGET_MS`, `PopulationGovernor`'s own thresholds). */
const PAGE_BUDGET: RunnerBudget = { frameMs: SIM_FRAME_BUDGET_MS, highMs: 6.5, lowMs: 3.5 };

/** The simulation run frame by frame where it lives (the page, or the worker `sim.worker.ts`): its topology, derived products and clock. */
export class SimRunner {
  alpha = 1;
  private readonly frames = new FrameWriter();
  private readonly topology: TopologyCatchUp;
  private readonly governor: PopulationGovernor;

  constructor(readonly world: SimWorld, private readonly net: Network, measurer: PairMeasurer, private readonly budget: RunnerBudget) {
    this.topology = new TopologyCatchUp(measurer);
    this.governor = new PopulationGovernor(1, budget.highMs, budget.lowMs);
    // How many cars and people the panel asks for: they come in at the ends of the roads (`sim/ambient` source 'edges').
    world.followCity = true;
  }

  get settings(): SimSettings {
    const w = this.world;
    return { paused: w.clock.paused, speed: w.clock.speed, trafficIntensity: w.trafficIntensity, pedestrianIntensity: w.pedestrianIntensity, demandMultiplier: w.demandMultiplier };
  }

  set(patch: Partial<SimSettings>): void {
    const w = this.world;
    if (patch.paused !== undefined) w.clock.paused = patch.paused;
    if (patch.speed !== undefined) w.clock.speed = patch.speed;
    if (patch.trafficIntensity !== undefined) w.trafficIntensity = patch.trafficIntensity;
    if (patch.pedestrianIntensity !== undefined) w.pedestrianIntensity = patch.pedestrianIntensity;
    if (patch.demandMultiplier !== undefined) w.demandMultiplier = patch.demandMultiplier;
  }

  /** The frame's wall time run; true when held (the traffic catching up with an edit). */
  advance(frame: SimAdvance): boolean {
    const w = this.world;
    w.focus = frame.focus;
    this.governor.setMax(frame.screenShare);
    let hold = frame.hold;
    // The traffic's topology catching up with an edit, the simulation held while the workers measure the new junctions' pairs
    if ((!hold || frame.opening) && this.topology.step(w, this.net.trafficRevision, frame.worldBusy)) hold = true;
    if (!hold) {
      // The simulation's products derived from the roads, brought up to the topology.
      w.walkwaysNow();
      laneGrid(w);
    }
    this.alpha = hold ? 1
      : w.clock.advance(frame.wall, () => step(w, { traffic: !w.clock.paused, pedestrians: !w.clock.paused }), this.budget.frameMs);
    if (!hold) w.populationShare = this.governor.feed(w.clock.lastSteps, w.clock.lastStepMs, performance.now() / 1000, w.vehicles.size, w.pedViews.length);
    return hold;
  }

  /** The page's frame of the world now (`sim/frame.ts`). */
  frame(): SimFrame {
    return this.frames.write(this.world);
  }

  behind(trafficRevision: number): boolean {
    return this.world.topologyRevision !== trafficRevision;
  }

  settle(): void {
    if (!this.behind(this.net.trafficRevision)) return;
    this.world.rebuildTopology();
    rebindAgents(this.world);
  }

  reset(): void {
    this.world.reset();
    this.world.ambient.reset(this.world);
    this.frames.reset();
  }

  health(): { readonly stepMs: number; readonly share: number } { return { stepMs: this.governor.stepMs, share: this.governor.share }; }

  run(seconds: number): void {
    this.world.clock.run(Math.max(0, Math.round(seconds / DT)), () => step(this.world, { traffic: true, pedestrians: true }));
  }

  step(traffic: boolean, pedestrians: boolean): void {
    step(this.world, { traffic, pedestrians });
  }
}

/** The simulation on the page: stepped in the frame, its derived products and its topology brought up there too. */
export class PageSimHost implements SimHost {
  readonly shown = new SimMirror();
  readonly inspect: SimInspect;
  readonly control: SimControl;
  readonly world: SimWorld;
  private readonly runner: SimRunner;

  constructor(net: Network, w: SimWorld, measurer: PairMeasurer, settings: SimSettings) {
    this.world = w;
    this.inspect = pageInspect(w);
    this.control = pageControl(w);
    this.runner = new SimRunner(w, net, measurer, PAGE_BUDGET);
    this.runner.set(settings);
  }

  get settings(): SimSettings { return this.runner.settings; }
  set(patch: Partial<SimSettings>): void { this.runner.set(patch); }
  get time(): number { return this.world.clock.time; }
  get minutes(): number { return this.world.city.minutes(this.world); }
  get alpha(): number { return this.runner.alpha; }

  advance(frame: SimAdvance): boolean {
    const hold = this.runner.advance(frame);
    this.shown.take(this.runner.frame());
    return hold;
  }

  behind(trafficRevision: number): boolean { return this.runner.behind(trafficRevision); }
  settle(): void { this.runner.settle(); }
  reset(): void { this.runner.reset(); }
  issues(): readonly AuditIssue[] { return this.world.issues; }
  health(): { readonly stepMs: number; readonly share: number } { return this.runner.health(); }
  seedZones(kept: ReadonlyMap<string, Float64Array | null>): void { this.world.conflicts.seed(kept); }
  takeMeasured(): ReadonlyMap<string, Float64Array | null> { return this.world.conflicts.takeMeasured(); }

  run(seconds: number): void {
    this.runner.run(seconds);
    this.shown.take(this.runner.frame());
  }

  step(traffic: boolean, pedestrians: boolean): void {
    this.runner.step(traffic, pedestrians);
    this.shown.take(this.runner.frame());
  }
}
