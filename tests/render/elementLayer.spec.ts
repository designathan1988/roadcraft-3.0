import { describe, expect, it } from 'vitest';
import { BoxGeometry, MeshStandardMaterial, Vector3 } from 'three';

import type { ChangeRect } from '../../src/world/changes';
import type { ElementItem, ElementKind } from '../../src/world/elements';
import { m } from '../../src/world/units';
import { createElementLayer, type ElementKit } from '../../src/render/elements';
import type { Exhaust } from '../../src/render/exhaust';

const kit: ElementKit = {
  models: new Map<ElementKind, { geometry: BoxGeometry; material: MeshStandardMaterial }[][]>([
    ['stones', [[{ geometry: new BoxGeometry(), material: new MeshStandardMaterial() }]]],
    ['grass', [[{ geometry: new BoxGeometry(), material: new MeshStandardMaterial() }], [{ geometry: new BoxGeometry(), material: new MeshStandardMaterial() }]]],
  ]),
  dispose() {},
};

/** A document's elements, filed by place as `RoadDoc.elementsIn` files them (a superset: the layer tests each). */
const docOf = (elements: ElementItem[]) => ({
  elements,
  elementsIn: (r: ChangeRect) => elements.filter((e) => e.x >= r[0] - m(32) && e.x <= r[2] + m(32) && e.y >= r[1] - m(32) && e.y <= r[3] + m(32)),
});
const item = (kind: ElementKind, x: number, y: number, seed = 0.2): ElementItem => ({ kind, x, y, size: m(1), yaw: 0, seed });

describe('the elements drawn cell by cell', () => {
  it('reads again only the cells a change reached, and sets on the ground only those that hold elements', () => {
    const elements = [item('stones', m(10), m(10)), item('grass', m(12), m(11), 0.7), item('stones', m(500), m(10))];
    const doc = docOf(elements);
    let asked = 0;
    const ground = (x: number): number => { asked++; return x * 0.01; };
    const layer = createElementLayer(kit);
    layer.sync({ items: null, ground: null }, doc, ground);
    expect(asked).toBe(3);
    expect(layer.triangles).toBe(3 * 12);
    // An element added in the first cell: that cell alone is made again.
    elements.push(item('grass', m(20), m(20)));
    asked = 0;
    layer.sync({ items: [[m(19), m(19), m(21), m(21)]], ground: [] }, doc, ground);
    expect(asked).toBe(3);
    expect(layer.triangles).toBe(4 * 12);
    // The ground moved over the whole map but under one cell's elements only: no cell without elements is made.
    asked = 0;
    layer.sync({ items: [], ground: [[m(400), -m(50), m(9_000), m(9_000)]] }, doc, ground);
    expect(asked).toBe(1);
    // Ground moved where nothing stands: nothing read.
    asked = 0;
    layer.sync({ items: [], ground: [[-m(3_000), -m(3_000), -m(2_000), -m(2_000)]] }, doc, ground);
    expect(asked).toBe(0);
  });

  it('gives off only the effects near the eye', () => {
    const doc = docOf([{ ...item('smoke' as ElementKind, 0, 0), intensity: 1 }, { ...item('smoke' as ElementKind, m(5_000), 0), intensity: 1 }]);
    const layer = createElementLayer(kit);
    layer.sync({ items: null, ground: null }, doc, () => 0);
    expect(layer.hasEffects).toBe(true);
    const bursts: number[] = [];
    const exhaust = { burst: (x: number) => { bursts.push(x); } } as unknown as Exhaust;
    layer.emit(1, new Vector3(0, m(10), 0), exhaust);
    expect(bursts.length).toBeGreaterThan(0);
    expect(bursts.every((x) => x === 0)).toBe(true);
  });
});
