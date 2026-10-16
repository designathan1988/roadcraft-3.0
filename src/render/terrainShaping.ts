import type { Aabb } from '@core/aabb';

/** WHICH CORNERS OF A PLATE'S GROUND A SHAPING PASS ASKS */

/** A box of grid corners, inclusive: x0..x1 across, y0..y1 down. */
export type TerrainRegion = readonly [number, number, number, number];

/** What `shapeToRoads` needs to know about the road network. */
export interface TerrainShaper {
  shapeAt(x: number, y: number, naturalGround: number): { height: number; weight: number };
  /** Boxes outside which `shapeAt` always answers weight 0. */
  shapeBounds(): readonly Aabb[];
}

/** A plate's grid of corners: `n` a side, corner `i` at `ix + iy * n`, and its world point. */
export interface CornerGrid {
  readonly n: number;
  readonly cell: number;
  readonly half: number;
  x(i: number): number;
  y(i: number): number;
}

/** DO NOT walk `shapeBounds` against the regions: every box of the town */
export function shapeCorners(
  grid: CornerGrid,
  natural: ArrayLike<number>,
  shape: TerrainShaper,
  regions: readonly TerrainRegion[] | null,
  visited: Int32Array,
  pass: number,
  take: (i: number, height: number) => void,
): void {
  const n = grid.n;
  const visit = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const i = ix + iy * n;
        if (visited[i] === pass) continue;
        visited[i] = pass;
        const ground = natural[i] as number;
        const { height, weight } = shape.shapeAt(grid.x(i), grid.y(i), ground);
        if (weight <= 0.001) continue;
        const blended = ground + (height - ground) * weight;
        if (Math.abs(blended - ground) < 0.002) continue;
        take(i, blended);
      }
    }
  };
  for (const r of regions ?? shape.shapeBounds().map((box) => boxRegion(grid, box))) {
    visit(Math.max(0, r[0]), Math.min(n - 1, r[1]), Math.max(0, r[2]), Math.min(n - 1, r[3]));
  }
}

/** The corners a box of the plate's coordinates covers, a corner round (clamped where they are visited). */
export function boxRegion(grid: Pick<CornerGrid, 'cell' | 'half'>, box: Aabb): TerrainRegion {
  return [
    Math.floor((box.minX + grid.half) / grid.cell), Math.ceil((box.maxX + grid.half) / grid.cell),
    Math.floor((grid.half - box.maxY) / grid.cell), Math.ceil((grid.half - box.minY) / grid.cell),
  ];
}

type ShapeAt = TerrainShaper['shapeAt'];

/** The roads' and the buildings' platforms' shaping as one (`renderer.ts` `shapeGround`, and the ground's worker) */
export function shapeBoth(roads: { shapeAt: ShapeAt } | null, pads: { shapeAt: ShapeAt }): ShapeAt {
  return (x, y, ground) => {
    const road = roads ? roads.shapeAt(x, y, ground) : { height: ground, weight: 0 };
    const pad = pads.shapeAt(x, y, ground);
    if (pad.weight <= 0) return road;
    if (road.weight <= 0) return pad;
    return { height: pad.height + (road.height - pad.height) * road.weight, weight: 1 };
  };
}

/** The height a plate's ground is drawn at, at a point of the plate (its own coordinates, inside it) */
export function sampleCorners(grid: Pick<CornerGrid, 'n' | 'cell' | 'half'>, corners: ArrayLike<number>, diagonals: ArrayLike<number>, x: number, y: number): number {
  return sampleIn(grid, corners, diagonals, x, y, 0, 0, grid.n, grid.n) ?? NaN;
}

/** Some corners of a plate's grid and their cells' diagonals, handed to a worker (`heightTile.ts`) */
export interface CornerWindow {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  readonly corners: Float64Array;
  readonly diagonals: Uint8Array;
}

/** The corners round a box of the plate's coordinates, a corner more each way (`sampleWindow` reads them). */
export function cornerWindow(grid: Pick<CornerGrid, 'n' | 'cell' | 'half'>, corners: ArrayLike<number>, diagonals: ArrayLike<number>, box: Aabb): CornerWindow {
  const n = grid.n, segments = n - 1;
  const clampCorner = (i: number): number => Math.min(n - 1, Math.max(0, i));
  const x0 = clampCorner(Math.floor((box.minX + grid.half) / grid.cell) - 1), x1 = clampCorner(Math.ceil((box.maxX + grid.half) / grid.cell) + 1);
  const y0 = clampCorner(Math.floor((grid.half - box.maxY) / grid.cell) - 1), y1 = clampCorner(Math.ceil((grid.half - box.minY) / grid.cell) + 1);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = { x0, y0, w, h, corners: new Float64Array(w * h), diagonals: new Uint8Array((w - 1) * (h - 1)) };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.corners[i + j * w] = corners[x0 + i + (y0 + j) * n] as number;
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) out.diagonals[i + j * (w - 1)] = diagonals[x0 + i + (y0 + j) * segments] as number;
  return out;
}

/** `sampleCorners` over a window of the corners: the same number, or undefined when the point's cell is not in it. */
export function sampleWindow(grid: Pick<CornerGrid, 'n' | 'cell' | 'half'>, window: CornerWindow, x: number, y: number): number | undefined {
  return sampleIn(grid, window.corners, window.diagonals, x, y, window.x0, window.y0, window.w, window.h);
}

/** The drawn height at a point over corners x0..x0+w-1 across, y0..y0+h-1 down of the plate's grid; undefined off them. */
function sampleIn(grid: Pick<CornerGrid, 'n' | 'cell' | 'half'>, corners: ArrayLike<number>, diagonals: ArrayLike<number>, x: number, y: number,
  x0: number, y0: number, w: number, h: number): number | undefined {
  const segments = grid.n - 1;
  // `PlaneGeometry` lays its rows from +y downwards, so the row index grows as world y falls.
  const gx = (x + grid.half) / grid.cell;
  const gy = (grid.half - y) / grid.cell;
  const ix = Math.min(segments - 1, Math.floor(gx));
  const iy = Math.min(segments - 1, Math.floor(gy));
  const u = gx - ix;
  const v = gy - iy;
  const i = ix - x0, j = iy - y0;
  if (i < 0 || j < 0 || i + 1 >= w || j + 1 >= h) return undefined;
  const a = corners[i + j * w] as number;
  const b = corners[i + (j + 1) * w] as number;
  const c = corners[i + 1 + (j + 1) * w] as number;
  const d = corners[i + 1 + j * w] as number;
  // Each cell is split along the diagonal it is DRAWN with (`retriangulate`): b-d into (a, b, d) and (b, c, d), or a-c into
  if (diagonals[i + j * (w - 1)]) {
    return u >= v ? a * (1 - u) + d * (u - v) + c * v : a * (1 - v) + b * (v - u) + c * u;
  }
  return u + v <= 1 ? a * (1 - u - v) + d * u + b * v : b * (1 - u) + c * (u + v - 1) + d * (1 - v);
}
