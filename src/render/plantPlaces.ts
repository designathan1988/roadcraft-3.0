import { MAP_REGIONS } from '@world/bounds';
import type { EcologyField } from '@world/ecology';
import type { CoverKind } from '@world/terrainPaint';
import { m } from '@world/units';
import { KEEP_CELL, keepCellAt, keepCellBox, keepCellKey } from './candidateKeep';
import type { ForestSpecies } from './groundCover';
import { natureDensity } from './natureNoise';
import { seedOfKind } from './natureTrees';
import { COVER_CELL, TERRAIN_CELL, TERRAIN_HALF, type TerrainPart } from './terrain';
import { WOODS_SLOPE_STEP, WOODS_SPACING } from './woodsBase';

/** THE PLACES THE PLANTS AND STONES MAY STAND, made cell by cell: a cell's places read only the ground at them */

/** A place a plant or a stone may stand. */
export interface Candidate {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly yaw: number;
  readonly seed: number;
  readonly species: ForestSpecies;
}
/** A stone of a river's bed or bank: kept by its height over the water, read on the ground as drawn. */
export interface ShoreCandidate extends Candidate {
  readonly level: number;
  /** Its cell's draw against the odds of its height over the water. */
  readonly draw: number;
}

/** What the painted covers' and the rivers' places read of the ground (`TerrainSurface`). */
export interface CoverGround {
  forestAt(x: number, y: number): number;
  coverAt(kind: CoverKind, x: number, y: number): number;
  shoreLevelAt(x: number, y: number): number | null;
}

/** A tree every twelve metres at the most where a wood is painted: the player wants few trees, not woods filling the map */
const FOREST_SPACING = m(12);
/** Low scrub (`world/terrainPaint.ts` 'scrub'): close-set low-poly bushes of a metre to two and a half, no trees */
const SCRUB_SPACING = m(2.4);
/** The stones: where rocks were painted, one candidate a cell of ROCK_SPACING kept by the density */
const ROCK_SPACING = m(3.2);
const RIVER_ROCK_SPACING = m(3);
/** How far round the water's box its stones are looked for. */
const SHORE_REACH = m(12);
/** How far past a dab's circle a painted place can move: a cell of the densities, and a lattice cell's jitter. */
export const COVER_PLACE_REACH = COVER_CELL + FOREST_SPACING;

/** A cell's hash in 0..1: the same wherever a placement asks it, so an edit elsewhere never moves a plant. */
export const cellHash = (a: number, b: number, salt: number): number => {
  let h = Math.imul(a | 0, 374_761_393) ^ Math.imul(b | 0, 668_265_263) ^ Math.imul(salt, 2_246_822_519);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
};

/** -1..1 value noise of about 25 m: where scrub gathers into thickets. */
const scrubClump = (x: number, y: number): number => {
  const s = m(25);
  const gx = x / s, gy = y / s;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number): number => {
    let v = Math.imul(a, 374_761_393) ^ Math.imul(b, 668_265_263) ^ 0x51b;
    v = Math.imul(v ^ (v >>> 13), 1_274_126_177);
    return ((v ^ (v >>> 16)) >>> 0) / 2_147_483_648 - 1;
  };
  const top = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * sx;
  const bottom = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
};

/** The places of a painted lattice of `spacing` in a cell: each lattice cell wholly inside a plate, its place jittered by up to `jitter` / 2 */
function paintedIn(cell: number, spacing: number, jitter: number, make: (i: number, j: number, cx: number, cy: number) => Candidate | null): Candidate[] {
  const [x0, y0, x1, y1] = keepCellBox(cell);
  const reach = spacing * (jitter / 2 + 1);
  const out: Candidate[] = [];
  for (const plate of MAP_REGIONS) {
    if (plate.cx + plate.half < x0 - reach || plate.cx - plate.half > x1 + reach || plate.cy + plate.half < y0 - reach || plate.cy - plate.half > y1 + reach) continue;
    const first = Math.ceil((plate.cx - plate.half + TERRAIN_HALF) / spacing), last = Math.floor((plate.cx + plate.half + TERRAIN_HALF) / spacing) - 1;
    const firstY = Math.ceil((plate.cy - plate.half + TERRAIN_HALF) / spacing), lastY = Math.floor((plate.cy + plate.half + TERRAIN_HALF) / spacing) - 1;
    const i0 = Math.max(first, Math.floor((x0 - reach + TERRAIN_HALF) / spacing)), i1 = Math.min(last, Math.floor((x1 + reach + TERRAIN_HALF) / spacing));
    const j0 = Math.max(firstY, Math.floor((y0 - reach + TERRAIN_HALF) / spacing)), j1 = Math.min(lastY, Math.floor((y1 + reach + TERRAIN_HALF) / spacing));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = make(i, j, -TERRAIN_HALF + (i + 0.5) * spacing, -TERRAIN_HALF + (j + 0.5) * spacing);
        if (c && keepCellAt(c.x, c.y) === cell) out.push(c);
      }
    }
  }
  return out;
}

/** The painted woods' trees in a cell (`world/terrainPaint.ts` 'forest'). */
export function forestIn(cell: number, ground: CoverGround): Candidate[] {
  return paintedIn(cell, FOREST_SPACING, 0.9, (i, j, cx, cy) => {
    const density = ground.forestAt(cx, cy);
    if (density < 0.04 || cellHash(i, j, 1) > density * 0.92) return null;
    const x = cx + (cellHash(i, j, 2) - 0.5) * FOREST_SPACING * 0.9, y = cy + (cellHash(i, j, 3) - 0.5) * FOREST_SPACING * 0.9;
    const h = m(10) + m(8) * cellHash(i, j, 4) * (0.6 + 0.4 * density);
    // A wood is green: broadleaf with some conifers.
    const roll = cellHash(i, j, 13);
    const species = roll < 0.45 ? 'broadleaf' : roll < 0.82 ? 'broadleafTall' : 'conifer';
    const kind = roll < 0.5 ? 'oak' : roll < 0.9 ? 'cypress' : 'palm';
    return { x, y, size: h, yaw: cellHash(i, j, 5) * Math.PI * 2, seed: seedOfKind(kind, cellHash(i, j, 6)), species };
  });
}

/** The low scrub in a cell ('scrub'). */
export function scrubIn(cell: number, ground: CoverGround): Candidate[] {
  return paintedIn(cell, SCRUB_SPACING, 0.95, (i, j, cx, cy) => {
    const density = ground.coverAt('scrub', cx, cy);
    if (density < 0.04) return null;
    const clump = 0.35 + 0.65 * Math.max(0, Math.min(1, (scrubClump(cx, cy) + 0.15) * 1.6));
    if (cellHash(i, j, 21) > Math.sqrt(density) * clump) return null;
    const x = cx + (cellHash(i, j, 22) - 0.5) * SCRUB_SPACING * 0.95, y = cy + (cellHash(i, j, 23) - 0.5) * SCRUB_SPACING * 0.95;
    return { x, y, size: m(1.5) + m(2) * cellHash(i, j, 24) * clump, yaw: cellHash(i, j, 26) * Math.PI * 2, seed: cellHash(i, j, 27), species: 'broadleaf' };
  });
}

/** The painted stones in a cell ('rocks'). */
export function rocksIn(cell: number, ground: CoverGround): Candidate[] {
  return paintedIn(cell, ROCK_SPACING, 0.9, (i, j, cx, cy) => {
    const density = ground.coverAt('rocks', cx, cy);
    if (density < 0.04 || cellHash(i, j, 41) > Math.sqrt(density) * 0.7) return null;
    const x = cx + (cellHash(i, j, 42) - 0.5) * ROCK_SPACING * 0.9, y = cy + (cellHash(i, j, 43) - 0.5) * ROCK_SPACING * 0.9;
    // Mostly modest stones, now and then a big boulder.
    const roll = cellHash(i, j, 44);
    const size = roll > 0.88 ? m(2.2) + m(2) * cellHash(i, j, 45) : m(0.6) + m(1.5) * roll;
    return { x, y, size, yaw: cellHash(i, j, 46) * Math.PI * 2, seed: cellHash(i, j, 47), species: 'broadleaf' };
  });
}

/** The water's box, world units (`TerrainSurface.waterArea`). */
export interface WaterBox { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }

/** The box the rivers' stones are looked for in round the water's box (null: no water). */
export const shoreBox = (water: WaterBox | null): readonly [number, number, number, number] | null =>
  water ? [water.minX - SHORE_REACH - RIVER_ROCK_SPACING, water.minY - SHORE_REACH - RIVER_ROCK_SPACING, water.maxX + SHORE_REACH + RIVER_ROCK_SPACING, water.maxY + SHORE_REACH + RIVER_ROCK_SPACING] : null;

/** Along every body of water - in the shallows, on the line and up the bank - the places in a cell a stone may lie */
export function shoreIn(cell: number, ground: CoverGround, water: WaterBox | null): ShoreCandidate[] {
  if (!water) return [];
  const s = RIVER_ROCK_SPACING;
  const [x0, y0, x1, y1] = keepCellBox(cell);
  // The lattice over the water's box, as one sweep of it would take it; each place inside its own lattice cell.
  const i0 = Math.max(Math.floor((water.minX - SHORE_REACH + TERRAIN_HALF) / s), Math.floor((x0 + TERRAIN_HALF) / s) - 1);
  const i1 = Math.min(Math.ceil((water.maxX + SHORE_REACH + TERRAIN_HALF) / s), Math.floor((x1 + TERRAIN_HALF) / s));
  const j0 = Math.max(Math.floor((water.minY - SHORE_REACH + TERRAIN_HALF) / s), Math.floor((y0 + TERRAIN_HALF) / s) - 1);
  const j1 = Math.min(Math.ceil((water.maxY + SHORE_REACH + TERRAIN_HALF) / s), Math.floor((y1 + TERRAIN_HALF) / s));
  const out: ShoreCandidate[] = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = -TERRAIN_HALF + (i + cellHash(i, j, 51)) * s, y = -TERRAIN_HALF + (j + cellHash(i, j, 52)) * s;
      if (keepCellAt(x, y) !== cell) continue;
      const level = ground.shoreLevelAt(x, y);
      if (level === null) continue;
      const size = m(0.6) + m(1.6) * cellHash(i, j, 54) ** 1.6;
      out.push({ x, y, level, draw: cellHash(i, j, 53), size, yaw: cellHash(i, j, 55) * Math.PI * 2, seed: cellHash(i, j, 56), species: 'broadleaf' });
    }
  }
  return out;
}

/** The ecosystem's tree lattice (`world/ecology.ts`): one candidate a cell of this. */
const NATURE_SPACING = WOODS_SPACING;
/** Trees the ecosystem grows at full vegetation quality (the forests take most). */
const NATURE_TREES = 2_500;

/** One plate's tree density as swept, and what it was swept from (the plate's ecology, its land's serial, the vegetation setting). */
export interface NaturePlate {
  readonly field: EcologyField;
  readonly land: number;
  readonly vegetation: number;
  readonly part: TerrainPart;
  readonly odds: Float32Array;
  readonly band: Uint8Array;
  readonly sum: number;
  /** Its trees as last picked, and the scale they were picked at: picked again only when either moved. */
  picked: { readonly scale: number; readonly trees: readonly Candidate[] } | null;
}

/** THE TREE MAP of one plate, as Horizon Zero Dawn's Placement_Trees (Guerrilla, GDC 2017): each lattice cell's odds of a tree */
export function sweepNaturePlate(part: TerrainPart, field: EcologyField, land: number, vegetation: number, reuse: NaturePlate | undefined): NaturePlate {
  const cells = Math.floor((TERRAIN_HALF * 2) / NATURE_SPACING);
  const odds = reuse?.odds ?? new Float32Array(cells * cells);
  const band = reuse?.band ?? new Uint8Array(cells * cells);
  const d = WOODS_SLOPE_STEP;
  let sum = 0;
  // The land's own slope, before the roads cut and fill it: a wood holds a hillside, not the bank of a street
  const natural = part.surface.naturalRenderedHeightAt;
  // Its density but the ecosystem's share, made off the page with the plate (`woodsBase.ts`): only that share added here.
  const base = part.surface.woodsBase?.() ?? null;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x = -TERRAIN_HALF + (i + 0.5) * NATURE_SPACING, y = -TERRAIN_HALF + (j + 0.5) * NATURE_SPACING;
      const ix = Math.round((x + TERRAIN_HALF) / TERRAIN_CELL), iy = Math.round((TERRAIN_HALF - y) / TERRAIN_CELL);
      const k = iy * field.side + ix;
      const ecology = Math.min(1, (field.canopy[k] ?? 0) * 0.9 + (field.trees[k] ?? 0) * 0.5 + (field.emergent[k] ?? 0) * 0.3);
      const o = j * cells + i;
      let density: number;
      if (base) density = base[o]! + ecology * 0.3;
      else {
        const slope = Math.hypot(natural(x + d, y) - natural(x - d, y), natural(x, y + d) - natural(x, y - d)) / (2 * d);
        const hillside = Math.min(1, Math.max(0, (slope - 0.06) / 0.35));
        // The patches drawn out to clear masses: woods on the plains too, as capões, and clean meadows between them.
        density = natureDensity(x + part.cx, y + part.cy, m(1), hillside, ecology);
      }
      // The bands: inner forest, its edge, scattered trees, a rare lone one.
      if (density > 0.62) { odds[o] = 0.92; band[o] = 3; }
      else if (density > 0.5) { odds[o] = 0.25 + (density - 0.5) / 0.12 * 0.6; band[o] = 2; }
      else if (density > 0.38) { odds[o] = 0.025; band[o] = 1; }
      else { odds[o] = 0.003; band[o] = 1; }
      sum += odds[o]!;
    }
  }
  return { field, land, vegetation, part, odds, band, sum, picked: null };
}

/** The scale of every plate's odds: as many trees on the plates shown as their area's share of the budget, in steps of 2 % */
export function natureScale(plates: readonly NaturePlate[], vegetation: number): number {
  const plateArea = (2 * TERRAIN_HALF) ** 2;
  const base = NATURE_TREES * Math.min(1, vegetation / 2_600);
  let treeSum = 0;
  for (const plate of plates) treeSum += plate.sum;
  const plannedSum = (treeSum / Math.max(1, plates.length)) * (m(1_920) ** 2 / plateArea);
  // In steps of 2 %: a plate brought in nudges the average
  return Math.min(1, Math.exp(Math.round(Math.log(base / Math.max(1, plannedSum)) / 0.02) * 0.02));
}

/** A plate's trees at a scale of its odds, row by row. */
export function pickNature(plate: NaturePlate, scale: number): Candidate[] {
  const cells = Math.floor((TERRAIN_HALF * 2) / NATURE_SPACING);
  const { part, odds, band } = plate;
  const di = Math.round(part.cx / NATURE_SPACING), dj = Math.round(part.cy / NATURE_SPACING);
  const mine: Candidate[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const o = j * cells + i;
      const gi = i + di, gj = j + dj;
      if (cellHash(gi, gj, 41) >= odds[o]! * scale) continue;
      const x = part.cx - TERRAIN_HALF + (i + 0.5 + (cellHash(gi, gj, 43) - 0.5) * 0.9) * NATURE_SPACING;
      const y = part.cy - TERRAIN_HALF + (j + 0.5 + (cellHash(gi, gj, 44) - 0.5) * 0.9) * NATURE_SPACING;
      // Tall in the heart of a wood, crowns meeting into one canopy; lower at its edge; short and crooked out in the open.
      const inner = band[o] === 3, edge = band[o] === 2;
      const h = inner ? m(11) + m(8) * cellHash(gi, gj, 45) : edge ? m(8) + m(6) * cellHash(gi, gj, 45) : m(5.5) + m(4) * cellHash(gi, gj, 45);
      const roll = cellHash(gi, gj, 46);
      const species = inner ? (roll < 0.6 ? 'broadleafTall' : 'broadleaf') : roll < 0.25 ? 'broadleafTall' : 'broadleaf';
      // Which of the low-poly trees (`natureTrees.ts`): oaks and cypresses most, a palm now and then out in the open.
      const pick = cellHash(gi, gj, 49);
      const kind = pick < 0.55 ? 'oak' : pick < (inner ? 0.97 : 0.85) ? 'cypress' : 'palm';
      mine.push({ x, y, size: h, yaw: cellHash(gi, gj, 47) * Math.PI * 2, seed: seedOfKind(kind, cellHash(gi, gj, 48)), species });
    }
  }
  return mine;
}

/** The keep cells of a plate (it spans whole cells). */
export function plateCells(part: { readonly cx: number; readonly cy: number }): number[] {
  const out: number[] = [];
  const i0 = Math.floor((part.cx - TERRAIN_HALF) / KEEP_CELL), i1 = Math.floor((part.cx + TERRAIN_HALF) / KEEP_CELL) - 1;
  const j0 = Math.floor((part.cy - TERRAIN_HALF) / KEEP_CELL), j1 = Math.floor((part.cy + TERRAIN_HALF) / KEEP_CELL) - 1;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push(keepCellKey(i, j));
  return out;
}
