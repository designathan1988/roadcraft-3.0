import { type GrowthStamp, commitGrowth, planOnLot } from '@editor/zoning';
import { type HeightTile, heightTileRect } from '@render/heightTile';
import type { SiteContext } from '@world/buildings/validate';
import { type ChangeRect, rectAround } from '@world/changes';
import type { DocChangeKind } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { GROWTH_READS, ReplicaFeed } from '@world/replica';
import { type FromGrowth, GROUND_READ, type GrownBatch, type HeightsNeed, type ToGrowth } from './growthProtocol';

/** THE CITY'S GROWTH AS THE PAGE HOLDS IT: its worker asked a batch at a time (`growth.worker.ts`), the buildings it grew put in the document */

/** Where the page reads the heights a batch needs (`SceneHandle`). */
export interface GrowthGround {
  terrainHeightAt(x: number, y: number): number;
  pavedHeightAt(x: number, y: number): number;
  heightTile(rect: readonly [number, number, number, number]): { readonly tile: HeightTile; readonly transfer: ArrayBuffer[] };
}

/** A batch asked: the cause its edit is written under, the lots set aside (the set added to), the stamp, the lots worked on at most. */
export interface GrowthAsk {
  readonly cause: string;
  readonly refused: Set<number>;
  readonly stamp: GrowthStamp;
  readonly seed: number;
  readonly most: number;
}

/** What a batch did: buildings grown, lots set aside; `done`, no open lot is left. Nothing done: not taken (the document moved meanwhile). */
export interface GrowthDone {
  readonly grown: number;
  readonly refused: number;
  readonly done: boolean;
}

/** Milliseconds a batch grows before its buildings are handed over: the pace they come into the document at. */
const BATCH_MS = 100;
/** The kinds of change that leave a batch grown on the copy as the document no longer is: not taken. */
const BATCH_READS: readonly DocChangeKind[] = ['roads', 'traffic', 'lots', 'buildings'];

export class GrowthHost {
  private worker: Worker | null = null;
  private broken = false;
  private readonly feed = new ReplicaFeed(GROWTH_READS);
  /** The batch out: what was asked, what to tell when it comes back. */
  private out: { readonly seq: number; readonly ask: GrowthAsk; readonly then: (done: GrowthDone) => void } | null = null;
  /** The diary read up to the batch out's asking: what it says next moved under the batch (`BATCH_READS`). */
  private readonly moved = new JournalCursor(BATCH_READS);
  private seq = 0;
  /** The records the page took from the last batch, as stored: the copy holds them already (`ReplicaFeed.take`). */
  private readonly taken = new Map<string, unknown>();
  /** The set of lots set aside the copy holds, and its size then: sent whole when the page's is another. */
  private refusedSent: { readonly set: Set<number> | null; readonly size: number } = { set: null, size: -1 };

  constructor(private readonly doc: RoadDoc, private readonly net: Network, private readonly ground: GrowthGround,
    private readonly caused: <T>(cause: string, fn: () => T) => T) {}

  /** A batch is out: none other is asked until it is back. */
  get busy(): boolean {
    return this.out !== null;
  }

  /** Whether the batches grow in the worker: told between frames, so the next may be asked at once. */
  get offPage(): boolean {
    return this.worker !== null && !this.broken;
  }

  /** A batch asked; `then` told what it did (at once on the page). False when one is out already. */
  grow(ask: GrowthAsk, then: (done: GrowthDone) => void): boolean {
    if (this.out) return false;
    const worker = this.start();
    if (!worker) {
      then(this.growHere(ask));
      return true;
    }
    const seq = ++this.seq;
    const whole = this.refusedSent.set !== ask.refused || this.refusedSent.size !== ask.refused.size;
    const message: ToGrowth = {
      kind: 'grow', seq, patch: this.feed.take(this.doc, (part, id, value) => this.taken.get(`${part}:${id}`) === value),
      nextId: this.doc.buildings.nextId, refused: whole ? [...ask.refused] : null,
      seed: ask.seed, stamp: ask.stamp, most: ask.most, budgetMs: BATCH_MS,
    };
    this.taken.clear();
    this.refusedSent = { set: ask.refused, size: ask.refused.size };
    this.moved.read(this.doc.changes);
    this.out = { seq, ask, then };
    worker.postMessage(message);
    return true;
  }

  /** @perItem A batch grown on the page itself (no worker): as `growOnLot`, until `BATCH_MS` is spent. */
  private growHere(ask: GrowthAsk): GrowthDone {
    const ctx: SiteContext = {
      doc: this.doc, net: this.net,
      groundAt: (x, y) => this.ground.terrainHeightAt(x, y), pavedAt: (x, y) => this.ground.pavedHeightAt(x, y),
    };
    const until = performance.now() + BATCH_MS;
    let grown = 0, refused = 0, done = false;
    this.caused(ask.cause, () => {
      while (grown + refused < ask.most && performance.now() < until) {
        const growth = planOnLot(ctx, ask.refused, ask.seed);
        if (!growth) { done = true; break; }
        if (commitGrowth(ctx, growth, ask.refused, ask.stamp)) grown++;
        else refused++;
      }
    });
    return { grown, refused, done };
  }

  private start(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    try {
      const worker = new Worker(new URL('./growth.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<FromGrowth>) => this.hear(event.data);
      worker.onerror = (event) => this.fail(`the growth's worker failed: ${event.message}`);
      worker.onmessageerror = () => this.fail("the growth's worker sent a message that cannot be read");
      this.worker = worker;
    } catch (error) {
      console.warn("[growth] the growth's worker cannot start; the city grows on the page", error);
      this.broken = true;
    }
    return this.worker;
  }

  private hear(m: FromGrowth): void {
    if (!this.out || m.seq !== this.out.seq) return;
    if (m.kind === 'need') this.answer(m);
    else if (m.kind === 'grown') this.take(m);
    else this.fail(`a batch failed in the growth's worker: ${m.error}`);
  }

  /** @perItem The heights a batch wants: the squares packed (`heightTile.ts`), the points read here. */
  private answer(need: HeightsNeed): void {
    const tiles: [number, HeightTile][] = [];
    const transfer: ArrayBuffer[] = [];
    for (const key of need.tiles) {
      const packed = this.ground.heightTile(heightTileRect(key));
      tiles.push([key, packed.tile]);
      transfer.push(...packed.transfer);
    }
    const points = new Float64Array(need.points.length / 3);
    for (let i = 0; i < need.points.length; i += 3) {
      const kind = need.points[i]!, x = need.points[i + 1]!, y = need.points[i + 2]!;
      points[i / 3] = kind === GROUND_READ ? this.ground.terrainHeightAt(x, y) : this.ground.pavedHeightAt(x, y);
    }
    transfer.push(points.buffer);
    const message: ToGrowth = { kind: 'heights', seq: need.seq, tiles, points };
    this.worker!.postMessage(message, transfer);
  }

  /** @perItem A batch back: put in the document as one edit, or, when the document moved meanwhile, left and the copy put right. */
  private take(batch: GrownBatch): void {
    const { ask, then } = this.out!;
    this.out = null;
    const moved = this.moved.read(this.doc.changes);
    const first = batch.buildings[0];
    if (moved === null || moved.length > 0 || (first && first.id !== this.doc.buildings.nextId)) {
      this.feed.resend('buildings', batch.buildings.map((b) => b.id));
      this.feed.resend('lots', batch.lots.map((l) => l.id));
      this.refusedSent = { set: null, size: -1 };
      then({ grown: 0, refused: 0, done: false });
      return;
    }
    const inStep = this.refusedSent.set === ask.refused && this.refusedSent.size === ask.refused.size;
    this.caused(ask.cause, () => {
      for (const b of batch.buildings) {
        const stored = this.doc.buildings.add(b);
        if (stored.id !== b.id) throw new Error(`building ${b.id} grown in the worker stored as ${stored.id}`);
        this.taken.set(`buildings:${stored.id}`, stored);
      }
      if (batch.lots.length) {
        const also = batch.lots.map((l) => rectAround(l.corners)).filter((r): r is ChangeRect => r !== null);
        this.doc.lotStore.apply({ put: batch.lots, also }, 'building grew on the lot');
        for (const lot of batch.lots) this.taken.set(`lots:${lot.id}`, lot);
      }
    });
    if (batch.refused.length) {
      // Told to the page's open lots as the worker's were (`OpenLots.refuse`): not read whole again.
      const open = this.doc.openLots;
      open.count(ask.refused);
      for (const id of batch.refused) {
        const lot = this.doc.lot(id);
        if (lot) open.refuse(lot, ask.refused);
        else ask.refused.add(id);
      }
    }
    this.refusedSent = inStep ? { set: ask.refused, size: ask.refused.size } : { set: null, size: -1 };
    then({ grown: batch.buildings.length, refused: batch.refused.length, done: batch.done });
  }

  /** The worker lost: the batch out told as not taken, and the city grows on the page from here on. */
  private fail(why: string): void {
    if (this.broken) return;
    console.warn(`[growth] ${why}; the city grows on the page`);
    this.broken = true;
    this.worker?.terminate();
    this.worker = null;
    const out = this.out;
    this.out = null;
    out?.then({ grown: 0, refused: 0, done: false });
  }
}
