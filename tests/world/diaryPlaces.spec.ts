import { afterEach, describe, expect, it, vi } from 'vitest';

import { RoadDoc, type RoadNode, type SerializedDoc } from '@world/doc';
import type { Change, ChangeKind, ChangeRect } from '@world/changes';
import { MAX_PAINT_DABS } from '@world/terrainPaint';
import { MAX_FOG_DABS } from '@world/fogPaint';
import { MAX_GULLY_DABS } from '@world/gullies';
import type { ElementItem } from '@world/elements';
import { MAX_TREE_CLEARINGS, type PlantedTree } from '@world/trees';
import { MAX_TERRAIN_STAMPS } from '@world/terrain';
import { blueprintByKey } from '@world/buildings/blueprints';
import { type Building, cloneBuilding } from '@world/buildings/types';

/** The diary says WHERE each change happened (`changes.ts`) */

const entriesSince = (doc: RoadDoc, seen: number, kind: ChangeKind): Change[] => doc.changes.since(seen, [kind]) ?? [];
const inside = (r: ChangeRect, x: number, y: number): boolean => r[0] <= x && x <= r[2] && r[1] <= y && y <= r[3];
/** Whether the entries have places (none `null`) and one of them reaches (x, y). */
function covers(entries: readonly Change[], x: number, y: number): boolean {
  return entries.some((e) => e.rects !== null && e.rects.some((r) => inside(r, x, y)));
}
const placed = (entries: readonly Change[]): boolean => entries.length > 0 && entries.every((e) => e.rects !== null);

function road(doc: RoadDoc, from: { x: number; y: number }, to: { x: number; y: number }): { a: RoadNode; b: RoadNode; id: number } {
  const a = doc.addNode(from), b = doc.addNode(to);
  const s = doc.addSegment(a.id, b.id, 1)!;
  return { a, b, id: s.id };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the diary is told where a road was and where it is', () => {
  it('a node moved: its old place and its road\'s, as well as the new', () => {
    const doc = new RoadDoc();
    const { b } = road(doc, { x: 0, y: 0 }, { x: 500, y: 0 });
    const seen = doc.changes.version;
    doc.moveNode(b.id, { x: 500, y: 400 });
    for (const kind of ['roads', 'traffic'] as const) {
      const entries = entriesSince(doc, seen, kind);
      expect(placed(entries)).toBe(true);
      expect(covers(entries, 500, 0)).toBe(true);
      expect(covers(entries, 250, 0)).toBe(true);
      expect(covers(entries, 500, 400)).toBe(true);
    }
  });

  it('a curve taken away: the bulge it had', () => {
    const doc = new RoadDoc();
    const { id } = road(doc, { x: 0, y: 0 }, { x: 600, y: 0 });
    doc.setSegmentCurve(id as never, { t: 0.5, h: 80 });
    const bulge = Math.abs(doc.segment(id as never)!.curve!.h);
    expect(bulge).toBeGreaterThan(40);
    const seen = doc.changes.version;
    doc.setSegmentCurve(id as never, null);
    const entries = entriesSince(doc, seen, 'roads');
    expect(placed(entries)).toBe(true);
    expect(covers(entries, 300, bulge) && covers(entries, 300, -bulge)).toBe(true);
  });

  it('loose nodes dropped: where they stood, not the whole map', () => {
    const doc = new RoadDoc();
    road(doc, { x: 0, y: 0 }, { x: 300, y: 0 });
    doc.addNode({ x: 1000, y: 1000 });
    const seen = doc.changes.version;
    expect(doc.pruneOrphanNodes()).toBe(1);
    const entries = entriesSince(doc, seen, 'roads');
    expect(placed(entries)).toBe(true);
    expect(covers(entries, 1000, 1000)).toBe(true);
    expect(covers(entries, 150, 0)).toBe(false);
  });
});

describe('only what changed', () => {
  it('a bench placed in a working copy writes no poles', () => {
    const doc = new RoadDoc();
    doc.addPole({ x: 100, y: 100 });
    const work = doc.clone();
    work.addLandscape('bench', { x: 200, y: 200 });
    const seen = doc.changes.version;
    doc.replaceWith(work);
    expect(entriesSince(doc, seen, 'utilities')).toEqual([]);
    expect(covers(entriesSince(doc, seen, 'landscape'), 200, 200)).toBe(true);
  });

  it('a node only raised moves the roads, not the traffic\'s plan: in a working copy and in an undo', () => {
    const doc = new RoadDoc();
    const { a } = road(doc, { x: 0, y: 0 }, { x: 300, y: 0 });
    const work = doc.clone();
    work.setNodeHeightOffset(a.id, 2);
    let seen = doc.changes.version;
    doc.replaceWith(work);
    expect(entriesSince(doc, seen, 'roads')).toHaveLength(1);
    expect(entriesSince(doc, seen, 'traffic')).toEqual([]);

    seen = doc.changes.version;
    doc.restore({ records: [{ part: 'nodes', id: a.id, value: { ...doc.node(a.id)!, incident: [...doc.node(a.id)!.incident], heightOffset: 0 } }], lists: [], values: [] });
    expect(placed(entriesSince(doc, seen, 'roads'))).toBe(true);
    expect(entriesSince(doc, seen, 'traffic')).toEqual([]);
  });

  it('the paint style, set or put back by an undo, is its own kind: not the roads, not the traffic\'s plan', () => {
    const doc = new RoadDoc();
    road(doc, { x: 0, y: 0 }, { x: 300, y: 0 });
    let seen = doc.changes.version;
    const revision = doc.revision;
    doc.setMarkingStyle('us');
    expect(entriesSince(doc, seen, 'markingStyle')).toHaveLength(1);
    expect(entriesSince(doc, seen, 'roads')).toEqual([]);
    expect(doc.revision).toBe(revision);
    seen = doc.changes.version;
    doc.restore({ records: [], lists: [], values: [{ part: 'markingStyle', value: 'br' }] });
    expect(doc.markingStyle).toBe('br');
    expect(entriesSince(doc, seen, 'markingStyle')).toHaveLength(1);
    expect(entriesSince(doc, seen, 'roads')).toEqual([]);
    expect(entriesSince(doc, seen, 'traffic')).toEqual([]);
  });

  it('a stretch of trees put back by an undo: where they stand', () => {
    const doc = new RoadDoc();
    const seen = doc.changes.version;
    const tree: PlantedTree = { x: 700, y: -300, height: 10, yaw: 0, seed: 0.5 };
    doc.restore({ records: [], lists: [{ part: 'trees', start: 0, remove: 0, items: [tree] }], values: [] });
    expect(doc.trees).toHaveLength(1);
    const entries = entriesSince(doc, seen, 'trees');
    expect(placed(entries)).toBe(true);
    expect(covers(entries, 700, -300)).toBe(true);
  });
});

describe('a list at its cap: the place of the item that left, not the whole map', () => {
  const dab = (i: number): { x: number; y: number; radius: number; strength: number } =>
    ({ x: i === 0 ? -2000 : 2000, y: i === 0 ? -2000 : 2000, radius: 10, strength: 1 });

  it('paint, fog, gullies, stamps, clearings', () => {
    const doc = new RoadDoc();
    for (let i = 0; i < MAX_PAINT_DABS; i++) doc.addPaintDab({ kind: 'sand', ...dab(i) });
    for (let i = 0; i < MAX_FOG_DABS; i++) doc.addFogDab({ ...dab(i), height: 10, speed: 1 });
    for (let i = 0; i < MAX_GULLY_DABS; i++) doc.addGullyDab(dab(i));
    for (let i = 0; i < MAX_TERRAIN_STAMPS; i++) doc.addTerrainStamp({ ...dab(i), mode: 'raise' });
    for (let i = 0; i < MAX_TREE_CLEARINGS; i++) doc.cutTrees(dab(i).x, dab(i).y, 10);
    const seen = doc.changes.version;
    doc.addPaintDab({ kind: 'sand', ...dab(1) });
    doc.addFogDab({ ...dab(1), height: 10, speed: 1 });
    doc.addGullyDab(dab(1));
    doc.addTerrainStamp({ ...dab(1), mode: 'raise' });
    doc.cutTrees(2000, 2000, 10);
    for (const kind of ['paint', 'fog', 'gullies', 'terrain', 'clearings'] as const) {
      const entries = entriesSince(doc, seen, kind);
      expect(placed(entries), kind).toBe(true);
      expect(covers(entries, -2000, -2000), kind).toBe(true);
      expect(covers(entries, 0, 0), kind).toBe(false);
    }
  });

  it('trees and elements: where they were laid, the oldest kept however many there are', () => {
    const doc = new RoadDoc();
    const tree = (x: number): PlantedTree => ({ x, y: x, height: 10, yaw: 0, seed: 0.5 });
    const element = (x: number): ElementItem => ({ kind: 'rock', x, y: x, size: 2, yaw: 0, seed: 0.5 } as unknown as ElementItem);
    // Past the counts the map once dropped its oldest at (20 000 trees, 60 000 elements): nothing of the player's goes.
    doc.plantTrees([tree(-2000), ...Array.from({ length: 20_000 }, () => tree(2000))]);
    doc.addElements([element(-2000), ...Array.from({ length: 60_000 }, () => element(2000))]);
    const seen = doc.changes.version;
    doc.plantTrees([tree(2000)]);
    doc.addElements([element(2000)]);
    expect(doc.trees[0]!.x).toBe(-2000);
    expect(doc.trees.length).toBe(20_002);
    expect(doc.elements[0]!.x).toBe(-2000);
    expect(doc.elements.length).toBe(60_002);
    for (const kind of ['trees', 'elements'] as const) {
      const entries = entriesSince(doc, seen, kind);
      expect(placed(entries), kind).toBe(true);
      expect(covers(entries, 2000, 2000), kind).toBe(true);
      expect(covers(entries, -2000, -2000), kind).toBe(false);
    }
  });

  it('a layer cleared: where its items lay', () => {
    const doc = new RoadDoc();
    doc.addPaintDab({ kind: 'sand', ...dab(1) });
    const seen = doc.changes.version;
    doc.clearPaint();
    const entries = entriesSince(doc, seen, 'paint');
    expect(placed(entries)).toBe(true);
    expect(covers(entries, 2000, 2000)).toBe(true);
    expect(covers(entries, 0, 0)).toBe(false);
  });
});

describe('work that does not grow with the map', () => {
  /** A map's text with `n` lots whose `id` counts its reads. */
  function lotsRead(n: number): number {
    let reads = 0;
    const lots = Array.from({ length: n }, (_, i) => {
      const lot = { corners: [{ x: i, y: 0 }, { x: i + 1, y: 0 }, { x: i + 1, y: 1 }, { x: i, y: 1 }] };
      Object.defineProperty(lot, 'id', { enumerable: true, get: () => { reads++; return i + 1; } });
      return lot;
    });
    const doc = RoadDoc.fromJSON({ ...new RoadDoc().toJSON(), lots } as unknown as SerializedDoc);
    expect(doc.lots).toHaveLength(n);
    expect(doc.lots.map((l) => l.id)).toEqual(lots.map((_, i) => i + 1));
    return reads;
  }

  it('loading lots reads each lot a few times, not once for every other', () => {
    const one = lotsRead(500), four = lotsRead(2000);
    // Linear: four times the lots, four times the reads (quadratic was sixteen).
    expect(four / one).toBeLessThan(5);
  });

  function house(x: number): Omit<Building, 'id'> {
    return { ...cloneBuilding(blueprintByKey('house')!.body as unknown as Building), x, y: 0, rotation: 0 };
  }

  /** A town of `n` houses; one moved in a working copy and taken back: the map lookups it cost. */
  function oneMoved(n: number): number {
    const doc = new RoadDoc();
    for (let i = 0; i < n; i++) doc.buildings.add(house(i * 40));
    doc.buildings.near(0, -10, 10, 10);
    const grid = (doc.buildings as unknown as { grid: object | null }).grid;
    expect(grid).not.toBeNull();
    const work = doc.clone();
    const last = [...work.buildings.all()].at(-1)!;
    work.buildings.put({ ...last, y: 500 });
    const seen = doc.changes.version;
    const get = vi.spyOn(Map.prototype, 'get');
    doc.replaceWith(work);
    const lookups = get.mock.calls.length;
    get.mockRestore();
    // The result: the copy's buildings, the grid kept and up to date, the diary told of that one only.
    expect(JSON.stringify(doc.buildings.toJSON())).toBe(JSON.stringify(work.buildings.toJSON()));
    expect((doc.buildings as unknown as { grid: object | null }).grid).toBe(grid);
    expect(doc.buildings.near(last.x - 1, 499, last.x + 1, 501).map((b) => b.id)).toContain(last.id);
    expect(doc.buildings.near(last.x - 1, -1, last.x + 1, 1).map((b) => b.id)).not.toContain(last.id);
    const entries = entriesSince(doc, seen, 'buildings');
    expect(entries.flatMap((e) => e.ids ?? [])).toEqual([last.id, last.id]);
    return lookups;
  }

  it('a road drawn takes back only the buildings its copy changed', () => {
    const one = oneMoved(100), four = oneMoved(400);
    expect(four).toBeLessThan(one * 1.5);
  });
});
