import type { NodeId, SegmentId } from '@world/ids';
import { ROAD_TUNING } from '@world/roads/tuning';

/** DO NOT age every leg ever seen every second */
const TAU = ROAD_TUNING.flow.trendWindow / 3;
/** What a second with nothing counted leaves of a rate. */
const KEEP = 1 - 1 / TAU;

/** A leg's rate as it stood at the end of second `at`. */
interface Rate { rate: number; at: number }

export class FlowStats {
  private readonly counts = new Map<NodeId, Map<SegmentId, number>>();
  private readonly rates = new Map<NodeId, Map<SegmentId, Rate>>();
  private carry = 0;
  /** Seconds aged so far: the clock the rates are kept against. */
  private second = 0;
  /** Seconds of traffic measured since the town was laid out (a trend needs `trendWindow`). */
  measured = 0;

  record(node: NodeId, from: SegmentId): void {
    this.counted.add(node);
    let legs = this.counts.get(node);
    if (!legs) this.counts.set(node, legs = new Map());
    legs.set(from, (legs.get(from) ?? 0) + 1);
  }

  step(dt: number): void {
    this.carry += dt;
    this.measured += dt;
    while (this.carry >= 1) {
      this.carry -= 1;
      this.second++;
      // The legs counted this second: aged up to it, the count taken in.
      for (const [node, counted] of this.counts) {
        let legs = this.rates.get(node);
        if (!legs) this.rates.set(node, legs = new Map());
        for (const [seg, n] of counted) {
          const known = legs.get(seg);
          if (!known) { legs.set(seg, { rate: (n * 3600) / TAU, at: this.second }); continue; }
          const aged = agedTo(known, this.second - 1);
          known.rate = aged + (n * 3600 - aged) / TAU;
          known.at = this.second;
        }
      }
      this.counts.clear();
    }
  }

  /** The junctions counted at since this was last asked: those whose rates went up (`ControlAdvisor.watch`). */
  takeCounted(): Set<NodeId> {
    const out = this.counted;
    this.counted = new Set();
    return out;
  }
  private counted = new Set<NodeId>();

  /** Vehicles an hour entering `node` from `seg`, as a trend. */
  rate(node: NodeId, seg: SegmentId): number {
    const known = this.rates.get(node)?.get(seg);
    return known ? agedTo(known, this.second) : 0;
  }

  /** Forgets what a removed junction measured. */
  keepOnly(nodes: ReadonlySet<NodeId>): void {
    for (const node of [...this.rates.keys()]) if (!nodes.has(node)) this.rates.delete(node);
  }

  /** These junctions' flows forgotten (gone with an edit). */
  drop(nodes: ReadonlySet<NodeId>): void {
    for (const node of nodes) this.rates.delete(node);
  }
}

/** A rate brought up to the end of `second`: a factor `KEEP` for each second since it was kept, none counted. */
function agedTo(r: Rate, second: number): number {
  const quiet = second - r.at;
  return quiet <= 0 ? r.rate : r.rate * Math.pow(KEEP, quiet);
}
