import type { Vec2 } from '@core/vec2';
import { ForkMap, forkWork } from '@core/forkMap';
import { ChangeJournal, rectAround, type ChangeRect } from './changes';
import { CellFiling } from './cells';
import { JournalCursor } from './derived';
import { IdAllocator } from './ids';
import { insideLot, type Lot } from './lotRecord';
import { m } from './units';

/** Where a lot lies: the box round its corners. */
export function lotBox(lot: Pick<Lot, 'corners'>): ChangeRect {
  return rectAround(lot.corners) ?? [0, 0, 0, 0];
}

/** Side of the cells the lots are filed in, world units: a few lots wide */
const LOT_CELL = m(64);

/** One change of some lots as the store applies it (`LotStore.apply`). */
export interface LotEdit {
  /** Lots taken away, by id. */
  readonly remove?: readonly number[];
  /** Records replacing the stored ones of the same id, each in its place in the order. */
  readonly put?: readonly Lot[];
  /** New lots: each given the next id, last in the order. */
  readonly add?: readonly Omit<Lot, 'id'>[];
  /** Where else the change reached (a lot side curved past its corners): written with the lots' own boxes. */
  readonly also?: readonly ChangeRect[];
}

/** DO NOT hand the lots out as an array the callers write into, nor search one by id or by place */
export class LotStore {
  /** @mapWide Every lot of the map, in the lots' order. */
  private items = new Map<number, Lot>();
  /** Each lot's place in the order: grows with every lot put last. */
  private order = new Map<number, number>();
  private nextOrder = 0;
  private ids = new IdAllocator(1);
  /** The lots by place, kept by the writers below; null after a whole-store change (a load, a copy), filed again when first asked. */
  private filing: CellFiling<number, Lot> | null = null;
  /** The land already cut into lots (`lots.ts` `planLots`), in the order it was cut, and the same as a set. */
  private keyList: string[] = [];
  private keySet = new Set<string>();
  /** The lots as an array, for the readers that still take one (`RoadDoc.lots`); null when a write made it stale. */
  private listed: readonly Lot[] | null = null;
  /** The store a working copy lies over (`forkFrom`) while it has written no lot */
  private below: LotStore | null = null;
  /** The keys still the original's (`forkFrom`): copied the first time the copy writes one (`ownKeys`). */
  private keysShared = false;

  /** `journal`: the document's diary; a store on its own keeps one of its own. */
  constructor(private readonly journal: ChangeJournal = new ChangeJournal()) {}

  /** The serial of the latest change of the lots in the diary. */
  get revision(): number {
    return this.journal.serialOf('lots');
  }

  get size(): number {
    return this.items.size;
  }

  get(id: number): Lot | undefined {
    return this.items.get(id);
  }

  has(id: number): boolean {
    return this.items.has(id);
  }

  /** Every lot, in the lots' order: what saves, copies or makes the whole map again reads; nothing that asks about a place. */
  all(): IterableIterator<Lot> {
    return this.items.values();
  }

  /** A lot's place in the order (`ORDER` above): a lot put last gets a number greater than any before. */
  orderOf(id: number): number | undefined {
    return this.order.get(id);
  }

  /** @rebuild The lots as an array, in their order, made again only after a change: for the readers that still take an array */
  list(): readonly Lot[] {
    if (this.below) return this.below.list();
    return this.listed ??= [...this.items.values()];
  }

  /** The id the next new lot gets. */
  get nextId(): number {
    return this.ids.peek;
  }

  /** The id allocator set back (undo, `RoadDoc.restore`). */
  restoreNextId(next: number): void {
    this.ids = new IdAllocator(next);
  }

  /** The land already cut into lots, in the order it was cut. */
  get keys(): readonly string[] {
    return this.keyList;
  }

  hasKey(key: string): boolean {
    return this.keySet.has(key);
  }

  /** The lots whose box meets `rect`, in increasing id order: a superset of those whose shape reaches it */
  in(rect: ChangeRect): Lot[] {
    if (this.below) return this.below.in(rect);
    return this.cells().idsMeeting(rect).map((id) => this.items.get(id)!);
  }

  /** The lot whose shape holds `p` (the first in the lots' order when lots overlap), or undefined. */
  at(p: Vec2): Lot | undefined {
    let best: Lot | undefined, bestOrder = Infinity;
    for (const lot of this.in([p.x, p.y, p.x, p.y])) {
      const order = this.order.get(lot.id)!;
      if (order < bestOrder && insideLot(p, lot)) { best = lot; bestOrder = order; }
    }
    return best;
  }

  /** The ids of the lots changed after `serial` (a `revision` read before), from the diary; null when it cannot say which */
  changedSince(serial: number): number[] | null {
    const entries = this.journal.since(serial, ['lots']);
    if (!entries || entries.some((e) => !e.ids)) return null;
    return entries.flatMap((e) => e.ids!);
  }

  /** A reader's place in the lots' diary (`changedFor`). */
  static cursor(): JournalCursor {
    return new JournalCursor(['lots'], true);
  }

  /** The ids of the lots changed since `cursor` last read this store; null: read them all */
  changedFor(cursor: JournalCursor): number[] | null {
    const entries = cursor.read(this.journal);
    return entries === null ? null : entries.flatMap((e) => e.ids!);
  }

  /** One change of the lots, written in the diary as ONE entry with every id it touched and where they were and are. */
  apply(edit: LotEdit, cause: string): Lot[] {
    const ids: number[] = [];
    const rects: ChangeRect[] = [...(edit.also ?? [])];
    for (const id of edit.remove ?? []) {
      const was = this.items.get(id);
      if (!was) continue;
      this.drop(id);
      ids.push(id);
      rects.push(lotBox(was));
    }
    for (const lot of edit.put ?? []) {
      const was = this.items.get(lot.id);
      if (!was) throw new Error(`LotStore: lot ${lot.id} put but not stored`);
      if (was === lot) continue;
      this.leaveBelow();
      this.items.set(lot.id, lot);
      this.filing?.file(lot.id, lot, lotBox(lot));
      this.listed = null;
      ids.push(lot.id);
      rects.push(lotBox(was), lotBox(lot));
    }
    const added: Lot[] = [];
    for (const value of edit.add ?? []) {
      const lot = { ...value, id: this.ids.take() } as Lot;
      this.append(lot);
      added.push(lot);
      ids.push(lot.id);
      rects.push(lotBox(lot));
    }
    if (ids.length) this.journal.record('lots', rects, { ids, cause });
    return added;
  }

  /** Adds land to what is already cut into lots (`lots.ts` `applyLots`) */
  addKeys(keys: readonly string[], rects: readonly ChangeRect[] | undefined, cause: string): boolean {
    const where: ChangeRect[] = [];
    let placeless = false, added = false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (this.keySet.has(key)) continue;
      this.ownKeys();
      this.keySet.add(key);
      this.keyList.push(key);
      added = true;
      const r = rects?.[i];
      if (r) where.push(r); else placeless = true;
    }
    if (added) this.journal.record('lotKeys', placeless ? null : where, { cause });
    return added;
  }

  /** A stretch of the keys put back as it was (undo, `RoadDoc.restore`): `list.splice`, the set kept with it. */
  spliceKeys(start: number, remove: number, items: readonly string[]): string[] {
    this.ownKeys();
    const tail = this.keyList.splice(start + remove);
    const gone = this.keyList.splice(start, remove);
    for (const key of gone) this.keySet.delete(key);
    for (const key of items) { this.keyList.push(key); this.keySet.add(key); }
    for (const key of tail) this.keyList.push(key);
    return gone;
  }

  /** Puts lots back as they were, or takes them away (`undefined`): undo and redo (`world/docImage.ts`), all in one entry */
  restore(records: readonly { readonly id: number; readonly value: Lot | undefined; readonly order?: number }[], cause: string): void {
    const ids: number[] = [];
    const rects: ChangeRect[] = [];
    const last: { lot: Lot; order: number }[] = [];
    for (const { id, value, order } of records) {
      const was = this.items.get(id);
      if (!was && value === undefined) continue;
      if (was) rects.push(lotBox(was));
      if (value === undefined) this.drop(id);
      else if (was && (order === undefined || this.order.get(id) === order)) {
        this.leaveBelow();
        this.items.set(id, value);
        this.filing?.file(id, value, lotBox(value));
        this.listed = null;
      } else if (order !== undefined) {
        // Put last in the order it was given (`replaceWith` does the same with a copy's places).
        if (was) this.drop(id);
        last.push({ lot: value, order });
        this.ids.reserve(id);
      } else {
        this.append(value);
        this.ids.reserve(id);
      }
      if (value) rects.push(lotBox(value));
      ids.push(id);
    }
    last.sort((a, b) => a.order - b.order);
    for (const { lot, order } of last) {
      this.append(lot, order);
      this.nextOrder = Math.max(this.nextOrder, order + 1);
    }
    if (ids.length) this.journal.record('lots', rects, { ids, cause });
  }

  /** The lots and keys of a map read (`RoadDoc.fromJSON`): the whole store, entries without ids. */
  load(lots: readonly Lot[], keys: readonly string[]): void {
    this.reset();
    for (const lot of lots) {
      this.append(lot);
      this.ids.reserve(lot.id);
    }
    for (const key of keys) if (!this.keySet.has(key)) { this.keySet.add(key); this.keyList.push(key); }
    if (lots.length) this.journal.record('lots', null, { cause: 'map loaded' });
    if (keys.length) this.journal.record('lotKeys', null, { cause: 'map loaded' });
  }

  /** The same records as another store (they are never changed in place) */
  shareFrom(source: LotStore): void {
    this.below = null;
    this.keysShared = false;
    this.items = new Map(source.items);
    this.order = new Map(source.order);
    this.nextOrder = source.nextOrder;
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    this.keyList = [...source.keyList];
    this.keySet = new Set(source.keySet);
    this.filing = null;
    this.listed = null;
  }

  /** DO NOT compare the lots as text (`JSON.stringify` of the whole list) */
  replaceWith(source: LotStore, changed: readonly number[] | null, cause: string): boolean {
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    let keysMoved = false;
    if (source.keyList.length !== this.keyList.length || source.keyList.some((k, i) => k !== this.keyList[i])) {
      this.keyList = [...source.keyList];
      this.keySet = new Set(source.keySet);
      this.keysShared = false;
      keysMoved = true;
      this.journal.record('lotKeys', null, { cause });
    }
    if (changed) {
      const ids: number[] = [];
      const rects: ChangeRect[] = [];
      const last: number[] = [];
      for (const id of new Set(changed)) {
        const was = this.items.get(id), now = source.items.get(id);
        if (!was && !now) continue;
        if (was && now && this.order.get(id) === source.order.get(id)) {
          // Changed where it stands: replaced in place (a `Map`'s `set` keeps the key's place).
          if (was === now) continue;
          this.leaveBelow();
          this.items.set(id, now);
          this.filing?.file(id, now, lotBox(now));
          this.listed = null;
          rects.push(lotBox(was), lotBox(now));
          ids.push(id);
          continue;
        }
        if (was) { rects.push(lotBox(was)); this.drop(id); }
        if (now) { rects.push(lotBox(now)); last.push(id); }
        ids.push(id);
      }
      // In the copy's order: each with the copy's place number (kept, or given there when it went last).
      last.sort((a, b) => source.order.get(a)! - source.order.get(b)!);
      for (const id of last) this.append(source.items.get(id)!, source.order.get(id)!);
      this.nextOrder = Math.max(this.nextOrder, source.nextOrder);
      if (ids.length) this.journal.record('lots', rects, { ids, cause });
      return ids.length > 0 || keysMoved;
    }
    let same = this.items.size === source.items.size;
    if (same) {
      const theirs = source.items.values();
      for (const mine of this.items.values()) if (mine !== theirs.next().value) { same = false; break; }
    }
    if (same) return keysMoved;
    const keyList = this.keyList, keySet = this.keySet, keysShared = this.keysShared;
    this.reset();
    this.keyList = keyList;
    this.keySet = keySet;
    this.keysShared = keysShared;
    for (const lot of source.items.values()) this.append(lot);
    this.journal.record('lots', null, { cause });
    return true;
  }

  /** A working copy over another store (`RoadDoc.fork`) */
  forkFrom(source: LotStore): void {
    this.items = new ForkMap(source.items);
    this.order = new ForkMap(source.order);
    this.nextOrder = source.nextOrder;
    this.ids = new IdAllocator(source.ids.peek);
    this.keyList = source.keyList;
    this.keySet = source.keySet;
    this.keysShared = true;
    this.filing = null;
    this.listed = null;
    this.below = source;
  }

  /** Takes back a working copy over this store (`forkFrom`): the lots it took away, replaced (in place) and put last */
  takeFork(copy: LotStore): void {
    const { gone, replaced, added } = (copy.items as ForkMap<number, Lot>).changes();
    if (gone.size || replaced.size || added.size) this.listed = null;
    for (const id of gone) { this.items.delete(id); this.filing?.remove(id); }
    for (const [id, lot] of replaced) { this.items.set(id, lot); this.filing?.file(id, lot, lotBox(lot)); }
    for (const [id, lot] of added) { this.items.set(id, lot); this.filing?.file(id, lot, lotBox(lot)); }
    (copy.order as ForkMap<number, number>).applyTo(this.order);
    this.nextOrder = copy.nextOrder;
    this.ids = new IdAllocator(copy.ids.peek);
    if (!copy.keysShared) {
      this.keyList = copy.keyList;
      this.keySet = copy.keySet;
    }
  }

  /** A working copy about to write a lot: its questions by place and its list its own from now on. */
  private leaveBelow(): void {
    if (!this.below) return;
    this.below = null;
    this.filing = null;
    this.listed = null;
  }

  /** A working copy about to write its keys: its own, copied from the original's the first time. */
  private ownKeys(): void {
    if (!this.keysShared) return;
    this.keysShared = false;
    this.keyList = [...this.keyList];
    this.keySet = new Set(this.keySet);
    forkWork.copied += this.keyList.length;
  }

  /** Every lot, its corners copied (the file, `RoadDoc.serialized`). */
  toJSON(): Lot[] {
    return [...this.items.values()].map((lot) => ({ ...lot, corners: lot.corners.map((q) => ({ x: q.x, y: q.y })) }));
  }

  /** @rebuild The whole store filed by place only on the first question after it was taken whole (a load, a copy). */
  private cells(): CellFiling<number, Lot> {
    if (!this.filing) {
      this.filing = new CellFiling<number, Lot>(LOT_CELL);
      for (const [id, lot] of this.items) this.filing.file(id, lot, lotBox(lot));
    }
    return this.filing;
  }

  /** A lot stored last in the order (`at`: the place number it keeps from a copy). */
  private append(lot: Lot, at?: number): void {
    this.leaveBelow();
    this.items.set(lot.id, lot);
    this.order.set(lot.id, at ?? this.nextOrder++);
    this.filing?.file(lot.id, lot, lotBox(lot));
    this.listed = null;
  }

  private drop(id: number): void {
    this.leaveBelow();
    this.items.delete(id);
    this.order.delete(id);
    this.filing?.remove(id);
    this.listed = null;
  }

  private reset(): void {
    this.below = null;
    this.keysShared = false;
    this.items = new Map();
    this.order = new Map();
    this.nextOrder = 0;
    this.keyList = [];
    this.keySet = new Set();
    this.filing = null;
    this.listed = null;
  }
}
