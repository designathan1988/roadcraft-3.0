import { onGridLength } from './grid';
import { m } from './units';
export const LANE_TURN_RULES = ['all', 'left', 'through', 'right', 'leftThrough', 'throughRight'] as const;
export type LaneTurnRule = (typeof LANE_TURN_RULES)[number];

/** What an element of the cross-section is paved with. */
export const CARRIAGEWAY_MATERIALS = ['asphalt', 'concrete', 'cobble'] as const;
export const FOOTWAY_MATERIALS = ['pavers', 'concrete', 'stone'] as const;
export const MEDIAN_MATERIALS = ['grass', 'concrete', 'pavers'] as const;
export type CarriagewayMaterial = (typeof CARRIAGEWAY_MATERIALS)[number];
export type FootwayMaterial = (typeof FOOTWAY_MATERIALS)[number];
export type MedianMaterial = (typeof MEDIAN_MATERIALS)[number];

export interface SectionMaterials {
  readonly carriageway?: CarriagewayMaterial;
  /** Left and right of a -> b. */
  readonly footwayLeft?: FootwayMaterial;
  readonly footwayRight?: FootwayMaterial;
  readonly median?: MedianMaterial;
}

/** Authored road section. */
export interface RoadSection {
  readonly laneWidth: number;
  readonly sidewalk: number;
  /** The footway left of a -> b, when it differs from the right one. */
  readonly sidewalkLeft?: number;
  readonly sidewalkRight?: number;
  /** A footway laid level with the carriageway (a shared surface): no kerb stone, no rise. */
  readonly flushLeft?: boolean;
  readonly flushRight?: boolean;
  /** A central reservation painted on the carriageway instead of kerbed and raised. */
  readonly medianFlush?: boolean;
  readonly materials?: SectionMaterials;
  readonly median: number;
  readonly speedKmh: number;
  readonly priority: number;
  /** Lane order matches laneIndex, inner to outer, in the stored a -> b direction. */
  readonly turnsForward?: readonly LaneTurnRule[];
  /** Lane order in the stored b -> a direction. Missing indexes retain default movements. */
  readonly turnsBackward?: readonly LaneTurnRule[];
  /** Who may drive each lane, by laneIndex (inner to outer) in each direction */
  readonly useForward?: readonly LaneUse[];
  readonly useBackward?: readonly LaneUse[];
  /** The line between lane k and lane k + 1 of each direction: dashed (a lane change allowed, LMS-2) or solid */
  readonly linesForward?: readonly LaneLine[];
  readonly linesBackward?: readonly LaneLine[];
  /** The line between the two directions (MBST vol. IV): dashed (LFO-2, overtaking allowed), solid */
  readonly centreLine?: CentreLine;
}

export type CentreLine = 'dashed' | 'solid' | 'double';
export const CENTRE_LINES: readonly CentreLine[] = ['dashed', 'solid', 'double'];

/** Who may drive a lane (`RoadSection.useForward`). */
export type LaneUse = 'all' | 'bus';
const LANE_USES: readonly LaneUse[] = ['all', 'bus'];
/** The line between two lanes of one direction (`RoadSection.linesForward`). */
export type LaneLine = 'dashed' | 'solid';
const LANE_LINES: readonly LaneLine[] = ['dashed', 'solid'];
const LANE_LIST_KEYS = ['useForward', 'useBackward', 'linesForward', 'linesBackward'] as const;

/** Physical edit bounds, shared by persistence and the section editor. */
export const ROAD_SECTION_LIMITS = {
  laneWidth: [m(2), m(6)],
  sidewalk: [m(1), m(12)],
  median: [0, m(8)],
  speedKmh: [10, 130],
  priority: [0, 5],
} as const;

/** Rejects incomplete/non-finite input; clamps finite values at the document boundary. */
export function normalizeRoadSection(raw: unknown): RoadSection | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const result = {} as { -readonly [K in keyof RoadSection]: RoadSection[K] };
  for (const key of Object.keys(ROAD_SECTION_LIMITS) as (keyof typeof ROAD_SECTION_LIMITS)[]) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
    const [min, max] = ROAD_SECTION_LIMITS[key];
    const clamped = Math.max(min, Math.min(max, key === 'priority' ? Math.round(number) : number));
    // Widths are whole metres of the universal grid (`grid.ts`).
    result[key] = key === 'laneWidth' || key === 'sidewalk' || key === 'median'
      ? Math.max(min, Math.min(max, onGridLength(clamped)))
      : clamped;
  }
  // The two footways, when they differ: each on the grid and within the limits, and `sidewalk` the wider
  const left = value['sidewalkLeft'], right = value['sidewalkRight'];
  if (left !== undefined || right !== undefined) {
    const side = (raw: unknown): number | null => {
      if (raw === undefined) return result.sidewalk;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
      const [min, max] = ROAD_SECTION_LIMITS.sidewalk;
      return Math.max(min, Math.min(max, onGridLength(Math.max(min, Math.min(max, raw)))));
    };
    const l = side(left), r = side(right);
    if (l === null || r === null) return undefined;
    if (l !== r) {
      result.sidewalkLeft = l;
      result.sidewalkRight = r;
      result.sidewalk = Math.max(l, r);
    } else result.sidewalk = l;
  }
  for (const key of ['flushLeft', 'flushRight', 'medianFlush'] as const) {
    const flag = value[key];
    if (flag === undefined || flag === false) continue;
    if (flag !== true) return undefined;
    result[key] = true;
  }
  if (value['materials'] !== undefined) {
    const materials = normalizeMaterials(value['materials']);
    if (materials === null) return undefined;
    if (materials) result.materials = materials;
  }
  for (const key of ['turnsForward', 'turnsBackward'] as const) {
    const rules = value[key];
    if (rules === undefined) continue;
    if (!Array.isArray(rules) || rules.length > 8 ||
      rules.some((rule) => !LANE_TURN_RULES.includes(rule as LaneTurnRule))) return undefined;
    result[key] = [...rules] as LaneTurnRule[];
  }
  const centreLine = value['centreLine'];
  if (centreLine !== undefined) {
    if (!CENTRE_LINES.includes(centreLine as CentreLine)) return undefined;
    result.centreLine = centreLine as CentreLine;
  }
  // Lane uses and lines: a list of at most eight known values, dropped when it says nothing a missing one would not
  for (const key of LANE_LIST_KEYS) {
    const list = value[key];
    if (list === undefined) continue;
    const allowed: readonly string[] = key.startsWith('use') ? LANE_USES : LANE_LINES;
    if (!Array.isArray(list) || list.length > 8 || list.some((x) => !allowed.includes(x as string))) return undefined;
    const fallback = allowed[0];
    let end = list.length;
    while (end > 0 && list[end - 1] === fallback) end--;
    if (end > 0) (result as Record<string, unknown>)[key] = list.slice(0, end);
  }
  return result;
}

/** Stored materials: undefined when none are set, null when one is not a material. */
function normalizeMaterials(raw: unknown): SectionMaterials | undefined | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  const pick = (key: keyof SectionMaterials, allowed: readonly string[]): boolean => {
    const v = value[key];
    if (v === undefined) return true;
    if (typeof v !== 'string' || !allowed.includes(v)) return false;
    out[key] = v;
    return true;
  };
  if (!pick('carriageway', CARRIAGEWAY_MATERIALS) || !pick('footwayLeft', FOOTWAY_MATERIALS) ||
    !pick('footwayRight', FOOTWAY_MATERIALS) || !pick('median', MEDIAN_MATERIALS)) return null;
  return Object.keys(out).length ? out as SectionMaterials : undefined;
}

/** The section's footway on one side of a -> b. */
export const sectionSidewalk = (s: RoadSection, side: 'left' | 'right'): number =>
  (side === 'left' ? s.sidewalkLeft : s.sidewalkRight) ?? s.sidewalk;

/** The same section seen from the other end of its road */
export function flipSection(s: RoadSection | undefined): RoadSection | undefined {
  if (!s) return undefined;
  const { sidewalkLeft, sidewalkRight, flushLeft, flushRight, materials, turnsForward, turnsBackward,
    useForward, useBackward, linesForward, linesBackward, ...rest } = s;
  const flippedMaterials = materials ? {
    ...(materials.carriageway ? { carriageway: materials.carriageway } : {}),
    ...(materials.median ? { median: materials.median } : {}),
    ...(materials.footwayRight ? { footwayLeft: materials.footwayRight } : {}),
    ...(materials.footwayLeft ? { footwayRight: materials.footwayLeft } : {}),
  } : undefined;
  return {
    ...rest,
    ...(sidewalkRight !== undefined ? { sidewalkLeft: sidewalkRight } : {}),
    ...(sidewalkLeft !== undefined ? { sidewalkRight: sidewalkLeft } : {}),
    ...(flushRight ? { flushLeft: true } : {}),
    ...(flushLeft ? { flushRight: true } : {}),
    ...(flippedMaterials ? { materials: flippedMaterials } : {}),
    ...(turnsBackward ? { turnsForward: [...turnsBackward] } : {}),
    ...(turnsForward ? { turnsBackward: [...turnsForward] } : {}),
    ...(useBackward ? { useForward: [...useBackward] } : {}),
    ...(useForward ? { useBackward: [...useForward] } : {}),
    ...(linesBackward ? { linesForward: [...linesBackward] } : {}),
    ...(linesForward ? { linesBackward: [...linesForward] } : {}),
  };
}

/** Every field of `SectionMaterials`: a field added there and left out here does not compile. */
const MATERIAL_FIELDS: Record<keyof SectionMaterials, true> = { carriageway: true, footwayLeft: true, footwayRight: true, median: true };
/** The fields of `SectionMaterials`, always in this order. */
export const MATERIAL_KEYS = Object.keys(MATERIAL_FIELDS) as readonly (keyof SectionMaterials)[];

/** DO NOT compare them as JSON text: the text follows the order the keys were written in */
function sameMaterials(a: SectionMaterials | undefined, b: SectionMaterials | undefined): boolean {
  return MATERIAL_KEYS.every((key) => a?.[key] === b?.[key]);
}

export function sameRoadSection(a: RoadSection | undefined, b: RoadSection | undefined): boolean {
  if (!a || !b) return a === b;
  return (Object.keys(ROAD_SECTION_LIMITS) as (keyof typeof ROAD_SECTION_LIMITS)[]).every((key) => a[key] === b[key]) &&
    a.sidewalkLeft === b.sidewalkLeft && a.sidewalkRight === b.sidewalkRight && !a.flushLeft === !b.flushLeft &&
    !a.flushRight === !b.flushRight && !a.medianFlush === !b.medianFlush &&
    sameMaterials(a.materials, b.materials) && a.centreLine === b.centreLine &&
    (['turnsForward', 'turnsBackward', ...LANE_LIST_KEYS] as const).every((key) => {
      const left: readonly string[] = a[key] ?? [], right: readonly string[] = b[key] ?? [];
      return left.length === right.length && left.every((rule, index) => rule === right[index]);
    });
}

/** The section of one piece of a split road. */
export function sectionForPiece(section: RoadSection | undefined, reachesA: boolean, reachesB: boolean): RoadSection | undefined {
  if (!section) return undefined;
  const { turnsForward, turnsBackward, ...rest } = section;
  return {
    ...rest,
    ...(reachesB && turnsForward ? { turnsForward: [...turnsForward] } : {}),
    ...(reachesA && turnsBackward ? { turnsBackward: [...turnsBackward] } : {}),
  };
}

/** Whether two sections are the same road once their lane arrows are set aside. */
export function sameRoadSectionIgnoringArrows(a: RoadSection | undefined, b: RoadSection | undefined): boolean {
  return sameRoadSection(sectionForPiece(a, false, false), sectionForPiece(b, false, false));
}

/** A snapshot must never share editable turn arrays with its document. */
export function cloneRoadSection(section: RoadSection): RoadSection {
  return { ...section,
    ...(section.materials ? { materials: { ...section.materials } } : {}),
    ...(section.turnsForward ? { turnsForward: [...section.turnsForward] } : {}),
    ...(section.turnsBackward ? { turnsBackward: [...section.turnsBackward] } : {}),
    ...(section.useForward ? { useForward: [...section.useForward] } : {}),
    ...(section.useBackward ? { useBackward: [...section.useBackward] } : {}),
    ...(section.linesForward ? { linesForward: [...section.linesForward] } : {}),
    ...(section.linesBackward ? { linesBackward: [...section.linesBackward] } : {}) };
}

/** Explicit arrows restrict every connector, including merge and U-turn fallbacks. */
export function laneTurnAllowed(rule: LaneTurnRule | undefined, turn: 'left' | 'right' | 'through' | 'uturn'): boolean {
  if (!rule || rule === 'all') return true;
  if (turn === 'uturn') return false;
  return rule === turn || (rule === 'leftThrough' && (turn === 'left' || turn === 'through')) ||
    (rule === 'throughRight' && (turn === 'through' || turn === 'right'));
}

/** The section that gives a road of class profile `rt` a chosen TOTAL width */
export function sectionForWidth(rt: { readonly lanes: number; readonly median: number; readonly sidewalk: number; readonly speedLimit: number; readonly priorityRank: number },
  totalMetres: number, speedKmh: number): RoadSection {
  const total = m(Math.round(totalMetres));
  const lanes = Math.max(1, rt.lanes);
  const [minLane, maxLane] = ROAD_SECTION_LIMITS.laneWidth;
  const [minWalk, maxWalk] = ROAD_SECTION_LIMITS.sidewalk;
  let sidewalk = rt.sidewalk;
  let laneWidth = (total - rt.median - 2 * sidewalk) / lanes;
  if (laneWidth < minLane || laneWidth > maxLane) {
    laneWidth = Math.max(minLane, Math.min(maxLane, laneWidth));
    sidewalk = Math.max(minWalk, Math.min(maxWalk, (total - rt.median - lanes * laneWidth) / 2));
  }
  return { laneWidth, sidewalk, median: rt.median, speedKmh, priority: rt.priorityRank };
}

/** Who may drive lane `index` of one direction of a section. */
export function laneUse(section: RoadSection | undefined, forward: boolean, index: number): LaneUse {
  return (forward ? section?.useForward : section?.useBackward)?.[index] ?? 'all';
}

/** Whether a lane change across the line between lane `index` and lane `index + 1` of one direction is allowed */
export function laneLineCrossable(section: RoadSection | undefined, forward: boolean, index: number): boolean {
  const line = (forward ? section?.linesForward : section?.linesBackward)?.[index] ?? 'dashed';
  return line === 'dashed' && laneUse(section, forward, index) === laneUse(section, forward, index + 1);
}
