import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { RoadDoc, type JunctionControl, type SegmentDirection } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import { MIN_LINK_LENGTH } from '@world/approach';
import { ROAD_TYPES } from '@world/roadTypes';
import type { RoadStructure } from '@world/structures';
import { commitDraft, commitRoadPath, joinSegments, moveNodeChecked, splitSegment } from '@editor/commit';
import { guardRoadEdit } from '@editor/editRules';

import { anchorForHeight, anchorHeightOffset, findAnchor, snapEndpoint, snapRoadEndpoint, type Anchor } from '@editor/snap';
import { fitRoadCurve } from '@world/doc';
import { profileOf } from '@world/roads/profile';
import { TUNED_UNIT, m } from '@world/units';
import { applyProfileTo } from '@editor/roads/profile';

/** The 0.4 m unit the gestures are drawn in: every length below in it, times U. */
const U = TUNED_UNIT;

/** One editor gesture, as plain JSON. */
export type FuzzOp =
  | { readonly op: 'draw'; readonly a: readonly [number, number]; readonly b: readonly [number, number];
    readonly type: number; readonly curve: { readonly t: number; readonly h: number } | null;
    readonly structure: RoadStructure }
  /** A road drawn the way the road tool draws it today: `commitRoadPath` with authored heights */
  | { readonly op: 'path'; readonly a: readonly [number, number]; readonly b: readonly [number, number];
    readonly type: number; readonly curve: { readonly t: number; readonly h: number } | null;
    readonly h0: number; readonly h1: number }
  | { readonly op: 'split'; readonly pick: number; readonly at: number }
  | { readonly op: 'join'; readonly pick: number }
  | { readonly op: 'move'; readonly pick: number; readonly dx: number; readonly dy: number }
  | { readonly op: 'type'; readonly pick: number; readonly type: number }
  | { readonly op: 'upgrade'; readonly pick: number }
  | { readonly op: 'lanes'; readonly pick: number; readonly lanes: number }
  | { readonly op: 'direction'; readonly pick: number; readonly direction: SegmentDirection }
  | { readonly op: 'structure'; readonly pick: number; readonly structure: RoadStructure }
  | { readonly op: 'curve'; readonly pick: number; readonly t: number; readonly h: number }
  | { readonly op: 'delete'; readonly pick: number }
  | { readonly op: 'removeNode'; readonly pick: number }
  | { readonly op: 'control'; readonly pick: number; readonly control: JunctionControl }
  /** A new cross-section on a road already built */
  | { readonly op: 'profile'; readonly pick: number; readonly left: number; readonly right: number;
    readonly flushLeft: boolean; readonly flushRight: boolean };

export interface FuzzState {
  readonly doc: RoadDoc;
  readonly net: Network;
  /** Defects seen DURING a gesture, before the rebuild `main.ts` does after it. */
  readonly notes: { category: string; subject: string; detail: string }[];
}

export function freshState(): FuzzState {
  const doc = new RoadDoc();
  // The fuzzer hunts geometry: money is never why a gesture fails here
  doc.setBalance(Number.MAX_SAFE_INTEGER, 'fuzz');
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, notes: [] };
}

const STRUCTURES: readonly RoadStructure[] = ['ground', 'ground', 'ground', 'elevated', 'bridge', 'tunnel'];
const DIRECTIONS: readonly SegmentDirection[] = ['both', 'aToB', 'bToA'];
const CONTROLS: readonly JunctionControl[] = ['auto', 'signal', 'stop', 'yield', 'priority', 'none'];
/** The half-extent of the square every drawn point is kept inside. */
const FIELD = 700 * U;

function pickFrom<T>(list: readonly T[], pick: number): T | undefined {
  if (!list.length) return undefined;
  return list[Math.min(list.length - 1, Math.floor(pick * list.length))];
}

function segmentIds(doc: RoadDoc): SegmentId[] {
  return [...doc.segments.keys()].sort((a, b) => a - b);
}

function nodeIds(doc: RoadDoc): NodeId[] {
  return [...doc.nodes.keys()].sort((a, b) => a - b);
}

/** The anchor the editor resolves under a pointer, including the structure rule in main.ts. */
function anchorAt(state: FuzzState, p: Vec2, structure: RoadStructure): Anchor {
  const anchor = findAnchor(state.doc, state.net, p, 1);
  if (anchor.kind !== 'segment' || anchor.segment === undefined) return anchor;
  const segment = state.doc.segment(anchor.segment);
  return segment && segment.structure !== structure ? { kind: 'free', at: anchor.at } : anchor;
}

/** Applies one gesture exactly the way `main.ts` does */
export function applyOp(state: FuzzState, op: FuzzOp): boolean {
  const { doc, net } = state;
  let changed = false;
  switch (op.op) {
    case 'draw': {
      const start = anchorAt(state, { x: op.a[0], y: op.a[1] }, op.structure);
      const snapped = snapEndpoint(doc, net, start, { x: op.b[0], y: op.b[1] }, 1).at;
      const endAnchor = anchorAt(state, snapped, op.structure);
      const end: Anchor = endAnchor.kind === 'free' ? { kind: 'free', at: snapped } : endAnchor;
      changed = commitDraft(doc, net, start, end, op.type, op.curve, op.structure).committed;
      // commitDraft hands back a network it claims is current.
      if (changed) {
        const missing = [...doc.segments.keys()].filter((id) => !net.ribbons.has(id));
        if (net.revision === doc.revision && missing.length) {
          state.notes.push({ category: 'staleNetwork', subject: `segs ${missing.join(',')}`,
            detail: 'commitDraft left a network marked current without the new road' });
        }
      }
      break;
    }
    case 'path': {
      // `main.ts` pointerdown + commitRoadGesture
      const start = findAnchor(doc, net, { x: op.a[0], y: op.a[1] }, 1);
      const startHeight = start.kind === 'free' ? op.h0 : anchorHeightOffset(doc, net, start, op.h0);
      const snapped = snapRoadEndpoint(doc, net, start, { x: op.b[0], y: op.b[1] }, 1, op.h1).at;
      const endAnchor = anchorForHeight(doc, net, findAnchor(doc, net, snapped, 1, undefined, op.h1), op.h1);
      const end: Anchor = endAnchor.kind === 'free' ? { kind: 'free', at: snapped } : endAnchor;
      const endHeight = end.kind === 'free' ? op.h1 : anchorHeightOffset(doc, net, end, op.h1);
      if (Math.hypot(start.at.x - end.at.x, start.at.y - end.at.y) < 1e-6) return false;
      const curve = op.curve ? fitRoadCurve(start.at, end.at, op.curve, op.type) : null;
      changed = commitRoadPath(doc, net, start, end, op.type, [{
        start: { at: start.at, heightOffset: startHeight },
        end: { at: end.at, heightOffset: endHeight },
        curve,
      }]).committed;
      break;
    }
    // Edits made in place are judged like a drawn road and undone when refused, as main.ts's `mutateRoads` does
    case 'split': {
      const id = pickFrom(segmentIds(doc), op.pick);
      if (id === undefined) return false;
      const line = net.polylines.get(doc, id);
      const s = line.length * op.at;
      changed = guardRoadEdit(doc, net, (work, workNet) => splitSegment(work, workNet, id, s, line.sampleAt(s).p) !== null).changed;
      break;
    }
    case 'join': {
      const id = pickFrom(nodeIds(doc).filter((n) => doc.degree(n) === 2), op.pick);
      changed = id !== undefined && guardRoadEdit(doc, net, (work) => joinSegments(work, id)).changed;
      break;
    }
    case 'move': {
      const id = pickFrom(nodeIds(doc), op.pick);
      const node = id === undefined ? undefined : doc.node(id);
      if (!node || id === undefined) return false;
      // As main.ts's drop (`NodeMover.drop`): move, reconcile and judge; a refused drop is put back by `moveNodeChecked` itself.
      changed = moveNodeChecked(doc, net, id, { x: node.x + op.dx, y: node.y + op.dy }).committed;
      break;
    }
    case 'type': case 'upgrade': {
      const id = pickFrom(segmentIds(doc), op.pick);
      const seg = id === undefined ? undefined : doc.segment(id);
      if (!seg || id === undefined) return false;
      const type = op.op === 'upgrade' ? seg.type + 1 : op.type;
      if (type >= ROAD_TYPES.length || type === seg.type) return false;
      changed = guardRoadEdit(doc, net, (work) => { work.setSegmentType(id, type); return true; }).changed;
      break;
    }
    case 'lanes': {
      const id = pickFrom(segmentIds(doc), op.pick);
      if (id === undefined) return false;
      const before = doc.segment(id)?.lanes;
      changed = guardRoadEdit(doc, net, (work) => {
        work.setSegmentLanes(id, op.lanes);
        return work.segment(id)?.lanes !== before;
      }).changed;
      break;
    }
    case 'direction': {
      const id = pickFrom(segmentIds(doc), op.pick);
      if (id === undefined || doc.segment(id)?.direction === op.direction) return false;
      changed = guardRoadEdit(doc, net, (work) => { work.setSegmentDirection(id, op.direction); return true; }).changed;
      break;
    }
    case 'structure': {
      const id = pickFrom(segmentIds(doc), op.pick);
      if (id === undefined || doc.segment(id)?.structure === op.structure) return false;
      changed = guardRoadEdit(doc, net, (work) => { work.setSegmentStructure(id, op.structure); return true; }).changed;
      break;
    }
    case 'curve': {
      const id = pickFrom(segmentIds(doc), op.pick);
      if (id === undefined) return false;
      changed = guardRoadEdit(doc, net, (work) => {
        work.setSegmentCurve(id, Math.abs(op.h) < 1e-6 ? null : { t: op.t, h: op.h });
        return true;
      }).changed;
      break;
    }
    case 'delete': {
      const id = pickFrom(segmentIds(doc), op.pick);
      if (id === undefined) return false;
      doc.removeSegment(id);
      doc.pruneOrphanNodes();
      changed = true;
      break;
    }
    case 'removeNode': {
      const id = pickFrom(nodeIds(doc), op.pick);
      const node = id === undefined ? undefined : doc.node(id);
      if (!node || id === undefined) return false;
      for (const seg of [...node.incident]) doc.removeSegment(seg);
      doc.removeNode(id);
      doc.pruneOrphanNodes();
      changed = true;
      break;
    }
    case 'profile': {
      const id = pickFrom(segmentIds(doc), op.pick);
      const seg = id === undefined ? undefined : doc.segment(id);
      if (!seg || id === undefined) return false;
      const base = profileOf(seg);
      const elements = base.elements.map((e, i) => e.kind !== 'footway' ? e
        : { ...e, width: m(i === 0 ? op.left : op.right), ...((i === 0 ? op.flushLeft : op.flushRight) ? { flush: true } : {}) });
      changed = guardRoadEdit(doc, net, (work) => applyProfileTo(work, [id], { ...base, elements }).changed).changed;
      break;
    }
    case 'control': {
      const id = pickFrom(nodeIds(doc).filter((n) => doc.degree(n) >= 3), op.pick);
      if (id === undefined || doc.node(id)?.control === op.control) return false;
      doc.setNodeControl(id, op.control);
      changed = true;
      break;
    }
  }
  if (changed) net.rebuild();
  return changed;
}

const round = (value: number): number => Math.round(value * 100) / 100;
const clampField = (value: number): number => Math.max(-FIELD, Math.min(FIELD, value));
const point = (x: number, y: number): [number, number] => [round(clampField(x)), round(clampField(y))];

/** Draws a gesture that is LIKELY to stress the builders, not a uniform one: roads out of existing nodes */
function drawOp(rng: Rng, state: FuzzState): FuzzOp {
  const { doc, net } = state;
  const type = rng.int(0, ROAD_TYPES.length - 1);
  const structure = rng.float() < 0.8 ? 'ground' : (pickFrom(STRUCTURES, rng.float()) as RoadStructure);
  const curve = rng.float() < 0.25 ? { t: round(rng.range(0.3, 0.7)), h: 0 } : null;
  const nodes = nodeIds(doc);
  const segments = segmentIds(doc);
  const mode = segments.length === 0 ? 0 : rng.int(0, 4);
  let a: [number, number];
  let b: [number, number];
  if (mode === 1 && nodes.length) {
    // Out of an existing node, at any angle: grows junction degree.
    const node = doc.requireNode(pickFrom(nodes, rng.float()) as NodeId);
    const angle = rng.range(0, Math.PI * 2);
    const length = rng.range(60, 320) * U;
    a = point(node.x, node.y);
    b = point(node.x + Math.cos(angle) * length, node.y + Math.sin(angle) * length);
  } else if (mode === 2) {
    // Across an existing road, at an angle between 20 and 90 degrees.
    const id = pickFrom(segments, rng.float()) as SegmentId;
    const line = net.polylines.get(doc, id);
    const frame = line.sampleAt(line.length * rng.range(0.15, 0.85));
    const angle = Math.atan2(frame.t.y, frame.t.x) + (rng.float() < 0.5 ? 1 : -1) * rng.range(0.35, Math.PI / 2);
    const half = rng.range(50, 200) * U;
    a = point(frame.p.x - Math.cos(angle) * half, frame.p.y - Math.sin(angle) * half);
    b = point(frame.p.x + Math.cos(angle) * half, frame.p.y + Math.sin(angle) * half);
  } else if (mode === 3) {
    // Touching an existing road a whisker past MIN_LINK_LENGTH from its end.
    const id = pickFrom(segments, rng.float()) as SegmentId;
    const line = net.polylines.get(doc, id);
    const s = Math.min(line.length - 1 * U, MIN_LINK_LENGTH + rng.range(-4, 8) * U);
    const frame = line.sampleAt(Math.max(0, s));
    const side = rng.float() < 0.5 ? 1 : -1;
    const length = rng.range(60, 240) * U;
    a = point(frame.p.x, frame.p.y);
    b = point(frame.p.x + frame.n.x * side * length, frame.p.y + frame.n.y * side * length);
  } else if (mode === 4) {
    // Nearly on top of an existing road: parallel, a few units off.
    const id = pickFrom(segments, rng.float()) as SegmentId;
    const line = net.polylines.get(doc, id);
    const offset = (rng.float() < 0.5 ? 1 : -1) * rng.range(4, 26) * U;
    const p0 = line.sampleAt(line.length * rng.range(0, 0.3));
    const p1 = line.sampleAt(line.length * rng.range(0.7, 1));
    a = point(p0.p.x + p0.n.x * offset, p0.p.y + p0.n.y * offset);
    b = point(p1.p.x + p1.n.x * offset, p1.p.y + p1.n.y * offset);
  } else {
    a = point(rng.range(-FIELD, FIELD), rng.range(-FIELD, FIELD));
    const angle = rng.range(0, Math.PI * 2);
    const length = rng.range(80, 500) * U;
    b = point(a[0] + Math.cos(angle) * length, a[1] + Math.sin(angle) * length);
  }
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const shaped = curve ? { t: curve.t, h: round((rng.float() < 0.5 ? 1 : -1) * rng.range(0.1, 0.35) * chord) } : null;
  // Most roads go through the tool's own path: authored heights, no legacy structure.
  if (rng.float() < 0.7) {
    const height = (): number => rng.float() < 0.6 ? 0 : round((rng.float() < 0.75 ? 1 : -1) * rng.range(2.5, 30) * U);
    return { op: 'path', a, b, type, curve: shaped, h0: height(), h1: height() };
  }
  return { op: 'draw', a, b, type, curve: shaped, structure };
}

/** One random gesture, weighted towards drawing (a map is mostly drawn). */
export function randomOp(rng: Rng, state: FuzzState): FuzzOp {
  const roll = rng.float();
  if (roll < 0.5 || state.doc.segments.size < 2) return drawOp(rng, state);
  const pick = round(rng.float());
  const kinds = ['split', 'join', 'move', 'type', 'upgrade', 'lanes', 'direction', 'structure', 'curve',
    'delete', 'removeNode', 'control', 'profile'] as const;
  const kind = pickFrom(kinds, rng.float()) as (typeof kinds)[number];
  switch (kind) {
    case 'split': return { op: 'split', pick, at: round(rng.range(0.2, 0.8)) };
    case 'join': return { op: 'join', pick };
    case 'move': return { op: 'move', pick, dx: round(rng.range(-60, 60) * U), dy: round(rng.range(-60, 60) * U) };
    case 'type': return { op: 'type', pick, type: rng.int(0, ROAD_TYPES.length - 1) };
    case 'upgrade': return { op: 'upgrade', pick };
    case 'lanes': return { op: 'lanes', pick, lanes: rng.int(1, 8) };
    case 'direction': return { op: 'direction', pick, direction: pickFrom(DIRECTIONS, rng.float()) as SegmentDirection };
    case 'structure': return { op: 'structure', pick, structure: pickFrom(STRUCTURES, rng.float()) as RoadStructure };
    case 'curve': return { op: 'curve', pick, t: round(rng.range(0.3, 0.7)), h: round(rng.range(-60, 60) * U) };
    case 'delete': return { op: 'delete', pick };
    case 'removeNode': return { op: 'removeNode', pick };
    case 'control': return { op: 'control', pick, control: pickFrom(CONTROLS, rng.float()) as JunctionControl };
    case 'profile': return { op: 'profile', pick, left: rng.int(1, 6), right: rng.int(1, 6),
      flushLeft: rng.float() < 0.2, flushRight: rng.float() < 0.2 };
  }
}
