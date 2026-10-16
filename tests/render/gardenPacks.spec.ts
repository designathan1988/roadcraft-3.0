import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, type InstancedMesh } from 'three';
import { createSceneryKit, type SceneryKit } from '@render/scenery';
import { createGardens, type GardenPlant, type Gardens } from '@render/gardens';
import { m } from '@world/units';
import { townChanges } from '../support/gardenChange';

/** The gardens are packed building by building and kept so (`gardens.ts`, audit M3a) */
const plant = (i: number, kind: GardenPlant['kind']): GardenPlant => ({
  kind, x: m(3) * i, y: m(2) * (i % 5), z: m(0.1) * (i % 3), w: m(2) + (i % 4) * m(0.5), d: m(1.5), h: m(2) + (i % 3), yaw: i * 0.7, seed: (i * 0.137) % 1,
});
const KINDS: GardenPlant['kind'][] = ['tree', 'shrub', 'hedge', 'flowers'];
const garden = (g: number): GardenPlant[] => Array.from({ length: 9 }, (_, i) => plant(g * 9 + i, KINDS[(g + i) % 4]!));
/** A view that sees everything. */
const everything = new Frustum().setFromProjectionMatrix(new Matrix4().makeOrthographic(-1e7, 1e7, 1e7, -1e7, -1e7, 1e7));
let views = 0;

/** The gardens of these lists, made at once: the reference a town built afresh draws. */
function buildGardens(groups: readonly (readonly GardenPlant[])[], kit: SceneryKit): Gardens {
  const gardens = createGardens(kit);
  gardens.update({ added: groups, removed: [] });
  return gardens;
}

/** Each mesh's drawn instances, by name: matrix and tint of each, in their order; the meshes the cull swaps applied to `scene`, as the renderer does. */
function drawn(gardens: Gardens, scene?: Set<InstancedMesh>): Map<string, string[]> {
  const swap = gardens.cull(everything, new Matrix4().makeTranslation(++views, 0, 0));
  for (const mesh of swap.removed) { if (scene) expect(scene.delete(mesh)).toBe(true); }
  for (const mesh of swap.added) scene?.add(mesh);
  const out = new Map<string, string[]>();
  for (const mesh of gardens.meshes as InstancedMesh[]) {
    const rows: string[] = [];
    const mats = mesh.instanceMatrix.array, tints = mesh.instanceColor?.array;
    for (let i = 0; i < mesh.count; i++) rows.push(`${Array.from(mats.slice(i * 16, i * 16 + 16)).join(',')}|${tints ? Array.from(tints.slice(i * 3, i * 3 + 3)).join(',') : ''}`);
    out.set(mesh.name, rows);
  }
  return out;
}
/** The meshes with something drawn (a store all of whose gardens went keeps its mesh, drawing nothing). */
const drawing = (map: Map<string, string[]>): Map<string, string[]> => new Map([...map].filter(([, r]) => r.length));
const sorted = (map: Map<string, string[]>): Map<string, string[]> => new Map([...drawing(map)].map(([k, r]) => [k, [...r].sort()]));

describe('garden packs', () => {
  const kit = createSceneryKit();

  it('per-building packs give the instances of one list of every plant', () => {
    const groups = [0, 1, 2, 3].map(garden);
    const split = buildGardens(groups, kit);
    const whole = buildGardens([groups.flat()], kit);
    expect(split.meshes.map((x) => x.name)).toEqual(whole.meshes.map((x) => x.name));
    expect(drawn(split)).toEqual(drawn(whole));
    split.meshes.forEach((mesh, i) => expect(mesh.castShadow).toBe(whole.meshes[i]!.castShadow));
    expect(split.triangles).toBeGreaterThan(0);
  });

  it('kept garden by garden, draw the plants of the town built afresh', () => {
    const lists = Array.from({ length: 40 }, (_, g) => garden(g));
    const gardens = createGardens(kit);
    const shown = new Set<InstancedMesh>();
    const change = townChanges();
    const apply = (groups: readonly (readonly GardenPlant[])[]): void => {
      const { removed, added } = gardens.update(change(groups));
      for (const mesh of removed) { expect(shown.has(mesh)).toBe(true); shown.delete(mesh); }
      for (const mesh of added) shown.add(mesh);
    };
    // Grown a few at a time, as a city grows.
    for (let n = 4; n <= 40; n += 4) apply(lists.slice(0, n));
    expect(sorted(drawn(gardens, shown))).toEqual(sorted(drawn(buildGardens(lists, kit))));
    // Some gone, some changed (a new list for the same building), the rest kept.
    const changed = lists.map((list, g) => (g % 3 === 0 ? garden(g + 100) : list)).filter((_, g) => g % 5 !== 1);
    apply(changed);
    expect(sorted(drawn(gardens, shown))).toEqual(sorted(drawn(buildGardens(changed, kit))));
    // Most gone: packed again in the order the gardens were placed - the plants of a town built afresh.
    const few = changed.slice(0, 6);
    apply(few);
    expect(sorted(drawn(gardens, shown))).toEqual(sorted(drawn(buildGardens(few, kit))));
    // The meshes in the scene are the ones it has.
    expect(new Set(gardens.meshes)).toEqual(shown);
    gardens.dispose();
  });
});
