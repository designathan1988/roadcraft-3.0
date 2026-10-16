import { CROSSWALK_DEPTH, MIN_LINK_LENGTH, STOP_BAR_SETBACK } from '@world/approach';
import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { roadProfile } from '@world/roadTypes';
import { sectionOf } from '@world/section';
import { splitSegment } from './commit';
import { LaneletGraph } from '@world/lanelets';
import { MEDIAN_UTURN_OPENING } from '@world/landscape';

export type PedestrianCrossingKind = 'zebra' | 'signal';
export type PedestrianCrossingResult =
  | { readonly committed: true; readonly node: NodeId; readonly segments: readonly SegmentId[] }
  | { readonly committed: false; readonly reason: 'unsupported' | 'tooShort' | 'geometry' };

/** Inserts one crossing whose centre is at the selected arc distance (midpoint by default). */
export function commitPedestrianCrossing(
  doc: RoadDoc,
  net: Network,
  segmentId: SegmentId,
  kind: PedestrianCrossingKind,
  s?: number,
): PedestrianCrossingResult {
  const segment = doc.segment(segmentId);
  if (!segment || (kind !== 'zebra' && kind !== 'signal') || segment.structure === 'tunnel') {
    return { committed: false, reason: 'unsupported' };
  }
  const profile = roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking);
  if (!sectionOf(profile, segment.direction).walkable || profile.sidewalk <= 0) {
    return { committed: false, reason: 'unsupported' };
  }
  const original = net.polylines.get(doc, segmentId);
  const selected = s ?? original.length / 2;
  const splitAt = selected + CROSSWALK_DEPTH / 2;
  // Reserve a whole drivable link beyond each approach, including the far junction's stop line.
  const reserve = MIN_LINK_LENGTH + CROSSWALK_DEPTH + STOP_BAR_SETBACK;
  if (!Number.isFinite(selected) ||
      splitAt < net.stopLineDistance(segmentId, segment.a) + reserve ||
      original.length - splitAt < net.stopLineDistance(segmentId, segment.b) + reserve) {
    return { committed: false, reason: 'tooShort' };
  }

  const work = doc.fork();
  const workNet = net.fork(work);
  const node = splitSegment(work, workNet, segmentId, splitAt, original.sampleAt(splitAt).p);
  if (node === null || node === segment.a || node === segment.b) {
    return { committed: false, reason: 'geometry' };
  }
  const record = work.requireNode(node);
  if (record.incident.length !== 2) return { committed: false, reason: 'geometry' };
  const segments = [...record.incident].sort((a, b) => a - b);
  const owner = segments.find((id) => work.requireSegment(id).a === segment.a);
  if (owner === undefined) return { committed: false, reason: 'geometry' };
  work.setNodeCrossing(node, kind, owner);
  workNet.rebuild();
  // Refuse if the new topology cannot carry the crossing the player requested.
  if (workNet.impossible.has(node) ||
      segments.filter((id) => workNet.crosswalkDistanceAt(id, node) > 0).length !== 1) {
    return { committed: false, reason: 'geometry' };
  }
  doc.takeBack(work);
  net.takeBack(workNet);
  return { committed: true, node, segments };
}

export type UturnResult =
  | { readonly committed: true; readonly node: NodeId }
  | { readonly committed: false; readonly reason: 'noMedian' | 'tooShort' | 'narrow' | 'geometry' };

/** Puts a U-turn through the median at the selected arc distance (the middle by default, retorno) */
export function commitUturn(doc: RoadDoc, net: Network, segmentId: SegmentId, toward: 'a' | 'b', s?: number): UturnResult {
  const segment = doc.segment(segmentId);
  if (!segment || segment.structure === 'tunnel') return { committed: false, reason: 'geometry' };
  const profile = roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking);
  if (segment.direction !== 'both' || profile.median <= 0) return { committed: false, reason: 'noMedian' };
  const original = net.polylines.get(doc, segmentId);
  const at = s ?? original.length / 2;
  const reserve = MIN_LINK_LENGTH + MEDIAN_UTURN_OPENING;
  if (!Number.isFinite(at) || at < net.stopLineDistance(segmentId, segment.a) + reserve ||
      original.length - at < net.stopLineDistance(segmentId, segment.b) + reserve) {
    return { committed: false, reason: 'tooShort' };
  }
  const work = doc.fork();
  const workNet = net.fork(work);
  const node = splitSegment(work, workNet, segmentId, at, original.sampleAt(at).p);
  if (node === null || node === segment.a || node === segment.b || work.requireNode(node).incident.length !== 2) {
    return { committed: false, reason: 'geometry' };
  }
  // The piece its traffic arrives from: heading for `b`, the one from `a`.
  const pieces = [...work.requireNode(node).incident];
  const fromA = pieces.find((id) => work.requireSegment(id).a === segment.a || work.requireSegment(id).b === segment.a);
  const from = toward === 'b' ? fromA : pieces.find((id) => id !== fromA);
  if (from === undefined) return { committed: false, reason: 'geometry' };
  work.setNodeUturn(node, from);
  workNet.rebuild();
  const graph = new LaneletGraph();
  graph.build(work, workNet);
  const car = 1;
  const fits = [...graph.connectors.values()].some((c) => c.node === node && c.turn === 'uturn' && c.maxBodyClass >= car);
  if (!fits) return { committed: false, reason: 'narrow' };
  doc.takeBack(work);
  net.takeBack(workNet);
  return { committed: true, node };
}
