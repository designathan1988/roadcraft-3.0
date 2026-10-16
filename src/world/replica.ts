import type { DocChangeKind } from './changes';
import { JournalCursor } from './derived';
import type { RecordPart, Restoration, RoadDoc, ValuePart } from './doc';

/** THE PARTS OF THE DOCUMENT A WORKER READS, kept on a copy there (`sim.worker.ts`, `growth.worker.ts`) by the diary */

/** A record part a copy reads and the kinds of change that move it. */
interface RecordRead {
  readonly part: RecordPart;
  readonly kinds: readonly DocChangeKind[];
}

/** What a copy reads: its record parts and its values, each with the kind that moves it. */
export interface ReplicaReads {
  readonly records: readonly RecordRead[];
  readonly values: readonly { readonly part: ValuePart; readonly kind: DocChangeKind }[];
}

/** How each record part is read: its ids, a record by id. */
const PARTS: Readonly<Partial<Record<RecordPart, { readonly ids: (d: RoadDoc) => Iterable<number>; readonly get: (d: RoadDoc, id: number) => unknown }>>> = {
  nodes: { ids: (d) => d.nodes.keys(), get: (d, id) => d.nodes.get(id as never) },
  segments: { ids: (d) => d.segments.keys(), get: (d, id) => d.segments.get(id as never) },
  buildings: {
    /** @rebuild Every building: the first patch, a map opened. */
    ids: (d) => [...d.buildings.all()].map((b) => b.id),
    get: (d, id) => d.buildings.get(id as never),
  },
  lots: { ids: (d) => [...d.lotStore.all()].map((l) => l.id), get: (d, id) => d.lotStore.get(id) },
};

const VALUES: ReplicaReads['values'] = [
  { part: 'transit', kind: 'transit' },
  { part: 'markingStyle', kind: 'markingStyle' },
];

/** What the simulation reads: the roads, the buildings and their wear, the lots. */
export const SIM_READS: ReplicaReads = {
  records: [
    { part: 'nodes', kinds: ['roads', 'traffic'] },
    { part: 'segments', kinds: ['roads', 'traffic'] },
    { part: 'buildings', kinds: ['buildings', 'buildingWear'] },
    { part: 'lots', kinds: ['lots'] },
  ],
  values: VALUES,
};

/** What the growth reads (`growth.worker.ts`): the same but the buildings' wear. */
export const GROWTH_READS: ReplicaReads = {
  records: [
    { part: 'nodes', kinds: ['roads', 'traffic'] },
    { part: 'segments', kinds: ['roads', 'traffic'] },
    { part: 'buildings', kinds: ['buildings'] },
    { part: 'lots', kinds: ['lots'] },
  ],
  values: VALUES,
};

/** What the copy takes in: the records and values as the document has them now */
export interface ReplicaPatch {
  readonly restoration: Restoration;
  readonly whole: readonly RecordPart[];
  /** Whether it carries nodes or segments: the copy's network is rebuilt. */
  readonly roads: boolean;
}

/** A record the copy holds already, as the document holds it (the page put the copy's own record there): not sent again. */
export type ReplicaKnown = (part: RecordPart, id: number, value: unknown) => boolean;

/** The document's changes since the last patch, as the copy takes them in (`applyReplica`), read from the diary */
export class ReplicaFeed {
  /** One cursor a record part (by id) and a value. */
  private readonly records: { readonly read: RecordRead; readonly cursor: JournalCursor }[];
  private readonly values: { readonly read: ReplicaReads['values'][number]; readonly cursor: JournalCursor }[];

  constructor(reads: ReplicaReads = SIM_READS) {
    this.records = reads.records.map((r) => ({ read: r, cursor: new JournalCursor(r.kinds, true) }));
    this.values = reads.values.map((v) => ({ read: v, cursor: new JournalCursor([v.kind]) }));
  }

  /** Everything again at the next patch (a copy made anew). */
  restart(): void {
    for (const r of this.records) r.cursor.reset();
    for (const v of this.values) v.cursor.reset();
  }

  /** What changed since the last patch, but what the copy is `known` to hold; null when nothing did. */
  take(doc: RoadDoc, known?: ReplicaKnown): ReplicaPatch | null {
    const records: { part: RecordPart; id: number; value: unknown; order?: number }[] = [];
    const values: { part: ValuePart; value: unknown }[] = [];
    const whole: RecordPart[] = [];
    let roads = false;
    const put = (part: RecordPart, id: number): void => {
      const value = PARTS[part]!.get(doc, id);
      // A lot with its place in the lots' order: the open lots are taken in that order (`world/openLots.ts`).
      const order = part === 'lots' && value !== undefined ? doc.lotStore.orderOf(id) : undefined;
      records.push(order === undefined ? { part, id, value } : { part, id, value, order });
    };
    for (const { read: r, cursor } of this.records) {
      const entries = cursor.read(doc.changes);
      if (entries?.length !== 0 && (r.part === 'nodes' || r.part === 'segments')) roads = true;
      if (entries === null) {
        // Every record of the part when the diary cannot say which changed: a map opened, the first patch.
        whole.push(r.part);
        for (const id of PARTS[r.part]!.ids(doc)) put(r.part, id);
        continue;
      }
      const ids = new Set<number>();
      for (const entry of entries) for (const id of entry.ids!) ids.add(id);
      for (const id of ids) if (!known?.(r.part, id, PARTS[r.part]!.get(doc, id))) put(r.part, id);
    }
    for (const { read: v, cursor } of this.values) {
      const entries = cursor.read(doc.changes);
      if (entries === null || entries.length) values.push({ part: v.part, value: doc.valueOf(v.part) });
    }
    if (!records.length && !values.length) return null;
    return { restoration: { records, lists: [], values }, whole, roads };
  }
}

/** A patch taken into the copy: a part sent whole lets go of its records the patch does not name, then each record is put back. */
export function applyReplica(doc: RoadDoc, patch: ReplicaPatch): void {
  const records = [...patch.restoration.records];
  for (const part of patch.whole) {
    const sent = new Set(records.filter((x) => x.part === part).map((x) => x.id));
    for (const id of [...PARTS[part]!.ids(doc)]) if (!sent.has(id)) records.push({ part, id, value: undefined });
  }
  doc.restore({ records, lists: [], values: patch.restoration.values });
}
