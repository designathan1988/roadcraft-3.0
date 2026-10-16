import { BufferAttribute, BufferGeometry, type Mesh } from 'three';
import type { BlockArrays } from './roadLodPure';

export { coarseArrays, type BlockArrays } from './roadLodPure';

/** DO NOT draw a far block at full detail: nothing there is resolved. */

/** A block's geometry from its arrays, full or coarse: `color` and `roadSection` only where they were made. */
export function blockGeometry(arrays: BlockArrays): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(arrays.position, 3));
  geometry.setAttribute('normal', new BufferAttribute(arrays.normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(arrays.uv, 2));
  if (arrays.color) geometry.setAttribute('color', new BufferAttribute(arrays.color, 3));
  if (arrays.roadSection) geometry.setAttribute('roadSection', new BufferAttribute(arrays.roadSection, 3));
  geometry.setIndex(new BufferAttribute(arrays.index, 1));
  return geometry;
}

/** What a block keeps of its two levels (`mesh.userData.lod`). */
export interface BlockLevels {
  /** The far level, null where the block is too small to have one. */
  readonly coarse: Mesh | null;
  /** The block's centre in the scene (x, z), for the distance to the camera. */
  readonly x: number;
  readonly z: number;
  /** Whether the full level is on the GPU (its arrays given back by `refillArrays` when it comes). */
  full: boolean;
}

export const LOD_KEY = 'lod';

export const levelsOf = (mesh: Mesh): BlockLevels | undefined => mesh.userData[LOD_KEY] as BlockLevels | undefined;
