import type { Vec2 } from '@core/vec2';
import { COARSE_EPS } from '@core/scalar';
import type { RoadDoc, RoadSegment } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { FLAT_GROUND, type RoadElevation, buildRoadElevation } from '@world/elevation';
import { Level, halfWidth } from '@world/roadTypes';
import { roadStructure } from '@world/structures';
import { ROAD_TUNING } from '@world/roads/tuning';
import { roadsBefore, settleRoadEdit } from './roads/economy';
import { m } from '@world/units';
import { ribbonsNear } from './snap';

/** What a road edit may not leave behind, judged on the network it builds. */
export type RoadEditRefusal = 'sharp' | 'squeezed' | 'overlap' | 'steep' | 'funds';

export interface RoadState {
  readonly doc: RoadDoc;
  /** Built for `doc` (`revision` current). */
  readonly net: Network;
}

/** A node's smallest leg gap may shrink this much before it counts as made sharper */
const GAP_NOISE = COARSE_EPS;
/** A squeeze may deepen this much (0.4 m) before it counts as made worse. */
const SQUEEZE_SLACK = m(0.4);
/** The steepest grade a road is refused beyond: Baldwin Street, Dunedin, the steepest street in the world at 34.8 % */
const MAX_BUILT_GRADE = ROAD_TUNING.grade.refuse;
/** Vertical room for one road to pass over another */
const PASS_CLEARANCE = ROAD_TUNING.clearance.elevated;
/** Two decks within this height of each other are at one level (`commit.ts` `HEIGHT_JOIN_EPS`). */
const SAME_LEVEL = m(0.3);
/** Spacing of the samples along a changed road (0.8 m). */
const SAMPLE_STEP = m(0.8);
/** Overlap shallower than this is a kerb grazing a kerb, not a road on a road (0.2 m). */
const OVERLAP_SLACK = m(0.2);
/** A point within this of an old centreline lay on that road before the edit. */
const SAME_PLACE = 1;

/** The reason to refuse turning `before` into `after`, or null when the edit may stand. */
export function refuseRoadEdit(before: RoadState, after: RoadState): RoadEditRefusal | null {
  for (const [node, gap] of after.net.impossible) {
    const was = before.doc.node(node) ? before.net.impossible.get(node) : undefined;
    if (was === undefined || gap < was - GAP_NOISE) return 'sharp';
  }
  for (const [node, short] of after.net.squeezed) {
    const was = before.doc.node(node) ? before.net.squeezed.get(node) : undefined;
    if (was === undefined || short > was + SQUEEZE_SLACK) return 'squeezed';
  }
  const changed = changedSegments(before.doc, after.doc);
  if (!changed.length) return null;
  if (tooSteep(before, after, changed)) return 'steep';
  // The decks as the game solves them, over flat land (two roads at one map point stand on the same ground, so it cancels)
  let solved: RoadElevation | null = null;
  const deck = (id: SegmentId, p: Vec2): number =>
    (solved ??= buildRoadElevation(after.net, FLAT_GROUND)).onSegment(id, p.x, p.y);
  if (changed.some((id) => overlapsAnother(before, after, id, deck))) return 'overlap';
  return null;
}

/** A copy of the roads as they stand, to judge an edit made in place against (`refuseRoadEdit`). */
function snapshotRoads(doc: RoadDoc, net: Network): RoadState {
  const copy = doc.clone();
  const copyNet = new Network(copy);
  if (net.revision === doc.revision) copyNet.adopt(net);
  else copyNet.rebuild();
  return { doc: copy, net: copyNet };
}

/** Runs an edit made in place on the live roads */
export function guardRoadEdit(doc: RoadDoc, net: Network, edit: () => boolean):
  { readonly changed: boolean; readonly refused: RoadEditRefusal | null } {
  const before = snapshotRoads(doc, net);
  const money = roadsBefore(doc);
  if (!edit()) return { changed: false, refused: null };
  if (net.revision !== doc.revision) net.rebuild();
  // Judged, then paid for (`editor/roads/economy.ts`): an edit the balance cannot cover is refused like any other.
  const refused = refuseRoadEdit(before, { doc, net }) ?? (settleRoadEdit(money, doc).affordable ? null : 'funds');
  if (!refused) return { changed: true, refused: null };
  doc.replaceWith(before.doc);
  net.adopt(before.net);
  return { changed: false, refused };
}

/** Segments of `after` that are new, or whose shape, class, structure or end points changed. */
function changedSegments(before: RoadDoc, after: RoadDoc): SegmentId[] {
  const out: SegmentId[] = [];
  // DO NOT walk every road of the map and write each one out twice as text for every edit and every pause of the pointer
  const named = after.roadIdsChangedFrom(before);
  if (named) {
    const candidates = new Set<SegmentId>();
    for (const id of named) {
      if (after.segment(id as SegmentId)) candidates.add(id as SegmentId);
      for (const sid of after.node(id as NodeId)?.incident ?? []) candidates.add(sid);
    }
    for (const id of candidates) {
      const seg = after.segment(id)!, old = before.segment(id);
      if (!old || segmentKey(before, old) !== segmentKey(after, seg)) out.push(id);
    }
    return out;
  }
  for (const [id, seg] of after.segments) {
    const old = before.segment(id);
    if (!old || segmentKey(before, old) !== segmentKey(after, seg)) out.push(id);
  }
  return out;
}

function segmentKey(doc: RoadDoc, seg: RoadSegment): string {
  const a = doc.node(seg.a);
  const b = doc.node(seg.b);
  return JSON.stringify([seg.a, seg.b, seg.type, seg.lanes, seg.direction, seg.structure, seg.curve, seg.section ?? null,
    seg.parking ?? null, a?.x, a?.y, a?.heightOffset, b?.x, b?.y, b?.heightOffset]);
}

/** The deck's authored height along a segment at arc length `s` (as `commit.ts` `segmentOffsetAt`). */
function deckAt(doc: RoadDoc, seg: RoadSegment, s: number, length: number): number {
  const t = Math.max(0, Math.min(1, s / Math.max(1e-6, length)));
  const a = doc.node(seg.a)?.heightOffset ?? 0;
  const b = doc.node(seg.b)?.heightOffset ?? 0;
  return a + (b - a) * t + roadStructure(seg.structure).clearance;
}

/** Spacing of the deck samples a grade is read from, and the run it is measured over (0.4 m). */
const GRADE_STEP = m(0.4);
const GRADE_RUN = 2;

/** The steepest grade of a segment's deck as the game solves it (rise over run, over `GRADE_RUN`) */
function grade(state: RoadState, id: SegmentId, solved: () => RoadElevation): number {
  const { doc, net } = state;
  const seg = doc.segment(id);
  if (!seg) return 0;
  const length = net.polylines.get(doc, id).length;
  // Level ends: no ramp to measure (and no profile to solve for it).
  if (Math.abs(deckAt(doc, seg, length, length) - deckAt(doc, seg, 0, length)) < SAME_LEVEL) return 0;
  const line = net.ribbons.get(id)?.full;
  if (!line) return 0;
  const elevation = solved();
  const heights: number[] = [];
  for (let s = 0; s <= line.length; s += GRADE_STEP) {
    const p = line.sampleAt(Math.min(s, line.length)).p;
    heights.push(elevation.onSegment(id, p.x, p.y));
  }
  const span = Math.max(1, Math.round(GRADE_RUN / GRADE_STEP));
  let steepest = 0;
  for (let i = span; i < heights.length; i++) {
    const rise = Math.abs((heights[i] as number) - (heights[i - span] as number));
    if (Number.isFinite(rise)) steepest = Math.max(steepest, rise / (span * GRADE_STEP));
  }
  return steepest;
}

/** Whether the edit leaves a ramp steeper than any street, on a road it laid or on one meeting it */
function tooSteep(before: RoadState, after: RoadState, changed: readonly SegmentId[]): boolean {
  const touched = new Set<SegmentId>(changed);
  for (const id of changed) {
    const seg = after.doc.segment(id);
    for (const node of seg ? [seg.a, seg.b] : []) {
      for (const other of after.doc.node(node)?.incident ?? []) touched.add(other);
    }
  }
  // Solved over flat land, once per state and only when a ramp asks for it
  let solvedAfter: RoadElevation | null = null;
  let solvedBefore: RoadElevation | null = null;
  const afterElevation = (): RoadElevation => (solvedAfter ??= buildRoadElevation(after.net, FLAT_GROUND));
  const beforeElevation = (): RoadElevation => (solvedBefore ??= buildRoadElevation(before.net, FLAT_GROUND));
  for (const id of touched) {
    const now = grade(after, id, afterElevation);
    if (now <= MAX_BUILT_GRADE) continue;
    if (!changed.includes(id) && before.doc.segment(id) && grade(before, id, beforeElevation) >= now - 1e-6) continue;
    return true;
  }
  return false;
}

/** Whether a changed segment's roadway lies on another road's carriageway */
function overlapsAnother(before: RoadState, after: RoadState, id: SegmentId,
  deck: (id: SegmentId, p: Vec2) => number): boolean {
  const { doc, net } = after;
  const seg = doc.segment(id);
  const ribbon = net.ribbons.get(id);
  if (!seg || !ribbon) return false;
  const line = ribbon.full;
  const length = line.length;
  const trims = net.trims.get(id);
  const from = (trims?.a[Level.Casing] ?? 0) + SAMPLE_STEP / 2;
  const to = length - (trims?.b[Level.Casing] ?? 0) - SAMPLE_STEP / 2;
  if (to <= from) return false;

  // DO NOT walk `doc.segments` here: each changed road of every edit and dry run read every road of the map.
  const box = line.bbox;
  const grow = halfWidth(ribbon.road, Level.Sidewalk);
  const others: { id: SegmentId; seg: RoadSegment; limit: number }[] = [];
  for (const near of ribbonsNear(net, [box.minX - grow, box.minY - grow, box.maxX + grow, box.maxY + grow])) {
    const otherId = near.id;
    const other = doc.segment(otherId);
    if (otherId === id || !other) continue;
    const ob = net.ribbons.get(otherId)?.full.bbox;
    const limit = overlapReach(net, id, otherId);
    if (!ob || ob.minX > box.maxX + limit || ob.maxX < box.minX - limit ||
      ob.minY > box.maxY + limit || ob.maxY < box.minY - limit) continue;
    others.push({ id: otherId, seg: other, limit });
  }
  if (!others.length) return false;

  const steps = Math.max(1, Math.ceil((to - from) / SAMPLE_STEP));
  for (let k = 0; k <= steps; k++) {
    const s = from + ((to - from) * k) / steps;
    const p = line.sampleAt(s).p;
    const height = deckAt(doc, seg, s, length);
    for (const { id: otherId, seg: other, limit } of others) {
      const otherLine = net.ribbons.get(otherId)?.full;
      if (!otherLine) continue;
      const ob = otherLine.bbox;
      if (p.x < ob.minX - limit || p.x > ob.maxX + limit || p.y < ob.minY - limit || p.y > ob.maxY + limit) continue;
      const hit = otherLine.closestPoint(p);
      if (hit.distance >= limit) continue;
      if (withinSharedPlate(after, seg, other, otherId, hit.s, otherLine.length)) continue;
      if (Math.abs(deck(id, p) - deck(otherId, hit.point)) >= PASS_CLEARANCE) continue;
      if (overlappedBefore(before, p, height, hit.point, deckAt(doc, other, hit.s, otherLine.length))) continue;
      return true;
    }
  }
  return false;
}

/** The other road's closest point lies on its own junction plate at a node the two share. */
function withinSharedPlate(after: RoadState, seg: RoadSegment, other: RoadSegment, otherId: SegmentId, s: number, length: number): boolean {
  const trims = after.net.trims.get(otherId);
  const shares = (node: number): boolean => node === seg.a || node === seg.b;
  if (shares(other.a) && s <= (trims?.a[Level.Casing] ?? 0) + SAMPLE_STEP) return true;
  if (shares(other.b) && s >= length - (trims?.b[Level.Casing] ?? 0) - SAMPLE_STEP) return true;
  return false;
}

/** The same two places already overlapped before the edit */
function overlappedBefore(before: RoadState, p: Vec2, ph: number, q: Vec2, qh: number): boolean {
  const onP = segmentsThrough(before, p, ph);
  if (!onP.length) return false;
  const gap = Math.hypot(q.x - p.x, q.y - p.y);
  for (const y of segmentsThrough(before, q, qh)) {
    for (const x of onP) {
      if (x !== y && gap < overlapReach(before.net, x, y)) return true;
    }
  }
  return false;
}

/** How close two roads' centrelines may come before one's carriageway lies on the other's carriageway or footway. */
function overlapReach(net: Network, a: SegmentId, b: SegmentId): number {
  const ra = net.ribbons.get(a)?.road;
  const rb = net.ribbons.get(b)?.road;
  if (!ra || !rb) return 0;
  return Math.max(halfWidth(ra, Level.Asphalt) + halfWidth(rb, Level.Sidewalk),
    halfWidth(ra, Level.Sidewalk) + halfWidth(rb, Level.Asphalt)) - OVERLAP_SLACK;
}

/** DO NOT walk `state.doc.segments`: this runs for every sample of every changed road. */
function segmentsThrough(state: RoadState, p: Vec2, height: number): SegmentId[] {
  const out: SegmentId[] = [];
  for (const { id } of ribbonsNear(state.net, [p.x - SAME_PLACE, p.y - SAME_PLACE, p.x + SAME_PLACE, p.y + SAME_PLACE])) {
    const seg = state.doc.segment(id);
    if (!seg) continue;
    const line = state.net.polylines.get(state.doc, id);
    const box = line.bbox;
    if (p.x < box.minX - SAME_PLACE || p.x > box.maxX + SAME_PLACE || p.y < box.minY - SAME_PLACE || p.y > box.maxY + SAME_PLACE) continue;
    const hit = line.closestPoint(p);
    if (hit.distance > SAME_PLACE) continue;
    if (Math.abs(deckAt(state.doc, seg, hit.s, line.length) - height) > SAME_LEVEL) continue;
    out.push(id);
  }
  return out;
}
