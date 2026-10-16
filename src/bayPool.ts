import type { Bay } from '@sim/agents/bay';
import { type LotAsk, shareOf } from '@sim/agents/lotBays';
import type { BayWorkers } from '@sim/agents/parking';

/** THE LOTS' BAYS WORKED OUT ON THE OTHER CORES (`bays.worker.ts`). */
interface Lane {
  readonly worker: Worker;
  readonly waiting: Map<number, { resolve(answer: Bay[][]): void; reject(error: Error): void }>;
  /** When the worker last spoke, or was handed a job (`performance.now()`). */
  heard: number;
}

/** DO NOT wait without a deadline: a lot waiting on a hung worker kept its old bays for the page's life. */
const SILENCE_MS = 10_000;

/** Most workers the pool opens. */
const MOST_LANES = 4;

export class BayPool implements BayWorkers {
  private lanes: Lane[] | null = null;
  private broken = false;
  private nextId = 1;
  /** The lane the next ask starts on: a few lots asked at a time go round the workers. */
  private turn = 0;

  work(asks: readonly LotAsk[]): Promise<Bay[][]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    // Contiguous shares, one a lane: neighbouring lots read the same lanes and walls, copied once a share.
    const per = Math.ceil(asks.length / lanes.length);
    const parts: Promise<Bay[][]>[] = [];
    for (let k = 0; k * per < asks.length; k++) {
      const lane = lanes[(this.turn + k) % lanes.length]!;
      const share = shareOf(asks.slice(k * per, (k + 1) * per));
      const id = this.nextId++;
      parts.push(new Promise<Bay[][]>((resolve, reject) => {
        lane.waiting.set(id, { resolve, reject });
        lane.heard = performance.now();
        lane.worker.postMessage({ id, share });
      }));
    }
    this.turn = (this.turn + parts.length) % lanes.length;
    return Promise.all(parts).then((answers) => answers.flat());
  }

  check(now = performance.now()): void {
    for (const lane of this.lanes ?? []) {
      if (lane.waiting.size && now - lane.heard > SILENCE_MS) {
        this.fail(`a bays worker was silent for ${SILENCE_MS} ms with lots waiting`);
        return;
      }
    }
  }

  private start(): Lane[] | null {
    if (this.lanes || this.broken) return this.lanes;
    if (typeof Worker === 'undefined') { this.broken = true; return null; }
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const count = Math.max(1, Math.min(MOST_LANES, cores - 1));
    const lanes: Lane[] = [];
    try {
      for (let k = 0; k < count; k++) {
        const worker = new Worker(new URL('./bays.worker.ts', import.meta.url), { type: 'module' });
        const lane: Lane = { worker, waiting: new Map(), heard: performance.now() };
        worker.onmessage = (event: MessageEvent<{ id: number; beat?: true; bays?: Bay[][]; error?: string }>) => {
          if (this.lanes !== lanes) return;
          // Any word from the worker, a beat or an answer: it is alive.
          lane.heard = performance.now();
          const job = event.data.beat ? undefined : lane.waiting.get(event.data.id);
          if (!job) return;
          lane.waiting.delete(event.data.id);
          if (event.data.bays) job.resolve(event.data.bays);
          else job.reject(new Error(event.data.error ?? 'bays worker failed'));
        };
        worker.onerror = (event) => this.fail(`a bays worker failed: ${event.message}`);
        worker.onmessageerror = () => this.fail('a bays worker sent a message that cannot be read');
        lanes.push(lane);
      }
      this.lanes = lanes;
    } catch (error) {
      // The workers already made end too: a half-made pool is never used and would run on unreachable.
      for (const lane of lanes) lane.worker.terminate();
      console.warn('[parking] the bays workers are unavailable; the lots are worked out on the page', error);
      this.broken = true;
      this.lanes = null;
    }
    return this.lanes;
  }

  /** The pool fails: every job waiting on ANY of its workers is rejected */
  private fail(why: string): void {
    if (this.broken) return;
    console.warn(`[parking] ${why}; the lots are worked out on the page`);
    this.broken = true;
    this.end(new Error(why));
  }

  /** Ends the workers, every job still waiting rejected. */
  dispose(): void {
    this.broken = true;
    this.end(new Error('the bays pool was closed'));
  }

  private end(error: Error): void {
    for (const lane of this.lanes ?? []) {
      for (const job of lane.waiting.values()) job.reject(error);
      lane.waiting.clear();
      lane.worker.terminate();
    }
    this.lanes = null;
  }
}
