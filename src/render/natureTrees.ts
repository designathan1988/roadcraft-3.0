import { BufferGeometry, MeshStandardMaterial, type MeshDepthMaterial } from 'three';
import type { TreePlacement } from './groundCover';
import { leafCardMaterials, lowPolyTreeParts } from './lowPolyTrees';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';
import { m } from '@world/units';

/** THE TREES of the countryside and the planted ones: the cypress, the palm and the oak the player drew */

/** The models, in seed order: each takes its share of the seed's range (`world/trees.ts` KIND_SLOTS). */
export const TREE_MODELS = ['oak', 'oak', 'cypress', 'cypress', 'palm', 'palm'] as const;
export type TreeModelKind = (typeof TREE_MODELS)[number];
/** A seed (0..1) that grows as this kind of tree, `r` (0..1) choosing among its models. */
export function seedOfKind(kind: TreeModelKind, r: number): number {
  const slots = TREE_MODELS.flatMap((k, i) => (k === kind ? [i] : []));
  const slot = slots[Math.min(slots.length - 1, Math.floor(r * slots.length))]!;
  return (slot + 0.05 + ((r * 7.31) % 1) * 0.9) / TREE_MODELS.length;
}
/** Neighbours within this reach (18 m) make a tree's stand. */
const STAND_REACH = m(18);

/** The forest's wind (`groundCover.ts`): a slow sway and a leaf flutter. */
const FOREST_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };

interface Variant {
  /** The model, one unit tall on its origin (the ground); the same at every distance. */
  readonly levels: readonly [BufferGeometry, BufferGeometry, BufferGeometry];
  /** Its foliage cards (`lowPolyTrees.ts`; a palm's frond strips), drawn with the same instances. */
  readonly cards: BufferGeometry | null;
}

export interface NatureTreeKit {
  readonly variants: readonly Variant[];
  readonly material: MeshStandardMaterial;
  readonly depth: MeshDepthMaterial;
  readonly cardMaterial: MeshStandardMaterial;
  /** The cards' shadow pass (a palm's fronds only). */
  readonly cardDepth: MeshDepthMaterial;
  dispose(): void;
}

/** Makes the trees; their materials share the forest's wind. */
export async function loadNatureTrees(_anisotropy: number): Promise<NatureTreeKit> {
  const variants: Variant[] = TREE_MODELS.map((kind, i) => {
    const { body, cards } = lowPolyTreeParts(kind, 0x7ee5 + i * 7919);
    return { levels: [body, body, body], cards };
  });
  // Opaque, matt, faceted: the trunk and the crown's shaded heart.
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: true, envMapIntensity: 0.35 });
  applyWind(material, FOREST_WIND, 'nature-trees-lowpoly');
  const depth = windDepthMaterial(FOREST_WIND, 'nature-trees-lowpoly-depth');
  const cardKit = leafCardMaterials(FOREST_WIND, 'nature-trees');
  console.info('[nature] trees (triangles, body + cards):', variants.map((v, i) => `${TREE_MODELS[i]} ${v.levels[0].getAttribute('position').count / 3} + ${(v.cards?.getAttribute('position').count ?? 0) / 3}`).join(', '));
  return {
    variants,
    material,
    depth,
    cardMaterial: cardKit.material,
    cardDepth: cardKit.depth,
    dispose() {
      for (const v of variants) { v.levels[0].dispose(); v.cards?.dispose(); }
      material.dispose();
      depth.dispose();
      cardKit.material.dispose();
      cardKit.depth.dispose();
    },
  };
}

/** The variety a tree is grown as, from its seed. */
export const varietyOf = (tree: { readonly seed: number }, varieties: number): number => Math.min(varieties - 1, Math.floor(tree.seed * varieties));

/** A cell of the stand grid as one number (a string key per tree and neighbour was most of the cost). */
const standKey = (cx: number, cy: number): number => cx * 100_003 + cy;

/** How each of `trees` stands among `among` (which holds them, and every tree within `STAND_REACH` of one of them) */
export function standsAmong(trees: readonly TreePlacement[], among: readonly TreePlacement[]): { crowd: Float32Array; openX: Float32Array; openY: Float32Array } {
  const cell = STAND_REACH;
  const grid = new Map<number, number[]>();
  among.forEach((t, i) => {
    const key = standKey(Math.floor(t.x / cell), Math.floor(t.y / cell));
    const list = grid.get(key);
    if (list) list.push(i); else grid.set(key, [i]);
  });
  const crowd = new Float32Array(trees.length), openX = new Float32Array(trees.length), openY = new Float32Array(trees.length);
  trees.forEach((t, i) => {
    const cx = Math.floor(t.x / cell), cy = Math.floor(t.y / cell);
    let n = 0, ax = 0, ay = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(standKey(cx + dx, cy + dy)) ?? []) {
          const o = among[j]!;
          if (o === t) continue;
          const ex = o.x - t.x, ey = o.y - t.y;
          const d = Math.hypot(ex, ey);
          if (d > STAND_REACH || d < 1e-3) continue;
          const w = 1 - d / STAND_REACH;
          n += w; ax += (ex / d) * w; ay += (ey / d) * w;
        }
      }
    }
    crowd[i] = Math.min(1, n / 6);
    const a = Math.hypot(ax, ay);
    openX[i] = a > 1e-3 ? -ax / a : 0;
    openY[i] = a > 1e-3 ? -ay / a : 0;
  });
  return { crowd, openX, openY };
}

/** A tree's matrix, into `m` at `o`: deep in a wood taller and narrower */
export function treeMatrixInto(item: TreePlacement, crowd: number, openX: number, openY: number, m: { [i: number]: number }, o: number): void {
  const tall = item.size * (0.92 + 0.22 * crowd);
  const wide = item.size * (1.12 - 0.3 * crowd) * (0.94 + ((item.seed * 5.3) % 1) * 0.12);
  const lean = 0.22 * (1 - crowd) * Math.min(1, crowd * 4);
  const sx = openX * lean, sz = -openY * lean;
  const c = Math.cos(item.yaw), s = Math.sin(item.yaw);
  m[o] = c * wide; m[o + 1] = 0; m[o + 2] = -s * wide; m[o + 3] = 0;
  m[o + 4] = sx * tall; m[o + 5] = tall; m[o + 6] = sz * tall; m[o + 7] = 0;
  m[o + 8] = s * wide; m[o + 9] = 0; m[o + 10] = c * wide; m[o + 11] = 0;
  m[o + 12] = item.x; m[o + 13] = item.z; m[o + 14] = -item.y; m[o + 15] = 1;
}

/** A tree's own green, into `col` at `o` (it multiplies the model's linear colours, three's color_vertex) */
export function treeColourInto(item: TreePlacement, col: { [i: number]: number }, o: number): void {
  const t = 0.9 + ((item.seed * 3.77) % 1) * 0.2;
  const hue = ((item.seed * 1.3) % 1) - 0.5;
  col[o] = t * (1 + hue * 0.16);
  col[o + 1] = t;
  col[o + 2] = t * (0.96 - hue * 0.12);
}
