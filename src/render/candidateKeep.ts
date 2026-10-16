import type { ChangeRect } from '@world/changes';
import { m } from '@world/units';

/** DO NOT keep the whole sweep again on a global key (the roads' revision, the covers' version) */

/** The places' cells, world units: also the cells their drawing is kept in (`plantCells.ts`). */
export const KEEP_CELL = m(64);
const CELL = KEEP_CELL;
/** A cell's key, from its column and row. */
export const keepCellKey = (i: number, j: number): number => (i + 0x8000) * 0x10000 + (j + 0x8000);
const cellKey = keepCellKey;
/** A key's column and row. */
export const keepCellOf = (key: number): readonly [number, number] => [Math.floor(key / 0x10000) - 0x8000, (key % 0x10000) - 0x8000];
/** The cell a point is filed in. */
export const keepCellAt = (x: number, y: number): number => cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
/** A cell's box, world units: [minX, minY, maxX, maxY], the far sides not its own. */
export const keepCellBox = (key: number): ChangeRect => {
  const [i, j] = keepCellOf(key);
  return [i * CELL, j * CELL, (i + 1) * CELL, (j + 1) * CELL];
};
/** Every cell a box reaches, into `out`. */
export function keepCellsOver(rect: ChangeRect, out: Set<number>): void {
  const i0 = Math.floor(rect[0] / CELL), i1 = Math.floor(rect[2] / CELL);
  const j0 = Math.floor(rect[1] / CELL), j1 = Math.floor(rect[3] / CELL);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.add(cellKey(i, j));
}

/** Whether two places are the same: one object, or the same values field by field (a sweep made again). */
function samePlace<C extends object>(a: C, b: C): boolean {
  if (a === b) return true;
  for (const key in a) if (!Object.is(a[key], b[key])) return false;
  return true;
}

/** A cell's places, whether each stands (1) or not (0), and the ground under each that stands. */
interface KeptCell<C> {
  readonly places: readonly C[];
  readonly standing: Uint8Array;
  readonly ground: Float64Array;
}

/** DO NOT make a new keep of every place when some came or went: the cells a change reached are listed again, cell by cell */
export class CellKeep<C extends { readonly x: number; readonly y: number }> {
  private readonly cells = new Map<number, KeptCell<C>>();
  /** The cells whose places, standing or ground changed since the last `takeChangedCells`. */
  private changedNow = new Set<number>();

  /** `test`: the ground under a place where it may stand, null where it may not. */
  constructor(private readonly test: (c: C) => number | null) {}

  /** A cell's places listed anew, each filed in it (`keepCellAt`); a place the same as before keeps its test, the cell its drawing */
  relist(cell: number, places: readonly C[]): void {
    const was = this.cells.get(cell);
    if (places.length === 0) {
      if (was) { this.cells.delete(cell); this.changedNow.add(cell); }
      return;
    }
    // The places kept by their x: a sweep made again makes the same places, in the same cells.
    const before = new Map<number, number[]>();
    if (was) was.places.forEach((c, k) => { const list = before.get(c.x); if (list) list.push(k); else before.set(c.x, [k]); });
    const standing = new Uint8Array(places.length), ground = new Float64Array(places.length);
    let changed = !was || was.places.length !== places.length;
    places.forEach((c, k) => {
      const list = before.get(c.x);
      const at = list?.findIndex((o) => samePlace(was!.places[o]!, c)) ?? -1;
      if (at >= 0) {
        const o = list!.splice(at, 1)[0]!;
        standing[k] = was!.standing[o]!;
        ground[k] = was!.ground[o]!;
        if (o !== k) changed = true;
        return;
      }
      changed = true;
      const z = this.test(c);
      if (z !== null) { standing[k] = 1; ground[k] = z; }
    });
    this.cells.set(cell, { places, standing, ground });
    if (changed) this.changedNow.add(cell);
  }

  /** The places a change reached tested again, `pad` round each box; null: every place (a change the diary cannot place). */
  refresh(rects: readonly ChangeRect[] | null, pad: number): void {
    const retest = (cell: number, kept: KeptCell<C>, k: number): void => {
      const z = this.test(kept.places[k]!);
      const now = z === null ? 0 : 1;
      if (now !== kept.standing[k] || (z !== null && z !== kept.ground[k])) this.changedNow.add(cell);
      kept.standing[k] = now;
      if (z !== null) kept.ground[k] = z;
    };
    if (rects === null) {
      /** @rebuild Every place: a change the diary cannot place. */
      for (const [cell, kept] of this.cells) for (let k = 0; k < kept.places.length; k++) retest(cell, kept, k);
      return;
    }
    const reached = new Set<number>();
    for (const r of rects) keepCellsOver([r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad], reached);
    for (const cell of reached) {
      const kept = this.cells.get(cell);
      if (!kept) continue;
      kept.places.forEach((c, k) => {
        for (const r of rects) {
          if (c.x >= r[0] - pad && c.x <= r[2] + pad && c.y >= r[1] - pad && c.y <= r[3] + pad) { retest(cell, kept, k); return; }
        }
      });
    }
  }

  /** The cells whose places changed since the last call; the call itself the new start. */
  takeChangedCells(): ReadonlySet<number> {
    const changed = this.changedNow;
    if (changed.size === 0) return changed;
    this.changedNow = new Set();
    return changed;
  }

  /** Whether a cell has places listed. */
  has(cell: number): boolean {
    return this.cells.has(cell);
  }

  /** Every cell with a place in it. */
  cellKeys(): IterableIterator<number> {
    return this.cells.keys();
  }

  /** The places standing in a cell, and the ground under each. */
  standingIn(key: number): { readonly c: C; readonly z: number }[] {
    const out: { c: C; z: number }[] = [];
    const kept = this.cells.get(key);
    if (kept) kept.places.forEach((c, k) => { if (kept.standing[k] === 1) out.push({ c, z: kept.ground[k]! }); });
    return out;
  }
}
