import { clamp } from '@core/scalar';
import { TUNED_UNIT, m } from './units';

export type TerrainMode = 'raise' | 'lower' | 'flatten' | 'river';

export interface TerrainStamp {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly strength: number;
  readonly mode: TerrainMode;
  /** Height a `flatten` stamp levels towards. */
  readonly level?: number;
  /** The brush stroke this dab belongs to. */
  readonly stroke?: number;
  /** Where a rough dab's noise is measured from (`rough`) */
  readonly ox?: number;
  readonly oy?: number;
  /** A natural brush (raise and lower dabs the player paints) */
  readonly rough?: boolean;
  /** How hard the brush's edge is, 0..1, for raise and lower: 0 (absent) the smooth dome */
  readonly hardness?: number;
  /** A raise's SHAPE other than the dome of its falloff. 'dome': a granite sugarloaf */
  readonly profile?: TerrainProfile;
}

/** The raise shapes besides the falloff's dome (`TerrainStamp.profile`). */
export type TerrainProfile = 'dome';
export const isTerrainProfile = (value: unknown): value is TerrainProfile => value === 'dome';

/** A sugarloaf's section, 1 at its centre to 0 at its foot, over `d` = the share of the reach out from the centre */
const sugarloafProfile = (d: number): number => Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.max(0, d)), 2.4)), 0.6);

/** How many brush dabs one map may hold. */
export const MAX_TERRAIN_STAMPS = 4_096;
/** The vertical extent of the land, in world units: how deep a pit and how high a mountain the brush may ever make. */
export const TERRAIN_MIN_HEIGHT = m(-144);
export const TERRAIN_MAX_HEIGHT = m(224);
export const TERRAIN_WATER_HEIGHT = m(0.048);
/** The extra factor a river stamp carves with, over a raise of the same strength. */
export const RIVER_CARVE = 1.45;

/** How much a stamp of strength 1 bends the ground `unit` of the way out */
export const terrainInfluence = (unit: number): number => unit * unit * (3 - 2 * unit);

/** The narrowest share of its radius a hard dab's edge falls over (`TerrainStamp.hardness`). */
const MIN_HARD_RIM = 0.08;
/** The narrowest a hard dab's wall is: two cells of the drawn terrain grid (6.4 m). */
const MIN_HARD_WALL = m(12.8);

/** A natural river dab carves this share of the old canyon's depth. */
const RIVER_BED_DEPTH = 0.42;
/** The share of a natural river dab's reach, from its edge, that is bank; inside it the bed is flat. */
export const RIVER_BED_FLOOR = 0.72;

/** The smallest share of its radius a rough dab reaches (`TerrainStamp.rough`). */
export const ROUGH_REACH_MIN = 0.78;

// --------------------------------------------------------------- base relief

/** The land the map starts with, before the player touches it. */
const BASE_AMPLITUDE = 32;

function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
}

/** Smooth deterministic value noise, -1..1 (the land's and the ecosystem's). */
export function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** Which land a map starts from (`RoadDoc.terrainRelief`) */
export type ReliefVersion = 1 | 2 | 3;
export const RELIEF_LEGACY: ReliefVersion = 1;
export const RELIEF_NATURAL: ReliefVersion = 2;
export const RELIEF_FLAT: ReliefVersion = 3;
/** A saved map's relief as the document reads it, or null when the value is none. 4 was the planet's Earth */
export const readRelief = (value: unknown): ReliefVersion | null =>
  value === 1 || value === 2 || value === 3 ? value : value === 4 ? RELIEF_FLAT : null;

/** Where a map's own relief (1, 2) stands */
const RELIEF_HALF = m(960);
const RELIEF_BLEND = m(480);

/** The map's own land at a point, before any stamp: its relief's field. */
export function reliefHeight(relief: ReliefVersion, x: number, y: number): number {
  if (relief === RELIEF_FLAT) return 0;
  const out = Math.max(Math.abs(x), Math.abs(y)) - RELIEF_HALF;
  if (out >= RELIEF_BLEND) return 0;
  const h = relief === RELIEF_NATURAL ? naturalRelief(x, y) : baseRelief(x, y);
  return out <= 0 ? h : h * (1 - smooth01(out / RELIEF_BLEND));
}

/** 0..1 smoothstep of `t`, clamped. */
const smooth01 = (t: number): number => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/** The natural landform: country, not a plate. - DOMAIN-WARPED (Inigo Quilez, "warp") */
export function naturalRelief(x: number, y: number): number {
  return naturalReliefTuned(x / TUNED_UNIT, y / TUNED_UNIT) * TUNED_UNIT;
}

/** `naturalRelief` in the unit its figures were tuned in (`TUNED_UNIT`). */
function naturalReliefTuned(x: number, y: number): number {
  const wx = valueNoise(x / 1400 + 3.1, y / 1400 - 7.4) * 420;
  const wy = valueNoise(x / 1400 - 11.2, y / 1400 + 2.6) * 420;
  const px = x + wx;
  const py = y + wy;
  const continent = valueNoise(px / 1900, py / 1900);
  const hilly = smooth01((valueNoise(px / 1300 + 17.3, py / 1300 - 5.9) + 0.1) / 0.85);
  let ridge = 0;
  let weight = 0;
  let amplitude = 1;
  let frequency = 1 / 640;
  for (let octave = 0; octave < 4; octave++) {
    const n = 1 - Math.abs(valueNoise(px * frequency + octave * 13.7, py * frequency - octave * 9.1));
    ridge += n * n * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  ridge /= weight;
  const rolling = valueNoise(px / 260 + 2.2, py / 260 - 8.8) * 0.65 + valueNoise(px / 110 + 4.4, py / 110 + 1.3) * 0.35;
  const micro = valueNoise(x / 38 - 6.6, y / 38 + 3.3) * 0.6 + valueNoise(x / 17 + 9.9, y / 17 - 2.7) * 0.4;
  return 55 * continent + hilly * (190 * ridge - 60) + 22 * rolling * (0.35 + 0.65 * hilly) + 1.6 * micro;
}

/** The procedural land under every map, in world units. */
export function baseRelief(x: number, y: number): number {
  return baseReliefTuned(x / TUNED_UNIT, y / TUNED_UNIT) * TUNED_UNIT;
}

/** `baseRelief` in the unit its figures were tuned in (`TUNED_UNIT`). */
function baseReliefTuned(x: number, y: number): number {
  const broad = valueNoise(x / 620, y / 620);
  const middle = valueNoise(x / 210 + 13.7, y / 210 - 4.1);
  const fine = valueNoise(x / 88 - 7.3, y / 88 + 19.2);
  const grain = valueNoise(x / 48 + 31.5, y / 48 - 12.8);
  return BASE_AMPLITUDE * (broad * 0.42 + middle * 0.29 + fine * 0.2 + grain * 0.09);
}

// -------------------------------------------------------------- stamp lookup

/** A uniform grid over the stamps, so a height query touches only nearby ones. */
export class TerrainIndex {
  private readonly buckets = new Map<number, TerrainStamp[]>();
  /** The stamps, in authoring order: its own list, copied from the caller's and grown by `add`. */
  private readonly list: TerrainStamp[];
  /** The revision the caller built it at, or last added to it at (`RoadDoc.terrainRevision`), kept for it; the index itself never reads it. */
  revision: number;
  /** The land under the stamps (`ReliefVersion`). */
  readonly relief: ReliefVersion;

  /** The land under the stamps when it is read otherwise than from the relief at the point itself */
  readonly ground: ((x: number, y: number) => number) | undefined;

  constructor(stamps: readonly TerrainStamp[], revision: number, relief: ReliefVersion = RELIEF_LEGACY, ground?: (x: number, y: number) => number) {
    this.relief = relief;
    this.ground = ground;
    // COPIED, not aliased.
    this.list = stamps.slice();
    this.revision = revision;
    for (const stamp of stamps) this.file(stamp);
  }

  /** The stamps, in authoring order (the index's own: the caller's list may change after). */
  get stamps(): readonly TerrainStamp[] {
    return this.list;
  }

  /** DO NOT build a new index of every stamp for one the brush laid: it is filed in the cells it covers, last in each. */
  add(stamp: TerrainStamp, revision: number): void {
    this.list.push(stamp);
    this.file(stamp);
    this.revision = revision;
  }

  /** Takes the last stamp away (an undo of the brush), from its cells too, where it is last as well; returns it. */
  pop(revision: number): TerrainStamp | undefined {
    const stamp = this.list.pop();
    if (!stamp) return undefined;
    this.cellsOf(stamp, (key) => {
      const bucket = this.buckets.get(key)!;
      bucket.pop();
      if (bucket.length === 0) this.buckets.delete(key);
    });
    this.revision = revision;
    return stamp;
  }

  /** A stamp put last in every cell its disc covers. DO NOT size the cell by the widest stamp: one wide stamp */
  private file(stamp: TerrainStamp): void {
    this.cellsOf(stamp, (key) => {
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(stamp);
      else this.buckets.set(key, [stamp]);
    });
  }

  /** The keys of the cells a stamp's disc covers. */
  private cellsOf(stamp: TerrainStamp, visit: (key: number) => void): void {
    const x0 = Math.floor((stamp.x - stamp.radius) / STAMP_CELL);
    const x1 = Math.floor((stamp.x + stamp.radius) / STAMP_CELL);
    const y0 = Math.floor((stamp.y - stamp.radius) / STAMP_CELL);
    const y1 = Math.floor((stamp.y + stamp.radius) / STAMP_CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) visit(stampCellKey(x, y));
  }

  /** The stamps that can affect a point, in authoring order. */
  near(x: number, y: number): readonly TerrainStamp[] {
    return this.buckets.get(stampCellKey(Math.floor(x / STAMP_CELL), Math.floor(y / STAMP_CELL))) ?? EMPTY;
  }
}

/** Side of the stamp index's cells, world units. */
const STAMP_CELL = m(64);
/** A cell's key from its column and row: exact, no two cells share one (a hash of them could). */
const stampCellKey = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);

const EMPTY: readonly TerrainStamp[] = [];

/** The height of the land at a point: base relief plus every stamp over it. */
export function sampleTerrainHeight(
  stamps: readonly TerrainStamp[] | TerrainIndex,
  x: number,
  y: number,
): number {
  const list = stamps instanceof TerrainIndex ? stamps.near(x, y) : stamps;
  const relief = stamps instanceof TerrainIndex ? stamps.relief : RELIEF_LEGACY;
  const ground = stamps instanceof TerrainIndex ? stamps.ground : undefined;
  let height = ground ? ground(x, y) : reliefHeight(relief, x, y);
  // The stroke being gathered (see `TerrainStamp.stroke`)
  let stroke: number | undefined;
  let strokeMode: TerrainMode | undefined;
  let strokeMove = 0;
  const settle = (): void => {
    height += strokeMove;
    stroke = undefined;
    strokeMove = 0;
  };
  for (const stamp of list) {
    if (stroke !== undefined && (stamp.stroke !== stroke || stamp.mode !== strokeMode)) settle();
    const dx = x - stamp.x;
    const dy = y - stamp.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared >= stamp.radius * stamp.radius) continue;
    const distance = Math.sqrt(distanceSquared);
    let reach = stamp.radius;
    let carve = 1;
    let bedProfile = false;
    // The noise's own coordinates (see `TerrainStamp.ox`).
    const nx = stamp.ox === undefined ? x : x - stamp.ox;
    const ny = stamp.oy === undefined ? y : y - stamp.oy;
    if (stamp.rough && stamp.mode === 'river') {
      // A river with a BED: a wide flat floor and ramped banks that wander in and out along its length, at a depth a river has
      const lobe = stamp.radius * 0.6;
      reach *= ROUGH_REACH_MIN + (1 - ROUGH_REACH_MIN) * (0.5 + 0.5 * valueNoise(nx / lobe + 23.9, ny / lobe + 31.4));
      if (distance >= reach) continue;
      carve = RIVER_BED_DEPTH;
      bedProfile = true;
    } else if (stamp.rough && (stamp.mode === 'raise' || stamp.mode === 'lower')) {
      // World-space noise scaled by the brush, so every dab of a stroke (one radius) agrees on the same lobes and crests.
      const lobe = stamp.radius * 0.45;
      reach *= ROUGH_REACH_MIN + (1 - ROUGH_REACH_MIN) * (0.5 + 0.5 * valueNoise(nx / lobe + 41.3, ny / lobe - 17.9));
      if (distance >= reach) continue;
      // A sugarloaf's crown is smooth rock: its outline wanders, its top does not.
      if (stamp.profile !== 'dome') {
        const crest = stamp.radius * 0.55;
        const ridge = 1 - Math.abs(valueNoise(nx / crest - 5.1, ny / crest + 8.6));
        // Gentle: dabs stack, and a strong carve stacked ten times drew spires.
        carve = 1 + (0.36 * ridge * ridge - 0.18) * (1 - 0.75 * (stamp.hardness ?? 0));
      }
    }
    const unit = 1 - distance / reach;
    // A hard edge: the falloff squeezed into the dab's outer rim.
    const rim = stamp.hardness && (stamp.mode === 'raise' || stamp.mode === 'lower') ? Math.min(1, Math.max(MIN_HARD_RIM, 1 - stamp.hardness, MIN_HARD_WALL / reach)) : 1;
    const influence = (bedProfile ? terrainInfluence(Math.min(1, unit / RIVER_BED_FLOOR))
      : stamp.profile === 'dome' && stamp.mode === 'raise' ? sugarloafProfile(1 - unit)
        : terrainInfluence(Math.min(1, unit / rim))) * carve;
    const move = stamp.mode === 'raise' ? stamp.strength * influence
      : stamp.mode === 'lower' ? -stamp.strength * influence
        : stamp.mode === 'river' ? -stamp.strength * RIVER_CARVE * influence
          : 0;
    if (stamp.mode !== 'flatten' && stamp.stroke !== undefined) {
      stroke = stamp.stroke;
      strokeMode = stamp.mode;
      if (Math.abs(move) > Math.abs(strokeMove)) strokeMove = move;
    } else if (stamp.mode !== 'flatten') height += move;
    else {
      // Level towards the stamp's own target.
      const target = stamp.level ?? 0;
      height += (target - height) * Math.min(1, stamp.strength / m(4)) * influence;
    }
  }
  settle();
  return clamp(height, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
}

export const isTerrainMode = (value: unknown): value is TerrainMode =>
  value === 'raise' || value === 'lower' || value === 'flatten' || value === 'river';
