import { flipParking, sameParking, type SegmentParking } from '@world/parking';
import {
  controlPoint,
  flattenSegment,
  shapeFromControl,
  splitQuad,
  type CurveShape,
} from '@core/bezier';
import { segSeg } from '@core/intersect';
import { Polyline } from '@core/polyline';
import { type Vec2, dist } from '@core/vec2';
import { type RoadDoc, type RoadSegment, fitRoadCurve, sameStamps } from '@world/doc';
import { Network } from '@world/network';
import { type NodeId, type SegmentId, asSegmentId } from '@world/ids';
import { MIN_LINK_LENGTH } from '@world/approach';
import { MAX_AUTHORED_GRADE, type RoadElevation, buildRoadElevation } from '@world/elevation';
import { TerrainIndex, sampleTerrainHeight } from '@world/terrain';
import { m, stepsIn } from '@world/units';
import { ROAD_TUNING } from '@world/roads/tuning';
import { type RoadStation, orderAlong, stationsAlong } from '@world/roads/buildMode';
import { flipSection, sameRoadSectionIgnoringArrows, sectionForPiece } from '@world/roadSection';
import { ROAD_TYPES } from '@world/roadTypes';
import { roadStructure, type RoadStructure } from '@world/structures';
import { type Anchor, ribbonsNear } from './snap';
import type { RoadPathPiece } from './roadPath';
import { type RoadEditRefusal, refuseRoadEdit } from './editRules';
import { roadsBefore, settleRoadEdit } from './roads/economy';
import { COARSE_EPS, EPS } from '@core/scalar';

/** Shortest road the editor will create. */
const MIN_DRAFT_LENGTH = m(9.6);
/** Two nodes closer than this are the same node. */
const MERGE_EPS = m(1.04);
/** Distinct decks at the same map point remain separate networks. */
const HEIGHT_JOIN_EPS = m(0.3);
/** Vertical room required before two crossing carriageways can pass independently. */
const CROSSING_CLEARANCE = ROAD_TUNING.clearance.elevated;
/** Cover over a road at grade past which it is bored as a tunnel instead of cut */
const AUTO_TUNNEL_COVER = ROAD_TUNING.tunnel.autoCover;

export interface DraftResult {
  readonly committed: boolean;
  readonly reason?: 'tooShort' | 'duplicate' | 'degenerate' | 'clearance' | RoadEditRefusal;
  readonly heightLimited?: boolean;
  readonly finalHeightOffset?: number;
  /** The roads' heights solved for the tunnel test on the ground the renderer reads, when no tunnel was bored */
  readonly elevation?: RoadElevation;
  /** What the edit costs (`world/economy.ts`): money taken, negative when money comes back. */
  readonly cost?: number;
  /** A dry run's road as it would be built */
  readonly stations?: readonly RoadStation[];
}

/** Spacing of a dry run's stations (`DraftResult.stations`). */
export const STATION_STEP = m(2);

/** Commits one freehand gesture as one undoable, atomic road. */
export function commitRoadPath(
  doc: RoadDoc,
  net: Network,
  start: Anchor,
  end: Anchor,
  type: number,
  pieces: readonly RoadPathPiece[],
  /** Lanes for every segment laid, or null for the class's own profile. */
  lanes: number | null = null,
  /** Parking left and right of the drawing direction, for every segment laid. */
  parking?: SegmentParking,
  /** The ground as already sampled for the roads' heights (the renderer's natural terrain) */
  ground?: (x: number, y: number) => number,
  /** `dryRun`: everything is worked out and judged on the copy, and the live map is left alone */
  options: {
    readonly dryRun?: boolean;
    /** The roads' heights the game last solved on this same natural ground (`ground`) */
    readonly groundSolve?: RoadElevation | null;
  } = {},
): DraftResult {
  if (!pieces.length || !Number.isInteger(type) || type < 0 || type >= ROAD_TYPES.length) {
    return { committed: false, reason: 'degenerate' };
  }
  pieces = joinShortPieces(pieces);
  // Each step of a road drawn timed (`hitch:` entries).
  let lap = performance.now();
  const timed = (what: string): void => { const now = performance.now(); performance.measure(`hitch:commit/${what}`, { start: lap, end: now }); lap = now; };
  // DO NOT copy the map to judge against when the network is behind
  if (net.revision !== doc.revision) net.rebuild();
  const work = doc.fork();
  timed('fork');
  const workNet = net.fork(work);
  timed('network');
  let committed = false;
  let heightLimited = false;
  let currentHeight = pieces[0]?.start.heightOffset ?? 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as RoadPathPiece;
    if (!validPoint(piece.start.at) || !validPoint(piece.end.at) ||
      !Number.isFinite(piece.start.heightOffset) || !Number.isFinite(piece.end.heightOffset)) {
      return { committed: false, reason: 'degenerate' };
    }
    const from: Anchor = i === 0 ? start : { kind: 'free', at: piece.start.at };
    const to: Anchor = i === pieces.length - 1 ? end : { kind: 'free', at: piece.end.at };
    const shape = fitRoadCurve(piece.start.at, piece.end.at, piece.curve, type);
    const length = Polyline.fromPoints(flattenSegment(piece.start.at, piece.end.at, shape)).length;
    const rise = length * MAX_AUTHORED_GRADE;
    const nextHeight = Math.max(currentHeight - rise,
      Math.min(currentHeight + rise, piece.end.heightOffset));
    const limited = Math.abs(nextHeight - piece.end.heightOffset) > 1e-6;
    heightLimited ||= limited;
    if (i === pieces.length - 1 && end.kind !== 'free' && limited) {
      return { committed: false, reason: 'tooShort' };
    }
    const result = commitDraftInPlace(
      work, workNet, from, to, type, shape, 'ground',
      { start: currentHeight, end: nextHeight,
        smoothEnd: i < pieces.length - 1 },
      lanes,
      parking,
    );
    if (!result.committed && result.reason !== 'duplicate') return result;
    committed ||= result.committed;
    currentHeight = nextHeight;
    workNet.rebuild();
  }
  timed('pieces');
  if (!committed) return { committed: false, reason: 'duplicate' };
  const bore = boreDeepCuts(doc, work, workNet, ground, options.groundSolve ?? null);
  if (bore.bored) workNet.rebuild();
  timed('tunnels');
  // Judged on what it built, against the map as it was (`editRules.ts`).
  const refused = refuseRoadEdit({ doc, net }, { doc: work, net: workNet });
  timed('rules');
  if (refused) return { committed: false, reason: refused };
  // Paid for on the copy, so the live map takes the balance with the roads and undo gives it back
  const charge = settleRoadEdit(roadsBefore(doc), work, !options.dryRun);
  if (!charge.affordable) return { committed: false, reason: 'funds', cost: charge.amount };
  if (options.dryRun) {
    const stations = draftStations(doc, work, workNet, pieces, type, start.at, ground, bore, options.groundSolve ?? null);
    timed('stations');
    return { committed: true, heightLimited, finalHeightOffset: currentHeight, cost: charge.amount, stations };
  }
  doc.takeBack(work);
  net.takeBack(workNet);
  timed('replace');
  return { committed: true, heightLimited, finalHeightOffset: currentHeight, cost: charge.amount,
    ...(!bore.bored && ground && bore.elevation ? { elevation: bore.elevation } : {}) };
}

/** Turns the roads just laid at grade into tunnels wherever their profile would run deeper than `AUTO_TUNNEL_COVER` under */
/** The terrain's index as last built; a road edit does not move the land, so the next one reuses it. */
let terrainIndex: TerrainIndex | null = null;
function terrainIndexOf(doc: RoadDoc): TerrainIndex {
  if (!terrainIndex || terrainIndex.relief !== doc.terrainRelief || !sameStamps(terrainIndex.stamps, doc.terrainStamps)) {
    terrainIndex = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
  }
  return terrainIndex;
}

function boreDeepCuts(before: RoadDoc, work: RoadDoc, workNet: Network, sampled?: (x: number, y: number) => number,
  previous: RoadElevation | null = null): { bored: boolean; elevation: RoadElevation | null } {
  const fresh = segmentsNewIn(before, work).filter((seg) => seg.structure === 'ground');
  if (!fresh.length || !work.terrainStamps.length) return { bored: false, elevation: null };
  // A cut that deep needs relief under the new roads, and the land is flat outside the stamps (the test just above)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of fresh) {
    const box = workNet.ribbons.get(seg.id)?.full.bbox;
    if (!box) { minX = -Infinity; maxX = Infinity; minY = -Infinity; maxY = Infinity; break; }
    minX = Math.min(minX, box.minX); minY = Math.min(minY, box.minY); maxX = Math.max(maxX, box.maxX); maxY = Math.max(maxY, box.maxY);
  }
  const margin = m(60);
  const reached = work.terrainStamps.some((stamp) =>
    stamp.x + stamp.radius >= minX - margin && stamp.x - stamp.radius <= maxX + margin &&
    stamp.y + stamp.radius >= minY - margin && stamp.y - stamp.radius <= maxY + margin);
  if (!reached) return { bored: false, elevation: null };
  const index = sampled ? null : terrainIndexOf(work);
  const ground = sampled ?? ((x: number, y: number): number => sampleTerrainHeight(index!, x, y));
  // From the game's last solve on the same ground, when there is one
  const elevation = buildRoadElevation(workNet, ground, sampled ? previous : null);
  let changed = false;
  for (const seg of fresh) {
    const ribbon = workNet.ribbons.get(seg.id);
    if (!ribbon) continue;
    const length = ribbon.full.length;
    const steps = Math.max(2, Math.ceil(stepsIn(length, 3.2)));
    for (let i = 0; i <= steps; i++) {
      const p = ribbon.full.sampleAt((i / steps) * length).p;
      if (ground(p.x, p.y) - elevation.onSegment(seg.id, p.x, p.y) > AUTO_TUNNEL_COVER) {
        work.setSegmentStructure(seg.id, 'tunnel');
        changed = true;
        break;
      }
    }
  }
  return { bored: changed, elevation };
}

/** Where the segments' allocator stands in `RoadDoc.allocatorMarks`. */
const SEGMENT_MARK = 1;

/** The id the next segment of `doc` will take: read before an edit, to find its own segments after it. */
export const nextSegmentId = (doc: RoadDoc): number => doc.allocatorMarks()[SEGMENT_MARK]!;

/** DO NOT copy `doc.segments.keys()` before an edit, or filter `work.segments` against `before.segments` */
export function segmentsFrom(doc: RoadDoc, first: number): RoadSegment[] {
  const out: RoadSegment[] = [];
  for (let id = first, end = nextSegmentId(doc); id < end; id++) {
    const seg = doc.segment(asSegmentId(id));
    if (seg) out.push(seg);
  }
  return out;
}

/** The segments of the working copy `work` that its original `before` does not hold. */
const segmentsNewIn = (before: RoadDoc, work: RoadDoc): RoadSegment[] => segmentsFrom(work, nextSegmentId(before));

/** The stations of the road a gesture laid, on the copy it was laid on: the new segments that lie on the drawn pieces */
function draftStations(
  before: RoadDoc, work: RoadDoc, workNet: Network, pieces: readonly RoadPathPiece[], type: number, startAt: Vec2,
  sampled: ((x: number, y: number) => number) | undefined,
  bore: { bored: boolean; elevation: RoadElevation | null }, previous: RoadElevation | null,
): RoadStation[] {
  const path = Polyline.fromPoints(pieces.flatMap((piece, i) => {
    const pts = flattenSegment(piece.start.at, piece.end.at, fitRoadCurve(piece.start.at, piece.end.at, piece.curve, type));
    return i === 0 ? pts : pts.slice(1);
  }));
  const laid = new Set<SegmentId>();
  for (const seg of segmentsNewIn(before, work)) {
    const line = workNet.ribbons.get(seg.id)?.full;
    if (!line) continue;
    const mid = line.sampleAt(line.length / 2).p;
    if (path.closestPoint(mid).distance < 1) laid.add(seg.id);
  }
  if (!laid.size) return [];
  const index = sampled ? null : terrainIndexOf(work);
  const ground = sampled ?? ((x: number, y: number): number => sampleTerrainHeight(index!, x, y));
  const elevation = bore.elevation && !bore.bored
    ? bore.elevation
    : buildRoadElevation(workNet, ground, sampled ? (bore.elevation ?? previous) : null);
  return stationsAlong(workNet, elevation, ground, orderAlong(work, laid, startAt), STATION_STEP);
}

/** A piece too short to be a road is folded into the next one (the last into the one before) */
function joinShortPieces(pieces: readonly RoadPathPiece[]): readonly RoadPathPiece[] {
  const out: RoadPathPiece[] = [];
  let carry: RoadPathPiece['start'] | null = null;
  for (const piece of pieces) {
    const start: RoadPathPiece['start'] = carry ?? piece.start;
    if (dist(start.at, piece.end.at) < MIN_LINK_LENGTH * 0.25) {
      carry = start;
      continue;
    }
    out.push(carry ? { start, end: piece.end, curve: null } : piece);
    carry = null;
  }
  if (carry) {
    const last = out.pop();
    const tail = pieces[pieces.length - 1]!;
    out.push(last ? { start: last.start, end: tail.end, curve: null } : { start: carry, end: tail.end, curve: null });
  }
  return out;
}

interface DraftStop {
  readonly node: NodeId;
  /** Quadratic parameter on the drafted road. */
  readonly q: number;
  /** Flattened arc length on the drafted road, for dash continuity. */
  readonly s: number;
}

interface ExistingCut {
  readonly at: Vec2;
  readonly s: number;
  readonly draftQ: number;
  readonly draftS: number;
}

interface TaggedCut<Tag> {
  readonly at: Vec2;
  readonly s: number;
  readonly tag: Tag;
}

/** Commits a drafted road atomically, splitting anything it crosses. */
export function commitDraft(
  doc: RoadDoc,
  net: Network,
  start: Anchor,
  end: Anchor,
  type: number,
  curve: CurveShape | null = null,
  structure: RoadStructure = 'ground',
): DraftResult {
  if (dist(start.at, end.at) < MIN_DRAFT_LENGTH) {
    return { committed: false, reason: 'tooShort' };
  }
  if (
    !Number.isInteger(type) ||
    type < 0 ||
    type >= ROAD_TYPES.length ||
    !validPoint(start.at) ||
    !validPoint(end.at)
  ) {
    return { committed: false, reason: 'degenerate' };
  }
  if (curve && (!Number.isFinite(curve.t) || !Number.isFinite(curve.h))) {
    return { committed: false, reason: 'degenerate' };
  }

  // Flattened as a whole BEFORE it is cut at crossings
  const shape = fitRoadCurve(start.at, end.at, curve, type);

  // DO NOT copy the map to judge against when the network is behind (`Network.fork` catches it up)
  const work = doc.fork();
  const workNet = net.fork(work);
  const result = commitDraftInPlace(work, workNet, start, end, type, shape, structure);
  if (!result.committed) return result;
  // `workNet` was last built BEFORE the draft's segments were added
  workNet.rebuild();
  const refused = refuseRoadEdit({ doc, net }, { doc: work, net: workNet });
  if (refused) return { committed: false, reason: refused };
  const charge = settleRoadEdit(roadsBefore(doc), work);
  if (!charge.affordable) return { committed: false, reason: 'funds', cost: charge.amount };

  doc.takeBack(work);
  net.takeBack(workNet);
  return { ...result, cost: charge.amount };
}

function commitDraftInPlace(
  doc: RoadDoc,
  net: Network,
  start: Anchor,
  end: Anchor,
  type: number,
  curve: CurveShape | null,
  structure: RoadStructure,
  heights?: { readonly start: number; readonly end: number; readonly smoothEnd?: boolean },
  lanes: number | null = null,
  parking?: SegmentParking,
): DraftResult {
  const endpoints = materializeEndpoints(doc, net, start, end, heights);
  if (!endpoints || endpoints[0] === endpoints[1]) {
    return { committed: false, reason: 'degenerate' };
  }
  const [startNode, endNode] = endpoints;

  // Splitting an endpoint changes existing segment ids.
  if (start.kind === 'segment' || end.kind === 'segment') net.rebuild();

  const a = start.at;
  const b = end.at;
  const draft = Polyline.fromPoints(flattenSegment(a, b, curve));
  const splitBySegment = new Map<SegmentId, ExistingCut[]>();
  const draftCuts: DraftStop[] = [];
  /** Existing nodes the draft crossed near, which may come onto it (`slideOntoCrossing`). */
  const slides: { node: NodeId; segment: SegmentId; at: Vec2 }[] = [];

  // DO NOT walk `doc.segments`: every piece of every road drawn, and every pause of the pointer
  const box = draft.bbox;
  for (const { id } of ribbonsNear(net, [box.minX - MERGE_EPS, box.minY - MERGE_EPS, box.maxX + MERGE_EPS, box.maxY + MERGE_EPS])) {
    const seg = doc.segment(id);
    if (!seg) continue;
    if (!heights && seg.structure !== structure) continue;
    const existing = net.polylines.get(doc, id);

    for (let di = 0; di + 1 < draft.n; di++) {
      const d0 = draft.point(di);
      const d1 = draft.point(di + 1);
      const draftPiece = (draft.cum[di + 1] as number) - (draft.cum[di] as number);

      for (let ei = 0; ei + 1 < existing.n; ei++) {
        const e0 = existing.point(ei);
        const e1 = existing.point(ei + 1);
        const hit = segSeg(d0, d1, e0, e1);
        if (!hit) continue;

        const existingPiece =
          (existing.cum[ei + 1] as number) - (existing.cum[ei] as number);
        const draftS = (draft.cum[di] as number) + hit.t * draftPiece;
        const existingS = (existing.cum[ei] as number) + hit.u * existingPiece;

        if (heights) {
          const drafted = heights.start +
            (heights.end - heights.start) * (draftS / Math.max(1e-6, draft.length));
          const gap = Math.abs(drafted - segmentOffsetAt(doc, seg, existingS, existing.length));
          if (gap > CROSSING_CLEARANCE) continue;
          // Too far apart in height to meet, too close to pass over: refused, as moving a node already is.
          if (gap > HEIGHT_JOIN_EPS) return { committed: false, reason: 'clearance' };
        }

        // The start and end anchors already materialize these contacts.
        if (draftS <= MERGE_EPS || draftS >= draft.length - MERGE_EPS) continue;

        const draftQ = (di + hit.t) / Math.max(1, draft.n - 1);

        // A crossing NEAR an existing endpoint reuses that junction node.
        if (existingS <= MIN_LINK_LENGTH) {
          draftCuts.push({ node: seg.a, q: draftQ, s: draftS });
          slides.push({ node: seg.a, segment: id, at: hit.point });
          continue;
        }
        if (existingS >= existing.length - MIN_LINK_LENGTH) {
          draftCuts.push({ node: seg.b, q: draftQ, s: draftS });
          slides.push({ node: seg.b, segment: id, at: hit.point });
          continue;
        }

        const cuts = splitBySegment.get(id) ?? [];
        const duplicate = cuts.some(
          (cut) =>
            Math.abs(cut.s - existingS) <= MERGE_EPS &&
            Math.abs(cut.draftS - draftS) <= MERGE_EPS,
        );
        if (!duplicate) {
          cuts.push({ at: hit.point, s: existingS, draftQ, draftS });
          splitBySegment.set(id, cuts);
        }
      }
    }
  }

  // The near nodes the draft is joined through, brought onto it where they can be, before any segment is split
  const slid = new Set<NodeId>();
  for (const slide of slides) {
    if (slid.has(slide.node)) continue;
    if (slideOntoCrossing(doc, slide.node, slide.segment, slide.at, splitBySegment)) slid.add(slide.node);
  }

  // One existing segment can be crossed more than once.
  for (const [id, cuts] of splitBySegment) {
    const tagged = cuts.map((cut) => ({ at: cut.at, s: cut.s, tag: cut }));
    const nodes = splitSegmentAtCuts(doc, net, id, tagged);
    for (const cut of cuts) {
      const node = nodes.get(cut);
      if (node !== undefined) {
        draftCuts.push({ node, q: cut.draftQ, s: cut.draftS });
      }
    }
  }

  const ordered = normalizeDraftStops([
    { node: startNode, q: 0, s: 0 },
    ...draftCuts,
    { node: endNode, q: 1, s: draft.length },
  ]);

  let made = 0;
  for (let i = 1; i < ordered.length; i++) {
    const from = ordered[i - 1] as DraftStop;
    const to = ordered[i] as DraftStop;
    if (from.node === to.node) continue;

    const fromNode = doc.node(from.node);
    const toNode = doc.node(to.node);
    if (!fromNode || !toNode) continue;
    const fromPoint = { x: fromNode.x, y: fromNode.y };
    const toPoint = { x: toNode.x, y: toNode.y };
    if (dist(fromPoint, toPoint) < MIN_LINK_LENGTH * 0.25) continue;

    const pieceCurve = curveShapeForRange(a, b, curve, fromPoint, toPoint, from.q, to.q);
    if (alreadyJoined(doc, from.node, to.node, pieceCurve, structure)) continue;
    const direction = ROAD_TYPES[type]?.lanes === 1 ? 'aToB' : 'both';
    if (doc.addSegment(from.node, to.node, type, pieceCurve, from.s, direction, lanes, structure, undefined, parking)) made++;
  }

  if (!made) return { committed: false, reason: 'duplicate' };
  doc.pruneOrphanNodes();
  return { committed: true };
}

/** How far a node may stand off the straight line of its two roads and still be a joint of one straight road. */
const JOINT_STRAIGHT = 0.5;

/** Brings an existing node the draft crossed near onto the crossing, along its own road */
function slideOntoCrossing(doc: RoadDoc, id: NodeId, segment: SegmentId, at: Vec2,
  cut: ReadonlyMap<SegmentId, readonly ExistingCut[]>): boolean {
  const node = doc.node(id);
  const seg = doc.segment(segment);
  if (!node || !seg || node.crossing) return false;
  const straight = (s: NonNullable<ReturnType<RoadDoc['segment']>>): boolean => !s.curve || Math.abs(s.curve.h) < COARSE_EPS;
  if (!straight(seg) || cut.has(seg.id)) return false;
  const far = doc.node(seg.a === id ? seg.b : seg.a);
  if (!far || dist(far, at) < MIN_LINK_LENGTH) return false;
  if (node.incident.length === 2) {
    const other = doc.segment(node.incident.find((s) => s !== seg.id) ?? seg.id);
    if (!other || other.id === seg.id || !straight(other) || cut.has(other.id)) return false;
    const beyond = doc.node(other.a === id ? other.b : other.a);
    if (!beyond || dist(beyond, at) < MIN_LINK_LENGTH) return false;
    const length = dist(far, beyond);
    if (length < EPS) return false;
    const off = Math.abs((node.x - far.x) * (beyond.y - far.y) - (node.y - far.y) * (beyond.x - far.x)) / length;
    if (off > JOINT_STRAIGHT) return false;
  } else if (node.incident.length !== 1) return false;
  return doc.moveNode(id, at);
}

function normalizeDraftStops(stops: readonly DraftStop[]): DraftStop[] {
  const sorted = [...stops].sort((left, right) => left.q - right.q || left.s - right.s);
  const out: DraftStop[] = [];
  for (const stop of sorted) {
    const previous = out[out.length - 1];
    if (previous?.node === stop.node) continue;
    // Flattened curve vertices can report the same crossing from both adjacent pieces.
    if (previous && Math.abs(previous.s - stop.s) < COARSE_EPS) continue;
    out.push(stop);
  }
  return out;
}

function alreadyJoined(
  doc: RoadDoc,
  a: NodeId,
  b: NodeId,
  candidate: CurveShape | null,
  structure: RoadStructure = 'ground',
): boolean {
  const node = doc.node(a);
  if (!node) return false;
  return node.incident.some((id) => {
    const seg = doc.segment(id);
    if (!seg || seg.structure !== structure || (seg.a !== b && seg.b !== b)) return false;

    const existing = seg.curve;
    if (!existing || Math.abs(existing.h) < COARSE_EPS) {
      return !candidate || Math.abs(candidate.h) < COARSE_EPS;
    }
    if (!candidate || Math.abs(candidate.h) < COARSE_EPS) return false;

    // Compare both shapes in the a->b orientation.
    const storedForward = seg.a === a;
    const t = storedForward ? existing.t : 1 - existing.t;
    const h = storedForward ? existing.h : -existing.h;
    return Math.abs(t - candidate.t) < COARSE_EPS && Math.abs(h - candidate.h) < COARSE_EPS;
  });
}

/** Materializes both anchors together so two cuts on one segment stay valid. */
function materializeEndpoints(
  doc: RoadDoc,
  net: Network,
  start: Anchor,
  end: Anchor,
  heights?: { readonly start: number; readonly end: number; readonly smoothEnd?: boolean },
): [NodeId, NodeId] | null {
  type Tag = 'start' | 'end';
  const resolved = new Map<Tag, NodeId>();
  const bySegment = new Map<SegmentId, TaggedCut<Tag>[]>();

  const queue = (tag: Tag, anchor: Anchor): boolean => {
    if (anchor.kind === 'node') {
      if (anchor.node === undefined || !doc.node(anchor.node)) return false;
      resolved.set(tag, anchor.node);
      return true;
    }

    if (anchor.kind === 'segment') {
      if (
        anchor.segment === undefined ||
        anchor.s === undefined ||
        !Number.isFinite(anchor.s) ||
        !doc.segment(anchor.segment)
      ) {
        return false;
      }
      const cuts = bySegment.get(anchor.segment) ?? [];
      cuts.push({ at: anchor.at, s: anchor.s, tag });
      bySegment.set(anchor.segment, cuts);
      return true;
    }

    resolved.set(tag, materializeFree(doc, net, anchor.at, heights?.[tag] ?? 0,
      tag === 'end' && heights?.smoothEnd === true, [...resolved.values()]));
    return true;
  };

  if (!queue('start', start) || !queue('end', end)) return null;
  for (const [id, cuts] of bySegment) {
    const nodes = splitSegmentAtCuts(doc, net, id, cuts);
    for (const cut of cuts) {
      const node = nodes.get(cut.tag);
      if (node !== undefined) resolved.set(cut.tag, node);
    }
  }

  const a = resolved.get('start');
  const b = resolved.get('end');
  return a === undefined || b === undefined ? null : [a, b];
}

/** The node a free anchor lands on. */
function materializeFree(doc: RoadDoc, net: Network, at: Vec2, heightOffset = 0, smooth = false,
  /** Nodes this draft has already put down, with no road yet (the other end). */
  fresh: readonly NodeId[] = []): NodeId {
  // DO NOT walk `doc.nodes`: every free end of every piece read every node.
  const candidates = new Set<NodeId>(fresh);
  for (const { id } of ribbonsNear(net, [at.x - MERGE_EPS, at.y - MERGE_EPS, at.x + MERGE_EPS, at.y + MERGE_EPS])) {
    const seg = doc.segment(id);
    if (seg) { candidates.add(seg.a); candidates.add(seg.b); }
  }
  for (const id of [...candidates].sort((p, q) => p - q)) {
    const node = doc.node(id);
    if (node && dist({ x: node.x, y: node.y }, at) < MERGE_EPS &&
      Math.abs((node.heightOffset ?? 0) - heightOffset) <= HEIGHT_JOIN_EPS) return node.id;
  }
  return doc.addNode(at, heightOffset, smooth).id;
}

function segmentOffsetAt(doc: RoadDoc, segment: NonNullable<ReturnType<RoadDoc['segment']>>, s: number, length: number): number {
  const t = Math.max(0, Math.min(1, s / Math.max(1e-6, length)));
  const a = doc.node(segment.a)?.heightOffset ?? 0;
  const b = doc.node(segment.b)?.heightOffset ?? 0;
  return a + (b - a) * t + roadStructure(segment.structure).clearance;
}

/** Splits a segment at an arc position, returning the new or endpoint node. */
export function splitSegment(
  doc: RoadDoc,
  net: Network,
  id: SegmentId,
  s: number,
  at: Vec2,
): NodeId | null {
  const tag = Symbol('split');
  return splitSegmentAtCuts(doc, net, id, [{ at, s, tag }]).get(tag) ?? null;
}

/** Makes the topology agree with a node the Move tool has just dropped. */
export function reconcileMovedNode(doc: RoadDoc, net: Network, id: NodeId, depth = 0): DraftResult {
  if (depth > 16) return { committed: true };
  const node = doc.node(id);
  if (!node) return { committed: false, reason: 'degenerate' };

  // DO NOT walk `doc.nodes`.
  const near = new Set<NodeId>();
  for (const { id: sid } of ribbonsNear(net, [node.x - MERGE_EPS, node.y - MERGE_EPS, node.x + MERGE_EPS, node.y + MERGE_EPS])) {
    const seg = doc.segment(sid);
    if (seg) { near.add(seg.a); near.add(seg.b); }
  }
  for (const otherId of [...near].sort((p, q) => p - q)) {
    const other = doc.node(otherId);
    if (!other || other.id === id) continue;
    if (dist(node, other) > MERGE_EPS || Math.abs(other.heightOffset - node.heightOffset) > HEIGHT_JOIN_EPS) continue;
    // Merging along a road would fold that road to nothing.
    if (node.incident.some((sid) => { const seg = doc.segment(sid); return seg && (seg.a === other.id || seg.b === other.id); })) {
      return { committed: false, reason: 'tooShort' };
    }
    doc.mergeNodes(other.id, id);
    return { committed: true };
  }

  for (const sid of node.incident) {
    const seg = doc.segment(sid);
    const far = seg && doc.node(seg.a === id ? seg.b : seg.a);
    if (far && dist(node, far) < MIN_LINK_LENGTH * 0.25) return { committed: false, reason: 'tooShort' };
  }

  net.rebuild();
  for (const sid of [...node.incident]) {
    const moved = doc.segment(sid);
    if (!moved) continue;
    const path = net.polylines.get(doc, sid);
    // DO NOT walk `doc.segments`.
    const pb = path.bbox;
    for (const { id: otherId } of ribbonsNear(net, [pb.minX - MERGE_EPS, pb.minY - MERGE_EPS, pb.maxX + MERGE_EPS, pb.maxY + MERGE_EPS])) {
      const other = doc.segment(otherId);
      if (!other || otherId === sid || other.structure !== moved.structure) continue;
      if (other.a === moved.a || other.a === moved.b || other.b === moved.a || other.b === moved.b) continue;
      const line = net.polylines.get(doc, otherId);
      for (let i = 0; i + 1 < path.n; i++) {
        let crossed = false;
        for (let j = 0; j + 1 < line.n; j++) {
          const hit = segSeg(path.point(i), path.point(i + 1), line.point(j), line.point(j + 1));
          if (!hit) continue;
          const sMoved = (path.cum[i] as number) + hit.t * ((path.cum[i + 1] as number) - (path.cum[i] as number));
          const sOther = (line.cum[j] as number) + hit.u * ((line.cum[j + 1] as number) - (line.cum[j] as number));
          if (sMoved <= MERGE_EPS || sMoved >= path.length - MERGE_EPS) continue;
          const gap = Math.abs(segmentOffsetAt(doc, moved, sMoved, path.length) - segmentOffsetAt(doc, other, sOther, line.length));
          if (gap > CROSSING_CLEARANCE) continue;
          if (gap > HEIGHT_JOIN_EPS) return { committed: false, reason: 'clearance' };
          // Near the other road's end, its junction is reused, as a drawn road does.
          const onOther = sOther <= MIN_LINK_LENGTH ? other.a
            : sOther >= line.length - MIN_LINK_LENGTH ? other.b
              : splitSegmentAtCuts(doc, net, otherId, [{ at: hit.point, s: sOther, tag: 'x' }]).get('x');
          const onMoved = splitSegmentAtCuts(doc, net, sid, [{ at: hit.point, s: sMoved, tag: 'x' }]).get('x');
          if (onOther !== undefined && onMoved !== undefined) doc.mergeNodes(onOther, onMoved);
          net.rebuild();
          crossed = true;
          break;
        }
        if (crossed) {
          // The moved road is now two pieces; what is left of it is handled by a fresh pass rather than on stale arc lengths.
          return reconcileMovedNode(doc, net, id, depth + 1);
        }
      }
    }
  }
  return { committed: true };
}

/** A node dropped by the Move tool at `to`, reconciled with the network */
export function moveNodeChecked(doc: RoadDoc, net: Network, id: NodeId, to: Vec2): DraftResult {
  // Made on a working copy (`RoadDoc.fork`) and judged against the map as it stands, as a drawn road is
  if (net.revision !== doc.revision) throw new Error('moveNodeChecked: the network is not built for the document as it stands');
  const work = doc.fork();
  const workNet = net.fork(work);
  if (!work.moveNode(id, to)) return { committed: false, reason: 'duplicate' };
  // `workNet` stands as before the move: the roads that did not move are filed where they are.
  const result = reconcileMovedNode(work, workNet, id);
  if (!result.committed) return result;
  workNet.rebuild();
  const refused = refuseRoadEdit({ doc, net }, { doc: work, net: workNet });
  if (refused) return { committed: false, reason: refused };
  // The roads made longer are paid for, shorter partly paid back (`editor/roads/economy.ts`).
  const charge = settleRoadEdit(roadsBefore(doc), work);
  if (!charge.affordable) return { committed: false, reason: 'funds', cost: charge.amount };
  doc.takeBack(work);
  net.takeBack(workNet);
  return { ...result, cost: charge.amount };
}

/** Joins two compatible straight segments meeting at an otherwise unused node. */
export function joinSegments(doc: RoadDoc, nodeId: NodeId): boolean {
  const node = doc.node(nodeId);
  // A node carrying a pedestrian crossing is the crossing; joining it away would erase what the player placed.
  if (!node || node.incident.length !== 2 || node.crossing) return false;
  const [firstId, secondId] = node.incident;
  if (firstId === undefined || secondId === undefined) return false;
  const first = doc.segment(firstId);
  const second = doc.segment(secondId);
  if (!first || !second || first.curve || second.curve || first.type !== second.type || first.lanes !== second.lanes ||
    first.direction !== 'both' || second.direction !== 'both') return false;
  const a = first.a === nodeId ? first.b : first.a;
  const b = second.a === nodeId ? second.b : second.a;
  // Sections read along a -> b on both pieces, as the parking below
  const sectionFirst = first.a === a ? first.section : flipSection(first.section);
  const sectionSecond = second.b === b ? second.section : flipSection(second.section);
  if (!sameRoadSectionIgnoringArrows(sectionFirst, sectionSecond)) return false;
  // Parking read along a -> b on both pieces: a piece stored the other way round has its sides swapped.
  const parkingFirst = first.a === a ? first.parking : flipParking(first.parking);
  const parkingSecond = second.b === b ? second.parking : flipParking(second.parking);
  if (!sameParking(parkingFirst, parkingSecond)) return false;
  if (a === b || first.structure !== second.structure || alreadyJoined(doc, a, b, null, first.structure)) return false;
  const dashOrigin = Math.min(first.dashOrigin, second.dashOrigin);
  const bansAtA = [...(doc.node(a)?.blockedMovements ?? [])];
  const bansAtB = [...(doc.node(b)?.blockedMovements ?? [])];
  const crossingAtA = doc.node(a)?.crossing;
  const crossingAtB = doc.node(b)?.crossing;
  doc.removeSegment(first.id);
  doc.removeSegment(second.id);
  doc.removeNode(nodeId);
  // The joined road keeps the arrows of its two ends
  const towardB = second.b === b ? second.section?.turnsForward : second.section?.turnsBackward;
  const towardA = first.a === a ? first.section?.turnsBackward : first.section?.turnsForward;
  const base = sectionForPiece(sectionFirst, false, false);
  const section = base && {
    ...base,
    ...(towardB ? { turnsForward: [...towardB] } : {}),
    ...(towardA ? { turnsBackward: [...towardA] } : {}),
  };
  const joined = doc.addSegment(a, b, first.type, null, dashOrigin, 'both', first.lanes, first.structure, section, parkingFirst);
  if (!joined) return false;
  if (first.cutWalls && second.cutWalls) doc.setSegmentCutWalls(joined.id, true);
  doc.carryMovements(a, bansAtA, first.id, joined.id);
  doc.carryMovements(b, bansAtB, second.id, joined.id);
  doc.carryCrossing(a, crossingAtA, first.id, joined.id);
  doc.carryCrossing(b, crossingAtB, second.id, joined.id);
  return true;
}

/** Creates a disconnected parallel copy of a road for rapid layout iteration. */
export function duplicateSegment(doc: RoadDoc, net: Network, id: SegmentId): SegmentId | null {
  const segment = doc.segment(id);
  if (!segment) return null;
  const a = doc.node(segment.a);
  const b = doc.node(segment.b);
  if (!a || !b) return null;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < MERGE_EPS) return null;
  const sourceWidth = net.ribbons.get(id)?.road.width ?? m(4.8);
  const offset = Math.max(m(8.8), sourceWidth + m(4.8));
  const nx = (-dy / length) * offset;
  const ny = (dx / length) * offset;
  const copyA = doc.addNode({ x: a.x + nx, y: a.y + ny }, a.heightOffset);
  const copyB = doc.addNode({ x: b.x + nx, y: b.y + ny }, b.heightOffset);
  const copy = doc.addSegment(
    copyA.id,
    copyB.id,
    segment.type,
    segment.curve ? { ...segment.curve } : null,
    segment.dashOrigin,
    segment.direction,
    segment.lanes,
    segment.structure,
    segment.section,
    segment.parking,
  );
  if (copy && segment.cutWalls) doc.setSegmentCutWalls(copy.id, true);
  if (copy) return copy.id;

  // Source validation above makes this defensive branch unlikely
  doc.removeNode(copyA.id);
  doc.removeNode(copyB.id);
  return null;
}

/** Splits one original segment at any number of positions. */
function splitSegmentAtCuts<Tag>(
  doc: RoadDoc,
  net: Network,
  id: SegmentId,
  requests: readonly TaggedCut<Tag>[],
): Map<Tag, NodeId> {
  const result = new Map<Tag, NodeId>();
  const seg = doc.segment(id);
  if (!seg) return result;
  const pl = net.polylines.get(doc, id);

  interface InteriorCut {
    at: Vec2;
    s: number;
    q: number;
    tags: Tag[];
  }

  const interior: InteriorCut[] = [];
  const ordered = [...requests]
    .filter((request) => Number.isFinite(request.s) && validPoint(request.at))
    .sort((left, right) => left.s - right.s);

  const originalA = doc.requireNode(seg.a);
  const originalB = doc.requireNode(seg.b);
  const a = { x: originalA.x, y: originalA.y };
  const b = { x: originalB.x, y: originalB.y };
  const control = seg.curve ? controlPoint(a, b, seg.curve) : null;

  for (const request of ordered) {
    if (request.s <= MERGE_EPS) {
      result.set(request.tag, seg.a);
      continue;
    }
    if (request.s >= pl.length - MERGE_EPS) {
      result.set(request.tag, seg.b);
      continue;
    }

    const previous = interior[interior.length - 1];
    if (previous && Math.abs(previous.s - request.s) <= MERGE_EPS) {
      previous.tags.push(request.tag);
      continue;
    }

    const q = parameterAtArc(pl, request.s);
    const at = control ? splitQuad(a, control, b, q).left[2] : request.at;
    interior.push({ at, s: request.s, q, tags: [request.tag] });
  }

  if (!interior.length) return result;

  const nodes = interior.map((cut) =>
    doc.addNode(cut.at, (originalA.heightOffset ?? 0) +
      ((originalB.heightOffset ?? 0) - (originalA.heightOffset ?? 0)) *
      (cut.s / Math.max(1e-6, pl.length))));
  for (let i = 0; i < interior.length; i++) {
    const cut = interior[i] as InteriorCut;
    const node = nodes[i] as { id: NodeId };
    for (const tag of cut.tags) result.set(tag, node.id);
  }

  const nodeIds = [seg.a, ...nodes.map((node) => node.id), seg.b];
  const points = [a, ...interior.map((cut) => cut.at), b];
  const params = [0, ...interior.map((cut) => cut.q), 1];
  const arcs = [0, ...interior.map((cut) => cut.s), pl.length];
  const type = seg.type;
  const dashOrigin = seg.dashOrigin;
  // The bans at the two ends name this segment; they move to the end pieces.
  const bansAtA = [...(doc.node(seg.a)?.blockedMovements ?? [])];
  const bansAtB = [...(doc.node(seg.b)?.blockedMovements ?? [])];
  // So does a crossing painted on this segment at either end.
  const crossingAtA = doc.node(seg.a)?.crossing;
  const crossingAtB = doc.node(seg.b)?.crossing;
  const pieces: SegmentId[] = [];

  doc.removeSegment(id);
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    const pieceCurve = curveShapeForRange(
      a,
      b,
      seg.curve,
      points[i] as Vec2,
      points[i + 1] as Vec2,
      params[i] as number,
      params[i + 1] as number,
    );
    const piece = doc.addSegment(
      nodeIds[i] as NodeId,
      nodeIds[i + 1] as NodeId,
      type,
      pieceCurve,
      dashOrigin + (arcs[i] as number),
      seg.direction,
      seg.lanes,
      seg.structure,
      sectionForPiece(seg.section, i === 0, i + 2 === nodeIds.length),
      seg.parking,
    );
    if (piece && seg.cutWalls) doc.setSegmentCutWalls(piece.id, true);
    if (piece) pieces.push(piece.id);
  }
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (first !== undefined) doc.carryMovements(seg.a, bansAtA, id, first);
  if (last !== undefined) doc.carryMovements(seg.b, bansAtB, id, last);
  if (first !== undefined) doc.carryCrossing(seg.a, crossingAtA, id, first);
  if (last !== undefined) doc.carryCrossing(seg.b, crossingAtB, id, last);

  return result;
}

function parameterAtArc(polyline: Polyline, s: number): number {
  const frame = polyline.sampleAt(s);
  return (frame.i + frame.u) / Math.max(1, polyline.n - 1);
}

function curveShapeForRange(
  originalA: Vec2,
  originalB: Vec2,
  curve: CurveShape | null,
  actualA: Vec2,
  actualB: Vec2,
  t0: number,
  t1: number,
): CurveShape | null {
  if (!curve || Math.abs(curve.h) < EPS) return null;
  const originalControl = controlPoint(originalA, originalB, curve);
  const range = quadRange(originalA, originalControl, originalB, t0, t1);
  const shape = shapeFromControl(actualA, actualB, range[1]);
  return Math.abs(shape.h) < EPS ? null : shape;
}

/** Returns the de Casteljau control triple over the original [t0,t1] range. */
function quadRange(
  a: Vec2,
  c: Vec2,
  b: Vec2,
  t0: number,
  t1: number,
): [Vec2, Vec2, Vec2] {
  let range: [Vec2, Vec2, Vec2] = [a, c, b];
  if (t1 < 1) range = splitQuad(range[0], range[1], range[2], t1).left;
  if (t0 > 0) {
    const local = t1 > 0 ? t0 / t1 : 0;
    range = splitQuad(range[0], range[1], range[2], local).right;
  }
  return range;
}

function validPoint(point: Vec2): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}
