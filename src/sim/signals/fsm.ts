import type { NodeId } from '@world/ids';
import type { Connector, JunctionTopology } from '@world/lanelets';
import { DT, SIGNAL } from '../params';
import { EPS } from '@core/scalar';
import type { SignalSettings } from '@world/roads/rules';
import {
  type CrossingId,
  type GroupId,
  type SignalPlan,
  PlanValidationError,
  buildSignalPlan,
  roundRobinPlan,
} from './plan';

type SubPhase = 'GREEN' | 'AMBER' | 'ALL_RED';

/** Per-junction signal state. */
export interface SignalController {
  readonly node: NodeId;
  plan: SignalPlan;
  stageIndex: number;
  sub: SubPhase;
  /** Seconds spent in the current sub-phase. */
  elapsed: number;
  /** Resting in green since a pass of stage 1 (`restController`): its seconds are counted on from it when read; null awake. */
  rest?: SignalRest | null;
  /** Tick at which each group last received green. */
  lastServed: Map<GroupId, number>;
  /** Tick at which each stage last ended its green. */
  stageServed: Map<number, number>;
  /** Coordination offset ALREADY APPLIED, in seconds. */
  readonly offsetApplied: number;
  /** Set when a plan failed validation and a fallback was substituted. */
  degraded: boolean;
}

export interface SignalDeps {
  readonly tick: () => number;
  readonly connectorsOf: (id: string) => Connector | undefined;
  /** The speed limit of an approach lane, u/s: what each stage's yellow is timed for (`plan.ts` `withAmbers`). */
  readonly approachSpeed?: (lane: string) => number;
  /** Movements that physically conflict with a connector (swept zones). */
  readonly conflictsOf?: (id: string) => readonly string[];
  /** Pedestrians still inside a crossing that this stage released. */
  readonly pedestriansCrossing: (node: NodeId, crossings: readonly CrossingId[]) => boolean;
  /** Whether any vehicle is waiting on the given groups (and movements). */
  readonly demandOn: (node: NodeId, groups: readonly GroupId[], movements?: readonly string[]) => boolean;
  /** Weighted demand; see `SimWorld.signalDemand`. */
  readonly demand?: (node: NodeId, groups: readonly GroupId[], movements?: readonly string[]) => { active: number; score: number };
  /** Longest time anybody has waited at a kerb for one of these crossings, seconds. */
  readonly pedestrianWait?: (node: NodeId, crossings: readonly CrossingId[]) => number;
  /** Whether a pedestrian is waiting to start one of these crossings. */
  readonly pedestrianDemandOn: (node: NodeId, crossings: readonly CrossingId[]) => boolean;
  /** Whether a physical compact-box holder needs this group next. */
  readonly reservationDemandOn: (node: NodeId, groups: readonly GroupId[]) => boolean;
  /** The player's settings of a junction's signal: fixed time, greens, offset, bus priority. */
  readonly settings?: (node: NodeId) => SignalSettings | undefined;
  /** Whether a bus is coming to the line of one of these groups, close enough to be served (V5). */
  readonly busNear?: (node: NodeId, groups: readonly GroupId[]) => boolean;
  /** Doing less (`SimWorld.doLess`): nobody near the junction */
  readonly quiet?: (c: SignalController) => boolean;
}

/** The passes of stage 1 a world has made: what a resting controller's seconds are counted on by (`restController`). */
export interface RestClock { passes: number }
interface SignalRest { readonly clock: RestClock; readonly since: number }

/** How long a green is held past its maximum for a bus about to reach the line (green extension), seconds */
const BUS_EXTENSION = 10;

/** Greens that rested with nobody near (`SignalDeps.quiet`): a count for the tests and the budgets. */
export const signalWork = { rested: 0 };

export function createController(
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  deps: SignalDeps,
  offset: number,
): SignalController {
  const { plan, degraded } = safePlan(junction, crossings, deps);
  const phase = seekPhase(plan, offset);
  const c = {
    node: junction.node,
    plan,
    stageIndex: phase.stageIndex,
    sub: phase.sub,
    /** The seconds as of its last step, or as of the pass it began to rest on (`rest`). */
    seconds: phase.elapsed,
    rest: null as SignalRest | null,
    // DO NOT add DT to a resting controller each tick: every signal of the map was visited each tick to keep its time.
    get elapsed(): number { return this.rest ? addRepeated(this.seconds, DT, this.rest.clock.passes - this.rest.since) : this.seconds; },
    set elapsed(value: number) { this.seconds = value; this.rest = null; },
    lastServed: new Map(plan.groups.map((g) => [g, deps.tick()])),
    stageServed: new Map(plan.stages.map((_, i) => [i, deps.tick()])),
    // Neighbouring junctions start out of phase so platoons do not all stop together.
    offsetApplied: offset,
    degraded,
  };
  return c;
}

/** `x` after `n` float additions of `step`, bit for bit as `x += step` n times, in a few operations per binade */
export function addRepeated(x: number, step: number, n: number): number {
  while (n > 0) {
    // Below 1, or for a step that is not positive, an addition's rounding may hang on x's own last bit: one at a time.
    if (!(x >= 1) || !(step > 0)) { x += step; n--; continue; }
    let top = 2 ** Math.floor(Math.log2(x));
    if (top > x) top /= 2;
    else if (top * 2 <= x) top *= 2;
    top *= 2;
    // A step falling half way between two floats of the binade rounds to the even one: one at a time.
    const r = step / (top * 2 ** -53);
    const inc = (x + step) - x;
    const k = Math.min(n, Math.floor((top - x) / inc) - 2);
    if (k <= 1 || r - Math.floor(r) === 0.5) { x += step; n--; continue; }
    // Within the binade every addition adds the same `inc`, exactly.
    x += k * inc;
    n -= k;
  }
  return x;
}

/** Where in its own cycle a plan sits `seconds` after the start of stage 0. */
function seekPhase(
  plan: SignalPlan,
  seconds: number,
): { stageIndex: number; sub: SubPhase; elapsed: number } {
  const total = plan.stages.reduce(
    (sum, s) => sum + s.targetGreen + s.amber + s.allRed,
    0,
  );
  if (!(total > 0) || !Number.isFinite(seconds) || seconds <= 0) {
    return { stageIndex: 0, sub: 'GREEN', elapsed: 0 };
  }

  let left = seconds % total;
  for (let index = 0; index < plan.stages.length; index++) {
    const stage = plan.stages[index];
    if (!stage) break;
    for (const [sub, span] of [
      ['GREEN', stage.targetGreen],
      ['AMBER', stage.amber],
      ['ALL_RED', stage.allRed],
    ] as const) {
      if (left < span) return { stageIndex: index, sub, elapsed: left };
      left -= span;
    }
  }
  return { stageIndex: 0, sub: 'GREEN', elapsed: 0 };
}

function safePlan(
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  deps: SignalDeps,
): { plan: SignalPlan; degraded: boolean } {
  try {
    return { plan: buildSignalPlan(junction, crossings, deps.connectorsOf, deps.conflictsOf, deps.approachSpeed), degraded: false };
  } catch (err) {
    if (!(err instanceof PlanValidationError)) throw err;
    if (isStrict()) throw err;
    // Never leave a group dark: fall back to plain round-robin coverage.
    return {
      plan: roundRobinPlan(
        junction.groups.map((g) => g.id),
        crossings,
      ),
      degraded: true,
    };
  }
}

const isStrict = (): boolean =>
  typeof process !== 'undefined' && process.env?.['SIM_STRICT'] === '1';

/** A controller asleep from this pass of stage 1 on (`SimWorld.signalsToStep`): its seconds go on by `clock`, without a step a tick. */
export function restController(c: SignalController, clock: RestClock): void {
  if (!c.rest) c.rest = { clock, since: clock.passes };
}

/** A resting controller's seconds brought up to the pass before this one, and it stepped again from now on. */
export function wakeController(c: SignalController): void {
  if (!c.rest) return;
  const seconds = c.elapsed;
  c.elapsed = seconds;
}

/** Longest a green is held past its maximum for people still on its crossings, seconds. */
const PED_HOLD_LIMIT = 30;

/** One tick of a controller. */
export function stepController(c: SignalController, deps: SignalDeps): boolean {
  c.elapsed += DT;
  const st = c.plan.stages[c.stageIndex];
  if (!st) {
    c.stageIndex = 0;
    return false;
  }

  switch (c.sub) {
    case 'GREEN': {
      // Nobody near: a green that is neither fixed-time nor held for buses rests in it
      if (deps.quiet?.(c) && !deps.pedestriansCrossing(c.node, st.pedWalk)) {
        const resting = deps.settings?.(c.node);
        if (resting?.mode !== 'fixed' && !resting?.busPriority) { signalWork.rested++; return true; }
      }
      // Bounded: see `PED_HOLD_LIMIT`.
      const pedestriansInside = c.elapsed < st.maxGreen + PED_HOLD_LIMIT &&
        deps.pedestriansCrossing(c.node, st.pedWalk);
      const mayEnd = c.elapsed >= st.minGreen && !pedestriansInside;
      const settings = deps.settings?.(c.node);
      // A fixed-time signal (V5): each stage its own green, every cycle, in order.
      if (settings?.mode === 'fixed') {
        const target = settings.greens?.[c.stageIndex] ?? st.targetGreen;
        if (c.elapsed >= target && (!pedestriansInside || c.elapsed >= target + PED_HOLD_LIMIT)) {
          for (const g of st.greenGroups) c.lastServed.set(g, deps.tick());
          c.stageServed.set(c.stageIndex, deps.tick());
          c.sub = 'AMBER';
          c.elapsed = 0;
        }
        break;
      }
      // Bus priority (V5): the green held for a bus about to reach the line...
      if (settings?.busPriority && deps.busNear?.(c.node, st.greenGroups) && c.elapsed < st.maxGreen + BUS_EXTENSION) break;
      // ...and cut short, after its minimum, for a bus waiting on another stage.
      if (settings?.busPriority && mayEnd && c.plan.stages.some((other, i) => i !== c.stageIndex && other.greenGroups.length &&
        deps.busNear?.(c.node, other.greenGroups))) {
        for (const g of st.greenGroups) c.lastServed.set(g, deps.tick());
        c.stageServed.set(c.stageIndex, deps.tick());
        c.sub = 'AMBER';
        c.elapsed = 0;
        break;
      }
      // Before its minimum and short of its maximum a green cannot end whatever the demand: nothing below is asked
      if (!mayEnd && c.elapsed < st.maxGreen) break;
      const competingDemand = c.plan.stages.some(
        (candidate, index) => index !== c.stageIndex && stageHasDemand(c, candidate, deps),
      );
      const reservedElsewhere = mayEnd && c.plan.groups.some(
        (group) =>
          !st.greenGroups.includes(group) &&
          deps.reservationDemandOn(c.node, [group]),
      );
      // A physical compact-box holder can depend on the next signal to release its rear from the previous junction.
      const currentDemand = (): boolean => deps.reservationDemandOn(c.node, st.greenGroups) || (deps.demand
        ? deps.demand(c.node, st.greenGroups, st.demandMovements).active > 0
        : deps.demandOn(c.node, st.greenGroups));
      // An actuated junction rests in green when nobody else asks for the right of way.
      const gapOut = mayEnd && competingDemand && !currentDemand();
      const yieldAtTarget = mayEnd && competingDemand && c.elapsed >= st.targetGreen;
      if (gapOut || (mayEnd && reservedElsewhere) || yieldAtTarget) {
        for (const g of st.greenGroups) c.lastServed.set(g, deps.tick());
        c.stageServed.set(c.stageIndex, deps.tick());
        c.sub = 'AMBER';
        c.elapsed = 0;
      } else if (c.elapsed >= st.maxGreen && !pedestriansInside &&
        (competingDemand || (c.elapsed >= st.maxGreen + PED_HOLD_LIMIT && deps.pedestriansCrossing(c.node, st.pedWalk)))) {
        c.stageServed.set(c.stageIndex, deps.tick());
        // Never cut a green over people still on its crossings.
        for (const g of st.greenGroups) c.lastServed.set(g, deps.tick());
        c.sub = 'AMBER';
        c.elapsed = 0;
      }
      break;
    }
    case 'AMBER':
      if (c.elapsed >= st.amber) {
        c.sub = 'ALL_RED';
        c.elapsed = 0;
      }
      break;
    case 'ALL_RED':
      // Clearance is purely time based.
      if (c.elapsed >= st.allRed) {
        const settings = deps.settings?.(c.node);
        const bus = settings?.busPriority
          ? c.plan.stages.findIndex((other, i) => i !== c.stageIndex && other.greenGroups.length > 0 && !!deps.busNear?.(c.node, other.greenGroups))
          : -1;
        c.stageIndex = settings?.mode === 'fixed' ? (c.stageIndex + 1) % Math.max(1, c.plan.stages.length)
          : bus >= 0 ? bus : pickNextStage(c, deps);
        c.sub = 'GREEN';
        c.elapsed = 0;
      }
      break;
  }
  return false;
}

/** Chooses the next stage without skipping any vehicle or pedestrian service. */
function pickNextStage(c: SignalController, deps: SignalDeps): number {
  const stages = c.plan.stages;
  if (stages.length <= 1) return 0;
  const sequential = (c.stageIndex + 1) % stages.length;
  const now = deps.tick();
  // `lastServed` is recorded in simulation ticks, not seconds.
  const deadline = (c.plan.cycle * SIGNAL.starvationCycles) / DT;

  let overdue = -1;
  let overdueAge = -Infinity;
  let demanded = -1;
  let demandedAge = -Infinity;

  for (let index = 0; index < stages.length; index++) {
    // Do not immediately reopen the phase that just completed its clearance.
    if (index === c.stageIndex) continue;
    const stage = stages[index]!;
    const hasDemand = stageHasDemand(c, stage, deps);
    // Age weighted by what is waiting
    const waited = stage.demandMovements
      ? now - (c.stageServed.get(index) ?? now)
      : stageAge(c, stage.greenGroups, now);
    const age = waited * (1 + stageScore(c, stage, deps) / DEMAND_PRIORITY);

    // An overdue stage wins among live calls
    if (stage.greenGroups.length && waited >= deadline && hasDemand &&
      betterCandidate(index, age, overdue, overdueAge, sequential, stages.length)) {
      overdue = index;
      overdueAge = age;
    }
    if (hasDemand && betterCandidate(index, age, demanded, demandedAge, sequential, stages.length)) {
      demanded = index;
      demandedAge = age;
    }
  }

  if (overdue >= 0) return overdue;

  // Somebody who has stood at a kerb for PED_WAIT_LIMIT is served next, ahead of vehicle demand
  let walkers = -1;
  let longest = PED_WAIT_LIMIT;
  for (let index = 0; index < stages.length; index++) {
    if (index === c.stageIndex) continue;
    const wait = deps.pedestrianWait?.(c.node, stages[index]!.pedWalk) ?? 0;
    if (wait >= longest) {
      longest = wait;
      walkers = index;
    }
  }
  if (walkers >= 0) return walkers;
  return demanded >= 0 ? demanded : sequential;
}

/** Kerb wait after which a crossing's stage is served next, seconds. */
const PED_WAIT_LIMIT = 45;

/** Queued vehicles that double a stage's claim to run next. */
const DEMAND_PRIORITY = 6;

function stageHasDemand(c: SignalController, stage: SignalPlan['stages'][number], deps: SignalDeps): boolean {
  if (stage.demandMovements) {
    return deps.demandOn(c.node, stage.greenGroups, stage.demandMovements);
  }
  return deps.reservationDemandOn(c.node, stage.greenGroups) ||
    deps.demandOn(c.node, stage.greenGroups) ||
    deps.pedestrianDemandOn(c.node, stage.pedWalk);
}

function stageScore(c: SignalController, stage: SignalPlan['stages'][number], deps: SignalDeps): number {
  return deps.demand?.(c.node, stage.greenGroups, stage.demandMovements).score ?? 0;
}

function stageAge(c: SignalController, groups: readonly GroupId[], now: number): number {
  if (!groups.length) return 0;
  return Math.max(...groups.map((group) => now - (c.lastServed.get(group) ?? now)));
}

/** Oldest wait wins; circular order breaks exact ties deterministically. */
function betterCandidate(
  index: number,
  age: number,
  current: number,
  currentAge: number,
  sequential: number,
  count: number,
): boolean {
  if (current < 0 || age > currentAge + EPS) return true;
  if (age < currentAge - EPS) return false;
  return circularDistance(index, sequential, count) < circularDistance(current, sequential, count);
}

const circularDistance = (index: number, start: number, count: number): number =>
  (index - start + count) % count;

/** Rebuilds a controller's plan after the network changed, carrying state over. */
export function rebuildController(
  c: SignalController,
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  deps: SignalDeps,
): void {
  const wasGreen = new Set(currentGreenGroups(c));
  const { plan, degraded } = safePlan(junction, crossings, deps);

  let best = 0;
  let bestScore = -1;
  plan.stages.forEach((s, i) => {
    const score = s.greenGroups.filter((g) => wasGreen.has(g)).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });

  c.plan = plan;
  c.degraded = degraded;
  c.stageIndex = best;

  if (bestScore > 0 && c.sub === 'GREEN') {
    c.elapsed = Math.min(c.elapsed, plan.stages[best]?.maxGreen ?? SIGNAL.maxGreen);
  } else {
    // What was green no longer exists, or we were mid-transition.
    c.sub = 'ALL_RED';
    c.elapsed = 0;
  }

  const now = deps.tick();
  for (const g of plan.groups) {
    if (!c.lastServed.has(g)) c.lastServed.set(g, now);
  }
  c.stageServed = new Map(plan.stages.map((_, i) => [i, now]));
  for (const g of [...c.lastServed.keys()]) {
    if (!plan.groups.includes(g)) c.lastServed.delete(g);
  }
}

function currentGreenGroups(c: SignalController): readonly GroupId[] {
  if (c.sub !== 'GREEN') return [];
  return c.plan.stages[c.stageIndex]?.greenGroups ?? [];
}

/** A fixed-time plan's cycle with the player's greens, seconds (V5). */
export function fixedCycle(plan: SignalPlan, settings: SignalSettings | undefined): number {
  return plan.stages.reduce((sum, s, i) => sum + (settings?.greens?.[i] ?? s.targetGreen) + s.amber + s.allRed, 0);
}

/** Puts a fixed-time signal where its cycle stands at `seconds` of the common clock plus its offset */
export function seekFixed(c: SignalController, settings: SignalSettings, seconds: number): void {
  const total = fixedCycle(c.plan, settings);
  if (!(total > 0)) return;
  let left = (((seconds - (settings.offset ?? 0)) % total) + total) % total;
  for (let index = 0; index < c.plan.stages.length; index++) {
    const stage = c.plan.stages[index]!;
    for (const [sub, span] of [
      ['GREEN', settings.greens?.[index] ?? stage.targetGreen],
      ['AMBER', stage.amber],
      ['ALL_RED', stage.allRed],
    ] as const) {
      if (left < span) { c.stageIndex = index; c.sub = sub; c.elapsed = left; return; }
      left -= span;
    }
  }
}
