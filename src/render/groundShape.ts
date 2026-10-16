import { Digest } from '@core/digest';
import { plateOf } from '@world/bounds';
import { type PadShapeCut, padShaper } from '@world/buildings/pads';
import { type RoadElevation, type RoadShapeCut, roadShaper } from '@world/elevation';
import { type CornerGrid, type TerrainRegion, sampleCorners, shapeBoth, shapeCorners } from './terrainShaping';

/** THE GROUND'S CUT AND FILL WORKED OUT OFF THE PAGE (`groundShape.worker.ts`) */

/** One plate's part of a shaping pass: its corners asked, as its mesh stands them. */
export interface PlateShapeAsk {
  /** The plate's centre: its corners are in its own coordinates, the roads and platforms in the world's. */
  readonly cx: number;
  readonly cy: number;
  /** Corners a side. */
  readonly n: number;
  /** The regions shaped, four numbers each (x0, x1, y0, y1, corners, clamped to the plate), in the pass's order. */
  readonly regions: Int32Array;
  /** `whole`: `xy` and `natural` hold every corner of the plate */
  readonly whole: boolean;
  /** Each corner's x and y where the mesh stands it (`CornerGrid.x`, `y`). */
  readonly xy: Float64Array;
  /** Each corner's height before any road or platform shaped it. */
  readonly natural: Float64Array;
}

/** A shaping pass asked of the worker: the roads and the platforms its corners read, and its plates. */
export interface GroundShapeAsk {
  readonly roads: RoadShapeCut | null;
  readonly pads: PadShapeCut | null;
  readonly plates: readonly PlateShapeAsk[];
}

/** The corners a plate's pass moved, in the order the pass met them, and their new heights. */
export interface PlateShapeAnswer {
  readonly corners: Int32Array;
  readonly heights: Float64Array;
}

/** A plate's part of a pass as the worker takes it (`terrain.ts` `askShape`) */
export function askPlate(grid: CornerGrid, natural: Float64Array, regions: readonly TerrainRegion[]): PlateShapeAsk {
  const n = grid.n;
  const clamped = new Int32Array(regions.length * 4);
  let count = 0;
  regions.forEach((r, k) => {
    const x0 = Math.max(0, r[0]), x1 = Math.min(n - 1, r[1]), y0 = Math.max(0, r[2]), y1 = Math.min(n - 1, r[3]);
    // DO NOT store an empty region as it is: an empty box's infinities became 0..0 in the integers, a corner never counted.
    const empty = !(x1 >= x0 && y1 >= y0);
    clamped[k * 4] = empty ? 1 : x0; clamped[k * 4 + 1] = empty ? 0 : x1; clamped[k * 4 + 2] = empty ? 1 : y0; clamped[k * 4 + 3] = empty ? 0 : y1;
    if (!empty) count += (x1 - x0 + 1) * (y1 - y0 + 1);
  });
  // Regions over as many corners as the plate has: the plate's corners once.
  const whole = count >= n * n;
  const xy = new Float64Array((whole ? n * n : count) * 2);
  const lands = whole ? natural.slice() : new Float64Array(count);
  if (whole) {
    for (let i = 0; i < n * n; i++) { xy[i * 2] = grid.x(i); xy[i * 2 + 1] = grid.y(i); }
  } else {
    let o = 0;
    for (let k = 0; k < clamped.length; k += 4) {
      for (let iy = clamped[k + 2]!; iy <= clamped[k + 3]!; iy++) {
        const row = iy * n;
        lands.set(natural.subarray(row + clamped[k]!, row + clamped[k + 1]! + 1), o);
        for (let ix = clamped[k]!; ix <= clamped[k + 1]!; ix++, o++) { xy[o * 2] = grid.x(row + ix); xy[o * 2 + 1] = grid.y(row + ix); }
      }
    }
  }
  return { cx: 0, cy: 0, n, regions: clamped, whole, xy, natural: lands };
}

/** The world boxes a pass's corners stand in, a cell round (`cell`, `half`: the plates' grid) */
export function cornerBoxes(plates: readonly PlateShapeAsk[], cell: number, half: number): [number, number, number, number][] {
  const boxes: [number, number, number, number][] = [];
  for (const plate of plates) {
    const r = plate.regions;
    for (let k = 0; k < r.length; k += 4) {
      if (r[k + 1]! < r[k]! || r[k + 3]! < r[k + 2]!) continue;
      boxes.push([
        plate.cx - half + (r[k]! - 1) * cell, plate.cy + half - (r[k + 3]! + 1) * cell,
        plate.cx - half + (r[k + 1]! + 1) * cell, plate.cy + half - (r[k + 2]! - 1) * cell,
      ]);
    }
  }
  return boxes;
}

/** A worker's scratch for its passes, sized to a plate once: where each corner stands and its land, and the corners visited. */
export class ShapeScratch {
  xs = new Float64Array(0);
  ys = new Float64Array(0);
  lands = new Float64Array(0);
  visited = new Int32Array(0);
  pass = 0;
}

const NO_BOUNDS = (): never => { throw new Error('a shaping off the page is always asked by regions'); };

/** A shaping pass as `terrain.ts` `shapeToRoads` runs it (`shapeCorners`), for each plate asked. */
export function shapeGroundAsk(ask: GroundShapeAsk, scratch = new ShapeScratch()): PlateShapeAnswer[] {
  const roads = ask.roads ? roadShaper(ask.roads) : null;
  const pads = ask.pads ? padShaper(ask.pads) : null;
  const shapeAt = pads ? shapeBoth(roads, pads) : roads ? roads.shapeAt : null;
  return ask.plates.map((plate) => {
    const corners: number[] = [];
    const heights: number[] = [];
    if (shapeAt) {
      const { n, cx, cy } = plate;
      const size = n * n;
      if (scratch.visited.length < size) {
        scratch.xs = new Float64Array(size); scratch.ys = new Float64Array(size); scratch.lands = new Float64Array(size); scratch.visited = new Int32Array(size);
      }
      const { xs, ys, lands, visited } = scratch;
      const regions: TerrainRegion[] = [];
      let o = 0;
      for (let k = 0; k < plate.regions.length; k += 4) {
        const x0 = plate.regions[k]!, x1 = plate.regions[k + 1]!, y0 = plate.regions[k + 2]!, y1 = plate.regions[k + 3]!;
        regions.push([x0, x1, y0, y1]);
        if (plate.whole) continue;
        for (let iy = y0; iy <= y1; iy++) {
          for (let ix = x0; ix <= x1; ix++) {
            const i = ix + iy * n;
            xs[i] = plate.xy[o * 2]!;
            ys[i] = plate.xy[o * 2 + 1]!;
            lands[i] = plate.natural[o]!;
            o++;
          }
        }
      }
      if (plate.whole) {
        for (let i = 0; i < size; i++) { xs[i] = plate.xy[i * 2]!; ys[i] = plate.xy[i * 2 + 1]!; }
        lands.set(plate.natural);
      }
      const grid: CornerGrid = { n, cell: NaN, half: NaN, x: (i) => xs[i]!, y: (i) => ys[i]! };
      // In the world's coordinates, as the atlas asks its plates' shapers (`flatAtlas.ts` `shaperFor`).
      const shaper = { shapeAt: (x: number, y: number, ground: number) => shapeAt(x + cx, y + cy, ground), shapeBounds: NO_BOUNDS };
      const pass = ++scratch.pass;
      shapeCorners(grid, lands, shaper, regions, visited, pass, (i, height) => { corners.push(i); heights.push(height); });
    }
    return { corners: Int32Array.from(corners), heights: Float64Array.from(heights) };
  });
}

/** What `blockDigest` reads of a solve of the roads: a `RoadElevation`, or a cut's reader (`roadShaper`). */
type BlockRoads = Pick<RoadElevation, 'shapeAt' | 'at' | 'roadAt'>;

/** What a block of ground reads of a solve, digested (`renderer.ts` `changedBlocks`) */
export function blockDigest(solve: BlockRoads, naturalAt: (x: number, y: number) => number,
  x0: number, y0: number, block: number, cell: number, half: number): number {
  const digest = new Digest();
  const quantum = (h: number): number => Math.round(h * 1000);
  for (let x = Math.ceil((x0 + half) / cell) * cell - half; x <= x0 + block; x += cell) {
    for (let y = Math.ceil((y0 + half) / cell) * cell - half; y <= y0 + block; y += cell) {
      const shaped = solve.shapeAt(x, y, naturalAt(x, y));
      digest.add(quantum(shaped.height)).add(quantum(shaped.weight));
      const road = solve.roadAt(x, y);
      if (road.type >= 0 && Math.abs(road.across) <= road.half) digest.add(road.type).add(quantum(solve.at(x, y)));
      else digest.add(-1);
    }
  }
  return digest.value();
}

/** A plate's natural ground as `naturalRenderedHeightAt` reads it: its corners and the diagonals they are drawn with. */
export interface NaturalPlate {
  /** The plate's index (`world/bounds.ts` `plateOf`) and centre. */
  readonly index: number;
  readonly cx: number;
  readonly cy: number;
  readonly n: number;
  readonly cell: number;
  readonly half: number;
  readonly natural: Float64Array;
  readonly diagonals: Uint8Array;
}

/** Blocks of two solves (or one) digested off the page: each solve's roads near its blocks, and the ground under them. */
export interface BlockDigestAsk {
  readonly solves: readonly { readonly roads: RoadShapeCut; readonly blocks: Float64Array }[];
  readonly plates: readonly NaturalPlate[];
  readonly block: number;
  readonly cell: number;
  readonly half: number;
}

/** Each solve's blocks digested as the page digests them (`blockDigest`) */
function digestBlocks(ask: BlockDigestAsk): Float64Array[] {
  const plates = new Map(ask.plates.map((p) => [p.index, p]));
  const naturalAt = (x: number, y: number): number => {
    const p = plates.get(plateOf(x, y));
    if (!p) throw new OffTheCut();
    const lx = x - p.cx, ly = y - p.cy;
    // Past the plate's edge the plate reads the land's own field (`terrain.ts` `sampleGrid`).
    if (!(lx >= -p.half && lx <= p.half && ly >= -p.half && ly <= p.half)) throw new OffTheCut();
    return sampleCorners(p, p.natural, p.diagonals, lx, ly);
  };
  return ask.solves.map(({ roads, blocks }) => {
    const solve = roadShaper(roads, naturalAt);
    const out = new Float64Array(blocks.length / 2);
    for (let k = 0; k < out.length; k++) {
      try {
        out[k] = blockDigest(solve, naturalAt, blocks[k * 2]!, blocks[k * 2 + 1]!, ask.block, ask.cell, ask.half);
      } catch (error) {
        if (!(error instanceof OffTheCut)) throw error;
        out[k] = NaN;
      }
    }
    return out;
  });
}

class OffTheCut extends Error {}

/** What the page asks the ground's worker. */
export type GroundJob = { readonly kind: 'shape'; readonly ask: GroundShapeAsk } | { readonly kind: 'blocks'; readonly ask: BlockDigestAsk };
/** What the worker answers each. */
export type GroundJobAnswer = PlateShapeAnswer[] | Float64Array[];

/** Runs a job as the worker does (`groundShape.worker.ts`; on the page when it fails), and the buffers its answer hands over. */
export function runGroundJob(job: GroundJob, scratch?: ShapeScratch): { answer: GroundJobAnswer; transfer: ArrayBuffer[] } {
  if (job.kind === 'shape') {
    const answer = shapeGroundAsk(job.ask, scratch);
    return { answer, transfer: answer.flatMap((a) => [a.corners.buffer as ArrayBuffer, a.heights.buffer as ArrayBuffer]) };
  }
  const answer = digestBlocks(job.ask);
  return { answer, transfer: answer.map((a) => a.buffer as ArrayBuffer) };
}
