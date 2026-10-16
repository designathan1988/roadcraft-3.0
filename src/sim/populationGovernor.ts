/** THE POPULATION THE MACHINE SUSTAINS (CLAUDE.md: "no fixed population cap: the limit is what the machine sustains"). */
import { FLEET_CEILING, PED_CEILING } from './params';

/** Each change multiplies or divides the share by this. */
const STEP = 0.85;
/** The thinnest the town is made. */
const MIN_SHARE = 0.3;
/** Seconds after a change before the next, while its effect shows. */
const HOLD_S = 3;
/** The measure's memory: an exponential mean over about this many steps. */
const SMOOTHING = 60;

export class PopulationGovernor {
  private mean = 0;
  private samples = 0;
  private changedAt = -Infinity;
  private shareNow: number;

  /** `max`: the device's own share, the most the town is ever given; a step costing more than `highMs` (ms, averaged) thins the town, less than `lowMs` lets it fill again. */
  constructor(private max: number, private readonly highMs = 6.5, private readonly lowMs = 3.5) {
    this.shareNow = max;
  }

  /** The share in use. */
  get share(): number {
    return this.shareNow;
  }

  /** The averaged cost of a step, ms (0 before any). */
  get stepMs(): number {
    return this.mean;
  }

  /** The device's share changed (the screen narrowed or widened). */
  setMax(max: number): void {
    this.max = max;
    if (this.shareNow > max) this.shareNow = max;
  }

  /** `steps` steps ran this frame at `msPerStep` each, at wall time `seconds`, with `vehicles` and `people` in the town. */
  feed(steps: number, msPerStep: number, seconds: number, vehicles: number, people: number): number {
    if (steps <= 0 || !Number.isFinite(msPerStep)) return this.shareNow;
    for (let i = 0; i < steps; i++) {
      this.samples++;
      const k = 1 / Math.min(this.samples, SMOOTHING);
      this.mean += (msPerStep - this.mean) * k;
    }
    if (this.samples < SMOOTHING || seconds - this.changedAt < HOLD_S) return this.shareNow;
    // The last cut has shown: the town is within the ceilings it set.
    const settled = vehicles <= FLEET_CEILING * this.shareNow && people <= PED_CEILING * this.shareNow;
    let next = this.shareNow;
    if (this.mean > this.highMs && settled) next = Math.max(MIN_SHARE, this.shareNow * STEP);
    else if (this.mean < this.lowMs) next = Math.min(this.max, this.shareNow / STEP);
    if (next !== this.shareNow) {
      this.shareNow = next;
      this.changedAt = seconds;
    }
    return this.shareNow;
  }
}
