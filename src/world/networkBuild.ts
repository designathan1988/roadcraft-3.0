import { MIN_RIBBON } from '@core/scalar';
import type { RoadDoc, RoadNode, RoadSegment } from './doc';
import type { NodeId, SegmentId } from './ids';
import { Level, SURFACE_LEVELS, type SurfaceLevel, flushOn } from './roadTypes';
import { type Junction, buildJunction, surfaceMode } from './junction/build';
import { deriveJunctionLevel } from './junction/derive';
import { clampSegmentTrims } from './junction/trim';
import { MIN_LEG_ANGLE, legAngles, smallestGap } from './legAngles';
import { CellFiling } from './cells';
import type { ChangeRect } from './changes';
import { m } from './units';
import type { PolylineCache } from './geometry';
import type { NetworkDelta } from './networkDelta';
import { type SegmentRibbon, type SegmentTrims, bendAt, junctionBounds, makeRibbon, ribbonBounds } from './ribbons';
import { networkWork } from './rebuildWork';
import { ForkMap, ForkSet } from '@core/forkMap';

/** What the build writes: the network's own derived maps */
interface Network {
  readonly doc: RoadDoc;
  readonly polylines: PolylineCache;
  readonly junctions: Map<NodeId, Map<SurfaceLevel, Junction>>;
  readonly ribbons: Map<SegmentId, SegmentRibbon>;
  readonly trims: Map<SegmentId, SegmentTrims>;
  readonly plateReach: Map<string, number>;
  readonly transitions: Set<NodeId>;
  readonly impossible: Map<NodeId, number>;
  readonly squeezed: Map<NodeId, number>;
  readonly segmentCells: CellFiling<SegmentId, SegmentRibbon>;
  readonly junctionCells: CellFiling<NodeId, ReadonlyMap<SurfaceLevel, Junction>>;
  readonly flushCells: CellFiling<SegmentId, SegmentRibbon>;
}

/** A mouth cut this little short of where its carriageway separates from the neighbouring leg's is the solver's own */
const SQUEEZE_NOISE = m(0.4);

/** A junction solved for one pass, with what the pass handed it (`junctionKey`) and the plate it reaches. */
interface MemoEntry {
  readonly key: string;
  readonly byLevel: Map<SurfaceLevel, Junction>;
  readonly plate: readonly (readonly [SegmentId, number])[];
}

interface RibbonMemo {
  readonly ribbon: SegmentRibbon;
  readonly trims: string;
  readonly bendA: number;
  readonly bendB: number;
}

/** Everything a segment's polyline, ribbon and junction legs are built from: its record and where its two ends stand. */
function segmentSourceKey(doc: RoadDoc, s: RoadSegment): string {
  const a = doc.node(s.a), b = doc.node(s.b);
  return `${s.a}>${s.b}|${s.type}|${s.curve ? `${s.curve.t},${s.curve.h}` : '-'}|${s.dashOrigin}|${s.direction}|${s.lanes}|` +
    `${s.structure}|${s.section ? JSON.stringify(s.section) : '-'}|${s.parking ? JSON.stringify(s.parking) : '-'}|` +
    `${a ? `${a.x},${a.y}` : '-'}|${b ? `${b.x},${b.y}` : '-'}${s.cutWalls ? '|walls' : ''}`;
}

/** Everything of a node a junction there is built from: its place, height, roads by id, control, crossing and end. */
function nodeSourceKey(n: RoadNode): string {
  return `${n.x},${n.y}|${n.heightOffset}|${n.smooth ? 1 : 0}|${n.incident.join(',')}|${n.control}|` +
    `${n.blockedMovements.join(',')}|${n.crossing ? `${n.crossing.kind}:${n.crossing.segment}` : '-'}|${n.end ?? '-'}|${n.uturn ?? '-'}`;
}

/** The whole record of a node: what the traffic reads of it besides the geometry (lane links, signal settings, approach rules). */
function nodeRecordKey(n: RoadNode): string {
  return `${nodeSourceKey(n)}|${n.laneLinks ? JSON.stringify(n.laneLinks) : '-'}|${n.signal ? JSON.stringify(n.signal) : '-'}|` +
    `${n.approachRules ? JSON.stringify(n.approachRules) : '-'}`;
}

/** A point's rectangle, for filing a node by where it stands. */
const pointRect = (x: number, y: number): ChangeRect => [x, y, x, y];

/** THE NETWORK'S BUILD, INCREMENTAL */
export class NetworkBuild {
  /** The diary's serial the last rebuild read up to; -1: never built. */
  private seen = -1;
  private segmentSource = new Map<SegmentId, string>();
  private segmentEnds = new Map<SegmentId, readonly [NodeId, NodeId]>();
  private nodeSource = new Map<NodeId, string>();
  private nodeRecord = new Map<NodeId, string>();
  private nodeIncident = new Map<NodeId, readonly SegmentId[]>();
  private nodePlaces = new CellFiling<NodeId, object>();

  private active = new Set<NodeId>();
  private j1 = new Map<NodeId, MemoEntry>();
  private j2 = new Map<NodeId, MemoEntry>();
  private j3 = new Map<NodeId, MemoEntry>();
  private scale1 = new Map<SegmentId, number>();
  private scale2 = new Map<SegmentId, number>();
  private trims2 = new Map<SegmentId, SegmentTrims>();
  private plateRaw = new Map<NodeId, ReadonlyMap<SegmentId, number>>();
  /** The plate keys each road wrote (`node:segment`), to take them out when it changes. */
  private plateKeys = new Map<SegmentId, readonly string[]>();
  private ribbonMemo = new Map<SegmentId, RibbonMemo>();
  /** The largest id the ribbons and the junctions may hold (`insertionWatch`): an upper bound. */
  private ribbonMax = -Infinity;
  private junctionMax = -Infinity;

  constructor(private readonly net: Network) {}

  /** Forgets everything: the next rebuild builds every piece (a map loaded). */
  forget(): void {
    this.seen = -1;
    this.segmentSource = new Map();
    this.segmentEnds = new Map();
    this.nodeSource = new Map();
    this.nodeRecord = new Map();
    this.nodeIncident = new Map();
    this.nodePlaces = new CellFiling();
    this.active = new Set();
    this.j1 = new Map();
    this.j2 = new Map();
    this.j3 = new Map();
    this.scale1 = new Map();
    this.scale2 = new Map();
    this.trims2 = new Map();
    this.plateRaw = new Map();
    this.plateKeys = new Map();
    this.ribbonMemo = new Map();
    this.ribbonMax = -Infinity;
    this.junctionMax = -Infinity;
  }

  /** Takes another build's state as its own (`Network.adopt`) */
  copyFrom(other: NetworkBuild): void {
    this.seen = this.net.doc.changes.version;
    this.segmentSource = new Map(other.segmentSource);
    this.segmentEnds = new Map(other.segmentEnds);
    this.nodeSource = new Map(other.nodeSource);
    this.nodeRecord = new Map(other.nodeRecord);
    this.nodeIncident = new Map(other.nodeIncident);
    this.nodePlaces.copyFrom(other.nodePlaces);
    this.active = new Set(other.active);
    this.j1 = new Map(other.j1);
    this.j2 = new Map(other.j2);
    this.j3 = new Map(other.j3);
    this.scale1 = new Map(other.scale1);
    this.scale2 = new Map(other.scale2);
    this.trims2 = new Map(other.trims2);
    this.plateRaw = new Map(other.plateRaw);
    this.plateKeys = new Map(other.plateKeys);
    this.ribbonMemo = new Map(other.ribbonMemo);
    this.ribbonMax = other.ribbonMax;
    this.junctionMax = other.junctionMax;
  }

  /** DO NOT copy the build's records for an edit: a working copy over `other`'s (`Network.fork`), never written while it stands. */
  layOver(other: NetworkBuild): void {
    // Where the copy's diary starts (`ChangeJournal.forkFrom`): an older serial would read as everything changed.
    this.seen = other.net.doc.changes.version;
    this.segmentSource = new ForkMap(other.segmentSource);
    this.segmentEnds = new ForkMap(other.segmentEnds);
    this.nodeSource = new ForkMap(other.nodeSource);
    this.nodeRecord = new ForkMap(other.nodeRecord);
    this.nodeIncident = new ForkMap(other.nodeIncident);
    this.nodePlaces = other.nodePlaces.fork();
    this.active = new ForkSet(other.active);
    this.j1 = new ForkMap(other.j1);
    this.j2 = new ForkMap(other.j2);
    this.j3 = new ForkMap(other.j3);
    this.scale1 = new ForkMap(other.scale1);
    this.scale2 = new ForkMap(other.scale2);
    this.trims2 = new ForkMap(other.trims2);
    this.plateRaw = new ForkMap(other.plateRaw);
    this.plateKeys = new ForkMap(other.plateKeys);
    this.ribbonMemo = new ForkMap(other.ribbonMemo);
    this.ribbonMax = other.ribbonMax;
    this.junctionMax = other.junctionMax;
  }

  /** Takes back the records of a working copy laid over this build (`layOver`): what it wrote, or what it rebuilt whole. */
  takeBack(copy: NetworkBuild): void {
    this.seen = copy.seen;
    this.segmentSource = taken(this.segmentSource, copy.segmentSource);
    this.segmentEnds = taken(this.segmentEnds, copy.segmentEnds);
    this.nodeSource = taken(this.nodeSource, copy.nodeSource);
    this.nodeRecord = taken(this.nodeRecord, copy.nodeRecord);
    this.nodeIncident = taken(this.nodeIncident, copy.nodeIncident);
    if (copy.nodePlaces.isForkOf(this.nodePlaces)) this.nodePlaces.takeBack(copy.nodePlaces); else this.nodePlaces = copy.nodePlaces;
    if (copy.active instanceof ForkSet) copy.active.applyTo(this.active); else this.active = copy.active;
    this.j1 = taken(this.j1, copy.j1);
    this.j2 = taken(this.j2, copy.j2);
    this.j3 = taken(this.j3, copy.j3);
    this.scale1 = taken(this.scale1, copy.scale1);
    this.scale2 = taken(this.scale2, copy.scale2);
    this.trims2 = taken(this.trims2, copy.trims2);
    this.plateRaw = taken(this.plateRaw, copy.plateRaw);
    this.plateKeys = taken(this.plateKeys, copy.plateKeys);
    this.ribbonMemo = taken(this.ribbonMemo, copy.ribbonMemo);
    this.ribbonMax = copy.ribbonMax;
    this.junctionMax = copy.junctionMax;
  }

  /** Whether a full rebuild must follow (never built, or forgotten). */
  get empty(): boolean {
    return this.seen < 0;
  }

  /** @rebuild Brings the network up to the document; returns what changed (`null`: everything, a build from nothing). */
  rebuild(): NetworkDelta | null {
    const net = this.net, doc = net.doc;
    const fromNothing = this.seen < 0;
    const { segments: changedSegs, nodes: changedNodes, records } = this.findChanges();
    this.seen = doc.changes.version;

    const oldRects: ChangeRect[] = [];
    const ribbonOrder = insertionWatch(net.ribbons, this.ribbonMax);
    const junctionOrder = insertionWatch(net.junctions, this.junctionMax);
    const ribbonBefore = new Map<SegmentId, SegmentRibbon | undefined>();
    const junctionBefore = new Map<NodeId, ReadonlyMap<SurfaceLevel, Junction> | undefined>();

    // ---- sources: the polylines and memos of what changed go ---------------
    for (const id of changedSegs) {
      net.polylines.invalidate(id);
      this.ribbonMemo.delete(id);
    }
    for (const id of changedNodes) {
      this.j1.delete(id);
      this.j2.delete(id);
      this.j3.delete(id);
    }

    // ---- pass 1 -----------------------------------------------------------
    const n1 = changedNodes;
    for (const node of n1) {
      networkWork.marks++;
      const record = doc.node(node);
      const isActive = !!record && surfaceMode(doc, net.polylines, node) === 'junction';
      if (isActive) {
        this.active.add(node);
        this.j1.set(node, this.solveNode(node, new Map(), false, this.j1.get(node)));
      } else {
        this.active.delete(node);
      }
      // The mark of a node the editor would refuse (`Network.impossible`).
      const gap = record ? smallestGap(legAngles(doc, net.polylines, node)) : Infinity;
      if (gap < MIN_LEG_ANGLE) net.impossible.set(node, gap); else net.impossible.delete(node);
    }

    // ---- reconcile 1: the scales ------------------------------------------
    const s1 = new Set<SegmentId>();
    for (const id of changedSegs) if (doc.segment(id)) s1.add(id);
    for (const node of n1) for (const id of doc.node(node)?.incident ?? []) s1.add(id);
    const scaled1 = new Set<SegmentId>();
    for (const id of s1) {
      networkWork.segments++;
      const { scale } = this.reconcileSegment(id, (n) => this.junction1(n));
      if (scale !== (this.scale1.get(id) ?? 1)) scaled1.add(id);
      if (scale < 1) this.scale1.set(id, scale); else this.scale1.delete(id);
    }
    for (const id of changedSegs) if (!doc.segment(id)) { this.scale1.delete(id); this.scale2.delete(id); this.trims2.delete(id); }

    // ---- pass 2: the nodes under length pressure --------------------------
    const n2 = new Set(n1);
    for (const id of scaled1) this.addEnds(n2, id);
    const moved2 = new Set<NodeId>();
    for (const node of n2) {
      networkWork.junctions++;
      const before = this.junction2(node);
      if (this.active.has(node) && this.pressured(node, this.scale1)) {
        this.j2.set(node, this.solveNode(node, this.scale1, false, this.j2.get(node)));
      } else {
        this.j2.delete(node);
      }
      if (this.junction2(node) !== before) moved2.add(node);
    }

    // ---- reconcile 2: the trims --------------------------------------------
    const s2 = new Set(s1);
    for (const node of moved2) for (const id of doc.node(node)?.incident ?? []) s2.add(id);
    const retrimmed = new Set<SegmentId>();
    for (const id of s2) {
      networkWork.segments++;
      const { trims, scale } = this.reconcileSegment(id, (n) => this.junction2(n));
      const oldTrims = this.trims2.get(id);
      if (!oldTrims || JSON.stringify(oldTrims) !== JSON.stringify(trims) || scale !== (this.scale2.get(id) ?? 1)) retrimmed.add(id);
      this.trims2.set(id, trims);
      if (scale < 1) this.scale2.set(id, scale); else this.scale2.delete(id);
    }

    // ---- pass 3: the capped junctions --------------------------------------
    const n3 = new Set(n2);
    for (const node of moved2) n3.add(node);
    for (const id of retrimmed) this.addEnds(n3, id);
    const moved3 = new Set<NodeId>();
    for (const node of n3) {
      networkWork.junctions++;
      const before = net.junctions.get(node);
      junctionBefore.set(node, before);
      if (this.active.has(node) && this.pressured(node, this.scale2)) {
        this.j3.set(node, this.solveNode(node, this.scale2, true, this.j3.get(node)));
      } else {
        this.j3.delete(node);
      }
      const after = this.junction3(node);
      if (after) junctionOrder.set(node, after); else net.junctions.delete(node);
      if (after !== before) moved3.add(node);
    }

    // ---- plates: what each node's last solve reaches -----------------------
    const plated = new Set<NodeId>();
    for (const node of n3) {
      const plate = new Map<SegmentId, number>();
      if (this.active.has(node)) {
        for (const entry of [this.j1.get(node), this.j2.get(node), this.j3.get(node)]) {
          for (const [seg, reach] of entry?.plate ?? []) plate.set(seg, reach);
        }
      }
      const old = this.plateRaw.get(node);
      if (!old || !samePlate(old, plate)) plated.add(node);
      if (plate.size) this.plateRaw.set(node, plate); else this.plateRaw.delete(node);
    }

    // ---- the roads: final trims, plate reaches, ribbons --------------------
    const s3 = new Set<SegmentId>(s2);
    for (const id of retrimmed) s3.add(id);
    for (const node of moved3) for (const id of doc.node(node)?.incident ?? []) s3.add(id);
    for (const node of plated) for (const id of doc.node(node)?.incident ?? []) s3.add(id);
    for (const node of n1) for (const id of doc.node(node)?.incident ?? []) s3.add(id);
    for (const id of changedSegs) {
      if (doc.segment(id)) continue;
      // A road gone: everything it had.
      const ribbon = net.ribbons.get(id);
      ribbonBefore.set(id, ribbon);
      if (ribbon) oldRects.push(ribbonBounds(ribbon));
      net.ribbons.delete(id);
      net.segmentCells.remove(id);
      net.flushCells.remove(id);
      net.trims.delete(id);
      for (const key of this.plateKeys.get(id) ?? []) net.plateReach.delete(key);
      this.plateKeys.delete(id);
      this.ribbonMemo.delete(id);
    }
    const retrimmedFinal = new Set<SegmentId>();
    for (const id of s3) {
      networkWork.segments++;
      const seg = doc.segment(id);
      if (!seg) continue;
      const trims = this.finalTrims(id, seg);
      const old = net.trims.get(id);
      if (!old || JSON.stringify(old) !== JSON.stringify(trims)) retrimmedFinal.add(id);
      net.trims.set(id, trims);
      this.writePlate(id, seg);
      const before = net.ribbons.get(id);
      ribbonBefore.set(id, before);
      const ribbon = this.buildRibbon(id, seg, trims);
      if (ribbon !== before) {
        if (before) oldRects.push(ribbonBounds(before));
        ribbonOrder.set(id, ribbon);
      }
      const bounds = ribbonBounds(ribbon);
      net.segmentCells.file(id, ribbon, bounds);
      if (flushOn(ribbon.road, 'left') || flushOn(ribbon.road, 'right')) net.flushCells.file(id, ribbon, bounds);
      else net.flushCells.remove(id);
    }

    this.ribbonMax = ribbonOrder.done();
    this.junctionMax = junctionOrder.done();

    // ---- the nodes: transitions, cells, squeezes ---------------------------
    for (const node of n3) {
      const byLevel = net.junctions.get(node);
      if (byLevel?.get(Level.Asphalt)?.transition) net.transitions.add(node); else net.transitions.delete(node);
      const before = junctionBefore.get(node);
      if (before !== byLevel && before) { const b = junctionBounds(before); if (b) oldRects.push(b); }
      const bounds = byLevel ? junctionBounds(byLevel) : null;
      if (byLevel && bounds) net.junctionCells.file(node, byLevel, bounds); else net.junctionCells.remove(node);
    }
    const marked = new Set<NodeId>(n3);
    for (const id of retrimmedFinal) this.addEnds(marked, id);
    for (const id of changedSegs) this.addEnds(marked, id);
    for (const node of marked) {
      networkWork.marks++;
      const worst = this.squeeze(node);
      if (worst > SQUEEZE_NOISE) net.squeezed.set(node, worst); else net.squeezed.delete(node);
    }

    // ---- what changed, for whatever is derived from the network ------------
    if (fromNothing) return null;
    const segments = new Set<SegmentId>(changedSegs);
    const rects: ChangeRect[] = oldRects;
    for (const [id, before] of ribbonBefore) {
      const after = net.ribbons.get(id);
      if (after === before && !retrimmedFinal.has(id)) continue;
      segments.add(id);
      if (after) rects.push(ribbonBounds(after));
    }
    for (const id of retrimmedFinal) segments.add(id);
    for (const node of plated) for (const id of doc.node(node)?.incident ?? []) segments.add(id);
    const nodes = new Set<NodeId>(records);
    for (const node of changedNodes) nodes.add(node);
    for (const node of moved3) {
      nodes.add(node);
      const after = net.junctions.get(node);
      const b = after ? junctionBounds(after) : null;
      if (b) rects.push(b);
    }
    return { segments, nodes, rects };
  }

  /** The segments and nodes whose sources differ from what the last rebuild recorded, and the nodes whose record does */
  private findChanges(): { segments: Set<SegmentId>; nodes: Set<NodeId>; records: Set<NodeId> } {
    const doc = this.net.doc;
    const entries = this.seen < 0 ? null : doc.changes.since(this.seen, ['roads', 'traffic']);
    const candSegs = new Set<SegmentId>();
    const candNodes = new Set<NodeId>();
    let everything = entries === null;
    for (const entry of entries ?? []) {
      if (entry.rects === null) { everything = true; break; }
      for (const id of entry.ids ?? []) { candSegs.add(id as SegmentId); candNodes.add(id as NodeId); }
      for (const id of this.nodePlaces.idsMeetingAny(entry.rects)) candNodes.add(id);
    }
    if (everything) {
      // In increasing id order: what is built from nothing is filed in the order an edit files what it adds (`keepInIdOrder`).
      for (const id of [...new Set([...doc.segments.keys(), ...this.segmentSource.keys()])].sort((p, q) => p - q)) candSegs.add(id);
      for (const id of [...new Set([...doc.nodes.keys(), ...this.nodeSource.keys()])].sort((p, q) => p - q)) candNodes.add(id);
    } else {
      // A node moved moves its roads.
      for (const node of candNodes) {
        for (const id of doc.node(node)?.incident ?? []) candSegs.add(id);
        for (const id of this.nodeIncident.get(node) ?? []) candSegs.add(id);
      }
    }

    const segments = new Set<SegmentId>();
    for (const id of candSegs) {
      networkWork.sources++;
      const seg = doc.segment(id);
      const key = seg ? segmentSourceKey(doc, seg) : undefined;
      if (this.segmentSource.get(id) === key) continue;
      segments.add(id);
    }
    const nodes = new Set<NodeId>(), records = new Set<NodeId>();
    for (const id of segments) {
      for (const end of this.segmentEnds.get(id) ?? []) candNodes.add(end);
      const seg = doc.segment(id);
      if (seg) { candNodes.add(seg.a); candNodes.add(seg.b); }
    }
    for (const id of candNodes) {
      networkWork.sources++;
      const node = doc.node(id);
      const source = node ? nodeSourceKey(node) : undefined;
      const record = node ? nodeRecordKey(node) : undefined;
      let changed = this.nodeSource.get(id) !== source;
      for (const seg of node?.incident ?? []) if (!changed && segments.has(seg)) changed = true;
      for (const seg of this.nodeIncident.get(id) ?? []) if (!changed && segments.has(seg)) changed = true;
      if (changed) nodes.add(id);
      if (changed || this.nodeRecord.get(id) !== record) records.add(id);
    }

    // The sources recorded as they are now.
    for (const id of segments) {
      const seg = doc.segment(id);
      if (seg) {
        this.segmentSource.set(id, segmentSourceKey(doc, seg));
        this.segmentEnds.set(id, [seg.a, seg.b]);
      } else {
        this.segmentSource.delete(id);
        this.segmentEnds.delete(id);
      }
    }
    for (const id of records) {
      const node = doc.node(id);
      if (node) {
        this.nodeSource.set(id, nodeSourceKey(node));
        this.nodeRecord.set(id, nodeRecordKey(node));
        this.nodeIncident.set(id, node.incident.slice());
        this.nodePlaces.file(id, node, pointRect(node.x, node.y));
      } else {
        this.nodeSource.delete(id);
        this.nodeRecord.delete(id);
        this.nodeIncident.delete(id);
        this.nodePlaces.remove(id);
      }
    }
    return { segments, nodes, records };
  }

  private addEnds(into: Set<NodeId>, id: SegmentId): void {
    const seg = this.net.doc.segment(id);
    if (seg) { into.add(seg.a); into.add(seg.b); }
    for (const end of this.segmentEnds.get(id) ?? []) if (this.net.doc.node(end)) into.add(end);
  }

  private pressured(node: NodeId, scales: ReadonlyMap<SegmentId, number>): boolean {
    for (const id of this.net.doc.node(node)?.incident ?? []) if (scales.has(id)) return true;
    return false;
  }

  /** The junction a node has after each pass (null: none): the last pass that built one. */
  private junction1(node: NodeId): Map<SurfaceLevel, Junction> | null {
    const entry = this.j1.get(node);
    return entry && entry.byLevel.size ? entry.byLevel : null;
  }

  private junction2(node: NodeId): Map<SurfaceLevel, Junction> | null {
    const entry = this.j2.get(node);
    return entry && entry.byLevel.size ? entry.byLevel : this.junction1(node);
  }

  private junction3(node: NodeId): Map<SurfaceLevel, Junction> | null {
    const entry = this.j3.get(node);
    return entry && entry.byLevel.size ? entry.byLevel : this.junction2(node);
  }

  /** One node's junction for one pass: the entry made for the same key before when there is one */
  private solveNode(node: NodeId, scales: ReadonlyMap<SegmentId, number>, capped: boolean, known: MemoEntry | undefined): MemoEntry {
    networkWork.junctions++;
    const net = this.net, doc = net.doc;
    const key = this.junctionKey(node, scales, capped);
    if (known && known.key === key) return known;
    for (const entry of [this.j1.get(node), this.j2.get(node), this.j3.get(node)]) if (entry?.key === key) return entry;
    const plate: [SegmentId, number][] = [];
    const byLevel = new Map<SurfaceLevel, Junction>();
    const build = (level: SurfaceLevel): Junction | null => {
      const maxTrimBySegment = capped ? this.trimCapsAt(node, level) : undefined;
      return buildJunction(doc, net.polylines, node, level, {
        radiusScaleBySegment: scales,
        ...(maxTrimBySegment ? { maxTrimBySegment } : {}),
      });
    };
    // Solved once, on the carriageway; every outer surface is that outline carried out to its own edge (`junction/derive.ts`).
    const carriageway = build(Level.Asphalt);
    const footprint = build(Level.Casing);
    footprint?.legs.forEach((leg, i) => plate.push([leg.seg, footprint.trims[i] as number]));
    for (const level of SURFACE_LEVELS) {
      const j = level === Level.Asphalt
        ? carriageway
        : (carriageway ? deriveJunctionLevel(doc, net.polylines, carriageway, level) : null) ?? build(level);
      if (j) byLevel.set(level, j);
    }
    return { key, byLevel, plate };
  }

  /** What a pass hands a node's junction beyond the node and its roads */
  private junctionKey(node: NodeId, scales: ReadonlyMap<SegmentId, number>, capped: boolean): string {
    const doc = this.net.doc;
    const source = doc.node(node);
    if (!source) return 'gone';
    const parts: string[] = [capped ? 'capped' : 'free'];
    for (const id of source.incident) {
      const segment = doc.segment(id);
      if (!segment) { parts.push('gone'); continue; }
      parts.push(String(scales.get(id) ?? 1));
      if (capped) {
        const trims = this.trims2.get(id);
        parts.push(JSON.stringify(trims ? (segment.a === node ? trims.a : trims.b) : null));
      }
    }
    return parts.join('|');
  }

  /** Final per-leg caps for one junction after segment-end reconciliation. */
  private trimCapsAt(node: NodeId, level: SurfaceLevel): ReadonlyMap<SegmentId, number> {
    const doc = this.net.doc;
    const caps = new Map<SegmentId, number>();
    const source = doc.node(node);
    if (!source) return caps;
    for (const id of source.incident) {
      const segment = doc.segment(id);
      const trims = this.trims2.get(id);
      if (!segment || !trims) continue;
      const side = segment.a === node ? trims.a : trims.b;
      caps.set(id, side[level] ?? 0);
    }
    return caps;
  }

  /** One segment's two ends reconciled against its length, per level, from the junctions at its ends */
  private reconcileSegment(id: SegmentId, junctionAt: (node: NodeId) => ReadonlyMap<SurfaceLevel, Junction> | null): { trims: SegmentTrims; scale: number } {
    const doc = this.net.doc;
    const seg = doc.requireSegment(id);
    const t: { a: Record<number, number>; b: Record<number, number> } = { a: {}, b: {} };
    let floor: { a: number; b: number } | undefined;
    for (const node of seg.a === seg.b ? [seg.a] : [seg.a, seg.b]) {
      const byLevel = junctionAt(node);
      if (!byLevel) continue;
      for (const [level, junction] of byLevel) {
        junction.legs.forEach((leg, i) => {
          if (leg.seg !== id) return;
          const side = seg.a === node ? t.a : t.b;
          side[level] = Math.max(side[level] ?? 0, junction.trims[i] as number);
        });
      }
      // The part of a mouth no length budget may take
      const junction = byLevel.get(Level.Asphalt);
      if (!junction || junction.transition) continue;
      for (const corner of junction.corners) {
        const x = corner.x;
        if (!x || corner.psi >= Math.PI / 2) continue;
        for (const index of [corner.i, corner.j]) {
          const leg = junction.legs[index];
          if (!leg || leg.seg !== id) continue;
          const along = (x.x - leg.origin.x) * leg.dir.x + (x.y - leg.origin.y) * leg.dir.y;
          if (!(along > 0)) continue;
          const h = floor ?? { a: 0, b: 0 };
          if (seg.a === node) h.a = Math.max(h.a, along); else h.b = Math.max(h.b, along);
          floor = h;
        }
      }
    }
    const length = this.net.polylines.get(doc, id).length;
    let worst = 1;
    for (const level of SURFACE_LEVELS) {
      const a = t.a[level] ?? 0;
      const b = t.b[level] ?? 0;
      const clamped = clampSegmentTrims({ a, b, length });
      let ca = clamped.a, cb = clamped.b;
      if (floor && clamped.scale < 1) {
        // The budget may squeeze the kerb returns, never the overlap itself
        const fa = Math.min(a, floor.a), fb = Math.min(b, floor.b);
        if (fa + fb <= length - MIN_RIBBON) { ca = Math.max(ca, fa); cb = Math.max(cb, fb); }
      }
      t.a[level] = ca;
      t.b[level] = cb;
      if (clamped.scale < worst) worst = clamped.scale;
    }
    return { trims: t, scale: worst };
  }

  /** The reconciled trims lowered to what the final junctions actually used */
  private finalTrims(id: SegmentId, seg: RoadSegment): SegmentTrims {
    const base = this.trims2.get(id)!;
    const t = { a: { ...base.a }, b: { ...base.b } };
    for (const node of seg.a === seg.b ? [seg.a] : [seg.a, seg.b]) {
      const byLevel = this.net.junctions.get(node);
      if (!byLevel) continue;
      for (const [level, junction] of byLevel) {
        junction.legs.forEach((leg, i) => {
          if (leg.seg !== id) return;
          const side = seg.a === node ? t.a : t.b;
          side[level] = Math.min(side[level] ?? Infinity, junction.trims[i] as number);
        });
      }
    }
    return t;
  }

  /** A road's plate reaches (`Network.plateReach`), reconciled against its length the way the trims are */
  private writePlate(id: SegmentId, seg: RoadSegment): void {
    const net = this.net;
    for (const key of this.plateKeys.get(id) ?? []) net.plateReach.delete(key);
    const keyA = `${seg.a}:${id}`, keyB = `${seg.b}:${id}`;
    const a = this.plateRaw.get(seg.a)?.get(id);
    const b = this.plateRaw.get(seg.b)?.get(id);
    if (a === undefined && b === undefined) { this.plateKeys.delete(id); return; }
    const clamped = clampSegmentTrims({ a: a ?? 0, b: b ?? 0, length: net.polylines.get(net.doc, id).length });
    // A road that comes back to its node has one key for both ends: the second write stands.
    if (a !== undefined) net.plateReach.set(keyA, clamped.a);
    if (b !== undefined) net.plateReach.set(keyB, clamped.b);
    this.plateKeys.set(id, keyA === keyB ? [keyA] : [keyA, keyB]);
  }

  /** How far the worst mouth of a junction is cut short of where two of its legs' carriageways stop overlapping */
  private squeeze(node: NodeId): number {
    const net = this.net;
    const junction = net.junctions.get(node)?.get(Level.Asphalt);
    if (!junction || junction.transition) return 0;
    let worst = 0;
    for (const corner of junction.corners) {
      const x = corner.x;
      if (!x || corner.psi >= Math.PI / 2) continue;
      for (const index of [corner.i, corner.j]) {
        const leg = junction.legs[index];
        const seg = leg ? net.doc.segment(leg.seg) : undefined;
        const trims = leg ? net.trims.get(leg.seg) : undefined;
        if (!leg || !seg || !trims) continue;
        const along = (x.x - leg.origin.x) * leg.dir.x + (x.y - leg.origin.y) * leg.dir.y;
        const trim = (seg.a === node ? trims.a : trims.b)[Level.Asphalt] ?? 0;
        worst = Math.max(worst, along - trim);
      }
    }
    return worst;
  }


  /** A road's ribbon: the one it had when its road, its trims and the bends at its ends are the same. */
  private buildRibbon(id: SegmentId, seg: RoadSegment, t: SegmentTrims): SegmentRibbon {
    const net = this.net;
    const trimsKey = JSON.stringify(t);
    const bendA = bendAt(net.doc, net.polylines, seg.a, id);
    const bendB = bendAt(net.doc, net.polylines, seg.b, id);
    const known = this.ribbonMemo.get(id);
    if (known && known.trims === trimsKey && known.bendA === bendA && known.bendB === bendB) return known.ribbon;
    const ribbon = makeRibbon(net.doc, net.polylines, id, seg, t, bendA, bendB);
    this.ribbonMemo.set(id, { ribbon, trims: trimsKey, bendA, bendB });
    return ribbon;
  }
}

/** A working copy's map taken back into `mine`: its writes when it is laid over `mine` (`ForkMap`), else itself (built whole). */
function taken<K, V>(mine: Map<K, V>, theirs: Map<K, V>): Map<K, V> {
  if (!(theirs instanceof ForkMap)) return theirs;
  theirs.applyTo(mine);
  return mine;
}

/** Sets entries of a map kept in increasing key order */
function insertionWatch<V>(map: Map<number, V>, largest: number): { set(id: number, value: V): void; done(): number } {
  let max = largest;
  let unordered = false;
  return {
    set(id: number, value: V): void {
      if (!map.has(id)) {
        if (id < max) unordered = true;
        else max = id;
      }
      map.set(id, value);
    },
    /** Lays the map out in order when needed; returns the largest key it may hold (an upper bound). */
    done(): number {
      if (!unordered) return max;
      const entries = [...map].sort((p, q) => p[0] - q[0]);
      map.clear();
      for (const [id, value] of entries) map.set(id, value);
      return entries.length ? entries[entries.length - 1]![0] : -Infinity;
    },
  };
}

function samePlate(a: ReadonlyMap<SegmentId, number>, b: ReadonlyMap<SegmentId, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}
