import type { DocChangeKind } from './changes';
import { JournalCursor } from './derived';
import type { RecordPart, Restoration, RoadDoc, ValuePart } from './doc';

/** THE PARTS OF THE DOCUMENT THE SIMULATION READS, kept on a copy elsewhere (`sim.worker.ts`) by the diary */

/** A record part the simulation reads, the kinds of change that move it, and how it is read. */
interface RecordRead {
  readonly part: RecordPart;
  readonly kinds: readonly DocChangeKind[];
  readonly ids: (d: RoadDoc) => Iterable<number>;
  readonly get: (d: RoadDoc, id: number) => unknown;
}

const RECORDS: readonly RecordRead[] = [
  { part: 'nodes', kinds: ['roads', 'traffic'], ids: (d) => d.nodes.keys(), get: (d, id) => d.nodes.get(id as never) },
  { part: 'segments', kinds: ['roads', 'traffic'], ids: (d) => d.segments.keys(), get: (d, id) => d.segments.get(id as never) },
  {
    part: 'buildings', kinds: ['buildings', 'buildingWear'],
    /** @rebuild Every building: the first patch, a map opened. */
    ids: (d) => [...d.buildings.all()].map((b) => b.id),
    get: (d, id) => d.buildings.get(id as never),
  },
  { part: 'lots', kinds: ['lots'], ids: (d) => [...d.lotStore.all()].map((l) => l.id), get: (d, id) => d.lotStore.get(id) },
];

/** The values the simulation reads, and the kind that moves each. */
const VALUES: readonly { readonly part: ValuePart; readonly kind: DocChangeKind }[] = [
  { part: 'transit', kind: 'transit' },
  { part: 'markingStyle', kind: 'markingStyle' },
];

/** What the copy takes in: the records and values as the document has them now */
export interface ReplicaPatch {
  readonly restoration: Restoration;
  readonly whole: readonly RecordPart[];
  /** Whether it carries nodes or segments: the copy's network is rebuilt. */
  readonly roads: boolean;
}

/** The document's changes since the last patch, as the copy takes them in (`applyReplica`), read from the diary */
export class ReplicaFeed {
  /** One cursor a record part (by id) and a value. */
  private readonly records = RECORDS.map((r) => ({ read: r, cursor: new JournalCursor(r.kinds, true) }));
  private readonly values = VALUES.map((v) => ({ read: v, cursor: new JournalCursor([v.kind]) }));

  /** Everything again at the next patch (a copy made anew). */
  restart(): void {
    for (const r of this.records) r.cursor.reset();
    for (const v of this.values) v.cursor.reset();
  }

  /** What changed since the last patch; null when nothing did. */
  take(doc: RoadDoc): ReplicaPatch | null {
    const records: { part: RecordPart; id: number; value: unknown }[] = [];
    const values: { part: ValuePart; value: unknown }[] = [];
    const whole: RecordPart[] = [];
    let roads = false;
    for (const { read: r, cursor } of this.records) {
      const entries = cursor.read(doc.changes);
      if (entries?.length !== 0 && (r.part === 'nodes' || r.part === 'segments')) roads = true;
      if (entries === null) {
        // Every record of the part when the diary cannot say which changed: a map opened, the first patch.
        whole.push(r.part);
        for (const id of r.ids(doc)) records.push({ part: r.part, id, value: r.get(doc, id) });
        continue;
      }
      const ids = new Set<number>();
      for (const entry of entries) for (const id of entry.ids!) ids.add(id);
      for (const id of ids) records.push({ part: r.part, id, value: r.get(doc, id) });
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
    const r = RECORDS.find((x) => x.part === part)!;
    const sent = new Set(records.filter((x) => x.part === part).map((x) => x.id));
    for (const id of [...r.ids(doc)]) if (!sent.has(id)) records.push({ part, id, value: undefined });
  }
  doc.restore({ records, lists: [], values: patch.restoration.values });
}
