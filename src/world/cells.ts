import type { ChangeRect } from './changes';
import { m } from './units';
import { uniqueCounter } from '@core/identityMemo';
import { ForkMap } from '@core/forkMap';

/** THE WORLD'S CELLS: one fixed grid over the plane the map is laid on, the partition an edit's cost is measured in */

/** The side of a cell, world units (Unreal's default runtime grid cell). */
export const CELL = m(256);

/** A cell's key from its column and row (both within ±32 767). */
const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);
const cellColumn = (key: number): number => Math.floor(key / 65536) - 32768;
const cellRow = (key: number): number => (key % 65536) - 32768;

/** The rectangle a cell covers. */
export function cellRect(key: number): ChangeRect {
  const x0 = cellColumn(key) * CELL, y0 = cellRow(key) * CELL;
  return [x0, y0, x0 + CELL, y0 + CELL];
}

/** The key of the cell holding a point. */
export const cellAt = (x: number, y: number): number => cellKey(Math.floor(x / CELL), Math.floor(y / CELL));

/** Calls `visit` with every cell (of side `side`) a rectangle reaches. */
function forCellsOver(rect: ChangeRect, visit: (key: number) => void, side = CELL): void {
  const cx0 = Math.floor(rect[0] / side), cx1 = Math.floor(rect[2] / side);
  const cy0 = Math.floor(rect[1] / side), cy1 = Math.floor(rect[3] / side);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) visit(cellKey(cx, cy));
}

/** A rectangle grown by `pad` on every side. */
export const grow = (r: ChangeRect, pad: number): ChangeRect => [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];

/** Whether two rectangles overlap (touching counts). */
const rectsMeet = (a: ChangeRect, b: ChangeRect): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** The clock every filing's cell versions are read from */
const nextVersion = uniqueCounter();

/** The work a filing did: things filed and cells visited. A count for the performance budgets (`core/perfBudget.ts`). */
export const cellWork = { filed: 0, cellsRead: 0 };

/** Things (by id) filed in the cells their bounds reach, each with the object it was filed for */
export class CellFiling<Id extends number, T extends object> {
  /** `side`: the side of its cells, world units - the world's cell by default */
  constructor(private readonly side = CELL) {}

  private entries = new Map<Id, { readonly item: T; readonly rect: ChangeRect; readonly cells: readonly number[] }>();
  private byCell = new Map<number, Set<Id>>();
  private versions = new Map<number, number>();
  /** The filing this one is a working copy over (`fork`), never written while the copy stands. */
  private below: CellFiling<Id, T> | null = null;
  /** Moves whenever any cell's version does: the clock's reading at the latest change. */
  epoch = 0;

  get size(): number {
    return this.entries.size;
  }

  /** Files `id` for `item` over `rect`; nothing happens when it is already filed for that same object. */
  file(id: Id, item: T, rect: ChangeRect): void {
    const known = this.entries.get(id);
    if (known && known.item === item) return;
    if (known) this.unfile(id, known.cells);
    cellWork.filed++;
    const cells: number[] = [];
    forCellsOver(rect, (key) => {
      cells.push(key);
      this.ownCell(key).add(id);
      this.bump(key);
    }, this.side);
    this.entries.set(id, { item, rect, cells });
  }

  /** Takes `id` out (nothing when it is not filed). */
  remove(id: Id): void {
    const known = this.entries.get(id);
    if (!known) return;
    this.unfile(id, known.cells);
    this.entries.delete(id);
  }

  /** Whether `id` is filed for exactly `item`. */
  holds(id: Id, item: T): boolean {
    return this.entries.get(id)?.item === item;
  }

  /** The rectangle `id` is filed over, or undefined. */
  rectOf(id: Id): ChangeRect | undefined {
    return this.entries.get(id)?.rect;
  }

  /** The ids filed (any order). */
  ids(): IterableIterator<Id> {
    return this.entries.keys();
  }

  /** The ids whose bounds meet `rect`, each once, in increasing order */
  idsMeeting(rect: ChangeRect): Id[] {
    const out = new Set<Id>();
    forCellsOver(rect, (key) => {
      cellWork.cellsRead++;
      const set = this.byCell.get(key);
      if (!set) return;
      for (const id of set) {
        if (out.has(id)) continue;
        if (rectsMeet(this.entries.get(id)!.rect, rect)) out.add(id);
      }
    }, this.side);
    return [...out].sort((a, b) => a - b);
  }

  /** DO NOT ask `idsMeeting` rectangle by rectangle for a change of many */
  idsMeetingAny(rects: readonly ChangeRect[]): Id[] {
    if (rects.length === 1) return this.idsMeeting(rects[0]!);
    const over = new Map<number, ChangeRect[]>();
    for (const rect of rects) {
      forCellsOver(rect, (key) => {
        const list = over.get(key);
        if (list) list.push(rect); else over.set(key, [rect]);
      }, this.side);
    }
    const out = new Set<Id>();
    for (const [key, list] of over) {
      cellWork.cellsRead++;
      const set = this.byCell.get(key);
      if (!set) continue;
      for (const id of set) {
        if (out.has(id)) continue;
        const box = this.entries.get(id)!.rect;
        for (const rect of list) if (rectsMeet(box, rect)) { out.add(id); break; }
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  /** The versions of the cells `rect` reaches, as one string: equal strings, nothing filed there moved. */
  stamp(rect: ChangeRect): string {
    let text = '';
    forCellsOver(rect, (key) => { text += `${this.versions.get(key) ?? 0},`; }, this.side);
    return text;
  }

  /** A copy filing the same things (a document's indices by place copied for a working copy's first write). */
  copyFrom(other: CellFiling<Id, T>): void {
    if (other.side !== this.side) throw new Error(`CellFiling: cells of ${other.side} copied into cells of ${this.side}`);
    this.entries = new Map(other.entries);
    this.byCell = new Map();
    for (const [key, set] of other.byCell) this.byCell.set(key, new Set(set));
    this.versions = new Map(other.versions);
    this.below = null;
    this.epoch = other.epoch;
  }

  /** Files nothing: the next filing starts from an empty one. */
  clear(): void {
    this.entries.clear();
    this.byCell.clear();
    this.versions.clear();
    this.epoch = 0;
  }

  /** DO NOT copy the filing for an edit (`copyFrom`): a working copy over this one (`Network.fork`), costing what it files */
  fork(): CellFiling<Id, T> {
    const copy = new CellFiling<Id, T>(this.side);
    copy.entries = new ForkMap(this.entries);
    copy.byCell = new ForkMap(this.byCell);
    copy.versions = new ForkMap(this.versions);
    copy.below = this;
    copy.epoch = this.epoch;
    return copy;
  }

  /** Whether this filing is a working copy over `other` (`fork`) not yet taken back. */
  isForkOf(other: CellFiling<Id, T>): boolean {
    return this.below === other;
  }

  /** Takes back what a working copy of this filing (`fork`) filed and took out; the copy is spent. */
  takeBack(copy: CellFiling<Id, T>): void {
    if (copy.below !== this) throw new Error('CellFiling.takeBack: not a working copy of this filing');
    (copy.entries as ForkMap<Id, { readonly item: T; readonly rect: ChangeRect; readonly cells: readonly number[] }>).applyTo(this.entries);
    (copy.byCell as ForkMap<number, Set<Id>>).applyTo(this.byCell);
    (copy.versions as ForkMap<number, number>).applyTo(this.versions);
    this.epoch = copy.epoch;
    copy.below = null;
  }

  /** A cell's set to add to: one made when there is none (`cellToWrite`). */
  private ownCell(key: number): Set<Id> {
    let set = this.cellToWrite(key);
    if (!set) this.byCell.set(key, set = new Set());
    return set;
  }

  /** A cell's set to change in place: a working copy's own, copied from the one below the first time (`fork`). */
  private cellToWrite(key: number): Set<Id> | undefined {
    const map = this.byCell;
    return map instanceof ForkMap ? (map as ForkMap<number, Set<Id>>).writable(key, (below) => new Set(below)) : map.get(key);
  }

  private unfile(id: Id, cells: readonly number[]): void {
    for (const key of cells) {
      const set = this.cellToWrite(key);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.byCell.delete(key);
      this.bump(key);
    }
  }

  private bump(key: number): void {
    const version = nextVersion();
    this.versions.set(key, version);
    // From the same clock: an epoch names one change too, never another filing's
    this.epoch = version;
  }
}
