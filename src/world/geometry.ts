import { Polyline } from '@core/polyline';
import { type CurveShape, flattenSegment } from '@core/bezier';
import { type Vec2, neg, perp } from '@core/vec2';
import type { RoadDoc, RoadSegment } from './doc';
import type { NodeId, SegmentId } from './ids';

/** A cross-section frame taken at some distance from one end of a segment. */
export interface LegFrame {
  /** Position on the centreline. */
  readonly p: Vec2;
  /** Unit direction pointing AWAY from the reference node. */
  readonly dir: Vec2;
  /** Unit left normal of `dir`. */
  readonly nrm: Vec2;
  /** Total arc length of the segment. */
  readonly length: number;
}

/** Flattened centreline of a segment, oriented a -> b. */
export function segmentPolyline(doc: RoadDoc, seg: RoadSegment): Polyline {
  const a = doc.requireNode(seg.a);
  const b = doc.requireNode(seg.b);
  return segmentLine({ x: a.x, y: a.y }, { x: b.x, y: b.y }, seg.curve);
}

/** A segment's centreline from its two ends and its curve (`segmentPolyline`): what a worker makes it from too (`junctionBuild.ts`). */
export function segmentLine(a: Vec2, b: Vec2, curve: CurveShape | null): Polyline {
  return Polyline.fromPoints(flattenSegment(a, b, curve));
}

/** Centreline oriented so that it starts at `from`. */
export function orientedPolyline(
  doc: RoadDoc,
  seg: RoadSegment,
  from: NodeId,
): Polyline {
  const pl = segmentPolyline(doc, seg);
  return seg.a === from ? pl : pl.reversed();
}

/** Frame at `distance` measured from `nodeId` along `seg`. */
export function frameFromNode(
  pl: Polyline,
  segStartsAtNode: boolean,
  distance: number,
): LegFrame {
  const length = pl.length;
  if (segStartsAtNode) {
    const f = pl.sampleAt(distance);
    return { p: f.p, dir: f.t, nrm: perp(f.t), length };
  }
  const f = pl.sampleAt(length - distance);
  const dir = neg(f.t);
  return { p: f.p, dir, nrm: perp(dir), length };
}

/** The other endpoint of `seg`. */
export const farNode = (seg: RoadSegment, from: NodeId): NodeId =>
  seg.a === from ? seg.b : seg.a;

export const segmentStartsAt = (seg: RoadSegment, node: NodeId): boolean =>
  seg.a === node;

/** Cheap cache of per-segment polylines, rebuilt only for dirty segments. */
export class PolylineCache {
  private map = new Map<SegmentId, Polyline>();
  /** The cache this one is a working copy over (`fork`): read where this one holds nothing and has not dropped the road. */
  private below: PolylineCache | null = null;
  /** Roads this working copy dropped (`invalidate`, `clear`): never read from below, which may still cache them. */
  private dropped = new Set<SegmentId>();
  private droppedAll = false;

  /** The segment's centreline. */
  get(doc: RoadDoc, id: SegmentId): Polyline {
    let pl = this.map.get(id) ?? this.fromBelow(id);
    if (!pl) {
      pl = segmentPolyline(doc, doc.requireSegment(id));
      this.map.set(id, pl);
    }
    return pl;
  }

  invalidate(id: SegmentId): void {
    this.map.delete(id);
    if (this.below) this.dropped.add(id);
  }

  clear(): void {
    this.map.clear();
    this.dropped.clear();
    this.droppedAll = this.below !== null;
  }

  /** DO NOT copy the cache for an edit: a working copy over this one (`Network.fork`) */
  fork(): PolylineCache {
    const copy = new PolylineCache();
    copy.below = this;
    return copy;
  }

  /** Takes back what a working copy of this cache (`fork`) dropped and made; the copy is spent. */
  takeBack(copy: PolylineCache): void {
    if (copy.below !== this) throw new Error('PolylineCache.takeBack: not a working copy of this cache');
    if (copy.droppedAll) this.clear();
    for (const id of copy.dropped) this.invalidate(id);
    for (const [id, pl] of copy.map) this.map.set(id, pl);
    copy.below = null;
  }

  /** What the cache below holds for a road this copy has not dropped (it never makes one there). */
  private fromBelow(id: SegmentId): Polyline | undefined {
    if (!this.below || this.droppedAll || this.dropped.has(id)) return undefined;
    return this.below.peek(id);
  }

  /** The centreline held for a road, made by nobody. */
  private peek(id: SegmentId): Polyline | undefined {
    return this.map.get(id) ?? this.fromBelow(id);
  }
}
