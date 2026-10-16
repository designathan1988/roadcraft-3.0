import { commitGrowth, planOnLot, type LotGrowth } from '@editor/zoning';
import { type HeightReads, heightTileKey, heightTileReads } from '@render/heightTile';
import type { SiteContext } from '@world/buildings/validate';
import type { Building } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import type { Lot } from '@world/lots';
import { Network } from '@world/network';
import { applyReplica } from '@world/replica';
import { type FromGrowth, GROUND_READ, type GrowAsk, type HeightsAnswer, PAVED_READ } from './growthProtocol';

/** THE CITY'S GROWTH OFF THE PAGE (`growth.worker.ts`): its own copy of the document (`world/replica.ts`) and network, the buildings grown on it a batch at a time */

/** Rounds of heights asked for one lot before it is given up as never settling (the squares under a lot: one round, two at a square's edge). */
const MOST_ROUNDS = 16;

/** A batch being grown: what was asked, the heights handed over for it, what it grew. */
interface Batch {
  readonly ask: GrowAsk;
  readonly started: number;
  /** The squares' readings (`heightTile.ts`) and the points read on the page, kept for this batch only: the page's ground moves between batches. */
  readonly tiles: Map<number, HeightReads>;
  readonly known: Map<string, number>;
  readonly buildings: Building[];
  readonly lots: Lot[];
  readonly refused: number[];
  /** What the last plan read and nothing could say: the squares, and the points (kind, x, y) with their keys. */
  readonly wantTiles: Set<number>;
  readonly wantKeys: Set<string>;
  wantPoints: number[];
  /** The points last asked of the page, in the order their readings come back. */
  asked: number[];
  rounds: number;
  /** The last ground read: what a reading not handed over yet stands in for while the plan runs on to find what else it needs. */
  lastGround: number;
}

export class GrowthRun {
  readonly doc = new RoadDoc();
  readonly net = new Network(this.doc);
  /** The lots set aside, as the page's set (`GrowAsk.refused`) and what this copy set aside since. */
  private refused = new Set<number>();
  private batch: Batch | null = null;

  /** A batch asked: the page's changes taken in, then grown until it is done or needs heights. */
  start(ask: GrowAsk): FromGrowth {
    if (ask.patch) applyReplica(this.doc, ask.patch);
    if (ask.patch?.roads) this.net.rebuild();
    this.doc.buildings.restoreNextId(ask.nextId);
    // A new set (not the same one cleared): the open lots read it whole again (`OpenLots.sync`).
    if (ask.refused) this.refused = new Set(ask.refused);
    this.batch = {
      ask, started: performance.now(), tiles: new Map(), known: new Map(), buildings: [], lots: [], refused: [],
      wantTiles: new Set(), wantKeys: new Set(), wantPoints: [], asked: [], rounds: 0, lastGround: 0,
    };
    return this.run();
  }

  /** The heights the batch asked for: it goes on; null when they are for a batch no longer running. */
  heights(answer: HeightsAnswer): FromGrowth | null {
    const batch = this.batch;
    if (!batch || answer.seq !== batch.ask.seq) return null;
    for (const [key, tile] of answer.tiles) batch.tiles.set(key, heightTileReads(tile));
    for (let i = 0; i < batch.asked.length; i += 3) batch.known.set(pointKey(batch.asked[i]!, batch.asked[i + 1]!, batch.asked[i + 2]!), answer.points[i / 3]!);
    return this.run();
  }

  /** @perItem The batch grown on, a lot at a time: a plan that read what nothing could say is asked for and made again. */
  private run(): FromGrowth {
    const batch = this.batch!;
    const { ask } = batch;
    const ctx: SiteContext = {
      doc: this.doc, net: this.net,
      groundAt: (x, y) => this.read(batch, GROUND_READ, x, y),
      pavedAt: (x, y) => this.read(batch, PAVED_READ, x, y),
    };
    let done = false;
    while (batch.buildings.length + batch.refused.length < ask.most && performance.now() - batch.started < ask.budgetMs) {
      batch.wantTiles.clear();
      batch.wantKeys.clear();
      batch.wantPoints = [];
      let growth: LotGrowth | null;
      try {
        growth = planOnLot(ctx, this.refused, ask.seed);
      } catch (error) {
        // Led astray by a reading that only stood in: made again once it is known.
        if (!wanting(batch)) throw error;
        growth = null;
      }
      if (wanting(batch)) {
        if (++batch.rounds > MOST_ROUNDS) throw new Error(`a lot still wanted heights after ${MOST_ROUNDS} rounds`);
        batch.asked = batch.wantPoints;
        return { kind: 'need', seq: ask.seq, tiles: [...batch.wantTiles], points: Float64Array.from(batch.wantPoints) };
      }
      batch.rounds = 0;
      if (!growth) { done = true; break; }
      const stored = commitGrowth(ctx, growth, this.refused, ask.stamp);
      if (stored) {
        batch.buildings.push(stored);
        batch.lots.push(this.doc.lot(growth.lot.id)!);
      } else batch.refused.push(growth.lot.id);
    }
    this.batch = null;
    return { kind: 'grown', seq: ask.seq, buildings: batch.buildings, lots: batch.lots, refused: batch.refused, done, ms: performance.now() - batch.started };
  }

  /** A height the plan reads: from the squares handed over, or a point the page told; else wanted, a stand-in given meanwhile. */
  private read(batch: Batch, kind: number, x: number, y: number): number {
    const key = heightTileKey(x, y);
    const tile = batch.tiles.get(key);
    if (tile) {
      const value = kind === GROUND_READ ? tile.ground(x, y) : tile.paved(x, y);
      if (value !== undefined) {
        if (kind === GROUND_READ) batch.lastGround = value;
        return value;
      }
      const point = pointKey(kind, x, y);
      const known = batch.known.get(point);
      if (known !== undefined) return known;
      if (!batch.wantKeys.has(point)) {
        batch.wantKeys.add(point);
        batch.wantPoints.push(kind, x, y);
      }
    } else batch.wantTiles.add(key);
    return kind === GROUND_READ ? batch.lastGround : NaN;
  }
}

/** A point's reading as a key: the exact numbers (a double's shortest text round-trips it). */
const pointKey = (kind: number, x: number, y: number): string => `${kind} ${x} ${y}`;

const wanting = (batch: Batch): boolean => batch.wantTiles.size > 0 || batch.wantPoints.length > 0;
