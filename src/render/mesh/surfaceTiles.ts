import { Box3, type BufferGeometry, Sphere, type Mesh } from 'three';
import { gpuOnly } from './gpuOnly';
import { type BlockArrays, type BlockLevels, LOD_KEY, coarseArrays, blockGeometry } from './roadLod';
import type { VertexReads } from './roadLodPure';
import { makeFar } from './roadResidency';
import { finish, type SurfaceMeshOptions, type Tile } from './surfaceMesh';

/** A surface's tiles, in order, as one mesh's arrays (the indices shifted), with only the attributes its material `reads`; null for none. */
function tileArrays(parts: readonly Tile[], reads: VertexReads): BlockArrays | null {
  let vertices = 0;
  let count = 0;
  for (const tile of parts) {
    vertices += tile.positions.length / 3;
    count += tile.indices.length;
  }
  if (count === 0) return null;
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const uv = new Float32Array(vertices * 2);
  const color = reads.color ? new Float32Array(vertices * 3) : null;
  const roadSection = reads.roadSection ? new Float32Array(vertices * 3) : null;
  const index = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  let v = 0;
  let k = 0;
  for (const tile of parts) {
    position.set(tile.positions, v * 3);
    normal.set(tile.normals, v * 3);
    uv.set(tile.uvs, v * 2);
    color?.set(tile.colors, v * 3);
    roadSection?.set(tile.sections, v * 3);
    const local = tile.indices;
    for (let i = 0; i < local.length; i++) index[k++] = (local[i] as number) + v;
    v += tile.positions.length / 3;
  }
  return { position, normal, uv, ...(color ? { color } : {}), ...(roadSection ? { roadSection } : {}), index };
}

/** DO NOT pass a source that returns `parts`: the closure would hold every tile's arrays for as long as the mesh lives. */
export function mergeTiles(parts: readonly Tile[], options: Pick<SurfaceMeshOptions,
  'name' | 'material' | 'castShadow' | 'receiveShadow'>, reads: VertexReads, source: () => readonly Tile[],
  far?: { readonly lock: readonly [number, number, number, number]; readonly near: boolean; readonly start?: (mesh: Mesh, arrays: BlockArrays) => void }): Mesh | null {
  const arrays = tileArrays(parts, reads);
  if (!arrays) return null;
  const geometry = blockGeometry(arrays);
  // Bounded by its tiles' boxes, made with them in the worker (`tileMesh.ts`)
  if (parts.every((tile) => tile.box)) {
    const box = new Box3();
    for (const tile of parts) {
      const b = tile.box!;
      if (b[0]! > b[3]!) continue;
      box.min.set(Math.min(box.min.x, b[0]!), Math.min(box.min.y, b[1]!), Math.min(box.min.z, b[2]!));
      box.max.set(Math.max(box.max.x, b[3]!), Math.max(box.max.y, b[4]!), Math.max(box.max.z, b[5]!));
    }
    geometry.boundingBox = box;
    geometry.boundingSphere = box.getBoundingSphere(new Sphere());
  }
  const mesh = finish(geometry, options);
  tilesOnGpu(mesh, reads, source);
  if (far) {
    // DO NOT simplify it here, a block after the other on the page.
    mesh.userData[LOD_KEY] = { coarse: null, x: (far.lock[0] + far.lock[2]) / 2, z: -(far.lock[1] + far.lock[3]) / 2, full: true } satisfies BlockLevels;
    far.start?.(mesh, arrays);
  }
  return mesh;
}

/** A block's arrays copied: what a worker is handed to simplify while the block keeps its own. */
export function cloneBlock(arrays: BlockArrays): BlockArrays {
  return {
    position: arrays.position.slice(), normal: arrays.normal.slice(), uv: arrays.uv.slice(),
    ...(arrays.color ? { color: arrays.color.slice() } : {}), ...(arrays.roadSection ? { roadSection: arrays.roadSection.slice() } : {}), index: arrays.index.slice(),
  };
}

/** The block's far level (`roadLod.ts`) as it arrives from its worker */
export function attachFarLevel(mesh: Mesh, coarse: BlockArrays, options: Pick<SurfaceMeshOptions,
  'name' | 'material' | 'castShadow' | 'receiveShadow'>, reads: VertexReads, source: () => readonly Tile[],
  lock: readonly [number, number, number, number], near: boolean): Mesh {
  const level = finish(blockGeometry(coarse), { ...options, name: `${options.name}-far` });
  // Made again from the block's tiles when a lost context asks, like the block's own.
  gpuOnly(level, () => coarseArrays(tileArrays(source(), reads)!, lock) ?? coarse);
  const levels = mesh.userData[LOD_KEY] as BlockLevels;
  (levels as { coarse: Mesh | null }).coarse = level;
  level.renderOrder = mesh.renderOrder;
  level.visible = !near;
  mesh.parent?.add(level);
  if (!near) makeFar(mesh);
  return level;
}

/** A merged mesh's arrays let go once on the GPU, and made again from `source`'s tiles when asked (`gpuOnly`). */
export function tilesOnGpu(mesh: Mesh, reads: VertexReads, source: () => readonly Tile[]): void {
  gpuOnly(mesh as Mesh & { geometry: BufferGeometry }, () => tileArrays(source(), reads)!);
}
