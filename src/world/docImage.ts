/** THE DOCUMENT AS LAST COMMITTED, and what changed since: the undo by records. */
import type { DocChangeKind } from './changes';
import { samePlain } from '@core/plain';
import { DOC_CHANGE_KINDS } from './changes';
import { LIST_KINDS, type ListPart, type RecordPart, type Restoration, type RoadDoc, type RoadKeeper, type RoadNode, type RoadSegment, type SerializedDoc, type ValuePart } from './doc';

/** Each saved key of the map and the part that keeps it: a key added to the format and not here does not compile. */
export const PARTS_OF_SAVED = {
  version: null, unit: null,
  nodes: 'nodes', segments: 'segments', terrain: 'terrainStamps', relief: 'terrainRelief',
  markingStyle: 'markingStyle', nature: 'nature', poles: 'poles', poleSpans: 'poleSpans', paint: 'terrainPaint',
  fog: ['fogDabs', 'fogSettings'], gullies: ['gullyDabs', 'gullyAuto'], clouds: 'clouds', elements: 'elements', trees: 'trees',
  weather: 'weather', treeClearings: 'treeClearings', landscape: 'landscape', transit: 'transit', barriers: 'barriers',
  buildings: 'buildings', zones: 'zones', zoneMarks: 'zoneMarks', lots: 'lots', lotKeys: 'lotKeys', people: 'people', economy: 'economy',
} as const satisfies Record<keyof SerializedDoc, RecordPart | ListPart | ValuePart | readonly (ListPart | ValuePart)[] | null>;

/** The keyed collections: their records by id, and the kinds of change that move them. */
// Every record is kept by reference: replaced whole by its writers, or (`inPlace`) copied by the image before the document first changes it (`RoadDoc.keepRoads`).
const RECORDS: readonly { readonly part: RecordPart; readonly kinds: readonly DocChangeKind[]; readonly entries: (d: RoadDoc) => Iterable<readonly [number, unknown]>; readonly get: (d: RoadDoc, id: number) => unknown; readonly inPlace?: boolean }[] = [
  { part: 'nodes', kinds: ['roads', 'traffic'], entries: (d) => d.nodes, get: (d, id) => d.nodes.get(id as never), inPlace: true },
  { part: 'segments', kinds: ['roads', 'traffic'], entries: (d) => d.segments, get: (d, id) => d.segments.get(id as never), inPlace: true },
  { part: 'poles', kinds: ['utilities'], entries: (d) => d.poles, get: (d, id) => d.poles.get(id as never) },
  { part: 'poleSpans', kinds: ['utilities'], entries: (d) => d.poleSpans, get: (d, id) => d.poleSpans.get(id as never) },
  { part: 'landscape', kinds: ['landscape'], entries: (d) => d.landscape, get: (d, id) => d.landscape.get(id) },
  { part: 'barriers', kinds: ['barriers'], entries: (d) => d.barriers, get: (d, id) => d.barriers.get(id) },
  // A building's record is replaced, never changed in place (`BuildingStore.put`).
  { part: 'buildings', kinds: ['buildings', 'buildingWear'], entries: (d) => buildingEntries(d), get: (d, id) => d.buildings.get(id as never) },
  // DO NOT go back to the lots as a list
  { part: 'lots', kinds: ['lots'], entries: (d) => lotEntries(d), get: (d, id) => d.lotStore.get(id) },
];
const LISTS = Object.keys(LIST_KINDS) as ListPart[];
/** The values and the kind that moves each; null: compared at every commit (they are small). */
const VALUES: Readonly<Record<ValuePart, DocChangeKind | null>> = {
  terrainRelief: 'terrain', markingStyle: 'markingStyle', nature: 'nature', fogSettings: 'fog', gullyAuto: 'gullies', weather: 'weather',
  economy: 'economy', transit: 'transit', nextZoneId: null, nextLotId: null, allocators: null,
};

function* buildingEntries(d: RoadDoc): Iterable<readonly [number, unknown]> {
  for (const b of d.buildings.all()) yield [b.id, b];
}

function* lotEntries(d: RoadDoc): Iterable<readonly [number, unknown]> {
  for (const lot of d.lotStore.all()) yield [lot.id, lot];
}

export interface DocPatch {
  readonly records: readonly { readonly part: RecordPart; readonly id: number; readonly before: unknown; readonly after: unknown }[];
  /** Stretches of lists, in order along each list: `start` where the stretch stands in the list as it is after. */
  readonly lists: readonly { readonly part: ListPart; readonly start: number; readonly before: readonly unknown[]; readonly after: readonly unknown[] }[];
  readonly values: readonly { readonly part: ValuePart; readonly before: unknown; readonly after: unknown }[];
  /** Roughly what it holds, UTF-16 bytes of its text. */
  readonly bytes: number;
}

/** One side of a patch as `RoadDoc.restore` takes it: `before` undoes (the stretches of a list from its last), `after` redoes. */
export function sideOf(patch: DocPatch, side: 'before' | 'after'): Restoration {
  const back = side === 'before';
  const lists = patch.lists.map((l) => ({ part: l.part, start: l.start, remove: back ? l.after.length : l.before.length, items: back ? l.before : l.after }));
  return {
    records: patch.records.map((r) => ({ part: r.part, id: r.id, value: back ? r.before : r.after })),
    lists: back ? lists.reverse() : lists,
    values: patch.values.map((v) => ({ part: v.part, value: back ? v.before : v.after })),
  };
}

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

const IN_PLACE: readonly RecordPart[] = RECORDS.filter((r) => r.inPlace).map((r) => r.part);
const textBytes = (value: unknown): number => (value === undefined ? 0 : 2 * JSON.stringify(value).length);
/** A reference held in a list's stretch, bytes. */
const REF_BYTES = 8;

/** What a patch holds that the document does not, UTF-16 bytes of its text: what was, a record changed in place as it is, a list's references */
function bytesHeld(records: DocPatch['records'], lists: DocPatch['lists'], values: DocPatch['values']): number {
  let bytes = 0;
  for (const r of records) bytes += textBytes(r.before) + (IN_PLACE.includes(r.part) ? textBytes(r.after) : 0);
  for (const l of lists) bytes += textBytes(l.before) + REF_BYTES * l.after.length;
  for (const v of values) bytes += textBytes(v.before) + textBytes(v.after);
  return bytes;
}

/** Where two lists differ, by the identity of their items (each written whole, never changed in place): stretches along `now`, one pass */
function listStretches(kept: readonly unknown[], now: readonly unknown[]): { start: number; before: unknown[]; after: unknown[] }[] {
  const out: { start: number; before: unknown[]; after: unknown[] }[] = [];
  let i = 0, j = 0;
  // The common end, so that the search below never runs into it.
  let ki = kept.length, nj = now.length;
  while (ki > i && nj > j && kept[ki - 1] === now[nj - 1]) { ki--; nj--; }
  while (i < ki || j < nj) {
    while (i < ki && j < nj && kept[i] === now[j]) { i++; j++; }
    if (i >= ki && j >= nj) break;
    // The nearest point where the two meet again: `k` items gone, come, or put in place of others; else all that is left.
    let gone = ki - i, came = nj - j;
    if (i < ki && j < nj) {
      for (let k = 1; i + k < ki || j + k < nj; k++) {
        if (i + k < ki && kept[i + k] === now[j]) { gone = k; came = 0; break; }
        if (j + k < nj && now[j + k] === kept[i]) { gone = 0; came = k; break; }
        if (i + k < ki && j + k < nj && kept[i + k] === now[j + k]) { gone = k; came = k; break; }
      }
    }
    out.push({ start: j, before: kept.slice(i, i + gone), after: now.slice(j, j + came) });
    i += gone;
    j += came;
  }
  return out;
}

export class DocImage implements RoadKeeper {
  /** Each record as last committed, the document's own while it stands unchanged. */
  private readonly records = new Map<RecordPart, Map<number, unknown>>();
  private readonly lists = new Map<ListPart, unknown[]>();
  private readonly values = new Map<ValuePart, unknown>();
  /** The diary's serial of each kind at the last commit. */
  private readonly seen = new Map<DocChangeKind, number>();

  constructor(doc: RoadDoc) {
    this.take(doc);
    doc.keepRoads(this);
  }

  /** Takes the whole document as it is: its records and list items by reference, its values copied. */
  take(doc: RoadDoc): void {
    for (const r of RECORDS) this.records.set(r.part, new Map(r.entries(doc)));
    for (const part of LISTS) this.lists.set(part, doc.listOf(part).slice());
    for (const part of Object.keys(VALUES) as ValuePart[]) this.values.set(part, copy(doc.valueOf(part)));
    this.see(doc);
  }

  /** A road record about to be changed in place: kept as it stood, when it is the one kept (`RoadDoc.keepRoads`). */
  beforeWrite(part: 'nodes' | 'segments', record: RoadNode | RoadSegment): void {
    const kept = this.records.get(part)!;
    if (kept.get(record.id) === record) kept.set(record.id, copy(record));
  }

  /** What changed since the last commit, and the image brought up to the document; null when nothing did. */
  commit(doc: RoadDoc): DocPatch | null {
    return this.update(doc, true);
  }

  /** The image brought up to the document, keeping nothing of what changed: a change made with no edit open */
  absorb(doc: RoadDoc): void {
    this.update(doc, false);
  }

  private update(doc: RoadDoc, keep: boolean): DocPatch | null {
    const moved = (kinds: readonly DocChangeKind[]): boolean => kinds.some((k) => doc.changes.serialOf(k) > (this.seen.get(k) ?? 0));
    const records: DocPatch['records'][number][] = [];
    const lists: DocPatch['lists'][number][] = [];
    const values: DocPatch['values'][number][] = [];
    for (const r of RECORDS) {
      if (!moved(r.kinds)) continue;
      const at = performance.now();
      const kept = this.records.get(r.part)!;
      const take = (id: number, now: unknown): void => {
        const was = kept.get(id);
        if (was === now) return;
        // The document's own record kept from here on: a copy only of what is changed in place, and only when it is.
        if (now === undefined) kept.delete(id); else kept.set(id, now);
        if (was !== undefined && now !== undefined && samePlain(was, now)) return;
        if (keep) records.push({ part: r.part, id, before: was, after: r.inPlace ? copy(now) : now });
      };
      // DO NOT walk every record of a kind that moved
      const ids = this.named(doc, r.kinds);
      if (ids) {
        for (const id of [...ids].sort((p, q) => p - q)) take(id, r.get(doc, id));
      } else {
        /** @rebuild Every record of the part only when the diary cannot say which changed. */
        for (const [id, now] of r.entries(doc)) take(id, now);
        for (const id of [...kept.keys()]) if (r.get(doc, id) === undefined) take(id, undefined);
      }
      if (performance.now() - at > 2) performance.measure(`hitch:image/${r.part} ${kept.size}`, { start: at, end: performance.now() });
    }
    for (const part of LISTS) {
      if (!moved([LIST_KINDS[part]])) continue;
      const at = performance.now();
      const now = doc.listOf(part);
      if (keep) for (const stretch of listStretches(this.lists.get(part)!, now)) lists.push({ part, ...stretch });
      this.lists.set(part, now.slice());
      if (performance.now() - at > 2) performance.measure(`hitch:image/${part} ${now.length}`, { start: at, end: performance.now() });
    }
    for (const part of Object.keys(VALUES) as ValuePart[]) {
      const kind = VALUES[part];
      if (kind !== null && !moved([kind])) continue;
      const was = this.values.get(part);
      const now = doc.valueOf(part);
      if (samePlain(was, now)) continue;
      if (keep) values.push({ part, before: was, after: copy(now) });
      this.values.set(part, copy(now));
    }
    this.see(doc);
    if (!records.length && !lists.length && !values.length) return null;
    return { records, lists, values, bytes: bytesHeld(records, lists, values) };
  }

  /** The ids the diary's entries of these kinds name since the last commit, each kind read from where it was last seen */
  private named(doc: RoadDoc, kinds: readonly DocChangeKind[]): Set<number> | null {
    const ids = new Set<number>();
    // DO NOT read every kind from the oldest one's serial: the entries of a map opened before the last commit were read again
    for (const kind of kinds) {
      const entries = doc.changes.since(this.seen.get(kind) ?? 0, [kind]);
      if (entries === null) return null;
      for (const entry of entries) {
        if (!entry.ids) return null;
        for (const id of entry.ids) ids.add(id);
      }
    }
    return ids;
  }

  private see(doc: RoadDoc): void {
    for (const kind of DOC_CHANGE_KINDS) this.seen.set(kind, doc.changes.serialOf(kind));
  }
}
