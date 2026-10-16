import type { ReliefVersion } from '@world/terrain';
import type { PlateMesh } from './plateMesh';

/** THE MAP'S LAND, WORKED OUT OFF THE PAGE. */

interface Job {
  readonly key: number;
  readonly relief: ReliefVersion;
  /** Where the job lies, for its order (the nearest the view first): world x, y. */
  readonly at: { readonly x: number; readonly y: number };
  readonly cx: number;
  readonly cy: number;
  readonly half: number;
  readonly cell: number;
  readonly side: number;
  /** The terrain's base level, added to the land in the mesh (`TERRAIN_BASE`). */
  readonly base: number;
  readonly done: (mesh: PlateMesh) => void;
  readonly failed: () => void;
}
interface Lane { readonly worker: Worker; busy: (Job & { id: number }) | null }

const LANES = 2;
let lanes: Lane[] | null = null;
let broken = false;
const queue: Job[] = [];
let nextId = 1;
let focusX = 0, focusY = 0;

function start(): Lane[] | null {
  if (lanes || broken) return lanes;
  if (typeof Worker === 'undefined') { broken = true; return null; }
  try {
    lanes = [];
    for (let k = 0; k < LANES; k++) {
      const worker = new Worker(new URL('./flatGround.worker.ts', import.meta.url), { type: 'module' });
      const lane: Lane = { worker, busy: null };
      worker.onmessage = (event: MessageEvent<{ id: number; mesh?: PlateMesh; error?: string }>) => {
        const job = lane.busy;
        lane.busy = null;
        if (job && job.id === event.data.id) {
          if (event.data.mesh) job.done(event.data.mesh);
          else { console.warn('[terrain] a plate of the land failed in its worker', event.data.error); job.failed(); }
        }
        pump();
      };
      worker.onerror = (event) => {
        console.warn('[terrain] a land worker failed', event.message);
        const job = lane.busy;
        lane.busy = null;
        job?.failed();
        pump();
      };
      lanes.push(lane);
    }
  } catch (error) {
    // The workers already made end too: a half-made pool is never used and would run on unreachable.
    for (const lane of lanes ?? []) lane.worker.terminate();
    console.warn('[terrain] the land workers are unavailable; the land is read on the page', error);
    broken = true;
    lanes = null;
  }
  return lanes;
}

function pump(): void {
  if (!lanes) return;
  for (const lane of lanes) {
    if (lane.busy || !queue.length) continue;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const j = queue[i]!, d = (j.at.x - focusX) ** 2 + (j.at.y - focusY) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    const job = queue.splice(best, 1)[0]!;
    lane.busy = { ...job, id: nextId++ };
    lane.worker.postMessage({ id: lane.busy.id, relief: job.relief, cx: job.cx, cy: job.cy, half: job.half, cell: job.cell, side: job.side, base: job.base });
  }
}

/** Whether the land can be read off the page here (a browser with workers). */
export function flatGroundOffPage(): boolean {
  return start() !== null;
}

/** Reads plate `key`'s corners in a worker, and builds its first mesh from them (`plateMesh.ts`): `done` with it */
export function readFlatGround(job: Job): void {
  if (!start()) { job.failed(); return; }
  const queued = queue.findIndex((j) => j.key === job.key);
  if (queued >= 0) queue[queued] = job; else queue.push(job);
  pump();
}

/** Drops plate `key` from the queue (no longer wanted); a job already running finishes. */
export function cancelFlatGround(key: number): void {
  const queued = queue.findIndex((j) => j.key === key);
  if (queued >= 0) queue.splice(queued, 1);
}

/** Where the view looks: the plates nearest it are read first. */
export function setFlatGroundFocus(x: number, y: number): void {
  focusX = x;
  focusY = y;
}
