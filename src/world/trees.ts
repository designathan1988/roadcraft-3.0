/** TREES THE PLAYER PLANTS, AND THE CLEARINGS THEY CUT. */

/** The tree models to choose from (`render/natureTrees.ts` TREE_MODELS, in order): each its share of the seed's range. */
export const TREE_KINDS = ['mixed', 'oak', 'cypress', 'palm'] as const;
export type TreeKind = (typeof TREE_KINDS)[number];
/** The models' slots (`render/natureTrees.ts` TREE_MODELS): two oaks, two cypresses, two palms. */
const KIND_SLOTS: Readonly<Record<Exclude<TreeKind, 'mixed'>, readonly number[]>> = { oak: [0, 1], cypress: [2, 3], palm: [4, 5] };
const MODEL_COUNT = 6;

export interface PlantedTree {
  readonly x: number;
  readonly y: number;
  /** Its height, world units. */
  readonly height: number;
  readonly yaw: number;
  /** 0..1: which model (`render/natureTrees.ts` picks by it), its tint and lean. */
  readonly seed: number;
}

/** Where the trees were cut away: no tree of the woods grows inside. */
export interface TreeClearing {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface TreeBrush {
  /** Trees per hectare at full strength. */
  readonly density: number;
  /** A tree's height, metres. */
  readonly height: number;
  /** 0..100: how far heights vary about it. */
  readonly variation: number;
  /** Least distance between two planted trees, metres. */
  readonly spacing: number;
}

export const DEFAULT_TREE_BRUSH: TreeBrush = { density: 120, height: 12, variation: 35, spacing: 6 };
/** A map keeps at most this many clearings, the oldest going first (a brush's stream; its trees are never dropped). */
export const MAX_TREE_CLEARINGS = 10_000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function readPlantedTree(data: unknown): PlantedTree | null {
  const d = data as Partial<Record<keyof PlantedTree, unknown>> | null;
  if (!d || !finite(d.x) || !finite(d.y) || !finite(d.height)) return null;
  return { x: d.x, y: d.y, height: Math.max(1, d.height), yaw: finite(d.yaw) ? d.yaw : 0, seed: finite(d.seed) ? Math.min(0.999, Math.max(0, d.seed)) : 0 };
}

export function readTreeClearing(data: unknown): TreeClearing | null {
  const d = data as Partial<Record<keyof TreeClearing, unknown>> | null;
  if (!d || !finite(d.x) || !finite(d.y) || !finite(d.radius)) return null;
  return { x: d.x, y: d.y, radius: Math.max(1, d.radius) };
}

/** A seed in the chosen kind's share of the range (any model for 'mixed'). */
export function treeSeed(kind: TreeKind, random: () => number): number {
  if (kind === 'mixed') return random() * 0.999;
  const slots = KIND_SLOTS[kind];
  const slot = slots[Math.floor(random() * slots.length)]!;
  return (slot + 0.05 + random() * 0.9) / MODEL_COUNT;
}

/** The trees one dab of the brush plants in a circle: as many as the density asks for its area */
export function plantTrees(kind: TreeKind, brush: TreeBrush, x: number, y: number, radius: number, unitsPerMetre: number,
  random: () => number, nearby: readonly PlantedTree[]): PlantedTree[] {
  const hectares = (Math.PI * (radius / unitsPerMetre) ** 2) / 10_000;
  const wanted = brush.density * hectares;
  const count = Math.min(200, Math.floor(wanted) + (random() < wanted % 1 ? 1 : 0));
  const spacing = brush.spacing * unitsPerMetre;
  const out: PlantedTree[] = [];
  for (let i = 0; i < count * 4 && out.length < count; i++) {
    const r = radius * Math.sqrt(random());
    const a = random() * Math.PI * 2;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    const free = (t: { x: number; y: number }): boolean => Math.hypot(t.x - px, t.y - py) >= spacing;
    if (!nearby.every(free) || !out.every(free)) continue;
    out.push(oneTree(kind, brush, px, py, unitsPerMetre, random));
  }
  return out;
}

/** One tree at a point, of the brush's height varied. */
export function oneTree(kind: TreeKind, brush: TreeBrush, x: number, y: number, unitsPerMetre: number, random: () => number): PlantedTree {
  const vary = (brush.variation / 100) * (random() * 2 - 1);
  return { x, y, height: brush.height * unitsPerMetre * Math.max(0.3, 1 + vary), yaw: random() * Math.PI * 2, seed: treeSeed(kind, random) };
}

/** Whether a point lies in a clearing. */
function inClearing(clearings: readonly TreeClearing[], x: number, y: number): boolean {
  for (const c of clearings) if (Math.abs(c.x - x) < c.radius && Math.abs(c.y - y) < c.radius && Math.hypot(c.x - x, c.y - y) < c.radius) return true;
  return false;
}

/** A lookup of the clearings for many points at once (the woods are tens of thousands of trees) */
export function clearingIndex(clearings: readonly TreeClearing[], cell = 64): (x: number, y: number) => boolean {
  if (clearings.length === 0) return () => false;
  const cells = new Map<number, TreeClearing[]>();
  const key = (i: number, j: number): number => (i + 32_768) * 65_536 + (j + 32_768);
  for (const c of clearings) {
    for (let j = Math.floor((c.y - c.radius) / cell); j <= Math.floor((c.y + c.radius) / cell); j++) {
      for (let i = Math.floor((c.x - c.radius) / cell); i <= Math.floor((c.x + c.radius) / cell); i++) {
        const k = key(i, j);
        const list = cells.get(k);
        if (list) list.push(c); else cells.set(k, [c]);
      }
    }
  }
  return (x, y) => inClearing(cells.get(key(Math.floor(x / cell), Math.floor(y / cell))) ?? [], x, y);
}
