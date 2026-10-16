import { Digest } from '@core/digest';
import { segSeg } from '@core/intersect';
import { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import { m } from './units';
import { HEADING_CHORD, chordHeading } from './heading';
import type { CornerMeasurer } from './walkingLines';
import type { RoadNode, RoadSegment } from './doc';
import type { ApproachGroup } from './approachGroups';
import type { NodeId, SegmentId } from './ids';

/** WHERE TWO MOVEMENTS' BODIES MEET, measured from their sampled sweeps alone */

/** Size classes a conflict zone is measured for. */
export type BodyClass = 0 | 1 | 2;

/** A turn as `turnPaths.ts` chose it: one cubic's handle, or two cubics through a point inside the junction. */
export type TurnChoice = number | { x: number; y: number; share: number };

/** What the search for a turn answers (`turnPaths.ts` `chooseTurn`): the choice and the largest body it fits. */
export interface ChosenTurn {
  readonly choice: TurnChoice;
  readonly maxBodyClass: BodyClass | -1;
}

/** What a turn is chosen from, as plain numbers, for a worker (`conflictPool.ts`) */
export interface TurnAsk {
  /** The lanes' own lists (`Polyline.xy`, never changed once made): not copied here, once by the message. */
  readonly inXY: Float64Array;
  readonly outXY: Float64Array;
  readonly waiting: readonly Float64Array[];
  /** The junction's surface, kept once a key in the plan (`TurnPlan.surfaces`). */
  readonly surfaceKey: string;
  readonly fromRoadEnd: boolean;
  readonly toRoadEnd: boolean;
}

/** A junction's surface as a worker makes it again: its centre and its rings as flat x, y lists. */
export interface SurfaceRings {
  readonly centre: { readonly x: number; readonly y: number };
  readonly rings: readonly Float64Array[];
}

export const BODY_CLASSES: readonly BodyClass[] = [0, 1, 2];
export const BODY_ENVELOPE: readonly { readonly length: number; readonly width: number }[] = [
  { length: m(2.2), width: m(0.9) },
  { length: m(5.7), width: m(2.05) },
  { length: m(12.1), width: m(2.6) },
];
export const HEAVY: BodyClass = 2;

/** Sampling step of the body centre along a movement, world units. */
const SWEEP_STEP = m(0.4);
/** How far behind its stop line the front of a waiting body is swept, world units */
const QUEUE_BACK = m(3.2);

/** A sweep's first sample and count: from a heavy body a little short of its stop line (`QUEUE_BACK`) to its rear past the movement's end (`length`). */
export function sweepSpan(length: number): { c0: number; count: number } {
  const heavy = BODY_ENVELOPE[HEAVY] as { length: number; width: number };
  const c0 = -heavy.length / 2 - QUEUE_BACK;
  const c1 = length + heavy.length / 2;
  return { c0, count: Math.max(2, Math.ceil((c1 - c0) / SWEEP_STEP) + 1) };
}

/** Clearance kept around every body, world units (6 cm). */
const SWEEP_MARGIN = m(0.06);
/** Consecutive samples one broad-phase box holds (`boxesOf`). */
const CHUNK = 8;
/** Slack on the broad phase's box tests, world units: far below a sample's rounding, far above the SAT's. */
const BOX_SLACK = m(1e-6);

/** What one movement's sweep is sampled from, as plain numbers */
export interface SweepAsk {
  readonly inXY: Float64Array;
  readonly crossXY: Float64Array;
  readonly outXY: Float64Array;
  readonly c0: number;
  readonly count: number;
}

/** A movement's sweep sampled (`sampleSweep`): its frame, and the digests the page keys it by. */
export interface SampledSweep {
  /** Per sample: centre x, y and unit tangent x, y (`SweepSamples.frame`). */
  readonly frame: Float64Array;
  readonly frameLengthSq: Float64Array;
  /** `lineDigest` of the approach, the movement and the exit. */
  readonly lines: readonly [number, number, number];
  /** `shapeDigest` of the frame and the movement's centreline. */
  readonly shape: number;
}

/** Digest of a centreline's points: part of a sweep's cache key (`conflictPoints.ts` `sweepOf`). */
export function lineDigest(xy: Float64Array): number {
  return new Digest().addAll(xy).value();
}

/** Digest of a sweep's frame and its movement's centreline: what a pair's key is made of */
export function shapeDigest(frame: Float64Array, centre: Float64Array): number {
  return new Digest().addAll(frame).addAll(centre).value();
}

/** The approach, the movement and the exit as one arc-length parameter. */
export function joinedPath(inbound: Polyline, crossing: Polyline, outbound: Polyline): { sampleAt(c: number): { p: Vec2; t: Vec2 } } {
  return {
    sampleAt(c: number): { p: Vec2; t: Vec2 } {
      if (c < 0) {
        const s = inbound.length + c;
        if (s >= 0) return inbound.sampleAt(s);
        const f = inbound.sampleAt(0);
        return { p: { x: f.p.x + f.t.x * s, y: f.p.y + f.t.y * s }, t: f.t };
      }
      if (c <= crossing.length) return crossing.sampleAt(c);
      const s = c - crossing.length;
      if (s <= outbound.length) return outbound.sampleAt(s);
      const f = outbound.sampleAt(outbound.length);
      const over = s - outbound.length;
      return { p: { x: f.p.x + f.t.x * over, y: f.p.y + f.t.y * over }, t: f.t };
    },
  };
}

/** The frame of a sweep: `count` body centres `SWEEP_STEP` apart from `c0` along the joined path */
export function sweepFrame(path: { sampleAt(c: number): { p: Vec2; t: Vec2 } }, c0: number, count: number): Float64Array {
  const frame = new Float64Array(count * 4);
  for (let i = 0; i < count; i++) {
    const at = c0 + i * SWEEP_STEP;
    const f = path.sampleAt(at);
    const t = chordHeading(path.sampleAt(at - HEADING_CHORD).p, path.sampleAt(at + HEADING_CHORD).p, f.t);
    frame[i * 4] = f.p.x;
    frame[i * 4 + 1] = f.p.y;
    frame[i * 4 + 2] = t.x;
    frame[i * 4 + 3] = t.y;
  }
  return frame;
}

/** Squared tangent length per sample of a frame (`SweepSamples.frameLengthSq`). */
export function frameLengthsOf(frame: Float64Array): Float64Array {
  const count = frame.length / 4;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const x = frame[i * 4 + 2]!, y = frame[i * 4 + 3]!;
    out[i] = x * x + y * y;
  }
  return out;
}

/** One movement's sweep sampled from plain numbers, as `conflictPoints.ts` `sweepOf` and `measureShape` would on the page */
export function sampleSweep(ask: SweepAsk, lines?: Map<Float64Array, { line: Polyline; digest: number }>): SampledSweep {
  const lineOf = (xy: Float64Array): { line: Polyline; digest: number } => {
    let known = lines?.get(xy);
    if (!known) {
      known = { line: Polyline.fromFlat(xy), digest: lineDigest(xy) };
      lines?.set(xy, known);
    }
    return known;
  };
  const inbound = lineOf(ask.inXY), crossing = lineOf(ask.crossXY), outbound = lineOf(ask.outXY);
  const frame = sweepFrame(joinedPath(inbound.line, crossing.line, outbound.line), ask.c0, ask.count);
  return {
    frame,
    frameLengthSq: frameLengthsOf(frame),
    lines: [inbound.digest, crossing.digest, outbound.digest],
    shape: shapeDigest(frame, ask.crossXY),
  };
}

/** Where two movements' centrelines first cross, with the arc position on each. */
export interface Crossing {
  readonly sA: number;
  readonly sB: number;
  readonly at: Vec2;
}

/** First intersection between two polylines, with arc positions on each (`conflictPoints.ts` keeps it with the pair). */
export function firstCrossing(a: readonly Vec2[], b: readonly Vec2[]): Crossing | null {
  let sA = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    const a0 = a[i] as Vec2;
    const a1 = a[i + 1] as Vec2;
    const segA = Math.hypot(a1.x - a0.x, a1.y - a0.y);

    let sB = 0;
    for (let j = 0; j + 1 < b.length; j++) {
      const b0 = b[j] as Vec2;
      const b1 = b[j + 1] as Vec2;
      const segB = Math.hypot(b1.x - b0.x, b1.y - b0.y);
      const hit = segSeg(a0, a1, b0, b1);
      if (hit) {
        return { sA: sA + hit.t * segA, sB: sB + hit.u * segB, at: hit.point };
      }
      sB += segB;
    }
    sA += segA;
  }
  return null;
}

/** A pair to finish somewhere else (`PairMeasurer.finishPairs`): its two centrelines' own point lists (`Polyline.xy`) and its table (`pairTable`). */
export interface FinishAsk {
  readonly a: Float64Array;
  readonly b: Float64Array;
  readonly table: Float64Array;
}

/** A pair finished (`finishPair`): where its centrelines first cross, and what the index makes of its zones. */
export interface FinishedPair {
  readonly crossing: Crossing | null;
  readonly facts: PairFacts;
}

/** Numbers in a pair's table (`pairTable`): 3 x 3 class pairs x [enterA, exitA, enterB, exitB]. */
export const TABLE_SIZE = 36;

/** A pair finished from its two centrelines' points and its table: `firstCrossing` and `pairFacts`, as the index works them out (`ConflictIndex.buildJunction`). */
export function finishPair(a: readonly Vec2[], b: readonly Vec2[], table: Float64Array): FinishedPair {
  return { crossing: firstCrossing(a, b), facts: pairFacts(zonesOf(table)) };
}

/** What `pairTable` reads of a movement's sweep (`conflictPoints.ts` `Sweep`), and the caches it keeps on it. */
export interface SweepSamples {
  /** First sampled centre arc position (negative: on the approach). */
  readonly c0: number;
  readonly count: number;
  /** The movement's own length (its crossing lanelet's): where a body's rear has left the box. */
  readonly length: number;
  /** Per sample: centre x, y and unit tangent x, y. */
  readonly frame: Float64Array;
  /** Squared tangent length per sample, shared by every pair using this sweep. */
  readonly frameLengthSq: Float64Array;
  /** A conservative bound around every sampled heavy-vehicle body. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Broad phase of the HEAVY rectangles (`boxesOf`), computed once. */
  boxes: SweepBoxes | null;
  /** Body classes that may stand at each sampled centre, computed once. */
  range: Uint8Array | null;
}

function boundsOf(s: SweepSamples): { minX: number; minY: number; maxX: number; maxY: number } {
  if (s.bounds) return s.bounds;
  const [hl, hw] = halfExtent(HEAVY);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < s.count; i++) {
    const x = s.frame[i * 4] as number, y = s.frame[i * 4 + 1] as number;
    const tx = s.frame[i * 4 + 2] as number, ty = s.frame[i * 4 + 3] as number;
    const ex = Math.abs(tx) * hl + Math.abs(ty) * hw;
    const ey = Math.abs(ty) * hl + Math.abs(tx) * hw;
    minX = Math.min(minX, x - ex); maxX = Math.max(maxX, x + ex);
    minY = Math.min(minY, y - ey); maxY = Math.max(maxY, y + ey);
  }
  return (s.bounds = { minX, minY, maxX, maxY });
}

/** A sweep's HEAVY rectangles bounded: per sample its half extents along x and y, and per `CHUNK` samples their box. */
interface SweepBoxes {
  readonly ext: Float64Array;
  /** Per chunk: min x, min y, max x, max y. */
  readonly chunks: Float64Array;
}

function boxesOf(s: SweepSamples): SweepBoxes {
  if (s.boxes) return s.boxes;
  const [hl, hw] = halfExtent(HEAVY);
  const ext = new Float64Array(s.count * 2);
  const chunks = new Float64Array(Math.ceil(s.count / CHUNK) * 4);
  for (let i = 0; i < s.count; i++) {
    const x = s.frame[i * 4] as number, y = s.frame[i * 4 + 1] as number;
    const tx = s.frame[i * 4 + 2] as number, ty = s.frame[i * 4 + 3] as number;
    const ex = Math.abs(tx) * hl + Math.abs(ty) * hw;
    const ey = Math.abs(ty) * hl + Math.abs(tx) * hw;
    ext[i * 2] = ex;
    ext[i * 2 + 1] = ey;
    const c = Math.floor(i / CHUNK) * 4;
    if (i % CHUNK === 0) {
      chunks[c] = x - ex; chunks[c + 1] = y - ey; chunks[c + 2] = x + ex; chunks[c + 3] = y + ey;
    } else {
      chunks[c] = Math.min(chunks[c]!, x - ex); chunks[c + 1] = Math.min(chunks[c + 1]!, y - ey);
      chunks[c + 2] = Math.max(chunks[c + 2]!, x + ex); chunks[c + 3] = Math.max(chunks[c + 3]!, y + ey);
    }
  }
  return (s.boxes = { ext, chunks });
}

/** Half length and half width of each class's swept rectangle, built once. */
const HALF_EXTENT: readonly (readonly [number, number])[] = BODY_CLASSES.map((cls) => {
  const e = BODY_ENVELOPE[cls] as { length: number; width: number };
  return [e.length / 2 + SWEEP_STEP / 2 + SWEEP_MARGIN, e.width / 2 + SWEEP_MARGIN] as const;
});

/** Per class pair (`ca * 3 + cb`), the squared centre distance past which two bodies' circumscribed circles are apart, with `BOX_SLACK`. */
const APART_SQ: readonly number[] = BODY_CLASSES.flatMap((ca) => BODY_CLASSES.map((cb) => {
  const r = Math.hypot(...(HALF_EXTENT[ca] as readonly [number, number])) + Math.hypot(...(HALF_EXTENT[cb] as readonly [number, number])) + BOX_SLACK;
  return r * r;
}));

function halfExtent(cls: BodyClass): readonly [number, number] {
  return HALF_EXTENT[cls] as readonly [number, number];
}

/** Whether sample `i` is a legal centre for a body of this class. */
/** Whether a sample is a place a body of this class can be on the movement. */
function inRange(s: SweepSamples, i: number, cls: BodyClass): boolean {
  const half = (BODY_ENVELOPE[cls] as { length: number }).length / 2;
  const c = s.c0 + i * SWEEP_STEP;
  return c >= s.c0 - 1e-9 && c <= s.length + half + 1e-9;
}

function rangeOf(s: SweepSamples): Uint8Array {
  if (s.range) return s.range;
  const range = new Uint8Array(s.count);
  for (let i = 0; i < s.count; i++) {
    let mask = 0;
    for (const cls of BODY_CLASSES) if (inRange(s, i, cls)) mask |= 1 << cls;
    range[i] = mask;
  }
  return (s.range = range);
}

function overlap(
  a: SweepSamples, i: number, ca: BodyClass,
  b: SweepSamples, j: number, cb: BodyClass,
): boolean {
  const [ahl, ahw] = halfExtent(ca);
  const [bhl, bhw] = halfExtent(cb);
  const ax = a.frame[i * 4] as number, ay = a.frame[i * 4 + 1] as number;
  const aux = a.frame[i * 4 + 2] as number, auy = a.frame[i * 4 + 3] as number;
  const bx = b.frame[j * 4] as number, by = b.frame[j * 4 + 1] as number;
  const bux = b.frame[j * 4 + 2] as number, buy = b.frame[j * 4 + 3] as number;
  const dx = bx - ax, dy = by - ay;
  // The four SAT axes are the two bodies' own frames.
  const dot = aux * bux + auy * buy;
  const cross = aux * buy - auy * bux;
  const along = Math.abs(dot), across = Math.abs(cross);
  const aLength = a.frameLengthSq[i]!;
  const bLength = b.frameLengthSq[j]!;
  return Math.abs(dx * aux + dy * auy) < ahl * aLength + (bhl * along + bhw * across)
    && Math.abs(-dx * auy + dy * aux) < ahw * aLength + (bhl * across + bhw * along)
    && Math.abs(dx * bux + dy * buy) < (ahl * along + ahw * across) + bhl * bLength
    && Math.abs(-dx * buy + dy * bux) < (ahl * across + ahw * along) + bhw * bLength;
}

/** The 3 x 3 class pairs' [enterA, exitA, enterB, exitB] (NaN: none), or null when even two heavy bodies never touch. */
export function pairTable(a: SweepSamples, b: SweepSamples): Float64Array | null {
  const aa = boundsOf(a), bb = boundsOf(b);
  if (aa.maxX < bb.minX || bb.maxX < aa.minX || aa.maxY < bb.minY || bb.maxY < aa.minY) return null;
  // DO NOT go back to a grid of cells: a map per sweep and every sample's cells looked up, most of a city's build (2026-10-16).
  // Heavy against heavy: the boxes of consecutive samples that meet, then the samples in them whose boxes meet.
  const A = boxesOf(a), B = boxesOf(b);
  const chunksA = A.chunks, chunksB = B.chunks, extA = A.ext, extB = B.ext;
  const rangeA = rangeOf(a), rangeB = rangeOf(b);
  // 3 x 3 class pairs x [enterA, exitA, enterB, exitB]; NaN = no overlap. Made at the first heavy hit.
  let table: Float64Array | null = null;
  // The four SAT axes and their body projections are identical for all nine class pairs at a sampled pose pair.
  const projection = new Float64Array(20);
  for (let p = 0; p < chunksA.length; p += 4) {
    const pMinX = chunksA[p]! - BOX_SLACK, pMinY = chunksA[p + 1]! - BOX_SLACK, pMaxX = chunksA[p + 2]! + BOX_SLACK, pMaxY = chunksA[p + 3]! + BOX_SLACK;
    for (let q = 0; q < chunksB.length; q += 4) {
      const qMinX = chunksB[q]!, qMinY = chunksB[q + 1]!, qMaxX = chunksB[q + 2]!, qMaxY = chunksB[q + 3]!;
      if (pMaxX < qMinX || qMaxX < pMinX || pMaxY < qMinY || qMaxY < pMinY) continue;
      const i1 = Math.min(a.count, (p / 4 + 1) * CHUNK), j0 = (q / 4) * CHUNK, j1 = Math.min(b.count, j0 + CHUNK);
      for (let i = (p / 4) * CHUNK; i < i1; i++) {
        const x = a.frame[i * 4] as number, y = a.frame[i * 4 + 1] as number;
        const ex = extA[i * 2]! + BOX_SLACK, ey = extA[i * 2 + 1]! + BOX_SLACK;
        if (x + ex < qMinX || qMaxX < x - ex || y + ey < qMinY || qMaxY < y - ey) continue;
        for (let j = j0; j < j1; j++) {
          if (Math.abs((b.frame[j * 4] as number) - x) > ex + extB[j * 2]! || Math.abs((b.frame[j * 4 + 1] as number) - y) > ey + extB[j * 2 + 1]!) continue;
          if (!overlap(a, i, HEAVY, b, j, HEAVY)) continue;
          table ??= new Float64Array(TABLE_SIZE).fill(Number.NaN);
          classesAt(a, i, b, j, rangeA[i]!, rangeB[j]!, table, projection);
        }
      }
    }
  }
  return table;
}

/** At a pose pair whose heavy bodies meet, the class pairs that meet too, widened into the table. */
function classesAt(a: SweepSamples, i: number, b: SweepSamples, j: number, eligibleA: number, eligibleB: number, table: Float64Array, projection: Float64Array): void {
  const cA = a.c0 + i * SWEEP_STEP;
  const cB = b.c0 + j * SWEEP_STEP;
  let projected = false;
  const dx = (b.frame[j * 4] as number) - (a.frame[i * 4] as number), dy = (b.frame[j * 4 + 1] as number) - (a.frame[i * 4 + 1] as number);
  const distanceSq = dx * dx + dy * dy;
  // Class pairs found apart at this pose pair (bit `ca * 3 + cb`): smaller bodies of both are apart too (`HALF_EXTENT` nests).
  let apart = 0;
  for (let ca = HEAVY; ca >= 0; ca--) {
    if (!(eligibleA & (1 << ca))) continue;
    const [ahl, ahw] = halfExtent(ca as BodyClass);
    for (let cb = HEAVY; cb >= 0; cb--) {
      if (!(eligibleB & (1 << cb))) continue;
      const at = (ca * 3 + cb) * 4;
      // DO NOT test a pose pair that cannot widen the table: only each class pair's first and last positions are kept.
      if (cA >= table[at]! && cA <= table[at + 1]! && cB >= table[at + 2]! && cB <= table[at + 3]!) continue;
      if (ca !== HEAVY || cb !== HEAVY) {
        if (apart & (1 << (ca * 3 + cb))) continue;
        // Their circles apart: the SAT below would find them apart too, on a margin far above its rounding.
        if (distanceSq > APART_SQ[ca * 3 + cb]!) {
          for (let x = 0; x <= ca; x++) for (let y = 0; y <= cb; y++) apart |= 1 << (x * 3 + y);
          continue;
        }
        if (!projected) {
          projected = true;
          projectAxes(a, i, b, j, projection);
        }
        const [bhl, bhw] = halfExtent(cb as BodyClass);
        let separate = false;
        for (let axis = 0; axis < 4; axis++) {
          const p = axis * 5;
          const ra = ahl * (projection[p + 1] as number) + ahw * (projection[p + 2] as number);
          const rb = bhl * (projection[p + 3] as number) + bhw * (projection[p + 4] as number);
          if ((projection[p] as number) >= ra + rb) { separate = true; break; }
        }
        if (separate) {
          for (let x = 0; x <= ca; x++) for (let y = 0; y <= cb; y++) apart |= 1 << (x * 3 + y);
          continue;
        }
      }
      widen(table, at, cA);
      widen(table, at + 2, cB);
    }
  }
}

/** The four SAT axes of two sampled bodies (their own frames) and, on each, the centres' distance and the four half-axis projections. */
function projectAxes(a: SweepSamples, i: number, b: SweepSamples, j: number, projection: Float64Array): void {
  const ax = a.frame[i * 4] as number, ay = a.frame[i * 4 + 1] as number;
  const aux = a.frame[i * 4 + 2] as number, auy = a.frame[i * 4 + 3] as number;
  const bx = b.frame[j * 4] as number, by = b.frame[j * 4 + 1] as number;
  const bux = b.frame[j * 4 + 2] as number, buy = b.frame[j * 4 + 3] as number;
  const dx = bx - ax, dy = by - ay;
  for (let axis = 0; axis < 4; axis++) {
    const nx = axis === 0 ? aux : axis === 1 ? -auy : axis === 2 ? bux : -buy;
    const ny = axis === 0 ? auy : axis === 1 ? aux : axis === 2 ? buy : bux;
    const at = axis * 5;
    projection[at] = Math.abs(dx * nx + dy * ny);
    projection[at + 1] = Math.abs(aux * nx + auy * ny);
    projection[at + 2] = Math.abs(-auy * nx + aux * ny);
    projection[at + 3] = Math.abs(bux * nx + buy * ny);
    projection[at + 4] = Math.abs(-buy * nx + bux * ny);
  }
}

function widen(table: Float64Array, at: number, c: number): void {
  const lo = table[at] as number;
  const hi = table[at + 1] as number;
  table[at] = Number.isNaN(lo) ? c : Math.min(lo, c);
  table[at + 1] = Number.isNaN(hi) ? c : Math.max(hi, c);
}

// ------------------------------------------------------------------ junctions

/** DO NOT define them in `junctionBuild.ts` */

/** How a movement turns (`junctionBuild.ts` `classifyTurn`). */
export type TurnKind = 'through' | 'left' | 'right' | 'uturn';

/** What a junction reads of its node. */
export type JunctionNode = Pick<RoadNode, 'id' | 'x' | 'y' | 'incident' | 'control' | 'crossing' | 'blockedMovements' | 'laneLinks' | 'uturn' | 'end'>;

/** A road meeting the junction: what the junction reads of it, and its two ends (its centreline, `segmentLine`). */
export interface JunctionLeg {
  readonly segment: Pick<RoadSegment, 'id' | 'a' | 'b' | 'curve' | 'type' | 'lanes' | 'direction' | 'section' | 'parking'>;
  readonly from: Vec2;
  readonly to: Vec2;
}

/** A link lane arriving at or leaving a junction (`LaneletGraph.buildSegmentLinks`), as a worker is sent it: its centre as its own point list (`Polyline.xy`). */
export interface LaneAsk {
  readonly id: string;
  /** The key it was built under: the junction's own key is made of its lanes' (`junctionBuild.ts` `junctionKey`). */
  readonly key: string;
  readonly segment: SegmentId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly laneIndex: number;
  readonly speedLimit: number;
  readonly centre: Float64Array;
  /** Whether its `from`, and its `to`, is a road's end (`RoadDoc.mapEdge`), where traffic comes into the map or leaves it. */
  readonly fromEdge: boolean;
  readonly toEdge: boolean;
}

/** One junction of a whole build, as a worker builds it (`buildJunctionOf`) */
export interface JunctionAsk {
  readonly node: JunctionNode;
  readonly legs: readonly JunctionLeg[];
  readonly inbound: readonly LaneAsk[];
  readonly outbound: readonly LaneAsk[];
  readonly surface: { readonly centre: Vec2; readonly parts: readonly (Float64Array | { readonly full: Float64Array; readonly half: number; readonly mouth: number })[] };
  readonly before: readonly (readonly [string, ChosenTurn])[] | null;
}

/** A junction a worker built (`buildJunctionOf`): its key, groups and control, each movement with its path's points, the turns it kept. */
export interface JunctionAnswer {
  readonly key: string;
  readonly groups: readonly ApproachGroup[];
  readonly signalised: boolean;
  readonly connectors: readonly {
    readonly from: number; readonly to: number; readonly turn: TurnKind; readonly carried: boolean; readonly group: number;
    readonly speedLimit: number; readonly maxBodyClass: BodyClass | -1; readonly path: Float64Array;
  }[];
  readonly turns: readonly (readonly [string, ChosenTurn])[];
}

/** Builds a whole build's junctions somewhere else - the browser's workers (`conflictPool.ts`) */
export interface JunctionMeasurer {
  buildJunctions?(asks: readonly JunctionAsk[]): Promise<readonly JunctionAnswer[]>;
}

/** Measures many pairs' tables somewhere else - the browser's workers (`conflictPool.ts`) */
export interface PairMeasurer extends CornerMeasurer, JunctionMeasurer {
  /** `key`: the pair's key, under which a measurer that `keeps` stores its table for the next session. */
  measure(pairs: readonly { readonly a: SweepSamples; readonly b: SweepSamples; readonly key?: string }[]): Promise<readonly (Float64Array | null)[]>;
  /** DO NOT keep them from the page: the structured clone of a city's tables in one write held a frame 0.9 s (2026-10-15). */
  readonly keeps?: boolean;
  /** Chooses many junction turns somewhere else, each as `turnPaths.ts` `chooseTurnOf` would here */
  chooseTurns?(asks: readonly TurnAsk[], surfaces: ReadonlyMap<string, SurfaceRings>): Promise<readonly ChosenTurn[]>;
  /** Samples many movements' sweeps somewhere else, each as `sampleSweep` would here, answered in the order asked */
  sampleSweeps?(asks: readonly SweepAsk[]): Promise<readonly SampledSweep[]>;
  /** Finishes many pairs somewhere else, each as `finishPair` would here - where the two movements' centrelines first cross */
  finishPairs?(pairs: readonly FinishAsk[]): Promise<readonly FinishedPair[]>;
}

// ------------------------------------------------------------------ zones

/** `cross`: the two centrelines intersect. */
export type ConflictKind = 'cross' | 'merge' | 'swept';

/** Centre-arc interval over which a body of one class on one movement overlaps the swept area of a body of another class on */
export interface Zone {
  readonly enter: number;
  readonly exit: number;
}

/** A connector's id (`lanelets.ts` `ConnectorId`), named here without importing the graph. */
type ConnectorId = string;

export interface ConflictRef {
  readonly point: number;
  /** Earliest front arc position of the zone, for ordering. */
  readonly s: number;
  readonly other: ConnectorId;
  readonly kind: ConflictKind;
  /** Body-centre arc position past which a vehicle of each class has cleared the zone against ANY vehicle on the other */
  readonly exit: readonly number[];
}

/** Two movements out of the same lane: resolved by car-following, not claims. */
export interface Diverge {
  readonly other: ConnectorId;
  /** Centre arc past which a body of class `mine` on the OTHER movement is clear of `theirs` on this one. */
  otherExit(mine: BodyClass, theirs: BodyClass): number;
}

/** A pair of movements' zones as the conflict index reads them (`conflictPoints.ts` `ConflictIndex`), over the pair's table. */
export interface PairZones {
  /** Zone on `a` (`onB` false) or on `b` (true) for body `mine` against `theirs`. */
  get(mine: BodyClass, theirs: BodyClass, onB: boolean): Zone | null;
}

/** A pair's zones over its table (`pairTable`): what is kept between sessions. */
export function zonesOf(table: Float64Array): PairZones {
  return {
    get(mine, theirs, onB) {
      const at = onB ? (theirs * 3 + mine) * 4 + 2 : (mine * 3 + theirs) * 4;
      const enter = table[at] as number;
      if (Number.isNaN(enter)) return null;
      // Half a step either side covers the motion between two samples.
      return { enter: enter - SWEEP_STEP / 2, exit: (table[at + 1] as number) + SWEEP_STEP / 2 };
    },
  };
}

/** DO NOT work them out again for each build */
export interface PairFacts {
  readonly sA: number;
  readonly sB: number;
  /** Per class, the centre past which the body on `a` (`exitA`) or `b` is clear of any other body. Never changed. */
  readonly exitA: readonly number[];
  readonly exitB: readonly number[];
  /** The intrusions in the order `recordIntrusions` finds them: whose (`onB`) and the two classes. */
  readonly intrusions: readonly { readonly onB: boolean; readonly mine: BodyClass; readonly theirs: BodyClass }[];
}

export function pairFacts(zones: PairZones): PairFacts {
  const intrusions: { onB: boolean; mine: BodyClass; theirs: BodyClass }[] = [];
  for (const mine of BODY_CLASSES) {
    for (const theirs of BODY_CLASSES) {
      const onA = zones.get(mine, theirs, false);
      if (onA && onA.enter + (BODY_ENVELOPE[mine]?.length ?? 0) / 2 <= 0) intrusions.push({ onB: false, mine, theirs });
      const onB = zones.get(theirs, mine, true);
      if (onB && onB.enter + (BODY_ENVELOPE[theirs]?.length ?? 0) / 2 <= 0) intrusions.push({ onB: true, mine: theirs, theirs: mine });
    }
  }
  return { sA: earliestFront(zones, false), sB: earliestFront(zones, true), exitA: clearExits(zones, false), exitB: clearExits(zones, true), intrusions };
}

/** Earliest body-FRONT arc position at which any class enters the zone. */
function earliestFront(zones: PairZones, onB: boolean): number {
  let best = Infinity;
  for (const mine of BODY_CLASSES) {
    const z = zones.get(mine, HEAVY, onB);
    const half = (BODY_ENVELOPE[mine] as { length: number }).length / 2;
    if (z) best = Math.min(best, z.enter + half);
  }
  return best;
}

/** Per class, the centre past which the body is clear of any other body. */
function clearExits(zones: PairZones, onB: boolean): number[] {
  return BODY_CLASSES.map((mine) => {
    let exit = -Infinity;
    for (const theirs of BODY_CLASSES) {
      const z = zones.get(mine, theirs, onB);
      if (z) exit = Math.max(exit, z.exit);
    }
    return exit;
  });
}

export function pushDiverge(
  map: Map<ConnectorId, Diverge[]>,
  self: ConnectorId,
  other: ConnectorId,
  zones: PairZones,
  selfIsB: boolean,
): void {
  const entry: Diverge = {
    other,
    otherExit: (mine, theirs) => zones.get(mine, theirs, !selfIsB)?.exit ?? -Infinity,
  };
  const list = map.get(self);
  if (list) list.push(entry);
  else map.set(self, [entry]);
}

export function pushRef(
  map: Map<ConnectorId, ConflictRef[]>,
  key: ConnectorId,
  ref: ConflictRef,
): void {
  const list = map.get(key);
  if (list) list.push(ref);
  else map.set(key, [ref]);
}
