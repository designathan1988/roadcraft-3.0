import type { Building, BuildingId } from '@world/buildings/types';
import { type Change, type ChangeKind, DOC_CHANGE_KINDS } from '@world/changes';
import { JournalCursor } from '@world/derived';
import { type RoadDoc, SAVED_RECORD_KEYS, type SavedRecordKey, type SavedValueKey, type SerializedDoc } from '@world/doc';

/** DO NOT walk every building of the map to find the parts that changed, nor write the head on every save */

/** Buildings a part holds, by id. */
export const BUILDINGS_PER_PART = 512;
/** Records a part of the head holds, by id (nodes, segments, poles, wires, street furniture, walls, lots). */
export const RECORDS_PER_PART = 1024;
/** Where a map's parts are kept: blobs by key, written and removed in one go. */
export interface PartStore {
  get(keys: readonly string[]): Promise<(Blob | null)[]>;
  /** Writes `put` and removes `remove` together; false when nothing was written. */
  write(put: readonly (readonly [string, Blob])[], remove: readonly string[]): Promise<boolean>;
}

/** What a parted save reads back. */
export interface PartedSession {
  readonly document: SerializedDoc;
  readonly settings: unknown;
  readonly savedAt: number;
}

/** The head in sections (manifest 4): the keys stored whole, and each keyed part's parts by id. */
interface HeadLayout {
  readonly values: readonly SavedValueKey[];
  readonly records: Readonly<Partial<Record<SavedRecordKey, readonly number[]>>>;
}

/** What a map in parts holds (`read`): the buildings' parts and the head's sections; null head: one text (manifest 3). */
export interface StoredLayout {
  readonly parts: readonly number[];
  readonly head: HeadLayout | null;
}

interface Manifest {
  /** 3: the head as one text (`:head`); 4: the head in sections (`head`). */
  readonly version: 3 | 4;
  readonly savedAt: number;
  readonly parts: readonly number[];
  readonly settings: unknown;
  readonly head?: HeadLayout;
}

const gzip = (text: string): Promise<Blob> =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
const gunzip = (blob: Blob): Promise<string> =>
  new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();

const isPartList = (value: unknown): value is number[] => Array.isArray(value) && value.every((p) => Number.isInteger(p));

function isHeadLayout(value: unknown): value is HeadLayout {
  if (typeof value !== 'object' || value === null) return false;
  const head = value as Record<string, unknown>;
  if (!Array.isArray(head['values']) || !(head['values'] as unknown[]).every((k) => typeof k === 'string' && k in VALUE_KINDS)) return false;
  const records = head['records'];
  if (typeof records !== 'object' || records === null) return false;
  return Object.entries(records).every(([key, parts]) => (SAVED_RECORD_KEYS as readonly string[]).includes(key) && isPartList(parts));
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m['savedAt'] !== 'number' || !isPartList(m['parts'])) return false;
  return m['version'] === 3 || (m['version'] === 4 && isHeadLayout(m['head']));
}

/** The kinds that live in the buildings' parts; every other kind of the document is in the head. */
const BUILDING_KINDS: readonly ChangeKind[] = ['buildings', 'buildingWear'];
/** The kinds of change that move each key of the head stored whole: a key added to the format and not here does not compile. */
const VALUE_KINDS: Readonly<Record<SavedValueKey, readonly ChangeKind[]>> = {
  version: [], unit: [], terrain: ['terrain'], relief: ['terrain'], markingStyle: ['markingStyle'], nature: ['nature'], paint: ['paint'],
  fog: ['fog'], gullies: ['gullies'], clouds: ['clouds'], elements: ['elements'], trees: ['trees'], weather: ['weather'],
  treeClearings: ['clearings'], zones: ['zones'], zoneMarks: ['zones'], lotKeys: ['lotKeys'], people: ['people'], transit: ['transit'], economy: ['economy'],
};
const VALUE_KEYS = Object.keys(VALUE_KINDS) as SavedValueKey[];
/** The kinds of change that move each keyed part of the head, whose entries name its records by id. */
const RECORD_KINDS: Readonly<Record<SavedRecordKey, readonly ChangeKind[]>> = {
  nodes: ['roads', 'traffic'], segments: ['roads', 'traffic'], poles: ['utilities'], poleSpans: ['utilities'],
  landscape: ['landscape'], barriers: ['barriers'], lots: ['lots'],
};

/** What waits to be written of the head: the keys stored whole, and each keyed part's parts ('all': every one). */
interface HeadDirt {
  values: Set<SavedValueKey> | 'all';
  records: Map<SavedRecordKey, Set<number> | 'all'>;
}
const everything = (): HeadDirt => ({ values: 'all', records: new Map(SAVED_RECORD_KEYS.map((key) => [key, 'all'] as const)) });

/** Two sets of dirt as one: what a failed write did not write, with what came since. */
function joined<T>(a: Set<T> | 'all', b: Set<T> | 'all'): Set<T> | 'all' {
  return a === 'all' || b === 'all' ? 'all' : new Set([...a, ...b]);
}

export class PartedSaves {
  /** The diary read up to the last save (every kind of the document). */
  private readonly cursor = new JournalCursor(DOC_CHANGE_KINDS);
  /** The document the stored parts are of; another one is written whole. */
  private doc: RoadDoc | null = null;
  /** The parts stored now (the manifest's list). */
  private readonly stored = new Set<number>();
  /** The head's sections stored now; null: none (nothing stored, or the head as one text), the next save writes every one. */
  private storedHead: { values: Set<SavedValueKey>; records: Map<SavedRecordKey, Set<number>> } | null = null;
  /** What changed and is not yet written (kept across a failed write): the parts, or all; the head's sections. */
  private dirtyParts: Set<number> | 'all' = 'all';
  /** The parts whose buildings' wear changed and is not yet written (their records may not have). */
  private dirtyWear: Set<number> | 'all' = 'all';
  private dirtyHead: HeadDirt = everything();
  /** Saves one after another: a save under way finishes before the next reads the map. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: PartStore, private readonly key: string) {}

  private partKey(part: number): string { return `${this.key}:part:${part}`; }
  private wearKey(part: number): string { return `${this.key}:wear:${part}`; }
  /** A key of the head stored whole, and a part of a keyed part of the head. */
  private valueKey(key: SavedValueKey): string { return `${this.key}:head:${key}`; }
  private recordKey(key: SavedRecordKey, part: number): string { return `${this.key}:head:${key}:${part}`; }

  save(doc: RoadDoc, settings: unknown, savedAt = Date.now()): Promise<boolean> {
    return this.queued(() => this.write(doc, settings, savedAt));
  }

  /** The document just opened from these parts (`Persistence.adoptLoaded`): a head stored as one text is written in sections at the next save. */
  adopt(doc: RoadDoc, layout: StoredLayout): void {
    this.doc = doc;
    this.cursor.read(doc.changes);
    this.stored.clear();
    for (const part of layout.parts) this.stored.add(part);
    this.dirtyParts = new Set();
    this.dirtyWear = new Set();
    const head = layout.head;
    this.storedHead = head && {
      values: new Set(head.values),
      records: new Map(SAVED_RECORD_KEYS.map((key) => [key, new Set(head.records[key] ?? [])] as const)),
    };
    this.dirtyHead = head ? { values: new Set(), records: new Map() } : everything();
  }

  /** Nothing is known to be stored: the next save writes every part. */
  private forget(): void {
    this.doc = null;
    this.stored.clear();
    this.storedHead = null;
    this.dirtyParts = 'all';
    this.dirtyWear = 'all';
    this.dirtyHead = everything();
  }

  /** What the diary says changed since the last look, added to what waits to be written. */
  private take(doc: RoadDoc): void {
    const entries = this.doc === doc ? this.cursor.read(doc.changes) : null;
    if (entries === null) {
      this.cursor.read(doc.changes);
      this.doc = doc;
      this.dirtyParts = 'all';
      this.dirtyWear = 'all';
      this.dirtyHead = everything();
      return;
    }
    for (const entry of entries) {
      if (!BUILDING_KINDS.includes(entry.kind)) { this.headMoved(entry); continue; }
      // Wear alone: the part's wears; anything else of a building: its part's records (and wears).
      const wearOnly = entry.kind === 'buildingWear';
      if (!entry.ids) { this.dirtyWear = 'all'; if (!wearOnly) this.dirtyParts = 'all'; continue; }
      for (const id of entry.ids) {
        const part = Math.floor(id / BUILDINGS_PER_PART);
        if (this.dirtyWear !== 'all') this.dirtyWear.add(part);
        if (!wearOnly && this.dirtyParts !== 'all') this.dirtyParts.add(part);
      }
    }
  }

  /** The head's sections an entry moves: the keys of its kind, and of the keyed parts the parts of the ids it names (all, without). */
  private headMoved(entry: Change): void {
    const dirt = this.dirtyHead;
    if (dirt.values !== 'all') for (const key of VALUE_KEYS) if (VALUE_KINDS[key].includes(entry.kind)) dirt.values.add(key);
    for (const key of SAVED_RECORD_KEYS) {
      if (!RECORD_KINDS[key].includes(entry.kind)) continue;
      const parts = dirt.records.get(key);
      if (parts === 'all') continue;
      if (!entry.ids) { dirt.records.set(key, 'all'); continue; }
      const set = parts ?? new Set<number>();
      // The ids name the records of every keyed part of the kind (a node's and a segment's alike): each one's part, in each.
      for (const id of entry.ids) set.add(Math.floor(id / RECORDS_PER_PART));
      dirt.records.set(key, set);
    }
  }

  private async write(doc: RoadDoc, settings: unknown, savedAt: number): Promise<boolean> {
    this.take(doc);
    const dirty = this.dirtyParts;
    const whole = dirty === 'all';
    const parts = dirty === 'all' ? everyPart(doc) : new Map([...dirty].map((part) => [part, buildingsOf(doc, part)] as const));
    // The stored parts whose wears alone are written: their records stand as stored.
    const wornDirty = this.dirtyWear;
    const worn = new Map<number, Building[]>();
    if (!whole) {
      const wornParts = wornDirty === 'all' ? [...this.stored] : [...wornDirty];
      for (const part of wornParts) if (!parts.has(part) && this.stored.has(part)) worn.set(part, buildingsOf(doc, part));
    }
    const head = this.dirtyHead;
    // Taken now; put back if the write fails (and with whatever came meanwhile).
    this.dirtyParts = new Set();
    this.dirtyWear = new Set();
    this.dirtyHead = { values: new Set(), records: new Map() };
    const put: [string, Blob][] = [];
    const remove: string[] = [];
    // DO NOT read the head's sections between the awaits below: a segment written after an edit, its node before it, is a map that fails to load.
    const headTexts: [string, string][] = [];
    const nextHead = this.headTexts(doc, head, headTexts, remove);
    const next = new Set(whole ? [] : this.stored);
    for (const [part, records] of parts) {
      if (records.length === 0) {
        next.delete(part);
        if (this.stored.has(part)) remove.push(this.partKey(part), this.wearKey(part));
        continue;
      }
      // `JSON.stringify` of a record is the text of its copy (`cloneBuilding` is a JSON round trip).
      put.push([this.partKey(part), await gzip(`[${records.map((b) => JSON.stringify(b)).join(',')}]`)]);
      put.push([this.wearKey(part), wearsOf(records)]);
      next.add(part);
    }
    // A stored part with no building left is a change of its records (`buildings`), never of wear alone.
    for (const [part, records] of worn) if (records.length) put.push([this.wearKey(part), wearsOf(records)]);
    if (whole) for (const part of this.stored) if (!next.has(part)) remove.push(this.partKey(part), this.wearKey(part));
    for (const [key, text] of headTexts) put.push([key, await gzip(text)]);
    const manifest: Manifest = {
      version: 4, savedAt, parts: [...next].sort((a, b) => a - b), settings,
      head: {
        values: [...nextHead.values].sort(),
        records: Object.fromEntries([...nextHead.records].filter(([, set]) => set.size).map(([key, set]) => [key, [...set].sort((a, b) => a - b)])),
      },
    };
    put.push([`${this.key}:manifest`, new Blob([JSON.stringify(manifest)])]);
    if (!(await this.store.write(put, remove))) {
      // Read again: what came while the write was under way (TS keeps the narrowing across the await).
      const since = this.dirtyParts as Set<number> | 'all';
      this.dirtyParts = dirty === 'all' || since === 'all' ? 'all' : new Set([...dirty, ...since]);
      const wornSince = this.dirtyWear as Set<number> | 'all';
      this.dirtyWear = wornDirty === 'all' || wornSince === 'all' ? 'all' : new Set([...wornDirty, ...wornSince]);
      const headSince = this.dirtyHead;
      const records = new Map(head.records);
      for (const [key, set] of headSince.records) records.set(key, joined(records.get(key) ?? new Set(), set));
      this.dirtyHead = { values: joined(head.values, headSince.values), records };
      return false;
    }
    this.stored.clear();
    for (const part of next) this.stored.add(part);
    this.storedHead = nextHead;
    return true;
  }

  /** The head's sections that moved as text, all read at once (one state of the map); the sections stored once they are written */
  private headTexts(doc: RoadDoc, dirt: HeadDirt, put: [string, string][], remove: string[]):
    { values: Set<SavedValueKey>; records: Map<SavedRecordKey, Set<number>> } {
    const was = this.storedHead;
    // The head as one text (manifest 3) goes once its sections are written: every one of them.
    if (!was) remove.push(`${this.key}:head`);
    const values = new Set(was?.values ?? []);
    for (const key of dirt.values === 'all' || !was ? VALUE_KEYS : dirt.values) {
      const value = doc.savedValue(key);
      if (value === undefined) {
        if (values.delete(key)) remove.push(this.valueKey(key));
        continue;
      }
      put.push([this.valueKey(key), JSON.stringify(value)]);
      values.add(key);
    }
    const records = new Map<SavedRecordKey, Set<number>>();
    for (const key of SAVED_RECORD_KEYS) {
      const stored = new Set(was?.records.get(key) ?? []);
      const moved = was ? dirt.records.get(key) : 'all';
      records.set(key, stored);
      if (!moved) continue;
      const byPart = moved === 'all' ? everyRecordPart(doc, key) : new Map([...moved].map((part) => [part, recordsOf(doc, key, part)] as const));
      // Every part stored that a whole write did not find again is gone.
      if (moved === 'all') for (const part of stored) if (!byPart.has(part)) byPart.set(part, { records: [] });
      for (const [part, records] of byPart) {
        if (records.records.length === 0) {
          if (stored.delete(part)) remove.push(this.recordKey(key, part));
          continue;
        }
        put.push([this.recordKey(key, part), JSON.stringify(records)]);
        stored.add(part);
      }
    }
    return { values, records };
  }

  /** The map saved in parts, or null when there is none or it cannot be read. */
  async read(): Promise<(PartedSession & StoredLayout) | null> {
    const [manifestBlob] = await this.store.get([`${this.key}:manifest`]);
    if (!manifestBlob) return null;
    const manifest: unknown = JSON.parse(await manifestBlob.text());
    if (!isManifest(manifest)) return null;
    const partBlobs = await this.store.get(manifest.parts.map((part) => this.partKey(part)));
    if (partBlobs.some((blob) => !blob)) return null;
    const head = manifest.head ? await this.readHead(manifest.head) : await this.readWholeHead();
    if (!head) return null;
    // Each part's wears, where kept (a map saved before them has none: its records carry their wear).
    const wearBlobs = await this.store.get(manifest.parts.map((part) => this.wearKey(part)));
    const buildings: unknown[] = [];
    for (let i = 0; i < partBlobs.length; i++) {
      const records: unknown = JSON.parse(await gunzip(partBlobs[i]!));
      if (!Array.isArray(records)) return null;
      const wearBlob = wearBlobs[i];
      const wears = wearBlob ? readWears(await wearBlob.text()) : null;
      for (const record of records) buildings.push(wears ? withWear(record, wears) : record);
    }
    return {
      document: { ...head, buildings } as unknown as SerializedDoc, settings: manifest.settings, savedAt: manifest.savedAt,
      parts: manifest.parts, head: manifest.head ?? null,
    };
  }

  /** The head as one text (manifest 3, every map saved in parts before the head was). */
  private async readWholeHead(): Promise<Record<string, unknown> | null> {
    const [blob] = await this.store.get([`${this.key}:head`]);
    if (!blob) return null;
    const head: unknown = JSON.parse(await gunzip(blob));
    return typeof head === 'object' && head !== null && !Array.isArray(head) ? head as Record<string, unknown> : null;
  }

  /** The head from its sections (manifest 4): each key stored whole, each keyed part's records in the document's order. */
  private async readHead(layout: HeadLayout): Promise<Record<string, unknown> | null> {
    const recordParts = SAVED_RECORD_KEYS.flatMap((key) => (layout.records[key] ?? []).map((part) => [key, part] as const));
    const blobs = await this.store.get([...layout.values.map((key) => this.valueKey(key)), ...recordParts.map(([key, part]) => this.recordKey(key, part))]);
    if (blobs.some((blob) => !blob)) return null;
    const head: Record<string, unknown> = {};
    for (let i = 0; i < layout.values.length; i++) head[layout.values[i]!] = JSON.parse(await gunzip(blobs[i]!));
    // The roads always (a map has a list of them, however empty); the other parts only when they hold any.
    const lists = new Map<SavedRecordKey, { order: number; record: unknown }[]>([['nodes', []], ['segments', []]]);
    for (let i = 0; i < recordParts.length; i++) {
      const [key, part] = recordParts[i]!;
      const stored: unknown = JSON.parse(await gunzip(blobs[layout.values.length + i]!));
      if (!isRecordPart(stored)) return null;
      const list = lists.get(key) ?? [];
      lists.set(key, list);
      stored.records.forEach((record, k) => list.push({ order: stored.order?.[k] ?? part * RECORDS_PER_PART + k, record }));
    }
    // In the order each part was kept in: by id, the lots by their place in the lots' order (`RoadDoc.lotOrder`).
    for (const [key, list] of lists) head[key] = list.sort((a, b) => a.order - b.order).map((entry) => entry.record);
    return head;
  }

  /** Runs after the saves under way: never a removal in the middle of a write. */
  private queued(run: () => Promise<boolean>): Promise<boolean> {
    const done = this.queue.then(run);
    this.queue = done.catch((error: unknown) => { console.error('[save] the parts of the map were not reached', error); return false; });
    return done;
  }

  /** The keys the saved map is held under, the manifest last. */
  private async savedKeys(): Promise<string[]> {
    const [manifestBlob] = await this.store.get([`${this.key}:manifest`]);
    const manifest: unknown = manifestBlob ? JSON.parse(await manifestBlob.text()) : null;
    if (!isManifest(manifest)) return [`${this.key}:head`, `${this.key}:manifest`];
    const parts = manifest.parts.flatMap((part) => [this.partKey(part), this.wearKey(part)]);
    const head = manifest.head ? [
      ...manifest.head.values.map((key) => this.valueKey(key)),
      ...SAVED_RECORD_KEYS.flatMap((key) => (manifest.head!.records[key] ?? []).map((part) => this.recordKey(key, part))),
    ] : [`${this.key}:head`];
    return [...head, ...parts, `${this.key}:manifest`];
  }

  /** The parts of the map removed: the map is saved whole again (`Persistence.saveSession`). */
  clear(): Promise<boolean> {
    return this.queued(async () => {
      this.forget();
      return this.store.write([], await this.savedKeys());
    });
  }

  /** The map in parts set aside under a key of its own, never deleted: it passed validation and the loader threw */
  setAside(at: number): Promise<boolean> {
    return this.queued(async () => {
      const keys = await this.savedKeys();
      const blobs = await this.store.get(keys);
      const aside = `${this.key}.unreadable.${at}`;
      const put = keys.flatMap((key, i) => {
        const blob = blobs[i];
        return blob ? [[`${aside}${key.slice(this.key.length)}`, blob] as const] : [];
      });
      if (put.length === 0) return false;
      this.forget();
      return this.store.write(put, keys);
    });
  }
}

/** A part of a keyed part of the head as stored: its records by id, and the lots' places in their order. */
interface RecordPart {
  readonly records: readonly unknown[];
  readonly order?: readonly number[];
}

function isRecordPart(value: unknown): value is RecordPart {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as RecordPart).records)) return false;
  const order = (value as RecordPart).order;
  return order === undefined || (isPartList(order) && order.length === (value as RecordPart).records.length);
}

/** A part's records as stored (`RoadDoc.savedRecord`), in increasing id order; the lots with their places in the lots' order. */
function recordPart(doc: RoadDoc, key: SavedRecordKey, ids: readonly number[]): RecordPart {
  const records = ids.map((id) => doc.savedRecord(key, id));
  return key === 'lots' ? { records, order: ids.map((id) => doc.lotOrder(id)!) } : { records };
}

/** One part of a keyed part of the head: the ids of its range looked up, never the whole part. */
function recordsOf(doc: RoadDoc, key: SavedRecordKey, part: number): RecordPart {
  const ids: number[] = [];
  for (let id = part * RECORDS_PER_PART; id < (part + 1) * RECORDS_PER_PART; id++) if (doc.hasSavedRecord(key, id)) ids.push(id);
  return recordPart(doc, key, ids);
}

/** @rebuild The first save of a map (or the diary cannot say): every record of a keyed part, by part. */
function everyRecordPart(doc: RoadDoc, key: SavedRecordKey): Map<number, RecordPart> {
  const byPart = new Map<number, number[]>();
  for (const id of doc.savedIds(key)) {
    const part = Math.floor(id / RECORDS_PER_PART);
    const list = byPart.get(part);
    if (list) list.push(id); else byPart.set(part, [id]);
  }
  return new Map([...byPart].map(([part, ids]) => [part, recordPart(doc, key, ids.sort((a, b) => a - b))] as const));
}

/** A part's wears: each building's id and decay (0: none), as numbers in pairs. */
function wearsOf(records: readonly Building[]): Blob {
  const pairs: number[] = [];
  for (const b of records) pairs.push(b.id, b.decay ?? 0);
  return new Blob([JSON.stringify(pairs)]);
}

/** A part's wears read back, by id; null when they cannot be read (the records' own wear stands). */
function readWears(text: string): Map<number, number> | null {
  const pairs: unknown = JSON.parse(text);
  if (!Array.isArray(pairs) || pairs.length % 2 !== 0 || !pairs.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const out = new Map<number, number>();
  for (let i = 0; i < pairs.length; i += 2) out.set(pairs[i] as number, pairs[i + 1] as number);
  return out;
}

/** A stored record with the wear kept for it laid over (no `decay` when it has none, as a record never worn). */
function withWear(record: unknown, wears: ReadonlyMap<number, number>): unknown {
  if (typeof record !== 'object' || record === null) return record;
  const r = record as { id?: unknown; decay?: number };
  const decay = typeof r.id === 'number' ? wears.get(r.id) : undefined;
  if (decay === undefined || decay === (r.decay ?? 0)) return record;
  const { decay: _was, ...rest } = r;
  return decay === 0 ? rest : { ...rest, decay };
}

/** The buildings of one part, by id: the ids of its range looked up, never the whole store. */
function buildingsOf(doc: RoadDoc, part: number): Building[] {
  const out: Building[] = [];
  for (let id = part * BUILDINGS_PER_PART; id < (part + 1) * BUILDINGS_PER_PART; id++) {
    const b = doc.buildings.get(id as BuildingId);
    if (b) out.push(b);
  }
  return out;
}

/** @rebuild The first save of a map (or the diary cannot say): every building, by part. */
function everyPart(doc: RoadDoc): Map<number, Building[]> {
  const byPart = new Map<number, Building[]>();
  for (const b of doc.buildings.all()) {
    const part = Math.floor(b.id / BUILDINGS_PER_PART);
    const list = byPart.get(part);
    if (list) list.push(b); else byPart.set(part, [b]);
  }
  for (const list of byPart.values()) list.sort((a, b) => a.id - b.id);
  return byPart;
}

/** A part store in an IndexedDB object store (`persistence.ts` opens the database). */
export function indexedDbParts(open: () => Promise<IDBDatabase | null>, storeName: string): PartStore {
  const transact = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T | null> => {
    const db = await open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, mode);
        const result = run(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(result());
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (error) {
        console.error('[save] the parts of the map could not be reached', error);
        resolve(null);
      }
    });
  };
  return {
    async get(keys) {
      const out = await transact('readonly', (store) => {
        const requests = keys.map((key) => store.get(key));
        return () => requests.map((r) => (r.result instanceof Blob ? r.result : null));
      });
      return out ?? keys.map(() => null);
    },
    async write(put, remove) {
      const out = await transact('readwrite', (store) => {
        for (const [key, blob] of put) store.put(blob, key);
        for (const key of remove) store.delete(key);
        return () => true;
      });
      return out === true;
    },
  };
}
