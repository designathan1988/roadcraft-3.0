import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, type WebGLRenderer } from 'three';
import type { CoverKind, GeologyKind, PaintDab } from '@world/terrainPaint';
import { reliefHeight, type ReliefVersion, type TerrainStamp } from '@world/terrain';
import type { RoadDoc } from '@world/doc';
import { MAP_HALF, MAP_REGIONS, PLATE_SIZE, plateOf } from '@world/bounds';
import type { ChangeKind, ChangeRect } from '@world/changes';
import { JournalCursor } from '@world/derived';
import { GroundChanges } from './groundChanges';
import { cancelFlatGround, flatGroundOffPage, readFlatGround, setFlatGroundFocus } from './flatGroundPool';
import { readFarWoods } from './ecologyPool';
import { createFarForest } from './farForest';
import type { PlateMesh } from './plateMesh';
import type { WaterLook } from './water';
import {
  TERRAIN_BASE,
  TERRAIN_CELL,
  TERRAIN_HALF,
  createTerrainSurface,
  slabGeometry,
  wallMaterial,
  type TerrainPart,
  type TerrainRegion,
  type ShapeAsking,
  type TerrainShaper,
  type TerrainSource,
  type TerrainSurface,
} from './terrain';
import { m } from '@world/units';
import type { Aabb } from '@core/aabb';
import type { NaturalPlate } from './groundShape';

/** THE MAP'S GROUND, 10 km on a side (`world/bounds.ts`) */

const REGION_STRIDE = 1000;
/** DO NOT cap the plates by count: the six newest were kept wherever the view stood */
const KEEP_MARGIN = 1.25;
/** Most plates drawn in full near the view. */
const NEAR_MOST = 9;
/** Beyond this much ground in view, no plate is drawn in full: the far mesh alone. */
const NEAR_VIEW = m(1400);
/** Corners along a plate's side (the terrain's grid). */
const SIDE = Math.round((2 * TERRAIN_HALF) / TERRAIN_CELL) + 1;
const PLATES = MAP_REGIONS.length;
/** The kinds of change that put content on a plate (`readContent`): what the whole read marks. */
const CONTENT_KINDS: readonly ChangeKind[] = ['roads', 'buildings', 'lots', 'utilities', 'landscape', 'trees', 'barriers', 'terrain', 'paint'];

class PlateSource implements TerrainSource {
  changes!: RoadDoc['changes'];
  /** The plate's own count of its stamps' changes (`TerrainSource.terrainRevision`), moved only when they did. */
  terrainRevision = 0;
  terrainStamps: TerrainStamp[] = [];
  terrainRelief!: RoadDoc['terrainRelief'];
  natureRevision = 0;
  nature: RoadDoc['nature'] = null;
  /** The plate's own count of its dabs' changes, moved only when they did. */
  paintRevision = 0;
  terrainPaint: PaintDab[] = [];
  terrainGround?: (x: number, y: number) => number;
}

interface Plate {
  readonly index: number;
  readonly cx: number;
  readonly cy: number;
  readonly source: PlateSource;
  surface: TerrainSurface | null;
  shown: boolean;
  used: number;
  /** The land at the plate's grid corners, the base level added, read off the page (`flatGroundPool.ts`), rows from the north edge; null until then. */
  heights: Float64Array | null;
  /** Its first build made off the page, until the plate is made from it (`plateMesh.ts`). */
  mesh: PlateMesh | null;
  /** Whether its corners were asked of the workers (and not yet come back). */
  asked: boolean;
  /** The highest corner of its drawn ground, kept as it changes. */
  top: number;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
/** Whether a disc reaches a plate (its square grown by the disc). */
const reaches = (p: { readonly cx: number; readonly cy: number }, x: number, y: number, radius: number): boolean =>
  Math.abs(x - p.cx) <= TERRAIN_HALF + radius && Math.abs(y - p.cy) <= TERRAIN_HALF + radius;

/** A brush's disc on the map (a stamp of the land, a dab of paint), world coordinates. */
interface Disc { readonly x: number; readonly y: number; readonly radius: number; readonly ox?: number; readonly oy?: number }

/** DO NOT filter the map's every stamp (dab) for every plate at each change: stamps times plates for one dab of the brush */
export class PlateShares<T extends Disc> {
  /** Each plate's items, the document's own, in the document's order. */
  readonly sources: T[][];
  /** The same items moved to each plate's own map (about its centre): the plate's surface reads these. */
  readonly locals: T[][];
  /** Each item's copy on each plate, made once (null: it does not reach the plate). */
  private readonly copies: WeakMap<T, T | null>[];
  /** The document's list as last shared out: its first and last item and its length (`appended`). */
  private first: T | undefined;
  private last: T | undefined;
  private count = 0;
  private readonly side: number;
  private readonly mid: number;

  /** `plates`: the map's plates, row by row from the south-west (`MAP_REGIONS`). */
  constructor(private readonly plates: readonly { readonly cx: number; readonly cy: number }[]) {
    this.sources = plates.map(() => []);
    this.locals = plates.map(() => []);
    this.copies = plates.map(() => new WeakMap());
    this.side = Math.round(Math.sqrt(plates.length));
    this.mid = (this.side - 1) / 2;
  }

  /** Brings every plate's lists up to `list` (`all`: each plate's taken again); returns the plates whose lists changed. */
  update(list: readonly T[], all: boolean): number[] {
    const added = all ? null : this.appended(list);
    this.first = list[0];
    this.last = list[list.length - 1];
    this.count = list.length;
    if (added) {
      // Only the plates the new items reach take them, at the end of their lists, in place.
      const reached = new Set<number>();
      for (const item of added) {
        this.reached(item, (i) => {
          reached.add(i);
          this.sources[i]!.push(item);
          this.locals[i]!.push(this.copyOn(i, item)!);
        });
      }
      return [...reached];
    }
    const moved: number[] = [];
    // @rebuild Every item shared out again (a load, an undo, a clear): each to the plates it reaches; a plate whose list is the same keeps it.
    const lists = this.plates.map((): T[] => []);
    for (const item of list) this.reached(item, (i) => { lists[i]!.push(item); });
    lists.forEach((next, i) => {
      if (!all && sameList(next, this.sources[i]!)) return;
      this.sources[i] = next;
      this.locals[i] = next.map((item) => this.copyOn(i, item)!);
      moved.push(i);
    });
    return moved;
  }

  /** The items added at the end of `list` since it was last shared out (the brush laying them), or null when it changed otherwise. */
  private appended(list: readonly T[]): readonly T[] | null {
    if (this.count === 0 || list.length < this.count || list[0] !== this.first || list[this.count - 1] !== this.last) return null;
    return list.slice(this.count);
  }

  /** The plates a disc reaches (`reaches`), found from its box. */
  private reached(item: T, visit: (plate: number) => void): void {
    const { side, mid } = this;
    const i0 = Math.max(0, Math.floor((item.x - item.radius - TERRAIN_HALF) / PLATE_SIZE) + mid);
    const i1 = Math.min(side - 1, Math.ceil((item.x + item.radius + TERRAIN_HALF) / PLATE_SIZE) + mid);
    const j0 = Math.max(0, Math.floor((item.y - item.radius - TERRAIN_HALF) / PLATE_SIZE) + mid);
    const j1 = Math.min(side - 1, Math.ceil((item.y + item.radius + TERRAIN_HALF) / PLATE_SIZE) + mid);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (reaches(this.plates[j * side + i]!, item.x, item.y, item.radius)) visit(j * side + i);
  }

  /** An item on plate `i`, about its centre (null when it does not reach it); the same copy each time. */
  private copyOn(i: number, item: T): T | null {
    const copies = this.copies[i]!;
    let local = copies.get(item);
    if (local === undefined) {
      const p = this.plates[i]!;
      copies.set(item, local = reaches(p, item.x, item.y, item.radius)
        ? { ...item, x: item.x - p.cx, y: item.y - p.cy, ...(item.ox !== undefined && item.oy !== undefined ? { ox: item.ox - p.cx, oy: item.oy - p.cy } : {}) }
        : null);
    }
    return local;
  }
}

/** The map's far ground: a coarse patch of `FAR_QUADS` x `FAR_QUADS` quads per plate, in world coordinates */
const FAR_QUADS = 32;
const FAR_SIDE = FAR_QUADS + 1;
const SKIRT = m(30);
const FAR_VERTS = FAR_SIDE * FAR_SIDE + 4 * FAR_SIDE;
const FAR_INDICES = FAR_QUADS * FAR_QUADS * 6 + 4 * FAR_QUADS * 12;
export interface FlatFar { readonly geometry: BufferGeometry; readonly all: Uint32Array; readonly high: Float32Array }
export function buildFlatFar(ground: (x: number, y: number) => number): FlatFar {
  const positions = new Float32Array(PLATES * FAR_VERTS * 3);
  const normals = new Float32Array(PLATES * FAR_VERTS * 3);
  const steep = new Float32Array(PLATES * FAR_VERTS);
  const all = new Uint32Array(PLATES * FAR_INDICES);
  const high = new Float32Array(PLATES);
  const step = PLATE_SIZE / FAR_QUADS;
  // Heights on a ring one cell wider than the patch, for its normals.
  const RING = FAR_SIDE + 2;
  const h = new Float64Array(RING * RING);
  let v = 0, w = 0;
  for (let plate = 0; plate < PLATES; plate++) {
    const c = MAP_REGIONS[plate]!;
    const x0 = c.cx - TERRAIN_HALF, y0 = c.cy - TERRAIN_HALF;
    for (let j = 0; j < RING; j++) for (let i = 0; i < RING; i++) h[j * RING + i] = TERRAIN_BASE + ground(x0 + (i - 1) * step, y0 + (j - 1) * step);
    const first = v;
    let top = -Infinity;
    for (let j = 0; j < FAR_SIDE; j++) {
      for (let i = 0; i < FAR_SIDE; i++) {
        const y = h[(j + 1) * RING + i + 1]!;
        if (y > top) top = y;
        positions[v * 3] = x0 + i * step; positions[v * 3 + 1] = y; positions[v * 3 + 2] = -(y0 + j * step);
        // three's axes: x east, y up, z south.
        const nx = h[(j + 1) * RING + i]! - h[(j + 1) * RING + i + 2]!;
        const nz = h[(j + 2) * RING + i + 1]! - h[j * RING + i + 1]!;
        const ny = 2 * step;
        const len = Math.hypot(nx, ny, nz);
        normals[v * 3] = nx / len; normals[v * 3 + 1] = ny / len; normals[v * 3 + 2] = nz / len;
        steep[v] = Math.acos(Math.min(1, ny / len)) * (180 / Math.PI);
        v++;
      }
    }
    high[plate] = top;
    const corner = (i: number, j: number): number => first + j * FAR_SIDE + i;
    for (let j = 0; j < FAR_QUADS; j++) {
      for (let i = 0; i < FAR_QUADS; i++) {
        const p00 = corner(i, j), p10 = corner(i + 1, j), p01 = corner(i, j + 1), p11 = corner(i + 1, j + 1);
        // Counter-clockwise seen from above (east x north = up).
        all[w++] = p00; all[w++] = p10; all[w++] = p01;
        all[w++] = p10; all[w++] = p11; all[w++] = p01;
      }
    }
    // An edge on the map's own rim hangs no skirt: the slab's cut side stands there (`slabGeometry`).
    const onRim = [c.cy - TERRAIN_HALF <= -MAP_HALF + 1e-6, c.cy + TERRAIN_HALF >= MAP_HALF - 1e-6, c.cx - TERRAIN_HALF <= -MAP_HALF + 1e-6, c.cx + TERRAIN_HALF >= MAP_HALF - 1e-6];
    for (let e = 0; e < 4; e++) {
      const hung = v;
      for (let k = 0; k < FAR_SIDE; k++) {
        const t = e === 0 ? corner(k, 0) : e === 1 ? corner(k, FAR_QUADS) : e === 2 ? corner(0, k) : corner(FAR_QUADS, k);
        positions[v * 3] = positions[t * 3]!; positions[v * 3 + 1] = positions[t * 3 + 1]! - SKIRT; positions[v * 3 + 2] = positions[t * 3 + 2]!;
        normals[v * 3] = normals[t * 3]!; normals[v * 3 + 1] = normals[t * 3 + 1]!; normals[v * 3 + 2] = normals[t * 3 + 2]!;
        steep[v] = steep[t]!;
        v++;
      }
      for (let k = 0; k < FAR_QUADS; k++) {
        const t0 = e === 0 ? corner(k, 0) : e === 1 ? corner(k, FAR_QUADS) : e === 2 ? corner(0, k) : corner(FAR_QUADS, k);
        const t1 = e === 0 ? corner(k + 1, 0) : e === 1 ? corner(k + 1, FAR_QUADS) : e === 2 ? corner(0, k + 1) : corner(FAR_QUADS, k + 1);
        const h0 = hung + k, h1 = hung + k + 1;
        if (onRim[e]) { for (let q = 0; q < 12; q++) all[w++] = t0; continue; }
        // Both ways round: the skirt is seen from either side.
        all[w++] = t0; all[w++] = h0; all[w++] = t1;
        all[w++] = t1; all[w++] = h0; all[w++] = h1;
        all[w++] = t0; all[w++] = t1; all[w++] = h0;
        all[w++] = t1; all[w++] = h1; all[w++] = h0;
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('aSteep', new BufferAttribute(steep, 1));
  geometry.setIndex(new BufferAttribute(new Uint32Array(all.length), 1));
  geometry.computeBoundingSphere();
  return { geometry, all, high };
}
/** Writes into the far ground's index the patches of the plates not drawn in full; returns how many indices. */
export function farIndexInto(far: FlatFar, full: (plate: number) => boolean): number {
  const index = far.geometry.getIndex()!;
  const out = index.array as Uint32Array;
  let n = 0;
  for (let plate = 0; plate < PLATES; plate++) {
    if (full(plate)) continue;
    out.set(far.all.subarray(plate * FAR_INDICES, (plate + 1) * FAR_INDICES), n);
    n += FAR_INDICES;
  }
  index.needsUpdate = true;
  index.clearUpdateRanges();
  index.addUpdateRange(0, n);
  far.geometry.setDrawRange(0, n);
  return n;
}

export function createFlatAtlas(anisotropy: number): TerrainSurface {
  const plates: Plate[] = MAP_REGIONS.map((c, index) =>
    ({ index, cx: c.cx, cy: c.cy, source: new PlateSource(), surface: null, shown: false, used: -1, heights: null, mesh: null, asked: false, top: -Infinity }));
  const root = new Group();
  root.name = 'flat-world-ground';

  // The far ground: a surface of its own lends the terrain's material
  const farSurface = createTerrainSurface(anisotropy, { x: 0, y: 0 }, PLATES);
  const farMesh = farSurface.ground;
  farMesh.name = 'flat-world-far';
  farMesh.frustumCulled = false;
  farMesh.receiveShadow = true;
  farMesh.visible = false;
  root.add(farMesh);
  // THE SLAB under the whole map (SimCity 4's): its cut sides all round, the strata from the land down to the bedrock.
  const slab = new Mesh(new BufferGeometry(), wallMaterial(anisotropy));
  slab.name = 'flat-world-slab';
  slab.receiveShadow = true;
  slab.visible = false;
  root.add(slab);
  // THE WOODS OF THE PLATES NOT IN FULL (`farForest.ts`)
  const farForest = createFarForest(MAP_REGIONS, { side: SIDE, cell: TERRAIN_CELL, half: TERRAIN_HALF, base: TERRAIN_BASE, farQuads: FAR_QUADS }, readFarWoods);
  root.add(farForest.object);
  let focusX = 0, focusY = 0;
  /** How far from the view a made plate not drawn is kept (`KEEP_MARGIN`); set with the view (`focus`). */
  let keepReach = Infinity;
  let farRelief: ReliefVersion | null = null;
  let far: FlatFar | null = null;
  const buildFar = (relief: ReliefVersion): void => {
    if (relief === farRelief) return;
    farRelief = relief;
    const land = (x: number, y: number): number => reliefHeight(relief, x, y);
    far = buildFlatFar(land);
    slab.geometry.dispose();
    slab.geometry = slabGeometry(-MAP_HALF, MAP_HALF, -MAP_HALF, MAP_HALF, TERRAIN_CELL, (x, y) => TERRAIN_BASE + land(x, y));
    slab.visible = true;
    farMesh.geometry.dispose();
    farMesh.geometry = far.geometry;
    farMesh.visible = true;
    farIndexInto(far, (i) => plates[i]!.shown);
  };

  let frame = 0;
  let content = new Set<number>();
  let near: number[] = [];
  const shownList: Plate[] = [];
  let partsShown: TerrainPart[] = [];
  let shownVersion = 0;
  let lastSun: { x: number; y: number; z: number } | null = null;
  const lastLook = { waves: NaN, foam: NaN, current: NaN, windX: NaN, windZ: NaN, windSpeed: NaN };
  let lookGiven = false;
  let lastDoc: TerrainSource | null = null;
  let highest = 0;


  /** A plate's highest drawn corner, read once each time its ground moved (not every plate's 90 601 at every change of the set). */
  const measureTop = (p: Plate): void => {
    const heights = p.surface!.ground.geometry.getAttribute('position').array;
    let top = -Infinity;
    for (let i = 1; i < heights.length; i += 3) if (heights[i]! > top) top = heights[i]!;
    p.top = top;
  };
  const measureHighest = (): void => {
    highest = -Infinity;
    for (const p of shownList) if (p.top > highest) highest = p.top;
  };

  const ensure = (p: Plate): TerrainSurface => {
    if (p.surface) return p.surface;
    // Each step of a plate's making measured (F9 and the probes read hitch: measures).
    const t0 = performance.now();
    const s = createTerrainSurface(anisotropy, { x: p.cx, y: p.cy }, p.index, p.mesh);
    // The surface keeps what it copied; the plate keeps only its corners (its land's field).
    p.mesh = null;
    const t1 = performance.now();
    p.surface = s;
    if (lastDoc) {
      s.update(p.source, false);
      const t2 = performance.now();
      s.updatePaint(p.source, true);
      performance.measure('hitch:flat-plate/update', { start: t1, end: t2 });
      performance.measure('hitch:flat-plate/paint', { start: t2, end: performance.now() });
    }
    performance.measure('hitch:flat-plate/create', { start: t0, end: t1 });
    if (lastSun) s.setSun(lastSun);
    if (lookGiven) s.setWaterLook(lastLook);
    measureTop(p);
    return s;
  };
  const show = (p: Plate, on: boolean): void => {
    if (p.shown === on) return;
    p.shown = on;
    const s = p.surface!;
    if (on) root.add(...s.meshes); else root.remove(...s.meshes);
  };
  const letGo = (p: Plate): void => {
    if (!p.surface) return;
    show(p, false);
    p.surface.dispose();
    p.surface = null;
    // Its corners go too (725 kB a plate): read again if it comes back.
    p.heights = null;
    p.mesh = null;
  };
  const home = plateOf(0, 0);
  const refresh = (): void => {
    frame++;
    const wanted = new Set<number>([home, ...content]);
    for (const i of wanted) { const p = plates[i]!; ensure(p); p.used = frame; }
    for (const i of near) { const p = plates[i]!; ensure(p); p.used = frame; wanted.add(i); }
    shownList.length = 0;
    const cached: Plate[] = [];
    for (const p of plates) {
      if (!p.surface) continue;
      const want = wanted.has(p.index);
      show(p, want);
      if (want) shownList.push(p); else cached.push(p);
    }
    for (const p of cached) {
      if (Math.abs(p.cx - focusX) > keepReach || Math.abs(p.cy - focusY) > keepReach) letGo(p);
    }
    if (shownList.length !== partsShown.length || shownList.some((p, k) => partsShown[k]!.surface !== p.surface)) shownVersion++;
    partsShown = shownList.map((p) => ({ surface: p.surface!, cx: p.cx, cy: p.cy }));
    if (far) farIndexInto(far, (i) => plates[i]!.shown);
    measureHighest();
  };

  /** DO NOT walk every node, building, lot, pole, plant and wall of the map at each change */
  const contentCursor = new JournalCursor(CONTENT_KINDS);
  const plateCountOf = (rect: ChangeRect, into: Set<number>): void => {
    const kx0 = Math.round(rect[0] / PLATE_SIZE), kx1 = Math.round(rect[2] / PLATE_SIZE);
    const ky0 = Math.round(rect[1] / PLATE_SIZE), ky1 = Math.round(rect[3] / PLATE_SIZE);
    for (let kx = kx0; kx <= kx1; kx++) for (let ky = ky0; ky <= ky1; ky++) into.add(plateOf(kx * PLATE_SIZE, ky * PLATE_SIZE));
  };
  const readContent = (doc: TerrainSource): boolean => {
    const entries = contentCursor.read(doc.changes);
    if (entries && entries.length === 0) return false;
    if (entries && entries.every((e) => e.rects !== null)) {
      // Marked in place: the plates the changes reach (a stamp or paint has its rects too).
      const before = content.size;
      for (const e of entries) for (const rect of e.rects!) plateCountOf(rect, content);
      return content.size !== before;
    }
    return readWholeContent(doc);
  };
  /** @rebuild Every plate's content read from the whole document: the first time, or when the diary cannot say where. */
  const readWholeContent = (doc: TerrainSource): boolean => {
    const d = doc as Partial<RoadDoc>;
    const next = new Set<number>();
    const mark = (x: number, y: number): void => { next.add(plateOf(x, y)); };
    for (const n of d.nodes?.values() ?? []) mark(n.x, n.y);
    for (const b of d.buildings?.all() ?? []) mark(b.x, b.y);
    for (const l of d.lots ?? []) for (const c of l.corners) mark(c.x, c.y);
    for (const p of d.poles?.values() ?? []) mark(p.x, p.y);
    for (const item of d.landscape?.values() ?? []) mark(item.x, item.y);
    for (const tree of d.trees ?? []) mark(tree.x, tree.y);
    for (const barrier of d.barriers?.values() ?? []) for (const q of barrier.points) mark(q.x, q.y);
    for (const p of plates) if (p.source.terrainStamps.length || p.source.terrainPaint.length) next.add(p.index);
    const changed = next.size !== content.size || [...next].some((i) => !content.has(i));
    content = next;
    return changed;
  };

  // The document's stamps and dabs on each plate they reach, moved to its map (about its centre).
  const stampShares = new PlateShares<TerrainStamp>(MAP_REGIONS);
  const dabShares = new PlateShares<PaintDab>(MAP_REGIONS);
  /** The diary of the land and of the paint: what moved since the last share (`sync`). */
  const terrainCursor = new JournalCursor(['terrain']);
  const paintCursor = new JournalCursor(['paint']);
  let seenRelief: ReliefVersion | null = null;
  /** The map's own land before any stamp, world coordinates (`reliefHeight`). */
  let bare: (x: number, y: number) => number = () => 0;
  const sync = (doc: TerrainSource): void => {
    lastDoc = doc;
    for (const p of plates) {
      p.source.changes = doc.changes;
      p.source.natureRevision = doc.natureRevision;
      p.source.nature = doc.nature;
    }
    if (doc.terrainRelief !== undefined) farForest.book.sync(doc.terrainRelief, doc.nature, focusX, focusY);
    const relief = doc.terrainRelief;
    const reliefMoved = seenRelief !== relief;
    const land = terrainCursor.read(doc.changes);
    if (reliefMoved || land === null || land.length > 0) {
      seenRelief = relief;
      if (reliefMoved) {
        bare = (x, y) => reliefHeight(relief, x, y);
        buildFar(relief);
        for (const p of plates) {
          p.source.terrainRelief = relief;
          p.heights = null; p.mesh = null; p.asked = false;
          // Read over the plate's own corners (off the page), not the field again at each.
          p.source.terrainGround = (lx, ly) => groundOn(p, lx, ly);
        }
      }
      for (const i of stampShares.update(doc.terrainStamps, reliefMoved)) {
        const p = plates[i]!;
        p.source.terrainStamps = stampShares.locals[i]!;
        p.source.terrainRevision++;
      }
    }
    const paint = paintCursor.read(doc.changes);
    if (paint === null || paint.length > 0) {
      for (const i of dabShares.update(doc.terrainPaint, false)) {
        const p = plates[i]!;
        p.source.terrainPaint = dabShares.locals[i]!;
        p.source.paintRevision++;
      }
    }
    if (readContent(doc)) refresh();
  };
  const bareAt = (p: Plate, lx: number, ly: number): number => TERRAIN_BASE + bare(p.cx + lx, p.cy + ly);
  /** A plate's land at a point of its map: its corners as the workers read them */
  function groundOn(p: Plate, lx: number, ly: number): number {
    const h = p.heights;
    if (h) {
      const gx = (lx + TERRAIN_HALF) / TERRAIN_CELL, gy = (TERRAIN_HALF - ly) / TERRAIN_CELL;
      if (gx >= 0 && gy >= 0 && gx <= SIDE - 1 && gy <= SIDE - 1) {
        const i = Math.min(SIDE - 2, Math.floor(gx)), j = Math.min(SIDE - 2, Math.floor(gy));
        const u = gx - i, v = gy - j, k = j * SIDE + i;
        const a = h[k]!, b = h[k + 1]!, c = h[k + SIDE]!, d = h[k + SIDE + 1]!;
        return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v - TERRAIN_BASE;
      }
    }
    return bare(p.cx + lx, p.cy + ly);
  }
  /** Asks the workers for a plate's corners, nearest the view first; the far patch stands in meanwhile (Proland). */
  const askCorners = (p: Plate): void => {
    if (p.asked || p.heights || p.surface || seenRelief === null) return;
    p.asked = true;
    const relief = seenRelief;
    readFlatGround({
      key: p.index, relief, at: { x: p.cx, y: p.cy }, cx: p.cx, cy: p.cy, half: TERRAIN_HALF, cell: TERRAIN_CELL, side: SIDE, base: TERRAIN_BASE,
      done: (mesh) => {
        p.asked = false;
        // A plate made meanwhile keeps the field it was made on; a relief changed meanwhile, the new one.
        if (relief === seenRelief && !p.surface) { p.heights = mesh.heights; p.mesh = mesh; }
        focusKey = '';
      },
      failed: () => { p.asked = false; p.heights = null; p.mesh = null; failedOffPage = true; focusKey = ''; },
    });
  };
  let failedOffPage = false;
  let focusKey = '';
  /** The plates the view wants in full, nearest first, and those of them made (reused: no allocation a frame). */
  const wantedNear: Plate[] = [];
  const nextNear: number[] = [];

  const decode = (region: TerrainRegion): { plate: Plate; local: TerrainRegion } => {
    const index = Math.floor(region[0] / REGION_STRIDE);
    const off = index * REGION_STRIDE;
    return { plate: plates[index]!, local: [region[0] - off, region[1] - off, region[2], region[3]] };
  };
  const encode = (p: Plate, region: TerrainRegion): TerrainRegion => {
    const off = p.index * REGION_STRIDE;
    return [region[0] + off, region[1] + off, region[2], region[3]];
  };
  /** A road field asked in a plate's own coordinates. */
  const shaperFor = (p: Plate, shape: TerrainShaper): TerrainShaper => ({
    shapeAt: (x, y, ground) => shape.shapeAt(x + p.cx, y + p.cy, ground),
    shapeBounds: () => shape.shapeBounds().map((b) => ({ minX: b.minX - p.cx, minY: b.minY - p.cy, maxX: b.maxX - p.cx, maxY: b.maxY - p.cy })),
  });

  /** The regions the last `update` that moved the land rewrote, encoded by plate (`encode`), or null: whole plates. */
  let lastRegions: readonly TerrainRegion[] | null = null;
  const geologyChanges = new GroundChanges();
  const geologySeen = new Map<Plate, number>();
  const sum = (read: (s: TerrainSurface) => number): number => {
    let total = 0;
    for (const p of shownList) total += read(p.surface!);
    return total;
  };
  const ask = <T>(x: number, y: number, read: (s: TerrainSurface, lx: number, ly: number) => T, bareRead: (p: Plate, lx: number, ly: number) => T): T => {
    const p = plates[plateOf(x, y)]!;
    return p.surface ? read(p.surface, x - p.cx, y - p.cy) : bareRead(p, x - p.cx, y - p.cy);
  };

  const first = plates[home]!;
  ensure(first);
  refresh();
  const firstSurface = first.surface!;
  return {
    meshes: [root],
    highest: () => highest,
    ground: firstSurface.ground,
    get parts() { return partsShown; },
    focus(x, y, reach) {
      // In full within some times the ground the view takes in (Proland's split rule), none from far out: the far mesh alone.
      setFlatGroundFocus(x, y);
      focusX = x;
      focusY = y;
      const radius = reach < NEAR_VIEW ? Math.max(TERRAIN_HALF, reach * 1.6) + TERRAIN_HALF : -1;
      keepReach = radius > 0 ? radius * KEEP_MARGIN : 0;
      const key = `${plateOf(x, y)}:${Math.round(radius / TERRAIN_HALF)}`;
      if (key !== focusKey) {
        focusKey = key;
        wantedNear.length = 0;
        if (radius > 0) {
          for (const p of plates) if (Math.abs(p.cx - x) <= radius && Math.abs(p.cy - y) <= radius) wantedNear.push(p);
          wantedNear.sort((a, b) => Math.hypot(a.cx - x, a.cy - y) - Math.hypot(b.cx - x, b.cy - y));
          if (wantedNear.length > NEAR_MOST) wantedNear.length = NEAR_MOST;
        }
        for (const p of plates) if (p.asked && !wantedNear.includes(p) && !content.has(p.index)) { cancelFlatGround(p.index); p.asked = false; }
      }
      // One plate made this frame: the nearest whose corners are in (or, with no workers, the nearest at all).
      const offPage = !failedOffPage && flatGroundOffPage();
      let made = false;
      for (const p of wantedNear) {
        if (p.surface) continue;
        if (offPage && !p.heights) { askCorners(p); continue; }
        if (made) continue;
        ensure(p);
        made = true;
      }
      // Drawn: the wanted plates that are made.
      nextNear.length = 0;
      for (const p of wantedNear) if (p.surface) nextNear.push(p.index);
      if (nextNear.length === near.length && nextNear.every((v, k) => v === near[k]) && nextNear.every((i) => plates[i]!.shown)) return;
      near = nextNear.slice();
      refresh();
    },
    setSun(direction) {
      lastSun = direction;
      for (const p of shownList) p.surface!.setSun(direction);
      farSurface.setSun(direction);
    },
    bakeRelief(renderer: WebGLRenderer, focus) {
      // Each made plate's painted ground written since the last frame, sent before this one is drawn.
      for (const p of plates) p.surface?.bakeRelief(renderer, focus);
      // The far woods: each plate's fade from whether it is in full and its own trees can grow.
      const now = performance.now() / 1000;
      for (const p of plates) farForest.book.setFull(p.index, p.shown, p.surface?.ecology() != null, now);
      farForest.update(renderer, now);
    },
    setWaterLook(look: WaterLook) {
      const was = lastLook;
      if (was.waves === look.waves && was.foam === look.foam && was.current === look.current
        && was.windX === look.windX && was.windZ === look.windZ && was.windSpeed === look.windSpeed) return;
      Object.assign(was, look);
      lookGiven = true;
      for (const p of plates) p.surface?.setWaterLook(look);
    },
    setVegetation(amount) {
      farForest.book.setVegetation(amount);
    },
    vergeMaterial: firstSurface.vergeMaterial,
    heightAt: (x, y) => ask(x, y, (s, lx, ly) => s.heightAt(lx, ly), bareAt),
    naturalRenderedHeightAt: (x, y) => ask(x, y, (s, lx, ly) => s.naturalRenderedHeightAt(lx, ly), bareAt),
    renderedHeightAt: (x, y) => ask(x, y, (s, lx, ly) => s.renderedHeightAt(lx, ly), bareAt),
    wetAt: (x, y) => ask(x, y, (s, lx, ly) => s.wetAt(lx, ly), () => false),
    digest(minX, minY, maxX, maxY) {
      const p = plates[plateOf((minX + maxX) / 2, (minY + maxY) / 2)]!;
      if (!p.surface) return p.index * 7919 + (seenRelief ?? 0) * 31 + 1;
      return p.surface.digest(minX - p.cx, minY - p.cy, maxX - p.cx, maxY - p.cy) + p.index;
    },
    update(doc, stroking) {
      sync(doc);
      // DO NOT keep only the last plate's: a dab across a plate's edge moves the land of both.
      let moved = false;
      let regions: TerrainRegion[] | null = [];
      for (const p of shownList) {
        if (!p.surface!.update(p.source, stroking)) continue;
        moved = true;
        const own = p.surface!.lastRegion;
        regions = own && regions ? [...regions, ...own.map((r) => encode(p, r))] : null;
        measureTop(p);
      }
      if (moved) { measureHighest(); lastRegions = regions; }
      return moved;
    },
    updatePaint(doc) {
      sync(doc);
      for (const p of shownList) {
        p.surface!.updatePaint(p.source, false);
        const v = p.surface!.geologyChanges.version;
        if (v !== geologySeen.get(p)) { geologySeen.set(p, v); geologyChanges.mark(null); }
      }
    },
    forestAt: (x, y) => ask(x, y, (s, lx, ly) => s.forestAt(lx, ly), () => 0),
    coverAt: (kind: CoverKind, x, y) => ask(x, y, (s, lx, ly) => s.coverAt(kind, lx, ly), () => 0),
    get forestRevision() { return sum((s) => s.forestRevision) + shownVersion * 1_000_003; },
    geologyAt: (x, y) => ask(x, y, (s, lx, ly) => s.geologyAt(lx, ly), (): GeologyKind => firstSurface.geologyAt(0, 0)),
    ecology: () => firstSurface.ecology(),
    get ecologyRevision() { return sum((s) => s.ecologyRevision) + shownVersion * 1_000_003; },
    ecologyTexture: firstSurface.ecologyTexture,
    geologyChanges,
    shoreLevelAt: (x, y) => ask(x, y, (s, lx, ly) => s.shoreLevelAt(lx, ly), () => null),
    waterArea() {
      let box: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
      for (const p of shownList) {
        const w = p.surface!.waterArea();
        if (!w) continue;
        const b = { minX: w.minX + p.cx, maxX: w.maxX + p.cx, minY: w.minY + p.cy, maxY: w.maxY + p.cy };
        box = box ? { minX: Math.min(box.minX, b.minX), maxX: Math.max(box.maxX, b.maxX), minY: Math.min(box.minY, b.minY), maxY: Math.max(box.maxY, b.maxY) } : b;
      }
      return box;
    },
    get waterRevision() { return sum((s) => s.waterRevision); },
    get lastRegion() { return lastRegions; },
    settle() { for (const p of shownList) p.surface!.settle(); },
    shapeToRoads(shape, region = null) {
      const list: readonly TerrainRegion[] | null = region === null ? null
        : typeof region[0] === 'number' ? [region as TerrainRegion] : region as readonly TerrainRegion[];
      let moved = false;
      if (list === null) {
        for (const p of shownList) if (p.surface!.shapeToRoads(shape && shaperFor(p, shape), null)) { moved = true; measureTop(p); }
        if (moved) measureHighest();
        return moved;
      }
      const byPlate = new Map<Plate, TerrainRegion[]>();
      for (const r of list) {
        const { plate, local } = decode(r);
        let mine = byPlate.get(plate);
        if (!mine) byPlate.set(plate, mine = []);
        mine.push(local);
      }
      for (const [p, regions] of byPlate) if (ensure(p).shapeToRoads(shape && shaperFor(p, shape), regions)) { moved = true; measureTop(p); }
      if (moved) measureHighest();
      return moved;
    },
    askShape(region, bounds) {
      const list: readonly TerrainRegion[] | null = region === null ? null
        : typeof region[0] === 'number' ? [region as TerrainRegion] : region as readonly TerrainRegion[];
      // Each plate's pass, as `shapeToRoads` above makes them: the plates shown, or those the regions name.
      const parts: { p: Plate; s: TerrainSurface; asking: ShapeAsking }[] = [];
      if (list === null) {
        const local = (p: Plate): Aabb[] | null => bounds && bounds.map((b) => ({ minX: b.minX - p.cx, minY: b.minY - p.cy, maxX: b.maxX - p.cx, maxY: b.maxY - p.cy }));
        for (const p of shownList) parts.push({ p, s: p.surface!, asking: p.surface!.askShape(null, local(p)) });
      } else {
        const byPlate = new Map<Plate, TerrainRegion[]>();
        for (const r of list) {
          const { plate, local } = decode(r);
          let mine = byPlate.get(plate);
          if (!mine) byPlate.set(plate, mine = []);
          mine.push(local);
        }
        for (const [p, regions] of byPlate) { const s = ensure(p); parts.push({ p, s, asking: s.askShape(regions, null) }); }
      }
      return {
        plates: parts.flatMap(({ p, asking }) => asking.plates.map((a) => ({ ...a, cx: p.cx, cy: p.cy }))),
        take(answers) {
          let moved = false;
          let k = 0;
          for (const { p, s, asking } of parts) {
            const mine = answers.slice(k, k += asking.plates.length);
            // A plate let go meanwhile took its ground with it, as it would have with the pass made here.
            if (p.surface !== s) continue;
            if (asking.take(mine)) { moved = true; measureTop(p); }
          }
          if (moved) measureHighest();
          return moved;
        },
      };
    },
    naturalCut(boxes) {
      const out = new Map<number, NaturalPlate>();
      for (const box of boxes) {
        for (const [x, y] of [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]] as const) {
          const p = plates[plateOf(x, y)]!;
          const corners = p.surface?.naturalCorners?.();
          if (!corners || out.has(p.index)) continue;
          out.set(p.index, { index: p.index, cx: p.cx, cy: p.cy, n: SIDE, cell: TERRAIN_CELL, half: TERRAIN_HALF, ...corners });
        }
      }
      return [...out.values()];
    },
    regionOf(box) {
      const p = plates[plateOf((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)]!;
      return encode(p, ensure(p).regionOf([box[0] - p.cx, box[1] - p.cy, box[2] - p.cx, box[3] - p.cy]));
    },
    rectOf(region) {
      const { plate, local } = decode(region);
      const r = ensure(plate).rectOf(local);
      return [r[0] + plate.cx, r[1] + plate.cy, r[2] + plate.cx, r[3] + plate.cy];
    },
    dispose() {
      for (const p of plates) p.surface?.dispose();
      farSurface.dispose();
      farForest.dispose();
      slab.geometry.dispose();
      (slab.material as MeshStandardMaterial).map?.dispose();
      (slab.material as MeshStandardMaterial).dispose();
    },
  };
}
