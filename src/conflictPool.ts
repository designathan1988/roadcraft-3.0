import { type FinishAsk, type FinishedPair, type PairMeasurer, type SampledSweep, type SweepAsk, type SweepSamples, TABLE_SIZE } from '@world/conflictTable';
import type { ChosenTurn, SurfaceRings, TurnAsk } from '@world/junctionTurns';
import type { CornerAsk } from '@world/walkingLines';
import type { JunctionAnswer, JunctionAsk } from '@world/junctionBuild';

/** THE TRAFFIC'S CONFLICT PAIRS, MEASURED ON THE OTHER CORES. */
interface Lane {
  readonly worker: Worker;
  readonly waiting: Map<number, { resolve(answer: unknown[]): void; reject(error: Error): void }>;
  /** Fails the pool when the worker stays silent with jobs waiting (`SILENCE_MS`). */
  watchdog: ReturnType<typeof setTimeout> | null;
}

/** DO NOT wait without a deadline: the topology catch-up yields WAITING until the answer comes */
export const SILENCE_MS = 10_000;

/** Most workers the pool opens: past four, a city's pairs are done before the copies are. */
const MOST_LANES = 4;

export class ConflictPool implements PairMeasurer {
  /** `keepPrefix`: the key prefix the tables are kept under for the next session */
  constructor(private readonly keepPrefix: string | null = null) {}

  get keeps(): boolean {
    return this.keepPrefix !== null;
  }

  private lanes: Lane[] | null = null;
  private broken = false;
  private nextId = 1;

  measure(pairs: readonly { readonly a: SweepSamples; readonly b: SweepSamples; readonly key?: string }[]): Promise<readonly (Float64Array | null)[]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    // Contiguous shares, one a lane, each with only the sweeps its pairs read.
    const per = Math.ceil(pairs.length / lanes.length);
    const parts: Promise<(Float64Array | null)[]>[] = [];
    for (let k = 0; k < lanes.length && k * per < pairs.length; k++) {
      const share = pairs.slice(k * per, (k + 1) * per);
      const index = new Map<SweepSamples, number>();
      const sweeps: { c0: number; count: number; length: number; frame: Float64Array; frameLengthSq: Float64Array }[] = [];
      const at = (s: SweepSamples): number => {
        let i = index.get(s);
        if (i === undefined) {
          i = sweeps.length;
          index.set(s, i);
          sweeps.push({ c0: s.c0, count: s.count, length: s.length, frame: s.frame, frameLengthSq: s.frameLengthSq });
        }
        return i;
      };
      const indices = new Int32Array(share.length * 2);
      share.forEach((p, q) => { indices[q * 2] = at(p.a); indices[q * 2 + 1] = at(p.b); });
      const keep = this.keepPrefix !== null ? { prefix: this.keepPrefix, keys: share.map((p) => p.key ?? '') } : null;
      parts.push(this.ask(lanes[k]!, sweeps, indices, keep));
    }
    return Promise.all(parts).then((answers) => answers.flat());
  }

  private ask(lane: Lane, sweeps: readonly object[], pairs: Int32Array, keep: { prefix: string; keys: readonly string[] } | null): Promise<(Float64Array | null)[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      lane.waiting.set(id, { resolve: (answer) => resolve(answer as (Float64Array | null)[]), reject });
      // The samples are copied (the page keeps its own); the indices handed over.
      lane.worker.postMessage({ kind: 'pairs', id, sweeps, pairs, keep }, [pairs.buffer]);
      this.arm(lane);
    });
  }

  /** Junction turns chosen across the workers (`conflictTable.worker.ts`, `chooseTurnOf`) */
  chooseTurns(asks: readonly TurnAsk[], rings: ReadonlyMap<string, SurfaceRings>): Promise<readonly ChosenTurn[]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    const per = Math.ceil(asks.length / lanes.length);
    const parts: Promise<ChosenTurn[]>[] = [];
    for (let k = 0; k < lanes.length && k * per < asks.length; k++) {
      const share = asks.slice(k * per, (k + 1) * per);
      const index = new Map<string, number>();
      const surfaces: { centre: { x: number; y: number }; rings: readonly Float64Array[]; key: string }[] = [];
      const turns = share.map((a) => {
        let at = index.get(a.surfaceKey);
        if (at === undefined) {
          at = surfaces.length;
          index.set(a.surfaceKey, at);
          const r = rings.get(a.surfaceKey)!;
          surfaces.push({ centre: r.centre, rings: r.rings, key: a.surfaceKey });
        }
        return { surface: at, inXY: a.inXY, outXY: a.outXY, waiting: a.waiting, fromRoadEnd: a.fromRoadEnd, toRoadEnd: a.toRoadEnd };
      });
      const lane = lanes[k]!;
      const id = this.nextId++;
      parts.push(new Promise<ChosenTurn[]>((resolve, reject) => {
        lane.waiting.set(id, { resolve: (answer) => resolve(answer as ChosenTurn[]), reject });
        lane.worker.postMessage({ kind: 'turns', id, surfaces, turns });
        this.arm(lane);
      }));
    }
    return Promise.all(parts).then((answers) => answers.flat());
  }

  /** Movements' sweeps sampled across the workers (`conflictTable.worker.ts`, `sampleSweep`) */
  sampleSweeps(asks: readonly SweepAsk[]): Promise<readonly SampledSweep[]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    const per = Math.ceil(asks.length / lanes.length);
    const parts: Promise<SampledSweep[]>[] = [];
    for (let k = 0; k < lanes.length && k * per < asks.length; k++) {
      const share = asks.slice(k * per, (k + 1) * per);
      const index = new Map<Float64Array, number>();
      const lines: Float64Array[] = [];
      const at = (xy: Float64Array): number => {
        let i = index.get(xy);
        if (i === undefined) { i = lines.length; index.set(xy, i); lines.push(xy); }
        return i;
      };
      const refs = new Int32Array(share.length * 3);
      const c0 = new Float64Array(share.length), count = new Int32Array(share.length);
      share.forEach((a, q) => {
        refs[q * 3] = at(a.inXY); refs[q * 3 + 1] = at(a.crossXY); refs[q * 3 + 2] = at(a.outXY);
        c0[q] = a.c0; count[q] = a.count;
      });
      const lane = lanes[k]!;
      const id = this.nextId++;
      parts.push(new Promise<SampledSweep[]>((resolve, reject) => {
        lane.waiting.set(id, { resolve: (answer) => resolve(answer as SampledSweep[]), reject });
        // The lanes' points are copied (the page keeps its own); the indices and the numbers handed over.
        lane.worker.postMessage({ kind: 'sweeps', id, lines, refs, c0, count }, [refs.buffer, c0.buffer, count.buffer]);
        this.arm(lane);
      }));
    }
    return Promise.all(parts).then((answers) => answers.flat());
  }

  /** Pairs finished across the workers (`conflictTable.worker.ts`, `finishPair`) */
  finishPairs(pairs: readonly FinishAsk[]): Promise<readonly FinishedPair[]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    const per = Math.ceil(pairs.length / lanes.length);
    const parts: Promise<FinishedPair[]>[] = [];
    for (let k = 0; k < lanes.length && k * per < pairs.length; k++) {
      const share = pairs.slice(k * per, (k + 1) * per);
      const index = new Map<Float64Array, number>();
      const lines: Float64Array[] = [];
      const at = (xy: Float64Array): number => {
        let i = index.get(xy);
        if (i === undefined) { i = lines.length; index.set(xy, i); lines.push(xy); }
        return i;
      };
      const refs = new Int32Array(share.length * 2);
      const tables = new Float64Array(share.length * TABLE_SIZE);
      share.forEach((p, q) => { refs[q * 2] = at(p.a); refs[q * 2 + 1] = at(p.b); tables.set(p.table, q * TABLE_SIZE); });
      const lane = lanes[k]!;
      const id = this.nextId++;
      parts.push(new Promise<FinishedPair[]>((resolve, reject) => {
        lane.waiting.set(id, { resolve: (answer) => resolve(answer as FinishedPair[]), reject });
        lane.worker.postMessage({ kind: 'finish', id, lines, refs, tables }, [refs.buffer, tables.buffer]);
        this.arm(lane);
      }));
    }
    return Promise.all(parts).then((answers) => answers.flat());
  }

  /** A whole build's junctions built across the workers (`conflictTable.worker.ts`, `buildJunctionOf`) */
  buildJunctions(asks: readonly JunctionAsk[]): Promise<readonly JunctionAnswer[]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    const per = Math.ceil(asks.length / lanes.length);
    const parts: Promise<JunctionAnswer[]>[] = [];
    for (let k = 0; k < lanes.length && k * per < asks.length; k++) {
      const share = asks.slice(k * per, (k + 1) * per);
      const lane = lanes[k]!;
      const id = this.nextId++;
      parts.push(new Promise<JunctionAnswer[]>((resolve, reject) => {
        lane.waiting.set(id, { resolve: (answer) => resolve(answer as JunctionAnswer[]), reject });
        lane.worker.postMessage({ kind: 'junctions', id, asks: share });
        this.arm(lane);
      }));
    }
    return Promise.all(parts).then((answers) => answers.flat());
  }

  /** Walkways' corners rounded across the workers (`conflictTable.worker.ts`, `roundCorners`) */
  roundCorners(asks: readonly CornerAsk[]): Promise<readonly (readonly (Float64Array | null)[])[]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    const per = Math.ceil(asks.length / lanes.length);
    const parts: Promise<(Float64Array | null)[][]>[] = [];
    for (let k = 0; k < lanes.length && k * per < asks.length; k++) {
      const share = asks.slice(k * per, (k + 1) * per);
      const lane = lanes[k]!;
      const id = this.nextId++;
      parts.push(new Promise<(Float64Array | null)[][]>((resolve, reject) => {
        lane.waiting.set(id, { resolve: (answer) => resolve(answer as (Float64Array | null)[][]), reject });
        lane.worker.postMessage({ kind: 'corners', id, asks: share });
        this.arm(lane);
      }));
    }
    return Promise.all(parts).then((answers) => answers.flat());
  }

  /** The lane's silence deadline started again, or stopped when nothing waits on it. */
  private arm(lane: Lane): void {
    if (lane.watchdog !== null) clearTimeout(lane.watchdog);
    lane.watchdog = lane.waiting.size
      ? setTimeout(() => this.fail(`a conflict worker was silent for ${SILENCE_MS} ms with pairs waiting`), SILENCE_MS)
      : null;
  }

  private start(): Lane[] | null {
    if (this.lanes || this.broken) return this.lanes;
    if (typeof Worker === 'undefined') { this.broken = true; return null; }
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const count = Math.max(1, Math.min(MOST_LANES, cores - 1));
    const lanes: Lane[] = [];
    try {
      for (let k = 0; k < count; k++) {
        const worker = new Worker(new URL('./conflictTable.worker.ts', import.meta.url), { type: 'module' });
        const lane: Lane = { worker, waiting: new Map(), watchdog: null };
        worker.onmessage = (event: MessageEvent<{ id: number; beat?: true; tables?: (Float64Array | null)[]; turns?: ChosenTurn[]; sweeps?: SampledSweep[]; finished?: FinishedPair[]; corners?: (Float64Array | null)[][]; junctions?: JunctionAnswer[]; error?: string }>) => {
          if (this.lanes !== lanes) return;
          const job = event.data.beat ? undefined : lane.waiting.get(event.data.id);
          if (job) lane.waiting.delete(event.data.id);
          // Any word from the worker, a beat or an answer: it is alive.
          this.arm(lane);
          if (!job) return;
          if (event.data.tables) job.resolve(event.data.tables);
          else if (event.data.turns) job.resolve(event.data.turns);
          else if (event.data.sweeps) job.resolve(event.data.sweeps);
          else if (event.data.finished) job.resolve(event.data.finished);
          else if (event.data.corners) job.resolve(event.data.corners);
          else if (event.data.junctions) job.resolve(event.data.junctions);
          else job.reject(new Error(event.data.error ?? 'conflict worker failed'));
        };
        // A worker that cannot run, or a message it cannot read: the pool is done (`fail`).
        worker.onerror = (event) => this.fail(`a conflict worker failed: ${event.message}`);
        worker.onmessageerror = () => this.fail('a conflict worker sent a message that cannot be read');
        lanes.push(lane);
      }
      this.lanes = lanes;
    } catch (error) {
      // The workers already made end too: a half-made pool is never used and would run on unreachable.
      for (const lane of lanes) lane.worker.terminate();
      console.warn('[traffic] the conflict workers are unavailable; the pairs are measured on the page', error);
      this.broken = true;
      this.lanes = null;
    }
    return this.lanes;
  }

  /** DO NOT end only the lane that failed */
  private fail(why: string): void {
    if (this.broken) return;
    console.warn(`[traffic] ${why}; the pairs are measured on the page`);
    this.broken = true;
    this.end(new Error(why));
  }

  /** Ends the workers, every job still waiting rejected (`fail`; the page going away). */
  dispose(): void {
    this.broken = true;
    this.end(new Error('the conflict pool was closed'));
  }

  private end(error: Error): void {
    for (const lane of this.lanes ?? []) {
      if (lane.watchdog !== null) clearTimeout(lane.watchdog);
      lane.watchdog = null;
      for (const job of lane.waiting.values()) job.reject(error);
      lane.waiting.clear();
      lane.worker.terminate();
    }
    this.lanes = null;
  }
}
