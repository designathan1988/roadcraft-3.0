import {
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Frustum,
  type Material,
  type MeshDepthMaterial,
} from 'three';
import { m } from '@world/units';
import { type Bounds, enclose, markRange, planeMask } from './instanceCull';
import { trianglesOf } from './propGeometry';

/** The same design as the buildings' gardens (`gardens.ts`, which keeps a run per garden list) */

/** One mesh of the layer: a model, its material, how it is drawn. */
export interface RunStore {
  readonly name: string;
  /** Its bounding sphere computed (each slot's sphere is grown from it). */
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** The shadow pass's material (the wind's sway). */
  readonly depth?: MeshDepthMaterial;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly renderOrder?: number;
  /** Has a colour per instance (white where a thing gives none): one program variant for its material. */
  readonly tinted: boolean;
  /** Leaf cards: left out at the map zoom (`setMap`). */
  readonly cards: boolean;
}

/** A thing's instances in one store: matrices (three's column order), tints (tinted stores) and each one's largest scale. */
interface RunPack {
  readonly matrices: Float32Array;
  readonly colours: Float32Array | null;
  readonly scales: Float32Array;
  readonly count: number;
}

/** A thing's instances, by store index. Never changed once made: a changed thing is a new run. */
export type Run = ReadonlyMap<number, RunPack>;

/** Runs to take away and to put in. A run is taken away by the same object that was put in. */
interface RunChange {
  readonly removed: readonly Run[];
  readonly added: readonly Run[];
}

/** Builds a run, placement by placement. */
export class RunBuilder {
  private readonly lists = new Map<number, { matrices: number[]; colours: number[]; scales: number[] }>();

  constructor(private readonly stores: readonly RunStore[]) {}

  /** One instance in `store`: its matrix (16 numbers), its largest scale, and its tint (r, g, b; white when none). */
  add(store: number, matrix: ArrayLike<number>, scale: number, tint?: { readonly r: number; readonly g: number; readonly b: number }): void {
    let list = this.lists.get(store);
    if (!list) this.lists.set(store, list = { matrices: [], colours: [], scales: [] });
    for (let i = 0; i < 16; i++) list.matrices.push(matrix[i]!);
    list.scales.push(scale);
    if (this.stores[store]!.tinted) list.colours.push(tint?.r ?? 1, tint?.g ?? 1, tint?.b ?? 1);
  }

  build(): Run {
    const run = new Map<number, RunPack>();
    for (const [store, list] of [...this.lists].sort((a, b) => a[0] - b[0])) {
      run.set(store, {
        matrices: Float32Array.from(list.matrices),
        colours: this.stores[store]!.tinted ? Float32Array.from(list.colours) : null,
        scales: Float32Array.from(list.scales),
        count: list.scales.length,
      });
    }
    return run;
  }
}

/** Whether two runs hold the same instances, bit for bit. */
export function sameRun(a: Run, b: Run): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [store, pa] of a) {
    const pb = b.get(store);
    if (!pb || pa.count !== pb.count) return false;
    if (!sameArray(pa.matrices, pb.matrices) || !sameArray(pa.scales, pb.scales)) return false;
    if ((pa.colours === null) !== (pb.colours === null) || (pa.colours && !sameArray(pa.colours, pb.colours!))) return false;
  }
  return true;
}

function sameArray(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

export interface InstanceRuns {
  /** Every mesh of the layer, under `group`. */
  readonly group: Group;
  readonly meshes: readonly InstancedMesh[];
  readonly triangles: number;
  /** The runs that came and went; the meshes grown are swapped under `group`. */
  update(change: RunChange): void;
  /** The map zoom: the leaf cards are left out, neither culled nor drawn. Only a change of mode does anything. */
  setMap(map: boolean): void;
  /** Keeps the instances of each shown store the camera can see, or see the margin round. */
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

/** One store's instances: every run's slots, the dead ones with a radius of -Infinity. */
interface Store {
  readonly index: number;
  readonly spec: RunStore;
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
  runs: Map<Run, { start: number; count: number }>;
  /** Per drawn position: the slot the GPU buffer holds there since the last cull (-1: unknown); as long as the mesh holds positions. */
  shown: Int32Array;
  /** Culled for the current view. */
  current: boolean;
  /** Culled by the walk in progress, and what it wrote. */
  active: boolean;
  drawn: number;
  firstChanged: number;
}

/** A leaf cell or an inner node of the quadtree. Bounds grown, never shrunk: a slot gone leaves it conservative. */
interface CellNode {
  x: number; y: number; z: number; r: number;
  readonly children: (CellNode | null)[] | null;
  /** Leaf: per store, its slots in ascending order (dead ones skipped by the cull, dropped at the store's repack). */
  readonly slots: number[][] | null;
}

/** The smallest store worth a mesh. */
const MIN_CAPACITY = 64;
/** Side of a leaf cell. */
const CELL = m(64);
/** Levels above the leaves: a root spans CELL * 2^LEVELS (65 km), so a town of any size has a handful of roots. */
const LEVELS = 10;
/** Slack on a node's radius over float rounding: a node test may only keep more than its slots' tests would, never less. */
const PAD = m(0.001);
/** Every frustum plane still to test. */
const ALL_PLANES = 0b111111;
/** Integer cell coordinates as one key (exact while |cell| < 2^24). */
const cellKey = (ix: number, iz: number): number => (ix + 0x1000000) * 0x2000000 + (iz + 0x1000000);

/** A store's mesh of `capacity` slots, none drawn: as the layer draws it - its program's variant */
function runMesh(spec: RunStore, capacity: number): InstancedMesh {
  const mesh = new InstancedMesh(spec.geometry, spec.material, capacity);
  mesh.name = spec.name;
  mesh.castShadow = spec.castShadow;
  mesh.receiveShadow = spec.receiveShadow;
  if (spec.renderOrder !== undefined) mesh.renderOrder = spec.renderOrder;
  // Culled per slot (`cull`): a sphere round the whole map rejects nothing.
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // The shadow pass bends with the wind too.
  if (spec.depth) mesh.customDepthMaterial = spec.depth;
  if (spec.tinted) {
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
  }
  mesh.count = 0;
  return mesh;
}

/** Meshes of each of these stores, one slot each, as the layer draws them: what compiles the layer's programs ahead */
export function warmMeshes(specs: readonly RunStore[]): InstancedMesh[] {
  return specs.map((spec) => {
    const mesh = runMesh(spec, 1);
    mesh.count = 1;
    return mesh;
  });
}

/** The layer over these stores. */
export function createInstanceRuns(name: string, specs: readonly RunStore[], margin: number): InstanceRuns {
  const group = new Group();
  group.name = name;
  const stores: Store[] = specs.map((spec, index) => {
    if (!spec.geometry.boundingSphere) spec.geometry.computeBoundingSphere();
    const sphere = spec.geometry.boundingSphere;
    return {
      index, spec, centre: sphere?.center.clone() ?? new Vector3(), reach: sphere?.radius ?? 1,
      mesh: null, capacity: 0, used: 0, dead: 0,
      matrices: new Float32Array(0), colours: new Float32Array(0), spheres: new Float32Array(0), bounds: null, runs: new Map(),
      shown: new Int32Array(0), current: false, active: false, drawn: 0, firstChanged: 0,
    };
  });

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
  const growNode = (node: CellNode, x: number, y: number, z: number, r: number): void => {
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
    growNode(leaf, x, y, z, r);
    grown.add(cellKey(ix, iz));
  };
  const growAncestors = (): void => {
    for (const key of grown) {
      const leaf = leaves.get(key)!;
      const ix = Math.floor(key / 0x2000000) - 0x1000000, iz = (key % 0x2000000) - 0x1000000;
      let node = roots.get(cellKey(ix >> LEVELS, iz >> LEVELS))!;
      for (let level = LEVELS; level > 0; level--) {
        growNode(node, leaf.x, leaf.y, leaf.z, leaf.r);
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

  /** The store's mesh made anew with room for `room` positions drawn, the first `keep` of the old one's carried over */
  const resize = (s: Store, room: number, keep: number): void => {
    const was = s.mesh!;
    const mesh = runMesh(s.spec, room);
    (mesh.instanceMatrix.array as Float32Array).set((was.instanceMatrix.array as Float32Array).subarray(0, keep * 16));
    if (s.spec.tinted) (mesh.instanceColor!.array as Float32Array).set((was.instanceColor!.array as Float32Array).subarray(0, keep * 3));
    const shown = new Int32Array(room).fill(-1);
    shown.set(s.shown.subarray(0, keep));
    s.shown = shown;
    mesh.visible = was.visible;
    mesh.boundingSphere = was.boundingSphere;
    mesh.count = Math.min(was.count, keep);
    group.remove(was);
    was.dispose();
    group.add(mesh);
    s.mesh = mesh;
    // A new buffer: everything kept goes up with it.
    s.firstChanged = 0;
  };
  /** The store's arrays sized for `capacity`; packed (`pack`), its live runs from slot 0 in the order they stood. */
  const repack = (s: Store, capacity: number, pack: boolean): void => {
    const matrices = new Float32Array(capacity * 16), colours = new Float32Array(s.spec.tinted ? capacity * 3 : 0).fill(1);
    const spheres = new Float32Array(capacity * 4);
    if (pack) {
      const runs = new Map<Run, { start: number; count: number }>();
      let at = 0;
      for (const [run, slots] of [...s.runs].sort((a, b) => a[1].start - b[1].start)) {
        matrices.set(s.matrices.subarray(slots.start * 16, (slots.start + slots.count) * 16), at * 16);
        if (s.spec.tinted) colours.set(s.colours.subarray(slots.start * 3, (slots.start + slots.count) * 3), at * 3);
        spheres.set(s.spheres.subarray(slots.start * 4, (slots.start + slots.count) * 4), at * 4);
        runs.set(run, { start: at, count: slots.count });
        at += slots.count;
      }
      s.runs = runs;
      s.used = at;
      s.dead = 0;
      s.bounds = null;
      for (let i = 0; i < at; i++) s.bounds = enclose(s.bounds, { x: spheres[i * 4]!, y: spheres[i * 4 + 1]!, z: spheres[i * 4 + 2]!, r: spheres[i * 4 + 3]! });
      s.matrices = matrices; s.colours = colours; s.spheres = spheres; s.capacity = capacity;
      refile(s);
      return;
    }
    // Only grown: every slot where it was, and in its cell still.
    matrices.set(s.matrices.subarray(0, s.used * 16));
    if (s.spec.tinted) colours.set(s.colours.subarray(0, s.used * 3));
    spheres.set(s.spheres.subarray(0, s.used * 4));
    s.matrices = matrices; s.colours = colours; s.spheres = spheres; s.capacity = capacity;
  };
  const point = new Vector3(), matrix = new Matrix4();
  const append = (s: Store, run: Run, one: RunPack): void => {
    const start = s.used;
    s.matrices.set(one.matrices, start * 16);
    if (s.spec.tinted) {
      if (one.colours) s.colours.set(one.colours, start * 3);
      else s.colours.fill(1, start * 3, (start + one.count) * 3);
    }
    let bounds: Bounds | null = null;
    for (let i = 0; i < one.count; i++) {
      matrix.fromArray(one.matrices, i * 16);
      point.copy(s.centre).applyMatrix4(matrix);
      const at = (start + i) * 4, r = s.reach * one.scales[i]!;
      s.spheres[at] = point.x; s.spheres[at + 1] = point.y; s.spheres[at + 2] = point.z; s.spheres[at + 3] = r;
      bounds = enclose(bounds, { x: point.x, y: point.y, z: point.z, r });
    }
    if (bounds) s.bounds = enclose(s.bounds, bounds);
    s.runs.set(run, { start, count: one.count });
    s.used += one.count;
    for (let i = start; i < s.used; i++) file(s, i);
  };

  let culledFor: Matrix4 | null = null;
  /** The map zoom as the last `setMap` gave it (null: never told). */
  let mapMode: boolean | null = null;
  const drawnNow = (s: Store): boolean => !(s.spec.cards && mapMode === true);
  const probe = new Sphere();
  let cullFrustum: Frustum | null = null;
  /** The node and what it holds against the planes of `mask` still unsettled for it */
  const visit = (node: CellNode, mask: number): void => {
    if (node.r < 0) return;
    let inner = mask;
    if (mask !== 0) {
      inner = planeMask(cullFrustum!, node.x, node.y, node.z, node.r + PAD + margin, mask);
      if (inner < 0) return;
    }
    if (node.children) {
      for (const child of node.children) if (child) visit(child, inner);
      return;
    }
    for (const s of stores) {
      if (!s.active) continue;
      const slots = node.slots![s.index]!;
      if (slots.length === 0) continue;
      const sp = s.spheres, matrices = s.matrices, colours = s.colours;
      let shown = s.shown;
      let target = s.mesh!.instanceMatrix.array as Float32Array;
      let tints = s.spec.tinted ? s.mesh!.instanceColor!.array as Float32Array : null;
      let n = s.drawn;
      for (const i of slots) {
        const r = sp[i * 4 + 3]!;
        if (r === -Infinity) continue;
        if (inner !== 0) {
          // A cell across the view's edge: its slots one by one.
          probe.center.set(sp[i * 4]!, sp[i * 4 + 1]!, sp[i * 4 + 2]!);
          probe.radius = r + margin;
          if (!cullFrustum!.intersectsSphere(probe)) continue;
        }
        // More in view than the mesh has room for: twice the room.
        if (n === shown.length) {
          resize(s, n * 2, n);
          shown = s.shown;
          target = s.mesh!.instanceMatrix.array as Float32Array;
          tints = s.spec.tinted ? s.mesh!.instanceColor!.array as Float32Array : null;
        }
        // Written only when this position held another slot.
        if (shown[n] !== i) {
          shown[n] = i;
          if (n < s.firstChanged) s.firstChanged = n;
          for (let j = 0; j < 16; j++) target[n * 16 + j] = matrices[i * 16 + j]!;
          if (tints) { tints[n * 3] = colours[i * 3]!; tints[n * 3 + 1] = colours[i * 3 + 1]!; tints[n * 3 + 2] = colours[i * 3 + 2]!; }
        }
        n++;
      }
      s.drawn = n;
    }
  };

  return {
    group,
    get meshes() { return stores.flatMap((s) => (s.mesh ? [s.mesh] : [])); },
    get triangles() {
      let n = 0;
      for (const s of stores) if (s.mesh) n += trianglesOf(s.spec.geometry) * (s.used - s.dead);
      return n;
    },
    update(change) {
      for (const s of stores) {
        let left = 0;
        // A thing changed or gone: its run is never drawn again.
        for (const run of change.removed) {
          const slots = s.runs.get(run);
          if (!slots) continue;
          for (let i = slots.start; i < slots.start + slots.count; i++) s.spheres[i * 4 + 3] = -Infinity;
          s.dead += slots.count;
          left += slots.count;
          s.runs.delete(run);
        }
        let coming = 0;
        for (const run of change.added) coming += run.get(s.index)?.count ?? 0;
        // A store none of whose things came or went: nothing of it is touched.
        if (left === 0 && coming === 0) continue;
        const was = s.mesh;
        let moved = false;
        if (s.dead > 0 && s.dead * 2 >= s.used + coming) {
          // Half the store dead: packed again in the order the runs stood, the new ones after, in arrays sized for what lives.
          repack(s, Math.max(MIN_CAPACITY, (s.used - s.dead + coming) * 2), true);
          moved = true;
        }
        if (s.used + coming > s.capacity) repack(s, Math.max(MIN_CAPACITY, (s.used + coming) * 2), false);
        for (const run of change.added) {
          const one = run.get(s.index);
          if (one) append(s, run, one);
        }
        // The mesh holds what is drawn, not the store: it starts small and the cull gives it room (`resize`).
        if (!s.mesh && s.capacity > 0) { s.mesh = runMesh(s.spec, MIN_CAPACITY); s.shown = new Int32Array(MIN_CAPACITY).fill(-1); }
        if (s.mesh && s.bounds) s.mesh.boundingSphere = new Sphere(new Vector3(s.bounds.x, s.bounds.y, s.bounds.z), s.bounds.r);
        if (was !== s.mesh) {
          if (was) { group.remove(was); was.dispose(); }
          if (s.mesh) {
            // Hidden as the one it replaces was, until the next frame says otherwise.
            if (was) s.mesh.visible = was.visible;
            else if (s.spec.cards && mapMode === true) s.mesh.visible = false;
            group.add(s.mesh);
          }
        }
        // DO NOT forget every store's positions at every edit: one thing more sent every instance in view to the GPU again.
        if (moved) s.shown.fill(-1);
        // Its slots came or went: culled again at the next frame.
        s.current = false;
      }
      growAncestors();
    },
    setMap(map) {
      if (mapMode === map) return;
      mapMode = map;
      for (const s of stores) {
        if (!s.spec.cards) continue;
        s.current = false;
        if (!s.mesh) continue;
        s.mesh.visible = !map;
        if (map) s.mesh.count = 0;
      }
    },
    cull(frustum, view) {
      if (!culledFor || !culledFor.equals(view)) {
        culledFor = (culledFor ?? new Matrix4()).copy(view);
        for (const s of stores) s.current = false;
      }
      // DO NOT cull every store at every move whatever is shown.
      let any = false;
      for (const s of stores) {
        s.active = s.mesh !== null && !s.current && s.mesh.visible && drawnNow(s);
        if (s.active) { any = true; s.drawn = 0; s.firstChanged = Infinity; }
      }
      if (!any) return;
      cullFrustum = frustum;
      for (const root of rootOrder) visit(root, ALL_PLANES);
      cullFrustum = null;
      for (const s of stores) {
        if (!s.active) continue;
        s.active = false;
        s.current = true;
        // Under a quarter of its room in use: half the room, the positions drawn carried over (never at every small change: twice, then a quarter).
        if (s.drawn * 4 < s.shown.length && s.shown.length > MIN_CAPACITY) resize(s, Math.max(MIN_CAPACITY, s.drawn * 2), s.drawn);
        const mesh = s.mesh!;
        // Only the positions whose slot changed go to the GPU.
        if (s.firstChanged < s.drawn) {
          markRange(mesh.instanceMatrix, s.firstChanged * 16, (s.drawn - s.firstChanged) * 16);
          if (s.spec.tinted) markRange(mesh.instanceColor!, s.firstChanged * 3, (s.drawn - s.firstChanged) * 3);
        }
        mesh.count = s.drawn;
      }
    },
    dispose() {
      for (const s of stores) s.mesh?.dispose();
      group.clear();
    },
  };
}
