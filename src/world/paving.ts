import { PointHeights, fieldOf, type FieldData, type RoadReads } from './roadField';
import { FOOTWAY_RISE, ROAD_TYPES, casingHalf, sidewalkHalf } from './roadTypes';
import { type FlushData, flushShareOf } from './roads/footwayRise';
import type { RoadStructure } from './structures';

/** THE HEIGHT OF THE PAVING AT A POINT (footway or carriageway of a road at grade, NaN off the roads) */

/** The paving's height at (x, y) over a field of roads at grade; `riseAt` the footway's rise there. */
export function pavedHeightFrom(field: Pick<RoadReads, 'roadAt' | 'at'>, structures: ReadonlySet<RoadStructure>,
  riseAt: (x: number, y: number) => number, x: number, y: number): number {
  const road = field.roadAt(x, y, structures);
  const rt = road.type >= 0 ? ROAD_TYPES[road.type] : undefined;
  if (!rt) return NaN;
  // `half` is this road's own casing (its lanes may be set individually)
  const walk = (road.across >= 0 ? road.sidewalkLeft : road.sidewalkRight) ?? road.sidewalk ?? rt.sidewalk;
  const footway = road.half - (casingHalf(rt) - sidewalkHalf(rt)) - ((road.sidewalk ?? rt.sidewalk) - walk);
  const across = Math.abs(road.across);
  if (across > footway) return NaN;
  const deck = field.at(x, y, structures);
  return across > footway - walk ? deck + riseAt(x, y) : deck;
}

/** What the paving reads near a rectangle, to hand a worker: the solved profiles there */
export interface PavingData {
  readonly rect: readonly [number, number, number, number];
  readonly field: FieldData | null;
  readonly flush: FlushData | null;
}

/** The paving's height as the page reads it, and what to hand a worker for a rectangle of it. */
export interface PavingSource {
  (x: number, y: number): number;
  /** Null when it cannot be handed over (a field that cannot pack its roads): the page is asked. */
  readonly pack?: (rect: readonly [number, number, number, number]) => { data: PavingData; transfer: ArrayBuffer[] } | null;
}

/** The paving's height over `PavingData`; `groundAt`: the ground the roads' field reads, where it is known (the page is asked elsewhere) */
export function pavingReader(data: PavingData, groundAt?: (x: number, y: number) => number | undefined): (x: number, y: number) => number | undefined {
  const [x0, y0, x1, y1] = data.rect;
  const inside = (x: number, y: number): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (!data.field) return (x, y) => (inside(x, y) ? NaN : undefined);
  /** The roads at grade: the paving's filter, as the page's (`GROUND_ONLY`). */
  const ground: ReadonlySet<RoadStructure> = new Set<RoadStructure>(['ground']);
  let missed = false;
  const field = fieldOf(data.field, (x, y) => {
    const land = groundAt?.(x, y);
    if (land !== undefined) return land;
    missed = true;
    return NaN;
  });
  const share = data.flush ? flushShareOf(data.flush) : null;
  const riseAt = (x: number, y: number): number => (share ? FOOTWAY_RISE * share(x, y) : FOOTWAY_RISE);
  /** Points whose reading needed the ground: the field remembers their NaN (`roadField.ts` `last`), so never read here again. */
  const asked = new PointHeights();
  return (x, y) => {
    if (!inside(x, y) || asked.get(x, y) !== undefined) return undefined;
    missed = false;
    const value = pavedHeightFrom(field, ground, riseAt, x, y);
    if (!missed) return value;
    asked.add(x, y, 0);
    return undefined;
  };
}
