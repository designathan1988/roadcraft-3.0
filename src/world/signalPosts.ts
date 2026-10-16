import { addScaled, angleOf, perp } from '@core/vec2';
import { crosswalkDistance } from './approach';
import type { LaneletGraph } from './lanelets';
import type { Network } from './network';
import type { NodeId, SegmentId } from './ids';
import { roadProfile } from './roadTypes';
import { m } from './units';

/** Where the traffic signal posts stand */

/** Clearance from the carriageway edge to the post's centre line. */
export const SIGNAL_POST_KERB = m(0.9);
/** Radius of the post: the drawn pole, 0.165 m (the pedestrians do not read it yet, see above). */
export const SIGNAL_POST_RADIUS = m(0.17);

export interface SignalPost {
  readonly node: NodeId;
  readonly segment: SegmentId;
  readonly x: number;
  readonly y: number;
  /** Heading the arm points in, over the road (world angle). */
  readonly yaw: number;
}

/** The post of one approach, or null if the segment is gone. */
export function signalPostPlace(net: Network, node: NodeId, segmentId: SegmentId): SignalPost | null {
  const segment = net.doc.segment(segmentId);
  if (!segment) return null;
  const road = roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking);
  const mouth = net.mouthDistance(segmentId, node);
  const polyline = net.polylines.get(net.doc, segmentId);
  // Sample outward from the node to find the kerb position, then reverse that tangent
  const outward = segment.a === node ? polyline : polyline.reversed();
  // A mid-block crossing has no junction mouth
  const record = net.doc.node(node);
  const midBlock = record?.crossing !== undefined && record.incident.length === 2;
  const distance = midBlock
    ? Math.min(net.stopLineDistance(segmentId, node), outward.length * 0.45)
    : Math.min(crosswalkDistance(mouth) + m(2), outward.length * 0.45);
  const frame = outward.sampleAt(distance);
  const travel = { x: -frame.t.x, y: -frame.t.y };
  const left = perp(travel);
  const right = { x: -left.x, y: -left.y };
  const position = addScaled(frame.p, right, road.width / 2 + SIGNAL_POST_KERB);
  return { node, segment: segmentId, x: position.x, y: position.y, yaw: angleOf({ x: -right.x, y: -right.y }) };
}

/** DO NOT ask for every post of the map to keep those round one point (a blast, `actionsWiring.ts`). */
/** The signalised junctions as the posts are placed from them: the lane graph's (`signalGroupsOf`), or the page's (`SimMirror`). */
export interface SignalGroups {
  /** Every junction that may have a signal. */
  nodes(): Iterable<NodeId>;
  /** A junction's signal groups, undefined when it has no signal. */
  groupsOf(node: NodeId): readonly { readonly segments: readonly SegmentId[] }[] | undefined;
}

/** The lane graph's signalised junctions (`SignalGroups`). */
export function signalGroupsOf(graph: LaneletGraph): SignalGroups {
  return {
    nodes: () => graph.junctions.keys(),
    groupsOf: (node) => { const junction = graph.junctions.get(node); return junction?.signalised ? junction.groups : undefined; },
  };
}

export function signalPosts(net: Network, signals: SignalGroups, near?: { readonly x: number; readonly y: number; readonly radius: number }): SignalPost[] {
  const out: SignalPost[] = [];
  let nodes: NodeId[];
  if (near) {
    const ends = new Set<NodeId>();
    for (const ribbon of net.ribbonsMeeting([near.x - near.radius, near.y - near.radius, near.x + near.radius, near.y + near.radius])) {
      const s = net.doc.segment(ribbon.id);
      if (s) { ends.add(s.a); ends.add(s.b); }
    }
    nodes = [...ends].filter((node) => signals.groupsOf(node) !== undefined).sort((a, b) => a - b);
  } else nodes = [...signals.nodes()].sort((a, b) => a - b);
  for (const node of nodes) {
    const groups = signals.groupsOf(node);
    if (!groups) continue;
    const record = net.doc.node(node);
    if (!record) continue;
    for (const segmentId of record.incident) {
      if (!groups.some((group) => group.segments.includes(segmentId))) continue;
      const post = signalPostPlace(net, node, segmentId);
      if (post) out.push(post);
    }
  }
  return out;
}
