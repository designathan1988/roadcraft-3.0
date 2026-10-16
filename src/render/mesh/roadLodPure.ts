import { MeshoptSimplifier } from 'meshoptimizer';

/** THE FAR LEVEL OF A BLOCK OF ROAD SURFACE, as arrays (`roadLod.ts` makes the mesh) */

/** The per-vertex attributes past position, normal and uv that a surface's material reads: only those are built and uploaded. */
export interface VertexReads {
  /** `material.vertexColors`: the tint (`TileMeshOptions.tint`). */
  readonly color: boolean;
  /** The road's cross-section (`roadEdges.ts`, `TileMeshOptions.section`). */
  readonly roadSection: boolean;
}

/** A block's arrays, as `tileArrays` makes them: `color` and `roadSection` only where its material reads them. */
export interface BlockArrays extends Readonly<Record<string, ArrayLike<number>>> {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  readonly color?: Float32Array;
  readonly roadSection?: Float32Array;
  readonly index: Uint16Array | Uint32Array;
}

/** Every buffer of a block's arrays, to hand over (MDN, "Transferable objects"). */
export function blockBuffers(arrays: BlockArrays): ArrayBuffer[] {
  const out = [arrays.position.buffer, arrays.normal.buffer, arrays.uv.buffer, arrays.index.buffer] as ArrayBuffer[];
  if (arrays.color) out.push(arrays.color.buffer as ArrayBuffer);
  if (arrays.roadSection) out.push(arrays.roadSection.buffer as ArrayBuffer);
  return out;
}

/** What a coarse block may deviate by from the block, metres (absolute: a 1 % error of a 250 m block is 2.5 m). */
export const COARSE_ERROR = 0.12;
/** The share of the triangles aimed at: the simplifier stops sooner when the error is reached. */
const COARSE_RATIO = 0.08;
/** A block with fewer triangles than this is not simplified: its far level would save nothing. */
const COARSE_MIN_TRIANGLES = 160;

/** The coarse arrays of a block, or null when it is too small to be worth it or the simplifier cannot run. */
export function coarseArrays(block: BlockArrays, lock: readonly [number, number, number, number]): BlockArrays | null {
  const count = block.position.length / 3;
  const indices = block.index.length;
  if (indices / 3 < COARSE_MIN_TRIANGLES || !MeshoptSimplifier.supported) return null;
  const locked = new Uint8Array(count);
  const eps = 1e-3;
  const [minX, minY, maxX, maxY] = lock;
  for (let i = 0; i < count; i++) {
    const x = block.position[i * 3]!, y = -block.position[i * 3 + 2]!;
    if (Math.abs(x - minX) < eps || Math.abs(x - maxX) < eps || Math.abs(y - minY) < eps || Math.abs(y - maxY) < eps) locked[i] = 1;
  }
  // Normals and tints weigh in the error: a skirt's hard edge, a paint's colour are kept where they matter.
  const attributes = new Float32Array(count * 6);
  // A block without `color` was untinted: white, as its tiles were written (`tileMesh.ts`).
  const color = block.color;
  for (let i = 0; i < count; i++) {
    attributes[i * 6] = block.normal[i * 3]!; attributes[i * 6 + 1] = block.normal[i * 3 + 1]!; attributes[i * 6 + 2] = block.normal[i * 3 + 2]!;
    attributes[i * 6 + 3] = color ? color[i * 3]! : 1; attributes[i * 6 + 4] = color ? color[i * 3 + 1]! : 1; attributes[i * 6 + 5] = color ? color[i * 3 + 2]! : 1;
  }
  const from = block.index instanceof Uint32Array ? block.index : Uint32Array.from(block.index);
  const target = Math.max(6, Math.floor((indices * COARSE_RATIO) / 3) * 3);
  let kept: Uint32Array;
  try {
    [kept] = MeshoptSimplifier.simplifyWithAttributes(from, block.position, 3, attributes, 6, [0.4, 0.4, 0.4, 0.15, 0.15, 0.15], locked, target, COARSE_ERROR, ['ErrorAbsolute', 'Prune']);
  } catch (error) {
    // The block is drawn at full detail wherever it is: reported, not hidden.
    console.error('[road lod] a block could not be simplified', error);
    return null;
  }
  if (kept.length === 0 || kept.length >= indices) return null;
  // Only the vertices the coarse triangles use, in the order they are first used.
  const remap = new Int32Array(count).fill(-1);
  let used = 0;
  for (let i = 0; i < kept.length; i++) if (remap[kept[i]!]! < 0) remap[kept[i]!] = used++;
  const take = (src: Float32Array, size: number): Float32Array => {
    const out = new Float32Array(used * size);
    for (let v = 0; v < count; v++) {
      const at = remap[v]!;
      if (at < 0) continue;
      for (let k = 0; k < size; k++) out[at * size + k] = src[v * size + k]!;
    }
    return out;
  };
  const index = used > 0xffff ? new Uint32Array(kept.length) : new Uint16Array(kept.length);
  for (let i = 0; i < kept.length; i++) index[i] = remap[kept[i]!]!;
  return {
    position: take(block.position, 3), normal: take(block.normal, 3), uv: take(block.uv, 2),
    ...(block.color ? { color: take(block.color, 3) } : {}), ...(block.roadSection ? { roadSection: take(block.roadSection, 3) } : {}), index,
  };
}

