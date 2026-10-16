import { plateOf } from '@world/bounds';
import { type PavingData, pavingReader } from '@world/paving';
import { type ReliefVersion, reliefHeight } from '@world/terrain';
import { type CornerGrid, type CornerWindow, sampleWindow } from './terrainShaping';

/** THE HEIGHTS OF A SQUARE OF THE MAP HANDED TO A WORKER: the ground as drawn and as it was, and the paving, read there as the page reads them */

/** A plate's corners round a box, as drawn (`renderedHeightAt`) and as they were before any road shaped them (`naturalRenderedHeightAt`). */
export interface PlateCorners {
  readonly grid: Pick<CornerGrid, 'n' | 'cell' | 'half'>;
  readonly drawn: CornerWindow;
  readonly natural: CornerWindow;
}

/** The ground of one plate round a box (`TerrainSurface.packHeights`): its corners there, or its bare relief when it is not made. */
export interface TerrainPack {
  /** The plate's index (`world/bounds.ts` `plateOf`) and centre. */
  readonly plate: number;
  readonly cx: number;
  readonly cy: number;
  /** The height the land's own field is drawn from (`TERRAIN_BASE`). */
  readonly base: number;
  /** The relief a plate not made reads (`flatAtlas.ts` `bareAt`); null: none known yet, the level plain. */
  readonly relief: ReliefVersion | null;
  readonly corners: PlateCorners | null;
}

/** What a worker reads of a square of the map: its ground and its paving (`PavingSource.pack`); null, the page is asked. */
export interface HeightTile {
  readonly terrain: TerrainPack | null;
  readonly paving: PavingData | null;
}

/** Side of the squares the heights are handed over in, world units: an eighth of a plate, so a square never straddles two. */
export const HEIGHT_TILE = 256;
/** The square holding a point, as a key (the openLots grid's). */
export const heightTileKey = (x: number, y: number): number =>
  (Math.floor(x / HEIGHT_TILE) + 32768) * 65536 + (Math.floor(y / HEIGHT_TILE) + 32768);
/** A square's rectangle by its key. */
export function heightTileRect(key: number): [number, number, number, number] {
  const i = Math.floor(key / 65536) - 32768, j = (key % 65536) - 32768;
  return [i * HEIGHT_TILE, j * HEIGHT_TILE, (i + 1) * HEIGHT_TILE, (j + 1) * HEIGHT_TILE];
}

/** Every buffer of a square: handed over, not copied (MDN, `postMessage` transfer). */
export function heightTileBuffers(tile: HeightTile): ArrayBuffer[] {
  const corners = tile.terrain?.corners;
  return corners ? [corners.drawn.corners, corners.drawn.diagonals, corners.natural.corners, corners.natural.diagonals].map((a) => a.buffer as ArrayBuffer) : [];
}

/** A square's readings: the ground as drawn, the paving; undefined where it cannot say (the page is asked). */
export interface HeightReads {
  ground(x: number, y: number): number | undefined;
  paved(x: number, y: number): number | undefined;
}

/** The readings over a square: the same numbers as the page's `terrainHeightAt` and `pavedHeightAt` when it was packed */
export function heightTileReads(tile: HeightTile): HeightReads {
  const terrain = tile.terrain;
  const on = (x: number, y: number, window: (c: PlateCorners) => CornerWindow): number | undefined => {
    if (!terrain || plateOf(x, y) !== terrain.plate) return undefined;
    const lx = x - terrain.cx, ly = y - terrain.cy;
    const c = terrain.corners;
    // Not made: the bare relief at the plate's own point (`flatAtlas.ts` `bareAt`).
    if (!c) return terrain.base + (terrain.relief === null ? 0 : reliefHeight(terrain.relief, terrain.cx + lx, terrain.cy + ly));
    // Past the plate's edge the plate reads the land's own field (`terrain.ts` `sampleGrid`): the page is asked.
    if (!(lx >= -c.grid.half && lx <= c.grid.half && ly >= -c.grid.half && ly <= c.grid.half)) return undefined;
    return sampleWindow(c.grid, window(c), lx, ly);
  };
  const natural = (x: number, y: number): number | undefined => on(x, y, (c) => c.natural);
  // The roads' field reads the ground what is built stands on (`renderer.ts` `builtGroundAt`): the natural corners.
  const paving = tile.paving ? pavingReader(tile.paving, natural) : null;
  return {
    ground: (x, y) => on(x, y, (c) => c.drawn),
    paved: (x, y) => paving?.(x, y),
  };
}
