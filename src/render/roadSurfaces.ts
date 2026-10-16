import { Color, Group, type Material, type Mesh } from 'three';

import type { Poly } from '@core/clipper';
import { Digest } from '@core/digest';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { Level, ROAD_TYPES, laneWidth } from '@world/roadTypes';
import type { CarriagewayMaterial } from '@world/roadSection';
import { footwayRiseShare, packFlush } from '@world/roads/footwayRise';
import { rampsMeeting, walkingRise } from '@world/curbRamps';
import type { CurbRamp } from '@world/rampRise';
import { RAISED_LIFT, isRaised, roadStructure } from '@world/structures';
import type { RoadElevation } from '@world/elevation';
import { LANE_LINE } from '@world/roadTypes';
import { PAINT_RISE } from './markings';
import { type Reach, SurfaceInputs, TILE, TILE_BIAS, TILE_ORIGIN } from './roadSurfaceInputs';
import type { Input } from './roadSurfaceRings';
import type { SceneMaterials } from './materials';
import { TERRAIN_CELL } from './terrain';
import { attachFarLevel, cloneBlock, mergeTiles, tilesOnGpu } from './mesh/surfaceTiles';
import { cancelWarm, warmLooseAhead } from './uploads';
import { levelsOf } from './mesh/roadLod';
import type { VertexReads } from './mesh/roadLodPure';
import { vertexReadsOf } from './mesh/roadEdges';
import { type TilePolys, type TileSource, tileShapes } from './roadTileShape';
import type { RoadTiler, TileJob } from './roadTilePool';
import type { SurfaceData } from './roadTileMesh';
import {
  FOOTWAY_EDGE_CELL,
  passSurfaces,
  tileSpecOf,
  type PassDesc,
  type RoadLook,
  type SurfaceRead,
  type SurfaceReads,
} from './roadSurfaceReads';
import type { SurfaceShape } from './mesh/tileShape';
import {
  disposeMesh,
  meshTileShape,
  type SurfaceMeshOptions,
  type Tile,
  type TileRect,
} from './mesh/surfaceMesh';

export { TERRAIN_UV } from './roadSurfaceReads';

/** The road network's surface bands */

/** Longest triangle edge on a road at grade. */
const GROUND_MAX_EDGE = TERRAIN_CELL / 2;
/** A raised deck follows nothing, so it needs vertices only for its shading. */
const RAISED_MAX_EDGE = TERRAIN_CELL;

/** What one build of the surfaces keeps for the next, so an edit rebuilds only the tiles it reaches. */
export interface SurfaceReuse {
  /** DO NOT keep a tile's arrays here */
  readonly tiles: Map<string, Map<number, KeptTile>>;
  /** A digest of everything the height field and the texture frames read in a rectangle */
  readonly dependsOn: (minX: number, minY: number, maxX: number, maxY: number) => number;
  /** The paint materials, by colour: made once, not on every rebuild. */
  readonly paint: Map<string, Material>;
  /** The meshes of each block of tiles */
  readonly chunks: Map<string, { readonly parts: readonly number[]; readonly mesh: Mesh }>;
  /** Block meshes replaced but maybe still drawn: freed by the owner once the new roads are in. */
  readonly retired?: Mesh[];
  /** Whether a block at (x, y), world units, is near the camera: made at full detail, its far level hidden */
  readonly near?: (x: number, y: number) => boolean;
  /** Tiles kept from an earlier session (`derivedCache.ts`), by `storedKey`: read as a build needs them, never the whole store */
  readonly stored?: StoredTiles;
  /** The passes' inputs, kept road by road and node by node between builds (`roadSurfaceInputs.ts`) */
  readonly inputs?: SurfaceInputs;
  /** Each tile built afresh, to be kept for a later session */
  readonly keep?: (key: string, bundle: TileBundle) => void;
}

/** The tiles kept from an earlier session: which keys the store holds, and a read of some of them. */
interface StoredTiles {
  has(key: string): boolean;
  /** These tiles; a key the store no longer holds is left out. */
  read(keys: readonly string[]): Promise<ReadonlyMap<string, TileBundle>>;
}

/** The box round a block's tiles' rectangles, [minX, minY, maxX, maxY]. */
function blockBox(rects: readonly TileRect[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) { minX = Math.min(minX, r[0]); minY = Math.min(minY, r[1]); maxX = Math.max(maxX, r[2]); maxY = Math.max(maxY, r[3]); }
  return [minX, minY, maxX, maxY];
}

/** A block into the group with its far level, which waits hidden beside it (`mesh/roadLod.ts`). */
function addBlock(group: Group, mesh: Mesh): void {
  group.add(mesh);
  const coarse = levelsOf(mesh)?.coarse;
  if (coarse) group.add(coarse);
}

/** The name a tile is kept under between sessions: its pass and its digest. */
export const storedKey = (pass: string, digest: number): string => `${pass}|${digest}`;

/** Frees what a `SurfaceReuse` holds on the GPU. */
export function disposeSurfaceReuse(reuse: SurfaceReuse): void {
  for (const { mesh } of reuse.chunks?.values() ?? []) disposeMesh(mesh);
  reuse.chunks?.clear();
  for (const mesh of reuse.retired?.splice(0) ?? []) disposeMesh(mesh);
  for (const material of reuse.paint.values()) material.dispose();
}

/** Every surface of one tile, by mesh name. */
export type TileBundle = ReadonlyMap<string, Tile>;
/** A tile kept between builds: the names of the surfaces it has. Its digest is its key. */
type KeptTile = readonly string[];

/** One tile of a pass in a build: its digest and block, its rings, its surfaces and arrays once known. */
interface PassTile {
  readonly value: number;
  readonly chunk: string;
  readonly rect: TileRect;
  readonly into: Reach;
  surfaces: KeptTile | null;
  bundle: TileBundle | null;
}

/** Whether a block's tiles are the ones its mesh was merged from, by digest. */
function sameTiles(parts: readonly number[], list: readonly PassTile[]): boolean {
  return parts.length === list.length && list.every((tile, i) => tile.value === parts[i]);
}

/** One surface's tiles in a block, built again from their rings (a lost WebGL context, `mesh/gpuOnly.ts`) */
function surfaceSource(spec: SurfaceSpec, tiles: readonly { readonly rect: TileRect; readonly into: Reach }[],
  reading: <T>(work: () => T) => T): () => Tile[] {
  return () => tiles.map(({ rect, into }) =>
    reading(() => bundleOf(tileShapes(polysOf(into), rect, [tileSpecOf(spec)]), [spec]).get(spec.options.name)!));
}

export interface RoadSurfaces {
  readonly group: Group;
  readonly meshes: readonly Mesh[];
  readonly triangles: number;
  /** Tiles the build made afresh, and copied from the build before. */
  readonly built: number;
  readonly reused: number;
  /** Tiles kept from before built again to merge a block that changed (their arrays are not kept). */
  readonly remade: number;
  /** Where the tiles made afresh lie (`world/changes.ts`). */
  readonly rebuilt: readonly TileRect[];
  /** The time the tiles and their blocks took, ms, without the frames between slices. */
  readonly workMs: number;
  /** Puts the blocks kept from the build before into `group`, at the swap. */
  adopt(): void;
  dispose(): void;
}

/** Tiles a side of one mesh. */
const CHUNK = 4;
/** Tiles a batch asked of the workers at once (`roadTilePool.ts`) */
const SHAPE_BATCH = 64;

/** Linear-space tints per road class, so the asphalt mesh can vary by class. */
const CLASS_TINT: readonly Color[] = ROAD_TYPES.map((type) =>
  new Color(type.color),
);
/** The tint the asphalt material is authored against, so 1.0 means "as baked". */
const TINT_REFERENCE = new Color(0x3a3d3f);
/** A carriageway's tone by what it is paved with; asphalt keeps its class's. */
const CARRIAGEWAY_TINT: Readonly<Record<Exclude<CarriagewayMaterial, 'asphalt'>, Color>> = {
  concrete: new Color(0x8f8d88),
  cobble: new Color(0x6a5f52),
};
/** A colour against the reference, channel by channel: the multiplier a vertex is tinted with. */
const againstReference = (tint: Color): [number, number, number] =>
  [tint.r / TINT_REFERENCE.r, tint.g / TINT_REFERENCE.g, tint.b / TINT_REFERENCE.b];
/** The carriageway's tints as a pass reads them (`PassDesc`): numbers, made once here with three's colour management. */
const CLASS_TINTS: readonly number[] = CLASS_TINT.flatMap(againstReference);
const REFERENCE_TINT = againstReference(TINT_REFERENCE);
const PAVING_TINTS: Readonly<Record<string, readonly [number, number, number]>> = Object.fromEntries(
  Object.entries(CARRIAGEWAY_TINT).map(([name, tint]) => [name, againstReference(tint)]));
/** What each surface of a tile is made from (`roadTileShape.ts`). */
type Source = TileSource;

/** One surface of a structural level: how it is meshed, and from what. */
interface SurfaceSpec {
  readonly source: Source;
  readonly options: Omit<SurfaceMeshOptions, 'polygons'>;
  readonly renderOrder?: number;
  /** What its material's shader reads past position, normal and uv: only those go to the GPU (`mergeTiles`). */
  readonly reads: VertexReads;
}

/** The road a surface reads beside the field, as a pass sees it (`RoadLook`): its paving, widths and mouths. */
function lookOf(net: Network, id: SegmentId): RoadLook | undefined {
  const ribbon = net.ribbons.get(id);
  if (!ribbon) return undefined;
  const trims = net.trims.get(id);
  const materials = ribbon.road.materials;
  return {
    width: ribbon.road.width,
    lane: laneWidth(ribbon.road),
    from: trims?.a[Level.Asphalt] ?? 0,
    to: ribbon.full.length - (trims?.b[Level.Asphalt] ?? 0),
    carriageway: materials?.carriageway,
    footwayLeft: materials?.footwayLeft,
    footwayRight: materials?.footwayRight,
  };
}

export function buildRoadSurfaces(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
  reuse?: SurfaceReuse,
  groundMaterial?: Material,
): RoadSurfaces {
  const steps = roadSurfaceSteps(net, elevation, materials, terrainAt, reuse, groundMaterial);
  let step = steps.next();
  while (!step.done) step = steps.next();
  step.value.adopt();
  return step.value;
}

/** `buildRoadSurfaces` in steps: it yields after each tile built and each block merged */
export function* roadSurfaceSteps(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
  reuse?: SurfaceReuse,
  groundMaterial?: Material,
  /** Shapes the tiles off the page (`roadTilePool.ts`); then the steps yield 'wait' while it works. None: all here. */
  tiler?: RoadTiler | null,
): Generator<'wait' | void, RoadSurfaces, void> {
  const started = performance.now();
  let tilesMs = 0;
  let mergeMs = 0;
  let chunksMerged = 0;
  let chunksKept = 0;
  let remade = 0;
  const chunks = reuse?.chunks;
  const usedChunks = new Set<string>();
  /** The blocks whose far level is being made by the workers (`mergeTiles`): the build waits for them before it ends. */
  let coarsening = 0;
  // A block let go before its upload came is taken out of the queue first (`uploads.ts` `cancelWarm`)
  const retire = (mesh: Mesh): void => { cancelWarm(levelsOf(mesh)?.coarse ? [mesh, levelsOf(mesh)!.coarse!] : [mesh]); if (reuse?.retired) reuse.retired.push(mesh); else disposeMesh(mesh); };
  const group = new Group();
  group.name = 'road-network';
  const meshes: Mesh[] = [];
  let triangles = 0;
  let built = 0;
  let reused = 0;
  const rebuilt: TileRect[] = [];
  // The paint of every colour, made at load (`paintCatalogue`): read here, never made.
  const paint = reuse?.paint;
  const paintFor = (color: string): Material => paint?.get(color) ?? paint?.get(LANE_LINE) ?? materials.asphalt;

  const reading = <T>(work: () => T): T => elevation.remembering ? elevation.remembering(work) : work();
  // The inputs of every pass, kept road by road and node by node and brought up to the network by its change
  const inputs = reuse?.inputs ?? new SurfaceInputs();
  inputs.refresh(net);
  // Roads at authored heights are drawn on their own, each from its own deck
  const passes = inputs.passList();
  if (reuse) {
    const current = new Set(passes.map((pass) => pass.id));
    for (const id of reuse.tiles.keys()) if (!current.has(id)) reuse.tiles.delete(id);
  }
  // Every pass may paint in every colour of the catalogue: a colour with no line in a tile draws nothing there
  const paintColours = inputs.paintColours();
  for (const pass of passes) {
    yield;
    const structure = roadStructure(pass.structure);
    const present = pass.chain !== undefined || inputs.present(structure.id);
    if (!present) {
      reuse?.tiles.delete(pass.id);
      continue;
    }

    const raised = pass.chain !== undefined
      ? pass.chain.some((id) => {
        const line = net.ribbons.get(id)?.full;
        if (!line) return false;
        for (let s = 0; s <= line.length; s += Math.max(4, line.length / 24)) {
          const p = line.sampleAt(s).p;
          if (elevation.onSegment(id, p.x, p.y) - terrainAt(p.x, p.y) > RAISED_LIFT) return true;
        }
        return false;
      })
      : isRaised(structure.id);
    const maxEdge = raised ? RAISED_MAX_EDGE : GROUND_MAX_EDGE;

    // DO NOT merge every footway of the pass: the union of a town's footways is one ring round the whole town
    const footwayEdges = new Map<number, number[] | undefined>();
    const edgesAt = (key: number): number[] | undefined => {
      if (!footwayEdges.has(key)) footwayEdges.set(key, inputs.footwayEdges(pass.id, key));
      return footwayEdges.get(key);
    };
    /** Each road's look, asked per vertex: made once a pass. */
    const looks = new Map<SegmentId, RoadLook | undefined>();
    const look = (id: SegmentId): RoadLook | undefined => {
      if (!looks.has(id)) looks.set(id, lookOf(net, id));
      return looks.get(id);
    };
    /** What this pass's surfaces read on the page: the network and the solved field (in a worker, `SurfaceData`). */
    const pageReads: SurfaceReads = {
      field: elevation,
      terrainAt,
      lineOf: (id) => net.ribbons.get(id)?.full,
      look,
      footwayShare: (x, y) => footwayRiseShare(net, x, y),
      walkingRise: (x, y, at) => walkingRise(net, x, y, true, at),
      footwayEdges: edgesAt,
    };
    net.crossingSurface();
    yield;
    /** The pass as its surfaces read it, plain data: the same on the page and in a worker (`roadSurfaceReads.ts`). */
    const desc: PassDesc = {
      id: pass.id,
      structure: structure.id,
      ...(pass.segment !== undefined ? { segment: pass.segment } : {}),
      ...(pass.chain !== undefined ? { chain: pass.chain } : {}),
      rootType: pass.segment === undefined ? 0 : net.doc.segment(pass.segment)?.type ?? 0,
      raised,
      maxEdge,
      groundMaterial: groundMaterial !== undefined,
      scale: { asphalt: materials.scale.asphalt, footway: materials.scale.footway, kerb: materials.scale.kerb, verge: materials.scale.verge, deck: materials.scale.deck },
      paint: paintColours,
      paintLift: 0.02 + PAINT_RISE,
      classTint: CLASS_TINTS,
      referenceTint: REFERENCE_TINT,
      pavingTint: PAVING_TINTS,
    };
    const specs = passSurfaces(desc, pageReads).map((read) => dress(read, raised, materials, groundMaterial, paintFor));

    // Everything a tile's build reads besides its rings and its surroundings
    const specSalt = (spec: SurfaceSpec): number => new Digest().addText(spec.options.name).add(spec.options.maxEdge)
      .add(spec.options.uvWorld ?? 0).add(spec.options.skirtUvScale ?? 0).add(spec.options.bottom ? 1 : 0)
      .add(spec.options.tint ? 1 : 0).value();
    const salt = new Digest().addText(pass.id);
    const paintSalt = new Map<string, number>();
    for (const spec of specs) {
      if (spec.source.kind === 'paint') paintSalt.set(spec.source.color, specSalt(spec));
      else salt.add(specSalt(spec));
    }
    const saltValue = salt.value();

    const previous = reuse?.tiles.get(pass.id);
    const kept = new Map<number, KeptTile>();
    /** The tiles in tile order: kept from before (its surfaces known, its arrays not), read from the store, or to build. */
    const tiles: PassTile[] = [];
    /** The tiles to read from the store kept from an earlier session (`SurfaceReuse.stored`). */
    const storedWanted: PassTile[] = [];
    // In tile order, so a mesh is laid out the same however it was reached.
    for (const key of inputs.tileKeys(pass.id)) {
      const { reach: into, digest: read, colours } = inputs.reachOf(pass.id, key);
      const ix = Math.floor(key / 0x1_0000) - TILE_BIAS;
      const iy = (key % 0x1_0000) - TILE_BIAS;
      const rect: TileRect = [
        ix * TILE + TILE_ORIGIN, iy * TILE + TILE_ORIGIN, (ix + 1) * TILE + TILE_ORIGIN, (iy + 1) * TILE + TILE_ORIGIN,
      ];
      // A paint colour's constants in the keys of the tiles that hold lines of that colour alone.
      const digest = new Digest().add(saltValue).add(key).add(read);
      for (const color of colours) digest.add(paintSalt.get(color) ?? 0);
      if (reuse) digest.add(reuse.dependsOn(rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1));
      const value = digest.value();
      const surfaces = previous?.get(value);
      const chunk = `${Math.floor(ix / CHUNK)},${Math.floor(iy / CHUNK)}`;
      const tile: PassTile = { value, chunk, rect, into, surfaces: surfaces ?? null, bundle: null };
      tiles.push(tile);
      // Kept by the store from an earlier session: read below, with the pass's others, only while the steps can wait.
      if (!surfaces && tiler && reuse?.stored?.has(storedKey(pass.id, value))) storedWanted.push(tile);
      if (surfaces) {
        reused++;
        // A step too: the digests of every tile kept, back to back, were a slice of 20-30 ms after a road edit
        yield;
      }
    }
    if (storedWanted.length) {
      let read: ReadonlyMap<string, TileBundle> | null = null;
      reuse!.stored!.read(storedWanted.map((tile) => storedKey(pass.id, tile.value))).then((got) => { read = got; }, (error: unknown) => {
        console.warn('[roads] the kept tiles could not be read; they are built', error);
        read = new Map();
      });
      while (read === null) yield 'wait';
      for (const tile of storedWanted.splice(0)) {
        const bundle = (read as ReadonlyMap<string, TileBundle>).get(storedKey(pass.id, tile.value));
        if (!bundle) continue;
        tile.bundle = bundle;
        tile.surfaces = [...bundle.keys()];
        reused++;
      }
    }
    /** The roads a share of the tiles reads, for a worker (`roadTileMesh.ts`) */
    const dataFor = (rects: readonly TileRect[]): { data: SurfaceData; transfer: ArrayBuffer[] } => {
      // A unit round each tile: its vertices lie on its edges, and the cut puts some a rounding past them.
      const around = rects.map((r): [number, number, number, number] => [r[0] - 1, r[1] - 1, r[2] + 1, r[3] + 1]);
      const packed = elevation.fieldFor!(around, pass.chain ?? []);
      const field = packed.data;
      const transfer = [...packed.transfer];
      const lookList: [SegmentId, RoadLook][] = [];
      const seen = new Set<SegmentId>();
      for (const id of [...field.ids as unknown as SegmentId[], ...(pass.chain ?? [])]) {
        if (seen.has(id)) continue;
        seen.add(id);
        const found = look(id);
        if (found) lookList.push([id, found]);
      }
      const ramps = new Set<CurbRamp>();
      const edgeKeys = new Set<number>();
      for (const rect of around) {
        for (const r of rampsMeeting(net, rect)) if (r.structure === structure.id) ramps.add(r);
        if (raised) continue;
        for (let cx = Math.floor(rect[0] / FOOTWAY_EDGE_CELL); cx <= Math.floor(rect[2] / FOOTWAY_EDGE_CELL); cx++) {
          for (let cy = Math.floor(rect[1] / FOOTWAY_EDGE_CELL); cy <= Math.floor(rect[3] / FOOTWAY_EDGE_CELL); cy++) {
            const key = (cx + 32768) * 65536 + (cy + 32768);
            if (edgesAt(key)) edgeKeys.add(key);
          }
        }
      }
      const flush = packFlush(net, around);
      transfer.push(...flush.transfer);
      const edgeLists = [...edgeKeys].map((key) => Float64Array.from(edgesAt(key)!));
      const joined = concat(edgeLists);
      const edgeData = { keys: Float64Array.from(edgeKeys), ends: joined.lineEnds, xy: joined.lines };
      for (const array of [edgeData.keys, edgeData.ends, edgeData.xy]) transfer.push(array.buffer as ArrayBuffer);
      return { data: { field, looks: lookList, flush: flush.data, ramps: [...ramps], edges: edgeData }, transfer };
    };
    /** DO NOT cut, triangulate or read the vertices of a city's tiles on the page: the whole of its roads' build (2026-10-15). */
    const offPage = tiler && elevation.fieldFor ? tiler : null;
    const buildAll = function* (list: readonly PassTile[], done: (tile: PassTile) => void): Generator<'wait' | void, void, void> {
      /** Asks the tiler for `SHAPE_BATCH` tiles from `from` on; the answer lands in the record it returns. */
      const ask = (from: number): { readonly from: number; readonly answer: { tiles?: Map<string, Tile>[]; failed?: boolean } } => {
        const answer: { tiles?: Map<string, Tile>[]; failed?: boolean } = {};
        const request: TileJob = {
          pass: desc,
          tiles: list.slice(from, from + SHAPE_BATCH).map((t) => ({ rect: t.rect, into: polysOf(t.into) })),
          dataFor,
          terrainAt,
        };
        offPage!.tiles(request).then(
          (tiles) => { answer.tiles = tiles; },
          (error: unknown) => { console.warn('[roads] the road tile workers failed; the tiles are built on the page', error); answer.failed = true; },
        );
        return { from, answer };
      };
      // DO NOT ask for every tile at once: a whole city's tiles held together, before any was merged, took the page past 7 GB
      let job = offPage && list.length ? ask(0) : null;
      let failed = false;
      for (let from = 0; from < list.length; from += SHAPE_BATCH) {
        let made: Map<string, Tile>[] | null = null;
        if (job && !failed) {
          while (!job.answer.tiles && !job.answer.failed) { offPage!.check(); yield 'wait'; }
          made = job.answer.tiles ?? null;
          if (!made) failed = true;
          job = !failed && from + SHAPE_BATCH < list.length ? ask(from + SHAPE_BATCH) : null;
        }
        for (let k = from; k < Math.min(list.length, from + SHAPE_BATCH); k++) {
          const tile = list[k]!;
          const tileAt = performance.now();
          // Made off the page: taken as it is.
          const bundle = made ? made[k - from]! : reading(() => buildTile(tile.into, tile.rect, specs));
          tile.bundle = bundle;
          tile.surfaces = [...bundle.keys()];
          tilesMs += performance.now() - tileAt;
          done(tile);
          yield;
        }
      }
    };
    /** The tiles built afresh this pass: kept for a later session once merged (below). */
    const fresh: PassTile[] = [];
    yield* buildAll(tiles.filter((t) => t.surfaces === null), (tile) => {
      built++;
      rebuilt.push(tile.rect);
      fresh.push(tile);
    });
    for (const tile of tiles) kept.set(tile.value, tile.surfaces!);
    reuse?.tiles.set(pass.id, kept);

    /** Each surface's tiles, by block of tiles, in tile order. */
    const parts = new Map<string, Map<string, PassTile[]>>();
    for (const spec of specs) parts.set(spec.options.name, new Map());
    for (const tile of tiles) {
      for (const name of tile.surfaces!) {
        const blocks = parts.get(name);
        if (!blocks) continue;
        const list = blocks.get(tile.chunk);
        if (list) list.push(tile);
        else blocks.set(tile.chunk, [tile]);
      }
    }
    // A block keeps its mesh while its tiles are the same (by digest).
    const keyOf = (spec: SurfaceSpec, chunk: string): string =>
      `${pass.id}|${spec.options.name}|${chunk}|${spec.options.material.uuid}|${spec.renderOrder ?? ''}`;
    const again = new Set<PassTile>();
    for (const spec of specs) {
      for (const [chunk, list] of parts.get(spec.options.name) ?? []) {
        const known = chunks?.get(keyOf(spec, chunk));
        if (known && sameTiles(known.parts, list)) continue;
        for (const tile of list) if (!tile.bundle) again.add(tile);
      }
    }
    yield* buildAll([...again], () => { remade++; });

    const mergeAt = performance.now();
    for (const spec of specs) {
      for (const [chunk, list] of parts.get(spec.options.name) ?? []) {
        const key = keyOf(spec, chunk);
        const known = chunks?.get(key);
        let mesh: Mesh | null;
        // DO NOT let the mesh hold its tiles for it: a second copy of every road on the GPU, kept on the CPU
        const source = surfaceSource(spec, list.map((tile) => ({ rect: tile.rect, into: tile.into })), reading);
        if (known && sameTiles(known.parts, list)) {
          mesh = known.mesh;
          // Bound to this build's rings: the build that made it lets go of its own.
          tilesOnGpu(mesh, spec.reads, source);
          chunksKept++;
        } else {
          if (known) retire(known.mesh);
          // The block's box and centre, to lock its edge in the far level and to tell near from far (`roadLod.ts`).
          const coarsen = reuse?.near && tiler?.coarsen ? tiler.coarsen.bind(tiler) : null;
          const lock = coarsen ? blockBox(list.map((tile) => tile.rect)) : null;
          const near = lock ? reuse!.near!((lock[0] + lock[2]) / 2, (lock[1] + lock[3]) / 2) : true;
          let started: Mesh | null = null;
          mesh = mergeTiles(list.map((tile) => tile.bundle!.get(spec.options.name)!), spec.options, spec.reads, source,
            lock ? {
              lock, near,
              start: (block, arrays) => {
                started = block;
                coarsening++;
                coarsen!(cloneBlock(arrays), lock).then((made) => {
                  // The block may have been built again meanwhile: its far level is of the one it was made for.
                  if (chunks?.get(key)?.mesh !== block) return;
                  if (made) {
                    const level = attachFarLevel(block, made, spec.options, spec.reads, source, lock, near);
                    if (!near) void warmLooseAhead([level]);
                  } else if (!near) void warmLooseAhead([block]);
                }).catch((error: unknown) => {
                  // No far level for this block: it stays at full detail, sent to the GPU.
                  console.warn('[roads] the far level of a block could not be made', error);
                  if (chunks?.get(key)?.mesh === block) void warmLooseAhead([block]);
                }).finally(() => { coarsening--; });
              },
            } : undefined);
          void started;
          if (mesh && spec.renderOrder !== undefined) mesh.renderOrder = spec.renderOrder;
          // DO NOT wait for the camera to frame it: a block out of view was never uploaded and kept its copy on the CPU
          if (mesh && !(lock && !near)) void warmLooseAhead([mesh]);
          if (mesh) chunks?.set(key, { parts: list.map((tile) => tile.value), mesh });
          else chunks?.delete(key);
          chunksMerged++;
          yield;
        }
        if (!mesh) continue;
        usedChunks.add(key);
        // A kept block stays where it is drawn until the swap (`adopt`).
        if (mesh.parent === null) addBlock(group, mesh);
        meshes.push(mesh);
        triangles += (mesh.geometry.index?.count ?? 0) / 3;
      }
    }
    // The tiles' arrays go with `tiles` here: copied into the blocks, which send them to the GPU.
    mergeMs += performance.now() - mergeAt;
    // Kept for a later session only now, every block merged
    for (const tile of fresh) reuse?.keep?.(storedKey(pass.id, tile.value), tile.bundle!);
  }
  // Blocks no surface has any more.
  if (chunks) for (const [key, { mesh }] of chunks) if (!usedChunks.has(key)) { retire(mesh); chunks.delete(key); }
  // DO NOT wait without a deadline: `check` fails the pool when a worker is silent.
  while (coarsening > 0) { tiler?.check(); yield 'wait'; }
  // Where an edit's time went (`hitch:` entries).
  const end = performance.now();
  performance.measure(`hitch:road-edit/surfaces ${built} tiles built ${reused} kept ${remade} remade, ${chunksMerged} blocks merged ${chunksKept} kept: tiles ${tilesMs.toFixed(0)} ms, merge ${mergeMs.toFixed(0)} ms`, { start: started, end });
  return {
    group,
    meshes,
    triangles,
    built,
    reused,
    remade,
    rebuilt,
    workMs: tilesMs + mergeMs,
    adopt() {
      // Every block, in the order it was built: the order a fresh build draws them in.
      for (const mesh of meshes) addBlock(group, mesh);
    },
    dispose() {
      // Meshes the cache keeps are freed by `disposeSurfaceReuse`.
      if (!chunks) for (const mesh of meshes) disposeMesh(mesh);
      group.clear();
    },
  };
}

/** Arrays end to end, with where each ends: one buffer to hand over instead of one an array. */
function concat(parts: readonly ArrayLike<number>[]): { lineEnds: Uint32Array; lines: Float64Array } {
  let length = 0;
  for (const part of parts) length += part.length;
  const lines = new Float64Array(length);
  const lineEnds = new Uint32Array(parts.length);
  let at = 0;
  parts.forEach((part, i) => { lines.set(part, at); at += part.length; lineEnds[i] = at; });
  return { lineEnds, lines };
}

/** A surface as the page draws it: what it reads (`passSurfaces`) with its material and shadows, and what that material reads per vertex. */
function dress(read: SurfaceRead, raised: boolean, materials: SceneMaterials, groundMaterial: Material | undefined,
  paintFor: (color: string) => Material): SurfaceSpec {
  const spec = dressed(read, raised, materials, groundMaterial, paintFor);
  return { ...spec, reads: vertexReadsOf(spec.options.material) };
}

/** `dress` without the reads. */
function dressed(read: SurfaceRead, raised: boolean, materials: SceneMaterials, groundMaterial: Material | undefined,
  paintFor: (color: string) => Material): Omit<SurfaceSpec, 'reads'> {
  const source = read.source;
  if (source.kind === 'paint') {
    return { source, options: { ...read.options, material: paintFor(source.color), receiveShadow: true }, renderOrder: 3 };
  }
  if (source.kind === 'median') {
    const material = source.part === 'kerb' ? materials.kerb : source.part === 'planting' ? materials.verge : materials.footway;
    return { source, options: { ...read.options, material, receiveShadow: true } };
  }
  switch (source.band) {
    case 'verge':
      return { source, options: { ...read.options, material: raised ? materials.deck : groundMaterial ?? materials.verge, castShadow: raised, receiveShadow: true } };
    case 'footway':
    case 'curbRamp':
      return { source, options: { ...read.options, material: materials.footway, castShadow: raised, receiveShadow: true } };
    case 'kerb':
      return { source, options: { ...read.options, material: materials.kerb, receiveShadow: true } };
    case 'asphalt':
      return { source, options: { ...read.options, material: raised ? materials.asphaltRaised : materials.asphalt, castShadow: raised, receiveShadow: true } };
  }
}

/** Every surface of one tile, from the rings that reach it */
function buildTile(into: Reach, rect: TileRect, specs: readonly SurfaceSpec[]): TileBundle {
  return bundleOf(tileShapes(polysOf(into), rect, specs.map(tileSpecOf)), specs);
}

/** A tile's surfaces from their shapes, each vertex read here (`meshTileShape`): a tile the page builds itself (a worker makes its own, `roadTileMesh.ts`). */
function bundleOf(shapes: ReadonlyMap<string, SurfaceShape>, specs: readonly SurfaceSpec[]): TileBundle {
  const bundle = new Map<string, Tile>();
  for (const spec of specs) {
    const shape = shapes.get(spec.options.name);
    if (shape) bundle.set(spec.options.name, meshTileShape(shape, spec.options));
  }
  return bundle;
}


/** A tile's rings without their digests: what its shapes are cut from. */
function polysOf(into: Reach): TilePolys {
  const polys = (list: readonly Input[]): Poly[] => list.map((input) => input.poly);
  return {
    levels: { casing: polys(into.levels.casing), sidewalk: polys(into.levels.sidewalk), curb: polys(into.levels.curb), asphalt: polys(into.levels.asphalt) },
    medians: { kerb: polys(into.medians.kerb), planting: polys(into.medians.planting), paved: polys(into.medians.paved) },
    ramps: polys(into.ramps),
    ribbons: polys(into.ribbons),
    quads: new Map([...into.quads].map(([color, list]) => [color, polys(list)])),
  };
}
