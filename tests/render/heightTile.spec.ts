import { describe, expect, it } from 'vitest';

import { Rng } from '@core/rng';
import { type HeightTile, HEIGHT_TILE, heightTileKey, heightTileReads, heightTileRect } from '@render/heightTile';
import { TERRAIN_BASE, TERRAIN_CELL, TERRAIN_HALF } from '@render/terrain';
import { cornerWindow, sampleCorners } from '@render/terrainShaping';
import { MAP_REGIONS, plateOf } from '@world/bounds';
import { GROUND_ONLY, buildRoadElevation } from '@world/elevation';
import { Network } from '@world/network';
import { RoadDoc } from '@world/doc';
import { pavedHeightFrom } from '@world/paving';
import { footwayRiseAt, packFlush } from '@world/roads/footwayRise';
import { RELIEF_NATURAL, reliefHeight } from '@world/terrain';
import { m } from '@world/units';

/** THE HEIGHTS A WORKER READS OVER A SQUARE OF THE MAP (`render/heightTile.ts`): the page's own numbers */

/** One made plate, its corners drawn (a road cut into them) and as they were, each cell's diagonal either way. */
function plate(): { grid: { n: number; cell: number; half: number }; drawn: Float64Array; natural: Float64Array; flip: Uint8Array; naturalFlip: Uint8Array } {
  const n = Math.round((2 * TERRAIN_HALF) / TERRAIN_CELL) + 1;
  const grid = { n, cell: TERRAIN_CELL, half: TERRAIN_HALF };
  const rng = new Rng(7);
  const natural = new Float64Array(n * n), drawn = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -TERRAIN_HALF + i * TERRAIN_CELL, y = TERRAIN_HALF - j * TERRAIN_CELL;
      natural[i + j * n] = 3 * Math.sin(x / 47) + 2 * Math.cos(y / 61);
      drawn[i + j * n] = natural[i + j * n]! + (Math.abs(y) < m(20) ? -m(0.4) : 0) + rng.range(-0.01, 0.01);
    }
  }
  const flip = new Uint8Array((n - 1) * (n - 1)).map(() => (rng.bool() ? 1 : 0));
  const naturalFlip = new Uint8Array((n - 1) * (n - 1)).map(() => (rng.bool() ? 1 : 0));
  return { grid, drawn, natural, flip, naturalFlip };
}

describe('the heights handed to a worker', () => {
  it('are the page\'s, the ground drawn and the paving, over every point of a square', () => {
    const home = plateOf(0, 0);
    const p = plate();
    // The atlas as the page reads it (`flatAtlas.ts` `ask`): the plate made at the middle, the others bare.
    const read = (corners: Float64Array, flip: Uint8Array) => (x: number, y: number): number => {
      const index = plateOf(x, y), c = MAP_REGIONS[index]!;
      const lx = x - c.cx, ly = y - c.cy;
      return index === home ? sampleCorners(p.grid, corners, flip, lx, ly) : TERRAIN_BASE + reliefHeight(RELIEF_NATURAL, c.cx + lx, c.cy + ly);
    };
    const drawnAt = read(p.drawn, p.flip), naturalAt = read(p.natural, p.naturalFlip);
    // A street along y = 0 and one across it, solved on the natural ground (`renderer.ts` `builtGroundAt`).
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-200), y: 0 }).id, b = doc.addNode({ x: m(300), y: 0 }).id;
    const c = doc.addNode({ x: m(40), y: m(-200) }).id, d = doc.addNode({ x: m(40), y: m(200) }).id;
    doc.addSegment(a, b, 1);
    doc.addSegment(c, d, 1);
    const net = new Network(doc);
    net.rebuild();
    const elevation = buildRoadElevation(net, naturalAt);
    const pavedAt = (x: number, y: number): number => pavedHeightFrom(elevation, GROUND_ONLY, (px, py) => footwayRiseAt(net, px, py), x, y);
    // Packed as the renderer packs a square (`heightTile`), sent as a message is.
    const pack = (key: number): HeightTile => {
      const rect = heightTileRect(key);
      const index = plateOf((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2), centre = MAP_REGIONS[index]!;
      const box = { minX: rect[0] - centre.cx, minY: rect[1] - centre.cy, maxX: rect[2] - centre.cx, maxY: rect[3] - centre.cy };
      const corners = index === home ? { grid: p.grid, drawn: cornerWindow(p.grid, p.drawn, p.flip, box), natural: cornerWindow(p.grid, p.natural, p.naturalFlip, box) } : null;
      return structuredClone({
        terrain: { plate: index, cx: centre.cx, cy: centre.cy, base: TERRAIN_BASE, relief: RELIEF_NATURAL, corners },
        paving: { rect, field: elevation.fieldFor!([rect], []).data, flush: packFlush(net, [rect]).data },
      });
    };
    let points = 0, paved = 0;
    const wrong: string[] = [];
    // Four squares about the crossing, and one on the next plate (bare): every point read there, none asked of the page.
    for (const [x0, y0] of [[-m(250), -m(250)], [m(10), -m(250)], [-m(250), m(10)], [m(10), m(10)], [m(1100), m(10)]] as const) {
      const key = heightTileKey(x0, y0);
      const reads = heightTileReads(pack(key));
      const rect = heightTileRect(key);
      for (let x = rect[0]; x < rect[2]; x += m(1.37)) {
        for (let y = rect[1]; y < rect[3]; y += m(2.13)) {
          if (heightTileKey(x, y) !== key) wrong.push(`key at ${x}, ${y}`);
          const ground = reads.ground(x, y), page = drawnAt(x, y);
          if (ground === undefined || !Object.is(ground, page)) wrong.push(`ground at ${x}, ${y}: ${ground} vs ${page}`);
          const there = reads.paved(x, y), pagePaved = pavedAt(x, y);
          if (there === undefined || !Object.is(there, pagePaved)) wrong.push(`paving at ${x}, ${y}: ${there} vs ${pagePaved}`);
          points++;
          if (Number.isFinite(pagePaved)) paved++;
        }
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(points).toBeGreaterThan(5 * (HEIGHT_TILE / 1.37) * (HEIGHT_TILE / 2.13) * 0.99);
    expect(paved).toBeGreaterThan(2_000);
  });

  it('says nothing past its square', () => {
    const p = plate();
    const key = heightTileKey(0, 0), rect = heightTileRect(key);
    const box = { minX: rect[0], minY: rect[1], maxX: rect[2], maxY: rect[3] };
    const reads = heightTileReads({ terrain: { plate: plateOf(0, 0), cx: 0, cy: 0, base: TERRAIN_BASE, relief: null,
      corners: { grid: p.grid, drawn: cornerWindow(p.grid, p.drawn, p.flip, box), natural: cornerWindow(p.grid, p.natural, p.naturalFlip, box) } }, paving: null });
    expect(reads.ground(rect[0] - m(20), rect[1])).toBeUndefined();
    expect(reads.ground(rect[2] + m(20), rect[3] + m(20))).toBeUndefined();
    expect(reads.paved(rect[0], rect[1])).toBeUndefined();
  });
});
