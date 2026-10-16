import { describe, expect, it } from 'vitest';
import { DocImage, PARTS_OF_SAVED } from '@world/docImage';
import { samePlain } from '@core/plain';
import { LIST_KINDS, RoadDoc } from '@world/doc';
import { JournalCursor } from '@world/derived';
import { History } from '@editor/history';
import type { ChangeKind } from '@world/changes';

describe('the image of the document', () => {
  it('names a part for every key of the saved map that the player changes', () => {
    const doc = new RoadDoc();
    const parts = Object.values(PARTS_OF_SAVED).flat() as (string | null)[];
    const records = new Set(['nodes', 'segments', 'poles', 'poleSpans', 'landscape', 'barriers', 'buildings', 'lots']);
    for (const part of parts) {
      if (part === null || records.has(part)) continue;
      if (part in LIST_KINDS) expect(Array.isArray(doc.listOf(part as never)), part).toBe(true);
      else expect(() => doc.valueOf(part as never), part).not.toThrow();
    }
  });

  it('compares plain data by value, a key holding undefined as no key', () => {
    expect(samePlain({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(samePlain({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(samePlain({ a: 1 }, { a: 1, b: 0 })).toBe(false);
    expect(samePlain([1, 2], [2, 1])).toBe(false);
    expect(samePlain(NaN, NaN)).toBe(true);
    expect(samePlain(null, {})).toBe(false);
  });

  it('finds nothing when nothing changed, and only the record that did', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: 100, y: 0 });
    doc.addSegment(a.id, b.id, 1);
    const image = new DocImage(doc);
    expect(image.commit(doc)).toBe(null);
    doc.moveNode(b.id, { x: 120, y: 10 });
    const patch = image.commit(doc)!;
    expect(patch.records.map((r) => `${r.part}:${r.id}`)).toContain(`nodes:${b.id}`);
    expect(patch.records.some((r) => r.part === 'nodes' && r.id === a.id)).toBe(false);
    expect(image.commit(doc)).toBe(null);
  });

  it('an undo and a document put back name the poles, wires, furniture and walls they change, by id', () => {
    // Written without ids, a reader by id (the undo image, the solids) took every pole and bench of the map as changed
    const doc = new RoadDoc();
    const kinds: ChangeKind[] = ['utilities', 'landscape', 'barriers'];
    const p = doc.addPole({ x: 0, y: 0 }), q = doc.addPole({ x: 40, y: 0 });
    doc.addLandscape('bench', { x: 10, y: 10 });
    const history = new History();
    history.begin(doc);
    const span = doc.addPoleSpan(p.id, q.id)!;
    const bench = doc.addLandscape('bench', { x: 20, y: 10 });
    const wall = doc.addBarrier('wall', [{ x: 0, y: 30 }, { x: 30, y: 30 }])!;
    history.end(doc);
    const reader = new JournalCursor(kinds, true);
    reader.read(doc.changes);
    const named = (): number[] => {
      const entries = reader.read(doc.changes);
      expect(entries).not.toBeNull();
      return [...new Set(entries!.flatMap((e) => e.ids!))].sort((a, b) => a - b);
    };
    history.undo(doc);
    expect(named()).toEqual([...new Set([p.id, q.id, span.id, bench.id, wall.id])].sort((a, b) => a - b));
    history.redo(doc);
    expect(named()).toEqual([...new Set([p.id, q.id, span.id, bench.id, wall.id])].sort((a, b) => a - b));
    // A whole document put in its place: the items that differ, by id.
    const other = RoadDoc.fromJSON(doc.toJSON());
    other.removeLandscape(bench.id);
    doc.replaceFromJSON(other.toJSON());
    expect(named()).toEqual([bench.id]);
  });
});
