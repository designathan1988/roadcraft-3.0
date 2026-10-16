import type { NodeId } from '@world/ids';
import { ROAD_TUNING } from '@world/roads/tuning';

/** THE CONTROL A JUNCTION LEFT ON "AUTOMATIC" GETS: chosen from the measured trend of its flows */
export type AutoControl = 'signal' | 'stop' | 'priority';

const F = ROAD_TUNING.flow;

/** The control a junction's flows warrant, given what it has now (hysteresis). */
export function warrantedControl(major: number, minorMax: number, minorTotal: number, current: AutoControl): AutoControl {
  const k = (step: AutoControl): number => (rank(current) >= rank(step) ? F.stepDown : 1);
  const signal = (major >= F.signalMajor * k('signal') && minorMax >= F.signalMinor * k('signal')) ||
    (major >= F.signalMajorB * k('signal') && minorMax >= F.signalMinorB * k('signal'));
  if (signal) return 'signal';
  const stop = major >= F.stopMajor * k('stop') && minorTotal >= F.stopMinor * k('stop');
  return stop ? 'stop' : 'priority';
}

const rank = (c: AutoControl): number => (c === 'signal' ? 2 : c === 'stop' ? 1 : 0);

export class ControlAdvisor {
  readonly choices = new Map<NodeId, AutoControl>();
  private readonly changedAt = new Map<NodeId, number>();
  /** Seconds between evaluations. */
  static readonly EVERY = 10;
  private since = 0;

  /** The control chosen for `node`, or undefined before the advisor has spoken (the game's geometric default holds). */
  choice(node: NodeId): AutoControl | undefined {
    return this.choices.get(node);
  }

  /** Whether it is time to evaluate again. */
  tick(dt: number): boolean {
    this.since += dt;
    if (this.since < ControlAdvisor.EVERY) return false;
    this.since = 0;
    return true;
  }

  /** One junction's evaluation; returns true when its choice changed. */
  evaluate(node: NodeId, major: number, minorMax: number, minorTotal: number, initial: AutoControl, now: number): boolean {
    const current = this.choices.get(node) ?? initial;
    if (!this.choices.has(node)) this.choices.set(node, initial);
    if (now < F.trendWindow) return false;
    if (now - (this.changedAt.get(node) ?? -Infinity) < F.trendWindow) return false;
    const next = warrantedControl(major, minorMax, minorTotal, current);
    if (next === current) return false;
    this.choices.set(node, next);
    this.changedAt.set(node, now);
    return true;
  }

  forget(nodes: ReadonlySet<NodeId>): void {
    for (const node of [...this.choices.keys()]) if (!nodes.has(node)) { this.choices.delete(node); this.changedAt.delete(node); }
    this.watched = null;
    this.due.clear();
  }

  /** These junctions' choices forgotten (gone with an edit). */
  drop(nodes: ReadonlySet<NodeId>): void {
    for (const node of nodes) { this.choices.delete(node); this.changedAt.delete(node); this.watched?.delete(node); }
  }

  /** DO NOT evaluate every junction of the map every 10 s */
  private watched: Set<NodeId> | null = null;

  /** A junction to evaluate again: traffic counted at it, or an edit built it again. */
  watch(node: NodeId): void {
    this.watched?.add(node);
  }

  /** The junctions out of the evaluations until their trend window ends, by that time (`waits`): a list per evaluation at most. */
  private readonly due = new Map<number, NodeId[]>();

  /** The junctions to evaluate at `now`, in no set order; `all`: the town's, read when every one is asked. */
  asked(now: number, all: () => Iterable<NodeId>): NodeId[] {
    this.watched ??= new Set(all());
    for (const [time, nodes] of this.due) {
      if (time > now) continue;
      for (const node of nodes) this.watched.add(node);
      this.due.delete(time);
    }
    return [...this.watched];
  }

  /** Whether a junction's window keeps any evaluation from changing it now: seen (`evaluate`), and left out until the window ends. */
  waits(node: NodeId, initial: AutoControl, now: number): boolean {
    if (!this.choices.has(node)) this.choices.set(node, initial);
    const due = Math.max(F.trendWindow, (this.changedAt.get(node) ?? -Infinity) + F.trendWindow);
    if (now >= due) return false;
    this.watched?.delete(node);
    const list = this.due.get(due);
    if (list) list.push(node); else this.due.set(due, [node]);
    return true;
  }

  /** A junction left out of the evaluations until it is watched again (not on "automatic", gone). */
  unwatch(node: NodeId): void {
    this.watched?.delete(node);
  }

  /** Out of the evaluations if, evaluated past its window and settled on 'priority', no evaluation can change it */
  settle(node: NodeId): void {
    if (this.choices.get(node) === 'priority') this.watched?.delete(node);
  }
}
