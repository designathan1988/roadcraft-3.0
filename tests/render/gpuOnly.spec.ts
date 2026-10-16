import { describe, expect, it } from 'vitest';
import { BoxGeometry, type BufferAttribute, Color, InstancedMesh, type Mesh, MeshBasicMaterial, type Object3D } from 'three';
import { compileCopy, shadowStandIn } from '@render/uploads';

import { createBuildingKit } from '@render/buildings/kit';
import { cellMass } from '@render/buildings/cellArrays';
import { createMassCells } from '@render/buildings/massCells';
import { emitMassing } from '@render/buildings/massing';
import { refillArrays } from '@render/mesh/gpuOnly';
import type { Tile } from '@render/mesh/surfaceMesh';
import { mergeTiles } from '@render/mesh/surfaceTiles';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** THE TOWN'S MESHES LIVE ON THE GPU (`render/mesh/gpuOnly.ts`) */
const attributes = (mesh: Mesh): BufferAttribute[] => [...Object.values(mesh.geometry.attributes), mesh.geometry.index!] as BufferAttribute[];
const arraysOf = (mesh: Mesh): number[][] => attributes(mesh).map((a) => Array.from(a.array));
/** What the renderer does after `bufferData` (`WebGLAttributes.createBuffer`). */
const upload = (mesh: Mesh): void => { for (const a of attributes(mesh)) a.onUploadCallback(); };

function checks(mesh: Mesh, root: Object3D): void {
  const before = arraysOf(mesh);
  const counts = attributes(mesh).map((a) => a.count);
  upload(mesh);
  for (const a of attributes(mesh)) expect(a.array).toBeNull();
  // What reads the mesh after: its bounds (culling, shadows) and its counts.
  expect(mesh.geometry.boundingSphere).not.toBeNull();
  expect(mesh.geometry.boundingBox).not.toBeNull();
  expect(attributes(mesh).map((a) => a.count)).toEqual(counts);
  refillArrays(root);
  expect(arraysOf(mesh)).toEqual(before);
}

function tile(dx: number): Tile {
  return {
    positions: new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx, 0, 1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    sections: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe('meshes that live on the GPU', () => {
  it('are copied to build their programs without their instances (no array to copy)', () => {
    const mesh = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 500);
    mesh.setColorAt(0, new Color(1, 0, 0));
    mesh.castShadow = true;
    // Uploaded: its arrays let go (`gpuOnlyAttributes`).
    (mesh.instanceMatrix as { array: ArrayLike<number> | null }).array = null;
    (mesh.instanceColor as { array: ArrayLike<number> | null }).array = null;
    expect(() => mesh.clone(false)).toThrow();
    const copy = compileCopy(mesh) as InstancedMesh;
    expect(copy.isInstancedMesh).toBe(true);
    expect(copy.count).toBe(1);
    expect(copy.geometry).toBe(mesh.geometry);
    expect(copy.material).toBe(mesh.material);
    expect(copy.instanceColor).not.toBeNull();
    expect(copy.castShadow).toBe(true);
    expect(shadowStandIn(mesh)).not.toBeNull();
  });

  it('a road block is copied to build its programs with its far level uploaded (kept in its userData)', () => {
    const tiles = [tile(0), tile(2)];
    const mesh = mergeTiles(tiles, { name: 'asphalt', material: new MeshBasicMaterial() }, { color: true, roadSection: true }, () => tiles)!;
    const far = mergeTiles(tiles, { name: 'asphalt-far', material: mesh.material as MeshBasicMaterial }, { color: true, roadSection: true }, () => tiles)!;
    upload(far);
    mesh.userData['levels'] = { coarse: far };
    mesh.castShadow = true;
    expect(() => mesh.clone(false)).toThrow();
    const copy = compileCopy(mesh) as Mesh;
    expect(copy.geometry).toBe(mesh.geometry);
    expect(copy.material).toBe(mesh.material);
    expect(mesh.userData['levels']).toEqual({ coarse: far });
    expect(shadowStandIn(mesh)).not.toBeNull();
  });

  it('a road block lets its arrays go once uploaded, and takes them back the same', () => {
    const tiles = [tile(0), tile(2), tile(5)];
    const mesh = mergeTiles(tiles, { name: 'asphalt', material: new MeshBasicMaterial() }, { color: true, roadSection: true }, () => tiles)!;
    checks(mesh, mesh);
  });

  it('a cell of building masses lets its arrays go too (a lost context asks the workers again, layer.ts refill)', () => {
    const kit = createBuildingKit();
    const cells = createMassCells(kit, m(240));
    const masses = [0, 1, 2].map((i) => {
      const bp = BLUEPRINTS[i]!;
      const b = { ...JSON.parse(JSON.stringify(bp.body)), id: i + 1, x: i * m(30), y: m(10), rotation: 0 } as Building;
      return emitMassing(b, () => 0)!;
    });
    cells.land('0,0', cellMass(masses));
    const mesh = cells.group.children.find((o) => o.name === 'building-massing') as Mesh;
    expect(mesh).toBeDefined();
    const counts = attributes(mesh).map((a) => a.count);
    upload(mesh);
    for (const a of attributes(mesh)) expect(a.array).toBeNull();
    expect(mesh.geometry.boundingSphere).not.toBeNull();
    expect(mesh.geometry.boundingBox).not.toBeNull();
    expect(attributes(mesh).map((a) => a.count)).toEqual(counts);
    cells.dispose();
  });
});
