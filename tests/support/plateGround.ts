import { Rng } from '@core/rng';
import type { HeightTile } from '@render/heightTile';
import { TERRAIN_BASE, TERRAIN_CELL, TERRAIN_HALF } from '@render/terrain';
import { cornerWindow, sampleCorners } from '@render/terrainShaping';
import { MAP_REGIONS, plateOf } from '@world/bounds';
import { GROUND_ONLY, buildRoadElevation } from '@world/elevation';
import type { Network } from '@world/network';
import { pavedHeightFrom } from '@world/paving';
import { footwayRiseAt, packFlush } from '@world/roads/footwayRise';
import { RELIEF_NATURAL, reliefHeight } from '@world/terrain';
import { m } from '@world/units';

/** THE GROUND AND PAVING AS THE PAGE READS THEM, over a made plate with a road cut into it (`renderer.ts`, `flatAtlas.ts`), for the specs */

/** The page's readings and its squares packed for a worker, as `SceneHandle` gives them. */
export interface PageGround {
  terrainHeightAt(x: number, y: number): number;
  pavedHeightAt(x: number, y: number): number;
  heightTile(rect: readonly [number, number, number, number]): { readonly tile: HeightTile; readonly transfer: ArrayBuffer[] };
}

/** The plate at the map's middle made (its corners drawn, a cut along y = 0, and as they were; each cell's diagonal either way), the others bare */
export function plateGround(net: Network): PageGround {
  const home = plateOf(0, 0);
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
  // The atlas as the page reads it (`flatAtlas.ts` `ask`).
  const read = (corners: Float64Array, diagonals: Uint8Array) => (x: number, y: number): number => {
    const index = plateOf(x, y), c = MAP_REGIONS[index]!;
    const lx = x - c.cx, ly = y - c.cy;
    return index === home ? sampleCorners(grid, corners, diagonals, lx, ly) : TERRAIN_BASE + reliefHeight(RELIEF_NATURAL, c.cx + lx, c.cy + ly);
  };
  const drawnAt = read(drawn, flip), naturalAt = read(natural, naturalFlip);
  // The roads solved on the ground what is built stands on (`renderer.ts` `builtGroundAt`).
  const elevation = buildRoadElevation(net, naturalAt);
  return {
    terrainHeightAt: drawnAt,
    pavedHeightAt: (x, y) => pavedHeightFrom(elevation, GROUND_ONLY, (px, py) => footwayRiseAt(net, px, py), x, y),
    heightTile(rect) {
      const index = plateOf((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2), centre = MAP_REGIONS[index]!;
      const box = { minX: rect[0] - centre.cx, minY: rect[1] - centre.cy, maxX: rect[2] - centre.cx, maxY: rect[3] - centre.cy };
      const corners = index === home ? { grid, drawn: cornerWindow(grid, drawn, flip, box), natural: cornerWindow(grid, natural, naturalFlip, box) } : null;
      const tile: HeightTile = {
        terrain: { plate: index, cx: centre.cx, cy: centre.cy, base: TERRAIN_BASE, relief: RELIEF_NATURAL, corners },
        paving: { rect, field: elevation.fieldFor!([rect], []).data, flush: packFlush(net, [rect]).data },
      };
      return { tile, transfer: [] };
    },
  };
}
