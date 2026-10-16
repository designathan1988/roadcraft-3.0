import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SweepSamples } from '@world/conflictTable';
import { ConflictPool, SILENCE_MS } from '@/conflictPool';

/** The conflict pool never waits on a worker without a deadline */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly asked: { id: number }[] = [];
  terminated = false;
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: { id: number }): void { this.asked.push(message); }
  terminate(): void { this.terminated = true; }
  say(data: unknown): void { this.onmessage?.({ data }); }
}

const sweep = (): SweepSamples => ({ c0: 0, count: 1, length: 1, frame: new Float64Array(4), frameLengthSq: new Float64Array(1), bounds: null, boxes: null, range: null } as unknown as SweepSamples);

describe('the conflict pool', () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects the pairs of a worker that stays silent, and ends its workers', async () => {
    const pool = new ConflictPool();
    const answer = pool.measure([{ a: sweep(), b: sweep() }]);
    const settled = answer.then(() => 'answered', () => 'rejected');
    await vi.advanceTimersByTimeAsync(SILENCE_MS + 1);
    expect(await Promise.race([settled, Promise.resolve('still waiting')])).toBe('rejected');
    expect(FakeWorker.made.every((w) => w.terminated)).toBe(true);
  });

  it('waits past the deadline for a worker that keeps reporting as it works', async () => {
    const pool = new ConflictPool();
    const answer = pool.measure([{ a: sweep(), b: sweep() }]);
    const worker = FakeWorker.made[0]!;
    const id = worker.asked[0]!.id;
    for (let k = 0; k < 4; k++) {
      await vi.advanceTimersByTimeAsync(SILENCE_MS / 2);
      worker.say({ id, beat: true });
    }
    worker.say({ id, tables: [null] });
    await expect(answer).resolves.toEqual([null]);
    expect(worker.terminated).toBe(false);
    pool.dispose();
  });

  it('ends the workers it already made when a later one cannot be made', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    class SecondFails extends FakeWorker {
      constructor() {
        super();
        if (FakeWorker.made.length === 2) throw new Error('no more workers');
      }
    }
    vi.stubGlobal('Worker', SecondFails);
    const pool = new ConflictPool();
    await expect(pool.measure([{ a: sweep(), b: sweep() }])).rejects.toThrow('no workers');
    expect(FakeWorker.made.length).toBe(2);
    expect(FakeWorker.made[0]!.terminated).toBe(true);
  });
});
