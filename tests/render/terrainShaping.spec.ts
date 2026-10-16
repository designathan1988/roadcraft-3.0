import { describe, expect, it } from 'vitest';

import { layCity } from '@editor/cityGenerator';
import { growOnLot } from '@editor/zoning';
import { type BlockDigestAsk, type GroundJob, type GroundShapeAsk, type PlateShapeAnswer, askPlate, blockDigest, cornerBoxes, runGroundJob } from '@render/groundShape';
import { type CornerGrid, type TerrainRegion, type TerrainShaper, boxRegion, sampleCorners, shapeBoth, shapeCorners } from '@render/terrainShaping';
import { storedBounds } from '@world/buildings/geometry';
import { siteGrading } from '@world/buildings/siteGrading';
import type { Building } from '@world/buildings/types';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import type { RoadDoc } from '@world/doc';
import { buildRoadElevation } from '@world/elevation';
import { PLATE_SIZE, plateOf } from '@world/bounds';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { Network } from '@world/network';
import { m } from '@world/units';

/** THE CORNERS A SHAPING PASS ASKS (`terrainShaping.ts`, `terrain.ts` `shapeToRoads`): with regions */
const SEGMENTS = 320;
const N = SEGMENTS + 1;
const CELL = PLATE_SIZE / SEGMENTS;
const HALF = PLATE_SIZE / 2;
/** Where `PlaneGeometry` turned flat stands each corner: float32, as the mesh's positions are. */
const xs = new Float32Array(N * N), ys = new Float32Array(N * N);
for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) { xs[ix + iy * N] = ix * CELL - HALF; ys[ix + iy * N] = -(iy * CELL - HALF); }
const grid: CornerGrid = { n: N, cell: CELL, half: HALF, x: (i) => xs[i]!, y: (i) => ys[i]! };
const groundAt = (x: number, y: number): number => m(6) * Math.sin(x / m(170)) + m(4) * Math.cos(y / m(130)) + x * 0.01;
const natural = new Float64Array(N * N);
for (let i = 0; i < N * N; i++) natural[i] = groundAt(xs[i]!, ys[i]!);

/** The pass before (`terrain.ts` until 2026-10-15): every box of the shaper against every region. */
function shapeByBoxes(shape: TerrainShaper, regions: readonly TerrainRegion[], visited: Int32Array, pass: number, take: (i: number, h: number) => void): void {
  for (const box of shape.shapeBounds()) {
    const bx0 = Math.max(0, Math.floor((box.minX + HALF) / CELL));
    const bx1 = Math.min(N - 1, Math.ceil((box.maxX + HALF) / CELL));
    const by0 = Math.max(0, Math.floor((HALF - box.maxY) / CELL));
    const by1 = Math.min(N - 1, Math.ceil((HALF - box.minY) / CELL));
    for (const r of regions) {
      const x0 = Math.max(bx0, r[0]), x1 = Math.min(bx1, r[1]);
      const y0 = Math.max(by0, r[2]), y1 = Math.min(by1, r[3]);
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) {
          const i = ix + iy * N;
          if (visited[i] === pass) continue;
          visited[i] = pass;
          const ground = natural[i]!;
          const { height, weight } = shape.shapeAt(xs[i]!, ys[i]!, ground);
          if (weight <= 0.001) continue;
          const blended = ground + (height - ground) * weight;
          if (Math.abs(blended - ground) < 0.002) continue;
          take(i, blended);
        }
      }
    }
  }
}

/** A generated city's streets, zoned and grown: a few hundred buildings. */
function grownCity(): RoadDoc {
  const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' }));
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], { use: (['residential', 'commercial', 'industrial'] as const)[k % 3]!, density: 'medium' }));
  const refused = new Set<number>();
  for (let k = 0; k < 1500; k++) if (growOnLot({ doc, net, groundAt }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  return doc;
}

describe('a shaping pass over regions', () => {
  const doc = grownCity();
  const net = new Network(doc);
  net.rebuild();
  const elevation = buildRoadElevation(net, groundAt);
  // As the renderer grades them (`renderer.ts` `sitesGraded`, `bankBox`, `regionOf`).
  const reach = CELL * 1.5 + m(40) + CELL;
  const bank = (b: Building): readonly [number, number, number, number] => {
    const r = storedBounds(b, reach);
    return [r.minX, r.minY, r.maxX, r.maxY];
  };
  const sites = siteGrading(groundAt, undefined, CELL * 1.5, bank);
  const changed = sites.changedSites(doc.buildings) ?? [];
  sites.rebuild(doc.buildings);
  const pads = sites.pads!;
  const clamp = (v: number): number => Math.max(0, Math.min(SEGMENTS, v));
  const regions: TerrainRegion[] = changed.map((box) => [
    clamp(Math.floor((box[0] + HALF) / CELL)), clamp(Math.ceil((box[2] + HALF) / CELL)),
    clamp(Math.floor((HALF - box[3]) / CELL)), clamp(Math.ceil((HALF - box[1]) / CELL)),
  ]);
  let boundsAsked = 0;
  const asked = new Uint16Array(N * N);
  const shaper: TerrainShaper = {
    shapeBounds: () => { boundsAsked++; return [...elevation.shapeBounds(), ...pads.shapeBounds()]; },
    shapeAt(x, y, ground) {
      const road = elevation.shapeAt(x, y, ground);
      const pad = pads.shapeAt(x, y, ground);
      if (pad.weight <= 0) return road;
      if (road.weight <= 0) return pad;
      return { height: pad.height + (road.height - pad.height) * road.weight, weight: 1 };
    },
  };

  it('gives the ground the walk of every box gave, to the bit', () => {
    expect(doc.buildings.size).toBeGreaterThan(150);
    expect(regions.length).toBe(doc.buildings.size);
    const before = natural.slice(), after = natural.slice();
    shapeByBoxes(shaper, regions, new Int32Array(N * N), 1, (i, h) => { before[i] = h; });
    shapeCorners(grid, natural, shaper, regions, new Int32Array(N * N), 1, (i, h) => { after[i] = h; });
    let moved = 0;
    for (let i = 0; i < N * N; i++) {
      if (after[i] !== natural[i]) moved++;
      if (!Object.is(after[i], before[i])) expect.fail(`corner ${i}: ${after[i]} against ${before[i]}`);
    }
    expect(moved).toBeGreaterThan(1000);
  });

  it('asks each corner of the regions once, and never walks the boxes', () => {
    // DO NOT cross the shaper's boxes with the regions: every box of the town against every region.
    const counting: TerrainShaper = {
      shapeBounds: () => shaper.shapeBounds(),
      shapeAt(x, y, ground) {
        asked[Math.round((x + HALF) / CELL) + Math.round((HALF - y) / CELL) * N]!++;
        return shaper.shapeAt(x, y, ground);
      },
    };
    boundsAsked = 0;
    asked.fill(0);
    shapeCorners(grid, natural, counting, regions, new Int32Array(N * N), 1, () => {});
    expect(boundsAsked).toBe(0);
    const inRegions = new Uint8Array(N * N);
    for (const r of regions) for (let iy = r[2]; iy <= r[3]; iy++) for (let ix = r[0]; ix <= r[1]; ix++) inRegions[ix + iy * N] = 1;
    let corners = 0, calls = 0;
    for (let i = 0; i < N * N; i++) {
      corners += inRegions[i]!;
      calls += asked[i]!;
      if (asked[i]! > 1) expect.fail(`corner ${i} asked ${asked[i]} times`);
      if (asked[i] && !inRegions[i]) expect.fail(`corner ${i} asked outside the regions`);
    }
    expect(calls).toBe(corners);
  });
});

/** THE SAME PASSES OFF THE PAGE (`groundShape.ts`, `groundShape.worker.ts`) */
describe('a shaping pass off the page', () => {
  const doc = grownCity();
  const net = new Network(doc);
  net.rebuild();
  const elevation = buildRoadElevation(net, groundAt);
  const reach = CELL * 1.5 + m(40) + CELL;
  const bank = (b: Building): readonly [number, number, number, number] => {
    const r = storedBounds(b, reach);
    return [r.minX, r.minY, r.maxX, r.maxY];
  };
  const sites = siteGrading(groundAt, undefined, CELL * 1.5, bank);
  const changed = sites.changedSites(doc.buildings) ?? [];
  sites.rebuild(doc.buildings);
  const pads = sites.pads!;
  const regions: TerrainRegion[] = changed.map((box) => [
    Math.floor((box[0] + HALF) / CELL), Math.ceil((box[2] + HALF) / CELL),
    Math.floor((HALF - box[3]) / CELL), Math.ceil((HALF - box[1]) / CELL),
  ]);
  const shaper: TerrainShaper = {
    shapeBounds: () => [...elevation.shapeBounds(), ...pads.shapeBounds()],
    shapeAt: shapeBoth(elevation, pads),
  };
  /** The page's pass: each corner taken, in order. */
  const onThePage = (asked: readonly TerrainRegion[] | null): [number, number][] => {
    const taken: [number, number][] = [];
    shapeCorners(grid, natural, shaper, asked, new Int32Array(N * N), 1, (i, h) => { taken.push([i, h]); });
    return taken;
  };
  /** The worker's: the ask copied there and its answer copied back, as messages are. */
  const offThePage = (asked: readonly TerrainRegion[]): [number, number][] => {
    const plate = askPlate(grid, natural, asked);
    const boxes = cornerBoxes([plate], CELL, HALF);
    const ask: GroundShapeAsk = { roads: elevation.shapeCut!(boxes), pads: pads.cut(boxes), plates: [plate] };
    const job = structuredClone<GroundJob>({ kind: 'shape', ask });
    const [answer] = structuredClone(runGroundJob(job).answer) as PlateShapeAnswer[];
    return Array.from(answer!.corners, (i, k) => [i, answer!.heights[k]!]);
  };
  const same = (a: readonly [number, number][], b: readonly [number, number][]): void => {
    expect(a.length).toBe(b.length);
    for (let k = 0; k < a.length; k++) {
      if (a[k]![0] !== b[k]![0] || !Object.is(a[k]![1], b[k]![1])) expect.fail(`take ${k}: corner ${a[k]![0]} at ${a[k]![1]} against ${b[k]![0]} at ${b[k]![1]}`);
    }
  };

  it('moves the corners the page moves, in its order, to its heights', () => {
    const here = onThePage(regions);
    expect(here.length).toBeGreaterThan(1000);
    same(offThePage(regions), here);
  });

  it('shapes the whole plate as the page does, the plate sent once', () => {
    const here = onThePage(null);
    const boxes = shaper.shapeBounds().map((b) => boxRegion(grid, b));
    expect(askPlate(grid, natural, boxes).whole).toBe(true);
    same(offThePage(boxes), here);
  });

  it('takes an empty box among the asked ones as no corner, not as the corner 0, 0', () => {
    const empty = boxRegion(grid, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity } as never);
    const plate = askPlate(grid, natural, [...regions.slice(0, 3), empty]);
    expect(plate.natural.length).toBe(askPlate(grid, natural, regions.slice(0, 3)).natural.length);
    same(offThePage([...regions.slice(0, 3), empty]), onThePage(regions.slice(0, 3)));
  });

  it('digests two solves block by block as the page does', () => {
    // The land raised under a part of the town: the roads there solved again.
    const raised = (x: number, y: number): number => groundAt(x, y) + (Math.hypot(x - m(150), y + m(100)) < m(260) ? m(2.5) : 0);
    const other = buildRoadElevation(net, raised);
    const diagonals = new Uint8Array(SEGMENTS * SEGMENTS);
    for (let k = 0; k < diagonals.length; k += 3) diagonals[k] = 1;
    const naturalAt = (x: number, y: number): number =>
      x >= -HALF && x <= HALF && y >= -HALF && y <= HALF ? sampleCorners(grid, natural, diagonals, x, y) : groundAt(x, y);
    const BLOCK = 160;
    const blocks: number[] = [];
    for (let x = -HALF; x < HALF; x += BLOCK) for (let y = -HALF; y < HALF; y += BLOCK) blocks.push(x, y);
    const rects = (): [number, number, number, number][] => {
      const out: [number, number, number, number][] = [];
      for (let k = 0; k < blocks.length; k += 2) out.push([blocks[k]! - 1, blocks[k + 1]! - 1, blocks[k]! + BLOCK + 1, blocks[k + 1]! + BLOCK + 1]);
      return out;
    };
    const ask: BlockDigestAsk = {
      solves: [elevation, other].map((solve) => ({ roads: solve.shapeCut!(rects()), blocks: Float64Array.from(blocks) })),
      plates: [{ index: plateOf(0, 0), cx: 0, cy: 0, n: N, cell: CELL, half: HALF, natural, diagonals }],
      block: BLOCK, cell: CELL, half: HALF,
    };
    const answers = structuredClone(runGroundJob(structuredClone<GroundJob>({ kind: 'blocks', ask })).answer) as Float64Array[];
    const page = [elevation, other].map((solve) => Array.from({ length: blocks.length / 2 }, (_, k) =>
      blockDigest(solve, naturalAt, blocks[k * 2]!, blocks[k * 2 + 1]!, BLOCK, CELL, HALF)));
    let offPlate = 0;
    for (let s = 0; s < 2; s++) {
      page[s]!.forEach((digest, k) => {
        const off = answers[s]![k]!;
        // Past the plate's edge the land's own field is read: the page digests that block itself.
        if (Number.isNaN(off)) { offPlate++; return; }
        if (off !== digest) expect.fail(`solve ${s}, block ${k}: ${off} against ${digest}`);
      });
    }
    // The last row and column of blocks reach past the plate; the others are all off the page.
    expect(offPlate).toBeLessThanOrEqual(2 * 25 * 2);
    const differ = page[0]!.filter((d, k) => d !== page[1]![k]).length;
    expect(differ).toBeGreaterThan(3);
  });
});
