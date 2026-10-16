import type { GroundAt } from '@world/buildings/foundation';
import type { Finish } from '@world/buildings/materials';
import type { PavingSource } from '@world/paving';
import { m } from '@world/units';
import { BATCH_CELL } from './layerCells';
import type { KitBoxes } from './cellArrays';
import { type CellEntry, type CellJob, type CellResult, CellWork, GROUND, type JobKind, NATURAL, PAVED, type WorkReply } from './cellWork';

/** THE PAGE'S SIDE OF THE CELLS PUT TOGETHER IN WORKERS (`cellWork.ts`, `cell.worker.ts`) */

/** What a job reads on the page: the ground as drawn and as it was, and the paving (with `pack`: read by the worker itself). */
export interface CellEnv {
  readonly groundAt: GroundAt;
  readonly naturalAt: GroundAt;
  readonly pavedAt?: PavingSource;
}

/** How far past its cell a job's buildings read the paving off the roads handed to its worker (`PavingData`) */
const PAVING_REACH = m(64);

/** The rectangle a cell's worker reads the paving in: the cell (`BATCH_CELL`, key "x,y") and `PAVING_REACH` round it. */
function pavingRect(cell: string): [number, number, number, number] | null {
  const [cx, cy] = cell.split(',').map(Number) as [number, number];
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  return [cx * BATCH_CELL - PAVING_REACH, cy * BATCH_CELL - PAVING_REACH, (cx + 1) * BATCH_CELL + PAVING_REACH, (cy + 1) * BATCH_CELL + PAVING_REACH];
}

/** Its message is written when it is handed to a worker (`job()`), not when asked */
interface Running { readonly id: number; readonly job: (worker: boolean) => { readonly job: CellJob; readonly transfer: ArrayBuffer[] }; readonly env: CellEnv; readonly done: (result: CellResult) => void; readonly lane: Lane | null; readonly rank: number }

/** A worker, the jobs it is working on, and those waiting their turn, in the order asked. */
interface Lane { readonly worker: Worker; readonly jobs: Map<number, Running>; readonly queue: Running[] }

/** Most workers the pool opens. */
const MOST_LANES = 4;
/** DO NOT post every job at once: a worker reads its messages in order */
const ACTIVE_PER_LANE = 1;
/** Which jobs a lane begins first (lower first). */
const PRIORITY: Readonly<Record<JobKind, number>> = { cell: 0, mass: 1, summary: 2 };

export class CellPool {
  private lanes: Lane[] | null = null;
  private broken = false;
  private local: CellWork | null = null;
  private nextId = 1;
  /** Begun jobs whose results nobody wants any more (`supersede`). */
  private readonly abandoned = new Set<number>();

  /** `workers`: false does every job on the page (tests). `tone`: each finish's colour from afar, for the masses (`kit.ts`). */
  /** `text`: an entry's record, taken when asked, written as text for the job's message when it is sent (the page keeps none). */
  constructor(private readonly boxes: () => KitBoxes, private readonly text: (entry: CellEntry) => () => string, private readonly workers = true,
    private readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>) {}

  /** Jobs handed out or waiting their turn, not done yet. */
  get running(): number {
    let n = 0;
    for (const lane of this.lanes ?? []) n += lane.jobs.size + lane.queue.length;
    return n;
  }

  /** A cell's job: its batches ('cell'), its masses ('mass') or its buildings' summaries */
  run(kind: JobKind, cell: string, entries: readonly CellEntry[], env: CellEnv, done: (result: CellResult) => void): number {
    // Each record taken now and written as text for this job's message alone, when it is sent (`CellJobEntry`).
    const id = this.nextId++;
    const writers = entries.map((e) => this.text(e));
    const paved = env.pavedAt !== undefined;
    // DO NOT ask the page for each point of the paving: a 2,560 m city's cells asked it 2.3 s of the page's time
    const job = (worker: boolean): { job: CellJob; transfer: ArrayBuffer[] } => {
      const base = { id, kind, cell, entries: entries.map((e, i) => ({ ...e, record: writers[i]!() })), paved };
      const rect = worker && paved && env.pavedAt?.pack ? pavingRect(cell) : null;
      const packed = rect ? env.pavedAt!.pack!(rect) : null;
      return packed ? { job: { ...base, paving: packed.data }, transfer: packed.transfer } : { job: base, transfer: [] };
    };
    const lanes = this.start();
    const lane = lanes ? lanes[laneOf(cell, lanes.length)]! : null;
    // A building the player cut open goes first: what the click asked for (`layer.ts` `entryFor`).
    const rank = entries.some((e) => e.key.includes('|')) ? -1 : PRIORITY[kind];
    const running: Running = { id, job, env, done, lane, rank };
    if (!lane) { this.onPage(running); return id; }
    lane.queue.push(running);
    this.pump(lane);
    return id;
  }

  /** DO NOT take them only in the order asked */
  private pump(lane: Lane): void {
    while (lane.jobs.size < ACTIVE_PER_LANE && lane.queue.length) {
      let at = 0;
      for (let i = 1; i < lane.queue.length && lane.queue[at]!.rank > -1; i++) if (lane.queue[i]!.rank < lane.queue[at]!.rank) at = i;
      const next = lane.queue.splice(at, 1)[0]!;
      lane.jobs.set(next.id, next);
      const { job, transfer } = next.job(true);
      lane.worker.postMessage({ type: 'start', job }, transfer);
    }
  }

  /** The workers made now, ahead of the first job */
  warm(): void {
    this.start();
  }

  /** DO NOT only mark it: the worker went through every round of a cell nobody wanted, and the cells behind it waited. */
  cancel(id: number): void {
    for (const lane of this.lanes ?? []) {
      const waiting = lane.queue.findIndex((r) => r.id === id);
      if (waiting >= 0) { lane.queue.splice(waiting, 1); return; }
      if (lane.jobs.delete(id)) {
        this.abandoned.delete(id);
        lane.worker.postMessage({ type: 'cancel', job: id });
        this.pump(lane);
        return;
      }
    }
  }

  /** A job a newer one for its cell replaces: dropped, waiting or begun (`cancel`). */
  supersede(id: number): void {
    this.cancel(id);
  }

  /** Whether a job is still waiting or being worked on (one done on the page never is). */
  isRunning(id: number): boolean {
    return (this.lanes ?? []).some((lane) => lane.jobs.has(id) || lane.queue.some((r) => r.id === id));
  }

  dispose(): void {
    for (const lane of this.lanes ?? []) lane.worker.terminate();
    this.lanes = null;
    this.local = null;
  }

  /** The job done here, every round answered at once. */
  private onPage(running: Running): void {
    this.local ??= new CellWork(this.boxes(), this.tone);
    const work = this.local;
    let reply = work.start(running.job(false).job);
    while (reply.kind !== 'done') reply = work.readings(reply.job, readingsOf(reply.points, running.env));
    this.finish(running, reply.result);
  }

  private finish(running: Running, result: CellResult): void {
    running.done(result);
  }

  private start(): Lane[] | null {
    if (this.lanes || this.broken || !this.workers) return this.lanes;
    if (typeof Worker === 'undefined') { this.broken = true; return null; }
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const count = Math.max(1, Math.min(MOST_LANES, cores - 1));
    const lanes: Lane[] = [];
    try {
      const boxes = this.boxes();
      for (let k = 0; k < count; k++) {
        const worker = new Worker(new URL('./cell.worker.ts', import.meta.url), { type: 'module' });
        const lane: Lane = { worker, jobs: new Map(), queue: [] };
        worker.onmessage = (event: MessageEvent<WorkReply | { kind: 'error'; job: number; message: string }>) => this.answer(lane, event.data);
        worker.onerror = (event) => {
          // A worker that cannot run: its jobs, and every one from now on, are done on the page.
          console.warn('[buildings] the cell workers failed; cells are put together on the page', event.message);
          this.giveUp();
        };
        worker.postMessage({ type: 'init', boxes, tone: this.tone });
        lanes.push(lane);
      }
      this.lanes = lanes;
    } catch (error) {
      // The workers already made end too: a half-made pool is never used and would run on unreachable.
      for (const lane of lanes) lane.worker.terminate();
      console.warn('[buildings] no cell workers; cells are put together on the page', error);
      this.broken = true;
    }
    return this.lanes;
  }

  /** A worker's reply: the readings or slots it asks answered, or its result handed on. */
  private answer(lane: Lane, reply: WorkReply | { kind: 'error'; job: number; message: string }): void {
    const running = lane.jobs.get(reply.job);
    if (!running) return;
    if (this.abandoned.has(reply.job) && (reply.kind === 'error' || reply.kind === 'done')) {
      this.abandoned.delete(reply.job);
      lane.jobs.delete(reply.job);
      this.pump(lane);
      return;
    }
    if (reply.kind === 'error') {
      console.warn('[buildings] a cell worker failed on a cell; put together on the page', reply.message);
      lane.jobs.delete(reply.job);
      this.onPage({ ...running, lane: null });
      this.pump(lane);
      return;
    }
    if (reply.kind === 'done') {
      lane.jobs.delete(reply.job);
      this.finish(running, reply.result);
      this.pump(lane);
      return;
    }
    // The readings answered on the page, the buffer handed back (MDN, transfer).
    const values = readingsOf(reply.points, running.env);
    lane.worker.postMessage({ type: 'readings', job: reply.job, values }, [values.buffer]);
  }

  private giveUp(): void {
    const waiting = (this.lanes ?? []).flatMap((lane) => [...lane.jobs.values(), ...lane.queue]);
    this.broken = true;
    this.dispose();
    for (const running of waiting) this.onPage({ ...running, lane: null });
  }
}

/** A cell's worker: the same one each time, by a hash of its key. */
function laneOf(cell: string, lanes: number): number {
  let h = 0;
  for (let i = 0; i < cell.length; i++) h = (h * 31 + cell.charCodeAt(i)) | 0;
  return Math.abs(h) % lanes;
}

/** The page's readings of kind, x, y threes. */
function readingsOf(points: Float64Array, env: CellEnv): Float64Array {
  const out = new Float64Array(points.length / 3);
  for (let i = 0, at = 0; i < points.length; i += 3, at++) {
    const kind = points[i]!, x = points[i + 1]!, y = points[i + 2]!;
    out[at] = kind === GROUND ? env.groundAt(x, y) : kind === NATURAL ? env.naturalAt(x, y) : kind === PAVED ? env.pavedAt!(x, y) : NaN;
  }
  return out;
}
