import type { NodeId, SegmentId } from '@world/ids';
import { type LaneletGraph, laneletId } from '@world/lanelets';
import type { LaneLink } from '@world/roads/connectors';
import type { AutoControl } from './roads/controlAdvisor';
import { type SignalState, signalStateFor } from './signals/query';
import type { SimWorld } from './world';

/** WHAT THE INSPECTOR SHOWS OF THE TRAFFIC: a road's or a junction's live numbers and lanes, as plain data */

/** The traffic on a road's lanes now. */
export interface SegmentTraffic {
  readonly occupancy: number;
  readonly queued: number;
  readonly speedSum: number;
  readonly speedCount: number;
  readonly capacity: number;
  readonly volume: number;
}

/** A lane's end at a junction, as the connector editor draws it: where it ends and the point before it. */
interface LaneEnd {
  readonly segment: SegmentId;
  readonly lane: number;
  readonly x: number;
  readonly y: number;
  /** The neighbouring point along the lane (before the end arriving, after it leaving). */
  readonly nx: number;
  readonly ny: number;
}

/** A junction as the inspector, the junction panel and the connector editor read it. */
export interface JunctionTraffic {
  /** Whether the lane graph has the junction at all. */
  readonly built: boolean;
  readonly signalised: boolean;
  readonly autoChoice: AutoControl | null;
  readonly movements: number;
  /** The traffic arriving: vehicles on the lanes, queued, their speeds, the lanes' room. */
  readonly active: number;
  readonly queued: number;
  readonly speedSum: number;
  readonly speedCount: number;
  readonly capacity: number;
  readonly volume: number;
  /** Vehicles an hour on each leg (`FlowStats.rate`). */
  readonly flows: readonly { readonly segment: SegmentId; readonly perHour: number }[];
  /** The signal: its cycle, stage, sub-phase, each group's lamp and each stage's green; null with none. */
  readonly signal: {
    readonly cycle: number;
    readonly stageIndex: number;
    readonly stages: number;
    readonly sub: string;
    readonly targetGreens: readonly number[];
    readonly groups: readonly { readonly id: number; readonly state: SignalState }[];
  } | null;
  /** Each movement through it: the leg it comes from, the one it goes to, its turn. */
  readonly moves: readonly { readonly from: SegmentId; readonly to: SegmentId; readonly turn: string | null }[];
  /** The lanes arriving and leaving and the connections built between them (`connectorPanel.ts`). */
  readonly arriving: readonly LaneEnd[];
  readonly leaving: readonly LaneEnd[];
  readonly links: readonly LaneLink[];
}

/** The traffic on a road's lanes, both ways: read lane by lane, never by walking the city's lanes. */
export function segmentTraffic(w: SimWorld, id: SegmentId): SegmentTraffic | null {
  const seg = w.doc.segment(id);
  if (!seg) return null;
  let occupancy = 0, queued = 0, speedSum = 0, speedCount = 0, capacity = 0;
  for (const [from, to] of [[seg.a, seg.b], [seg.b, seg.a]] as const) {
    for (let k = 0; ; k++) {
      const lane = w.graph.lanelet(laneletId(id, from, to, k));
      if (!lane) break;
      capacity += Math.max(1, lane.length / 12);
      const order = w.runtime.get(lane.id)?.order;
      if (!order) continue;
      occupancy += order.length;
      for (const vehicleId of order) {
        const vehicle = w.veh(vehicleId);
        if (!vehicle) continue;
        speedSum += vehicle.v;
        speedCount++;
        if (vehicle.v < 0.6) queued++;
      }
    }
  }
  return { occupancy, queued, speedSum, speedCount, capacity, volume: w.segmentVolume.get(id) ?? 0 };
}

/** A junction's traffic, signal and lanes now; null when the node is gone. */
export function junctionTraffic(w: SimWorld, id: NodeId): JunctionTraffic | null {
  const node = w.doc.node(id);
  if (!node) return null;
  const junction = w.graph.junctions.get(id);
  let active = 0, queued = 0, speedSum = 0, speedCount = 0, capacity = 0;
  for (const laneId of junction?.inbound ?? []) {
    const lane = w.lanelet(laneId);
    if (!lane) continue;
    const runtime = w.rt(laneId);
    active += runtime.order.length;
    capacity += Math.max(1, lane.length / 12);
    for (const vehicleId of runtime.order) {
      const vehicle = w.veh(vehicleId);
      if (!vehicle) continue;
      speedSum += vehicle.v;
      speedCount++;
      if (vehicle.v < 0.6) queued++;
    }
  }
  const controller = w.controller(id);
  const signalised = junction?.signalised === true;
  const moves: { from: SegmentId; to: SegmentId; turn: string | null }[] = [];
  for (const cid of junction?.connectors ?? []) {
    const c = w.connector(cid);
    if (c) moves.push({ from: c.inSegment, to: c.outSegment, turn: c.turn ?? null });
  }
  const lanes = laneEnds(w.graph, id);
  return {
    built: junction !== undefined,
    signalised,
    autoChoice: w.advisor.choice(id) ?? null,
    movements: junction?.connectors.length ?? 0,
    active, queued, speedSum, speedCount, capacity,
    volume: node.incident.reduce((total, segment) => total + (w.segmentVolume.get(segment) ?? 0), 0),
    flows: node.incident.map((segment) => ({ segment, perHour: w.flow.rate(id, segment) })),
    signal: controller && signalised ? {
      cycle: controller.plan.cycle,
      stageIndex: controller.stageIndex,
      stages: controller.plan.stages.length,
      sub: controller.sub,
      targetGreens: controller.plan.stages.map((s) => s.targetGreen),
      groups: (junction?.groups ?? []).map((g) => ({ id: g.id, state: signalStateFor(controller, g.id) })),
    } : null,
    moves,
    ...lanes,
  };
}

/** The node's lanes and built connections, read from the lane graph (`connectorPanel.ts` `nodeLanes`). */
function laneEnds(graph: LaneletGraph, node: NodeId): Pick<JunctionTraffic, 'arriving' | 'leaving' | 'links'> {
  const junction = graph.junctions.get(node);
  if (!junction) return { arriving: [], leaving: [], links: [] };
  const end = (id: string, arriving: boolean): LaneEnd | null => {
    const l = graph.lanelet(id);
    if (!l || l.segment === undefined) return null;
    const pts = l.centre.toPoints();
    const p = arriving ? pts[pts.length - 1]! : pts[0]!;
    const q = arriving ? pts[Math.max(0, pts.length - 2)]! : pts[Math.min(pts.length - 1, 1)]!;
    return { segment: l.segment, lane: l.laneIndex ?? 0, x: p.x, y: p.y, nx: q.x, ny: q.y };
  };
  const arriving = (graph.inbound.get(node) ?? []).map((id) => end(id, true)).filter((x): x is LaneEnd => x !== null);
  const leaving = (graph.outbound.get(node) ?? []).map((id) => end(id, false)).filter((x): x is LaneEnd => x !== null);
  const links: LaneLink[] = [];
  for (const id of junction.connectors) {
    const c = graph.connectors.get(id);
    const a = c && graph.lanelet(c.fromLane), b = c && graph.lanelet(c.toLane);
    if (a?.segment !== undefined && b?.segment !== undefined) links.push({ from: a.segment, fromLane: a.laneIndex ?? 0, to: b.segment, toLane: b.laneIndex ?? 0 });
  }
  return { arriving, leaving, links };
}
