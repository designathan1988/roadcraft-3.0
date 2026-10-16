import { describe, expect, it } from 'vitest';
import { Box3, type Mesh, type Object3D } from 'three';

import { beginFrameWork } from '@core/frameWork';
import { createBuildingLayer } from '@render/buildings/layer';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/** The buildings layer takes a change of some buildings by their ids in the diary (`townIndex.ts`, AUDITORIA A1) */
const SPACING = m(70);
const flat = (): number => 0;

function body(index: number, x: number, y: number): Omit<Building, 'id'> {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), x, y, rotation: 0 } as Omit<Building, 'id'>;
}

function settle(layer: ReturnType<typeof createBuildingLayer>, doc: RoadDoc): void {
  for (let frame = 0; frame < 5000; frame++) {
    beginFrameWork();
    layer.update(doc, flat, 'g');
    if (!layer.pending) return;
  }
  throw new Error('the layer never settled');
}

/** What a layer draws: its triangles, and each far cell's mesh by its vertices. */
function drawn(layer: ReturnType<typeof createBuildingLayer>): { triangles: number; far: number[] } {
  const far: number[] = [];
  layer.group.traverse((o: Object3D) => {
    if (o.parent?.name === 'buildings-far' && (o as Mesh).isMesh) far.push((o as Mesh).geometry.getAttribute('position').count);
  });
  return { triangles: layer.triangles, far: far.sort((a, b) => a - b) };
}

describe('the buildings layer, a change at a time', () => {
  it('draws what a layer put together from nothing draws', () => {
    let seed = 11;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const doc = new RoadDoc();
    const side = 6;
    for (let i = 0; i < side * side; i++) doc.buildings.add(body(i, (i % side) * SPACING, Math.floor(i / side) * SPACING));
    const live = createBuildingLayer();
    settle(live, doc);
    let incremental = 0;
    for (let round = 0; round < 12; round++) {
      // A cell emptied whole, and a building taken to a cell where none stood.
      if (round === 4) for (const b of [...doc.buildings.all()]) if (b.x < m(240) && b.y < m(240)) doc.buildings.remove(b.id);
      if (round === 7) doc.buildings.add(body(3, side * SPACING + m(500), m(10)));
      // A few edits between two frames, as a tool or the growth makes them.
      for (let k = 0, n = round === 4 || round === 7 ? 0 : 1 + Math.floor(rand() * 3); k < n; k++) {
        const ids = [...doc.buildings.all()].map((b) => b.id);
        const pick = ids[Math.floor(rand() * ids.length)]! as BuildingId;
        const roll = rand();
        if (roll < 0.3) doc.buildings.add(body(Math.floor(rand() * 100), rand() * side * SPACING, rand() * side * SPACING));
        else if (roll < 0.5) doc.buildings.remove(pick);
        else if (roll < 0.75) {
          // Moved: across a cell's edge or within it.
          const b = doc.buildings.get(pick)!;
          doc.buildings.put({ ...b, x: b.x + (rand() - 0.5) * m(300), y: b.y + (rand() - 0.5) * m(60) });
        } else {
          const b = doc.buildings.get(pick)!;
          doc.buildings.put({ ...b, palette: (b.palette + 1) % 8 });
        }
      }
      // A change overtaking one still being put together: the cells of both are swapped.
      if (round === 9) {
        beginFrameWork();
        live.update(doc, flat, 'g');
        const b = doc.buildings.get([...doc.buildings.all()][0]!.id)!;
        doc.buildings.put({ ...b, x: b.x + m(250) });
      }
      // Taken in by the ids alone: the town is not walked.
      const all = doc.buildings.all.bind(doc.buildings);
      let walked = 0;
      doc.buildings.all = () => { walked++; return all(); };
      const before = live.version;
      settle(live, doc);
      doc.buildings.all = all;
      if (live.version > before && walked === 0) incremental++;
      const fresh = createBuildingLayer();
      settle(fresh, doc);
      expect(drawn(live)).toEqual(drawn(fresh));
      for (let i = 0; i < 300; i++) {
        const x = rand() * side * SPACING, y = rand() * side * SPACING;
        expect(live.covers(x, y)).toBe(fresh.covers(x, y));
      }
      fresh.dispose();
    }
    expect(incremental).toBe(12);
    live.dispose();
  });

  it("draws a building's new wear, by its id, without walking the town", () => {
    const doc = new RoadDoc();
    for (let i = 0; i < 9; i++) doc.buildings.add(body(i, (i % 3) * SPACING, Math.floor(i / 3) * SPACING));
    const live = createBuildingLayer();
    settle(live, doc);
    const worn = (): number => {
      let most = 0;
      live.group.traverse((o: Object3D) => {
        const decay = (o as Mesh).isMesh ? (o as Mesh).geometry.getAttribute('aDecay') : undefined;
        if (decay) for (let i = 0; i < decay.count; i++) most = Math.max(most, decay.getX(i));
      });
      return most;
    };
    expect(worn()).toBeLessThan(0.9);
    const shape = doc.buildings.revision;
    doc.buildings.wear([...doc.buildings.all()][4]!.id, 0.9);
    expect(doc.buildings.revision).toBe(shape);
    const all = doc.buildings.all.bind(doc.buildings);
    let walked = 0;
    doc.buildings.all = () => { walked++; return all(); };
    const before = live.version;
    settle(live, doc);
    doc.buildings.all = all;
    expect(live.version).toBeGreaterThan(before);
    expect(walked).toBe(0);
    expect(worn()).toBeCloseTo(0.9, 5);
    live.dispose();
  });
});

describe('the buildings layer by the eye', () => {
  it('lets go of the detail of the cells left far behind in perspective, and brings it back on return', () => {
    const doc = new RoadDoc();
    // Two districts 4 km apart, nine buildings each.
    for (const ox of [0, m(4000)]) for (let i = 0; i < 9; i++) doc.buildings.add(body(i, ox + (i % 3) * SPACING, Math.floor(i / 3) * SPACING));
    const layer = createBuildingLayer();
    const pxAtMetre = 1080 / (2 * Math.tan((35 * Math.PI) / 360));
    /** The eye 150 m up over a point: the detail meshes resident then, by the district they stand in (three's x is the world's). */
    const lookAt = (x: number): { first: number; second: number } => {
      for (let frame = 0; frame < 5000; frame++) {
        beginFrameWork();
        layer.levelOfDetail(x, m(-200), m(150), pxAtMetre, null);
        layer.update(doc, flat, 'g');
        if (!layer.pending) break;
      }
      const out = { first: 0, second: 0 };
      layer.group.updateMatrixWorld(true);
      layer.group.traverse((o) => {
        if (!(o as Mesh).isMesh || o.parent?.name !== 'buildings') return;
        const box = new Box3().setFromObject(o);
        if (box.isEmpty()) return;
        if ((box.min.x + box.max.x) / 2 < m(2000)) out.first++; else out.second++;
      });
      return out;
    };
    const atFirst = lookAt(m(70));
    expect(atFirst.first).toBeGreaterThan(0);
    const atSecond = lookAt(m(4070));
    expect(atSecond.second).toBeGreaterThan(0);
    // 4 km behind: past twice the farthest a cell is drawn near (1.3 km at 1,080 pixels high).
    expect(atSecond.first).toBe(0);
    expect(lookAt(m(70))).toEqual({ first: atFirst.first, second: 0 });
    layer.dispose();
  });
});
