import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Sphere,
  Vector3,
  Group,
  type BufferGeometry,
  type Color,
  type Frustum,
  type Material,
  type MeshDepthMaterial,
} from 'three';
import { Rng } from '@core/rng';
import { m } from '@world/units';
import { BUSH_KINDS, TREE_SPECIES, trianglesOf, type BushKind, type TreeSpecies } from './propGeometry';
import { SHADOW_REACH, foliageTint, type Scenery, type SceneryKit } from './scenery';
import { type Bounds, enclose, markRange, planeMask } from './instanceCull';

/** DO NOT go back to rebuilding the whole town's gardens at every building. */

/** A plant of a building's garden, in the world: a tree, a shrub, a run of hedge or a flower bed. */
export interface GardenPlant {
  readonly kind: 'tree' | 'shrub' | 'hedge' | 'flowers';
  readonly x: number;
  readonly y: number;
  /** Ground height under it. */
  readonly z: number;
  /** Size, world units: along (w), across (d) and height (h); `yaw` the way `w` runs. */
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly yaw: number;
  readonly seed: number;
  /** A tree's species, when it is not a garden's mix (a painted forest's). */
  readonly species?: TreeSpecies;
  /** A shrub that never flowers (a wood's understorey). */
  readonly plain?: boolean;
}

interface Placement { x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number; tint?: Color }

/** A garden tree's species: mostly broadleaf, some conifers, now and then a flowering ipê. */
function gardenSpecies(roll: number): TreeSpecies {
  if (roll < 0.42) return 'broadleaf';
  if (roll < 0.62) return 'broadleafTall';
  if (roll < 0.8) return 'conifer';
  return roll < 0.9 ? 'ipeYellow' : 'ipePink';
}

/** One building's garden placed, per plant kind: its instances' matrices, tints and largest scale. */
interface GardenPack {
  readonly matrices: Float32Array;
  /** Tints, white where a plant has none; null when none has one. */
  readonly colours: Float32Array | null;
  readonly scales: Float32Array;
  readonly count: number;
}

/** DO NOT go through an `Object3D` for each plant of a garden */
export function yawMatrixInto(out: Float32Array | number[], at: number, px: number, py: number, pz: number, yaw: number, sx: number, sy: number, sz: number): void {
  const y = Math.sin(yaw / 2), w = Math.cos(yaw / 2);
  const y2 = y + y;
  const yy = y * y2, wy = w * y2;
  out[at] = (1 - yy) * sx; out[at + 1] = 0; out[at + 2] = -wy * sx; out[at + 3] = 0;
  out[at + 4] = 0; out[at + 5] = sy; out[at + 6] = 0; out[at + 7] = 0;
  out[at + 8] = wy * sz; out[at + 9] = 0; out[at + 10] = (1 - yy) * sz; out[at + 11] = 0;
  out[at + 12] = px; out[at + 13] = py; out[at + 14] = pz; out[at + 15] = 1;
}

/** One garden's plants placed, by plant kind (`tree:<species>`, `bush:<kind>`). */
function gardenPack(list: readonly GardenPlant[]): ReadonlyMap<string, GardenPack> {
  const trees = new Map<TreeSpecies, Placement[]>(TREE_SPECIES.map((s) => [s, []]));
  const bushes = new Map<BushKind, Placement[]>(BUSH_KINDS.map((k) => [k, []]));
  for (const p of list) {
    const rng = new Rng(Math.floor(p.seed * 0xffffff) ^ 0x5eed);
    switch (p.kind) {
      case 'tree': {
        const spread = 0.82 + rng.float() * 0.3;
        const roll = rng.float();
        (trees.get(p.species ?? gardenSpecies(roll)) as Placement[]).push({
          x: p.x, y: p.y, z: p.z - m(0.05), yaw: rng.float() * Math.PI * 2,
          sx: p.h * spread, sy: p.h, sz: p.h * spread * (0.9 + rng.float() * 0.2), tint: foliageTint(rng),
        });
        break;
      }
      case 'shrub': {
        // The geometry is about 1.5 across for 1 tall, kept in the bush's own proportions
        const across = (Math.min(p.w, p.d) / 1.5) * 0.8;
        const tall = Math.min(p.h, across * 1.3);
        const wide = Math.max(across, tall / 1.3);
        (bushes.get(!p.plain && rng.float() < 0.25 ? 'bushFlowering' : 'bush') as Placement[]).push({
          x: p.x, y: p.y, z: p.z - m(0.05), yaw: rng.float() * Math.PI * 2,
          sx: wide, sy: tall, sz: wide * (0.9 + rng.float() * 0.2), tint: foliageTint(rng),
        });
        break;
      }
      case 'hedge': {
        // Clipped pieces along its run, overlapping so it reads as one.
        const n = Math.max(1, Math.round(p.w / Math.max(m(2.2), p.h * 1.5)));
        const step = p.w / n;
        const cx = Math.cos(p.yaw), cy = Math.sin(p.yaw);
        const tint = foliageTint(rng);
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) * step - p.w / 2;
          (bushes.get('hedge') as Placement[]).push({
            x: p.x + cx * t, y: p.y + cy * t, z: p.z - m(0.05), yaw: p.yaw,
            sx: (step / 1.9) * 1.25, sy: p.h, sz: p.d / 0.9, tint,
          });
        }
        break;
      }
      case 'flowers': {
        // A bed of low flowering clumps.
        const n = Math.max(2, Math.round((p.w * p.d) / (m(0.7) * m(0.7))));
        const cx = Math.cos(p.yaw), cy = Math.sin(p.yaw);
        for (let i = 0; i < Math.min(n, 24); i++) {
          const u = (rng.float() - 0.5) * p.w * 0.85, v = (rng.float() - 0.5) * p.d * 0.85;
          const h = m(0.35) + rng.float() * m(0.25);
          (bushes.get('bushFlowering') as Placement[]).push({
            x: p.x + cx * u - cy * v, y: p.y + cy * u + cx * v, z: p.z + m(0.12), yaw: rng.float() * Math.PI * 2,
            sx: h * 1.1, sy: h, sz: h * 1.1,
          });
        }
        break;
      }
    }
  }
  const out = new Map<string, GardenPack>();
  const pack = (key: string, placed: readonly Placement[]): void => {
    if (!placed.length) return;
    const matrices = new Float32Array(placed.length * 16);
    const scales = new Float32Array(placed.length);
    let colours: Float32Array | null = null;
    placed.forEach((placement, index) => {
      yawMatrixInto(matrices, index * 16, placement.x, placement.z, -placement.y, placement.yaw, placement.sx, placement.sy, placement.sz);
      scales[index] = Math.max(placement.sx, placement.sy, placement.sz);
      if (placement.tint) {
        colours ??= new Float32Array(placed.length * 3).fill(1);
        placement.tint.toArray(colours, index * 3);
      }
    });
    out.set(key, { matrices, colours, scales, count: placed.length });
  };
  for (const [species, placed] of trees) pack(`tree:${species}`, placed);
  for (const [kind, placed] of bushes) pack(`bush:${kind}`, placed);
  return out;
}



/** One plant kind's instances: every garden's run of slots, the dead ones with a radius of -Infinity. */
interface Store {
  /** Its place in the stores, and in a leaf's `slots`. */
  readonly index: number;
  readonly key: string;
  readonly name: string;
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly depth: MeshDepthMaterial | undefined;
  /** The foliage cards: they throw no shadow (`plantMeshes`). */
  readonly cards: boolean;
  readonly centre: Vector3;
  readonly reach: number;
  mesh: InstancedMesh | null;
  capacity: number;
  used: number;
  dead: number;
  matrices: Float32Array;
  colours: Float32Array;
  /** Per slot: centre x, y, z and radius, in the scene's frame. */
  spheres: Float32Array;
  bounds: Bounds | null;
  runs: Map<readonly GardenPlant[], { start: number; count: number }>;
  /** Per drawn position: the slot the GPU buffer holds there since the last cull (-1: unknown). */
  shown: Int32Array;
  /** The cull in progress: positions written so far and the first one that changed. */
  drawn: number;
  firstChanged: number;
}

/** The smallest store worth a mesh. */
const MIN_CAPACITY = 64;

/** DO NOT go back to a pass over every plant of the town per camera move, nor to a flat list of cells */
interface CellNode {
  /** Bounds of everything under it, scene frame; radius < 0 while empty. Grown, never shrunk: a gone plant leaves it conservative. */
  x: number; y: number; z: number; r: number;
  /** Inner node: its four quadrants. */
  readonly children: (CellNode | null)[] | null;
  /** Leaf: per store, its slots in ascending order (dead ones skipped by the cull, dropped at the store's repack). */
  readonly slots: number[][] | null;
}

/** Side of a leaf cell. */
const CELL = m(64);
/** Levels above the leaves: a root spans CELL * 2^LEVELS (65 km), so a town of any size has a handful of roots. */
const LEVELS = 10;
/** Slack on a node's radius over float rounding: a node test may only keep more than its plants' tests would, never less. */
const PAD = m(0.001);
/** Every frustum plane still to test. */
const ALL_PLANES = 0b111111;
/** Integer cell coordinates as one key (exact while |cell| < 2^24). */
const cellKey = (ix: number, iz: number): number => (ix + 0x1000000) * 0x2000000 + (iz + 0x1000000);


/** The buildings' garden lists to place and to take away (`gardenLists.ts`): a list is placed once and taken away by the same object. */
export interface GardenChange {
  readonly added: readonly (readonly GardenPlant[])[];
  readonly removed: readonly (readonly GardenPlant[])[];
}

export interface Gardens extends Scenery {
  /** DO NOT hand it the town's lists to find what changed: that was a pass over the town per building grown. */
  update(change: GardenChange): MeshSwap;
  /** The cull, as `Scenery.cull`; a mesh given more or less room for what is drawn is swapped, the caller putting it in the scene. */
  cull(frustum: Frustum, view: Matrix4): MeshSwap;
}

/** Meshes taken out of the scene and put in. */
interface MeshSwap { readonly removed: readonly InstancedMesh[]; readonly added: readonly InstancedMesh[] }
const NO_SWAP: MeshSwap = { removed: [], added: [] };

export function createGardens(kit: SceneryKit): Gardens {
  const packs = new WeakMap<readonly GardenPlant[], ReadonlyMap<string, GardenPack>>();
  const packOf = (list: readonly GardenPlant[]): ReadonlyMap<string, GardenPack> => {
    let known = packs.get(list);
    if (!known) packs.set(list, known = gardenPack(list));
    return known;
  };
  const stores: Store[] = [];
  const store = (key: string, name: string, geometry: BufferGeometry, material: Material, depth: MeshDepthMaterial | undefined, cards: boolean): void => {
    // The kit's models have their spheres (`createSceneryKit`).
    const sphere = geometry.boundingSphere;
    stores.push({
      index: stores.length, key, name, geometry, material, depth, cards,
      centre: sphere?.center.clone() ?? new Vector3(), reach: sphere?.radius ?? 1,
      mesh: null, capacity: 0, used: 0, dead: 0,
      matrices: new Float32Array(0), colours: new Float32Array(0), spheres: new Float32Array(0), bounds: null, runs: new Map(),
      shown: new Int32Array(0), drawn: 0, firstChanged: 0,
    });
  };
  // The same meshes, in the same order, as the scenery's plants (`plantMeshes`).
  for (const species of TREE_SPECIES) {
    store(`tree:${species}`, `garden-trees-${species}`, kit.trees[species], kit.foliage, kit.foliageDepth, false);
    const cards = kit.cards[species];
    if (cards) store(`tree:${species}`, `garden-trees-${species}-cards`, cards, kit.treeCards, kit.treeCardsDepth, true);
  }
  for (const kind of BUSH_KINDS) {
    store(`bush:${kind}`, `garden-bushes-${kind}`, kit.bushes[kind], kit.shrubs, kit.shrubsDepth, false);
    const cards = kit.cards[kind];
    if (cards) store(`bush:${kind}`, `garden-bushes-${kind}-cards`, cards, kit.shrubCards, kit.shrubCardsDepth, true);
  }

  /** The quadtree's roots, by key, and in key order (the order the cull walks them). */
  const roots = new Map<number, CellNode>();
  let rootOrder: CellNode[] = [];
  const leaves = new Map<number, CellNode>();
  /** The leaves whose bounds grew since the last `update`: their ancestors are grown once at its end. */
  const grown = new Set<number>();
  const emptyNode = (leaf: boolean): CellNode => ({
    x: 0, y: 0, z: 0, r: -1,
    children: leaf ? null : [null, null, null, null],
    slots: leaf ? stores.map(() => []) : null,
  });
  /** The leaf at these cell coordinates, made with its path from the root if new. */
  const leafAt = (ix: number, iz: number): CellNode => {
    const key = cellKey(ix, iz);
    const leaf = leaves.get(key);
    if (leaf) return leaf;
    const rootKey = cellKey(ix >> LEVELS, iz >> LEVELS);
    let node: CellNode | undefined = roots.get(rootKey);
    if (!node) {
      roots.set(rootKey, node = emptyNode(false));
      rootOrder = [...roots.keys()].sort((a, b) => a - b).map((k) => roots.get(k)!);
    }
    for (let level = LEVELS; level > 0; level--) {
      const quadrant = ((ix >> (level - 1)) & 1) | (((iz >> (level - 1)) & 1) << 1);
      const children: (CellNode | null)[] = node.children!;
      node = children[quadrant] ??= emptyNode(level === 1);
    }
    leaves.set(key, node);
    return node;
  };
  /** Grows a node's bounds round a sphere (`enclose`). */
  const grow = (node: CellNode, x: number, y: number, z: number, r: number): void => {
    const b = enclose(node.r < 0 ? null : node, { x, y, z, r });
    node.x = b.x; node.y = b.y; node.z = b.z; node.r = b.r;
  };
  /** Slot `i` of the store put in its cell (slots arrive in ascending order). */
  const file = (s: Store, i: number): void => {
    const sp = s.spheres;
    const x = sp[i * 4]!, y = sp[i * 4 + 1]!, z = sp[i * 4 + 2]!, r = sp[i * 4 + 3]!;
    // Scene z is the world's -y: the cell is found on the ground plane, x and z.
    const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
    const leaf = leafAt(ix, iz);
    leaf.slots![s.index]!.push(i);
    grow(leaf, x, y, z, r);
    grown.add(cellKey(ix, iz));
  };
  /** The grown leaves' ancestors grown round them, root down to the leaf's parent. */
  const growAncestors = (): void => {
    for (const key of grown) {
      const leaf = leaves.get(key)!;
      const ix = Math.floor(key / 0x2000000) - 0x1000000, iz = (key % 0x2000000) - 0x1000000;
      let node = roots.get(cellKey(ix >> LEVELS, iz >> LEVELS))!;
      for (let level = LEVELS; level > 0; level--) {
        grow(node, leaf.x, leaf.y, leaf.z, leaf.r);
        node = node.children![((ix >> (level - 1)) & 1) | (((iz >> (level - 1)) & 1) << 1)]!;
      }
    }
    grown.clear();
  };
  /** The store's slots filed again after a repack moved them. */
  const refile = (s: Store): void => {
    for (const leaf of leaves.values()) leaf.slots![s.index]!.length = 0;
    for (let i = 0; i < s.used; i++) if (s.spheres[i * 4 + 3] !== -Infinity) file(s, i);
  };

  const newMesh = (s: Store, room: number): InstancedMesh => {
    const mesh = new InstancedMesh(s.geometry, s.material, room);
    mesh.name = s.name;
    mesh.castShadow = !s.cards;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    if (s.depth) mesh.customDepthMaterial = s.depth;
    // Every store tinted, white where a plant has none: one program variant for the shared materials.
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(room * 3).fill(1), 3);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    return mesh;
  };
  /** The meshes swapped by the cull in progress (`resize`), for the renderer to put in the scene. */
  let swaps: { removed: InstancedMesh[]; added: InstancedMesh[] } | null = null;
  /** The store's mesh made anew with room for `room` plants drawn, the first `keep` of the old one's carried over */
  const resize = (s: Store, room: number, keep: number): void => {
    const was = s.mesh!;
    const mesh = newMesh(s, room);
    (mesh.instanceMatrix.array as Float32Array).set((was.instanceMatrix.array as Float32Array).subarray(0, keep * 16));
    (mesh.instanceColor!.array as Float32Array).set((was.instanceColor!.array as Float32Array).subarray(0, keep * 3));
    const shown = new Int32Array(room).fill(-1);
    shown.set(s.shown.subarray(0, keep));
    s.shown = shown;
    mesh.visible = was.visible;
    mesh.boundingSphere = was.boundingSphere;
    mesh.count = Math.min(was.count, keep);
    was.dispose();
    swaps ??= { removed: [], added: [] };
    // One made in this same cull never reached the scene: it only leaves the list of those to put in.
    const fresh = swaps.added.indexOf(was);
    if (fresh >= 0) swaps.added.splice(fresh, 1);
    else swaps.removed.push(was);
    swaps.added.push(mesh);
    s.mesh = mesh;
    // A new buffer: everything kept goes up with it.
    s.firstChanged = 0;
  };
  /** The store's arrays sized for `capacity`; packed (`pack`), its live runs from slot 0 in the order they stood. */
  const repack = (s: Store, capacity: number, pack: boolean): void => {
    const matrices = new Float32Array(capacity * 16), colours = new Float32Array(capacity * 3).fill(1), spheres = new Float32Array(capacity * 4);
    if (pack) {
      const runs = new Map<readonly GardenPlant[], { start: number; count: number }>();
      let at = 0;
      for (const [list, run] of [...s.runs].sort((a, b) => a[1].start - b[1].start)) {
        matrices.set(s.matrices.subarray(run.start * 16, (run.start + run.count) * 16), at * 16);
        colours.set(s.colours.subarray(run.start * 3, (run.start + run.count) * 3), at * 3);
        spheres.set(s.spheres.subarray(run.start * 4, (run.start + run.count) * 4), at * 4);
        runs.set(list, { start: at, count: run.count });
        at += run.count;
      }
      s.runs = runs;
      s.used = at;
      s.dead = 0;
      s.bounds = null;
      for (let i = 0; i < at; i++) s.bounds = enclose(s.bounds, { x: spheres[i * 4]!, y: spheres[i * 4 + 1]!, z: spheres[i * 4 + 2]!, r: spheres[i * 4 + 3]! });
      s.matrices = matrices; s.colours = colours; s.spheres = spheres; s.capacity = capacity;
      // The slots moved: the cells hold them anew.
      refile(s);
      return;
    }
    // Only grown: every slot where it was, and in its cell still.
    matrices.set(s.matrices.subarray(0, s.used * 16));
    colours.set(s.colours.subarray(0, s.used * 3));
    spheres.set(s.spheres.subarray(0, s.used * 4));
    s.matrices = matrices; s.colours = colours; s.spheres = spheres; s.capacity = capacity;
  };
  const point = new Vector3(), matrix = new Matrix4();
  const append = (s: Store, list: readonly GardenPlant[], one: GardenPack): void => {
    const start = s.used;
    s.matrices.set(one.matrices, start * 16);
    if (one.colours) s.colours.set(one.colours, start * 3);
    else s.colours.fill(1, start * 3, (start + one.count) * 3);
    let bounds: Bounds | null = null;
    for (let i = 0; i < one.count; i++) {
      matrix.fromArray(one.matrices, i * 16);
      point.copy(s.centre).applyMatrix4(matrix);
      const at = (start + i) * 4, r = s.reach * one.scales[i]!;
      s.spheres[at] = point.x; s.spheres[at + 1] = point.y; s.spheres[at + 2] = point.z; s.spheres[at + 3] = r;
      bounds = enclose(bounds, { x: point.x, y: point.y, z: point.z, r });
    }
    if (bounds) s.bounds = enclose(s.bounds, bounds);
    s.runs.set(list, { start, count: one.count });
    s.used += one.count;
    for (let i = start; i < s.used; i++) file(s, i);
  };

  let culledFor: Matrix4 | null = null;
  /** The map zoom as the last `setMap` gave it (null: never told). */
  let mapMode: boolean | null = null;
  /** Whether a store is drawn at all in the current mode. */
  const drawnNow = (s: Store): boolean => !(s.cards && mapMode === true);
  const probe = new Sphere();
  /** The frustum of the cull in progress. */
  let cullFrustum: Frustum | null = null;
  /** The node and what it holds against the planes of `mask` still unsettled for it */
  const visit = (node: CellNode, mask: number): void => {
    if (node.r < 0) return;
    let inner = mask;
    if (mask !== 0) {
      inner = planeMask(cullFrustum!, node.x, node.y, node.z, node.r + PAD + SHADOW_REACH, mask);
      if (inner < 0) return;
    }
    if (node.children) {
      for (const child of node.children) if (child) visit(child, inner);
      return;
    }
    for (const s of stores) {
      const slots = node.slots![s.index]!;
      const mesh = s.mesh;
      if (!mesh || slots.length === 0 || !drawnNow(s)) continue;
      const sp = s.spheres, matrices = s.matrices, colours = s.colours;
      let shown = s.shown;
      let target = mesh.instanceMatrix.array as Float32Array, tints = mesh.instanceColor!.array as Float32Array;
      let n = s.drawn;
      for (const i of slots) {
        const r = sp[i * 4 + 3]!;
        if (r === -Infinity) continue;
        if (inner !== 0) {
          // A cell across the view's edge: its plants one by one, the same test as ever.
          probe.center.set(sp[i * 4]!, sp[i * 4 + 1]!, sp[i * 4 + 2]!);
          probe.radius = r + SHADOW_REACH;
          if (!cullFrustum!.intersectsSphere(probe)) continue;
        }
        // More in view than the mesh has room for: twice the room.
        if (n === shown.length) {
          resize(s, n * 2, n);
          shown = s.shown;
          target = s.mesh!.instanceMatrix.array as Float32Array;
          tints = s.mesh!.instanceColor!.array as Float32Array;
        }
        // Written only when this position held another plant.
        if (shown[n] !== i) {
          shown[n] = i;
          if (n < s.firstChanged) s.firstChanged = n;
          for (let j = 0; j < 16; j++) target[n * 16 + j] = matrices[i * 16 + j]!;
          tints[n * 3] = colours[i * 3]!; tints[n * 3 + 1] = colours[i * 3 + 1]!; tints[n * 3 + 2] = colours[i * 3 + 2]!;
        }
        n++;
      }
      s.drawn = n;
    }
  };
  const live = (): InstancedMesh[] => stores.flatMap((s) => (s.mesh ? [s.mesh] : []));
  return {
    get meshes() { return live(); },
    grass: new Group(),
    get triangles() {
      let n = 0;
      for (const s of stores) if (s.mesh) n += trianglesOf(s.geometry) * (s.used - s.dead);
      return n;
    },
    update(change) {
      const removed: InstancedMesh[] = [], added: InstancedMesh[] = [];
      // Only the gardens that came and went are read.
      const gone = change.removed, fresh = change.added;
      let touched = false;
      for (const s of stores) {
        let left = 0;
        // A garden changed or gone: its run is never drawn again.
        for (const list of gone) {
          const run = s.runs.get(list);
          if (!run) continue;
          for (let i = run.start; i < run.start + run.count; i++) s.spheres[i * 4 + 3] = -Infinity;
          s.dead += run.count;
          left += run.count;
          s.runs.delete(list);
        }
        let coming = 0;
        for (const list of fresh) coming += packOf(list).get(s.key)?.count ?? 0;
        // A store none of whose gardens came or went: nothing of it is touched.
        if (left === 0 && coming === 0) continue;
        touched = true;
        const was = s.mesh;
        let moved = false;
        if (s.dead > 0 && s.dead * 2 >= s.used + coming) {
          // Half the store dead: packed again in the order the runs stood, the new ones after, in arrays sized for what lives.
          repack(s, Math.max(MIN_CAPACITY, (s.used - s.dead + coming) * 2), true);
          moved = true;
        }
        if (s.used + coming > s.capacity) repack(s, Math.max(MIN_CAPACITY, (s.used + coming) * 2), false);
        for (const list of fresh) {
          const one = packOf(list).get(s.key);
          if (one) append(s, list, one);
        }
        // The mesh holds what is drawn, not the store: it starts small and the cull gives it room (`resize`).
        if (!s.mesh && s.capacity > 0) { s.mesh = newMesh(s, MIN_CAPACITY); s.shown = new Int32Array(MIN_CAPACITY).fill(-1); }
        if (s.mesh && s.bounds) s.mesh.boundingSphere = new Sphere(new Vector3(s.bounds.x, s.bounds.y, s.bounds.z), s.bounds.r);
        if (was !== s.mesh) {
          if (was) { removed.push(was); was.dispose(); }
          if (s.mesh) added.push(s.mesh);
        }
        // DO NOT forget every store's positions at every building
        if (moved) s.shown.fill(-1);
      }
      growAncestors();
      // Slots came or went: the next cull draws them.
      if (touched) culledFor = null;
      return { removed, added };
    },
    // A garden plant has one model at every zoom.
    setNear() {},
    /** DO NOT drop the cull here unconditionally */
    setMap(map) {
      if (mapMode === map) return;
      mapMode = map;
      culledFor = null;
      for (const s of stores) {
        if (!s.cards || !s.mesh) continue;
        s.mesh.visible = !map;
        if (map) s.mesh.count = 0;
      }
    },
    cull(frustum: Frustum, view: Matrix4) {
      if (culledFor && culledFor.equals(view)) return NO_SWAP;
      culledFor = (culledFor ?? new Matrix4()).copy(view);
      for (const s of stores) { s.drawn = 0; s.firstChanged = Infinity; }
      cullFrustum = frustum;
      for (const root of rootOrder) visit(root, ALL_PLANES);
      cullFrustum = null;
      for (const s of stores) {
        if (!s.mesh) continue;
        // Left out at the map zoom: nothing drawn, its buffer as it was.
        if (!drawnNow(s)) { s.mesh.count = 0; continue; }
        // Under a quarter of its room in use: half the room, the plants drawn carried over (twice, then a quarter: never at every small change).
        if (s.drawn * 4 < s.shown.length && s.shown.length > MIN_CAPACITY) resize(s, Math.max(MIN_CAPACITY, s.drawn * 2), s.drawn);
        const mesh = s.mesh;
        // Only the positions whose plant changed go to the GPU; the same plants in view
        if (s.firstChanged < s.drawn) {
          markRange(mesh.instanceMatrix, s.firstChanged * 16, (s.drawn - s.firstChanged) * 16);
          markRange(mesh.instanceColor!, s.firstChanged * 3, (s.drawn - s.firstChanged) * 3);
        }
        mesh.count = s.drawn;
      }
      const swapped = swaps ?? NO_SWAP;
      swaps = null;
      return swapped;
    },
    exclude() { /* a garden's plants are the building's own */ },
    dispose() {
      for (const s of stores) s.mesh?.dispose();
    },
  };
}
