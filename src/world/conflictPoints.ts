import { Digest } from '@core/digest';
import type { Vec2 } from '@core/vec2';
import type { NodeId } from './ids';
import type { Connector, ConnectorId, JunctionTopology, Lanelet, LaneletGraph } from './lanelets';
import { rebuildWork } from './rebuildWork';
import {
  BODY_CLASSES, BODY_ENVELOPE, type BodyClass, type ConflictKind, type ConflictRef, type Crossing, type Diverge, HEAVY, type PairFacts,
  type FinishAsk, type PairMeasurer, type PairZones, type SweepAsk, type SweepSamples, type Zone, firstCrossing, frameLengthsOf, joinedPath,
  lineDigest as digestOfLine, pairFacts, pairTable, pushDiverge, pushRef, shapeDigest, sweepFrame, sweepSpan, zonesOf,
} from './conflictTable';

import { WAITING, answered } from './waiting';

/** Yielded by `ConflictIndex.prepare` while its pairs are measured off the page (`waiting.ts`). */
export { WAITING } from './waiting';

export { BODY_CLASSES, BODY_ENVELOPE, type BodyClass, type ConflictKind, type ConflictRef, type Diverge, HEAVY,  } from './conflictTable';

export function bodyClassOf(length: number, width: number): BodyClass {
  for (const c of BODY_CLASSES) {
    const e = BODY_ENVELOPE[c] as { length: number; width: number };
    if (length <= e.length && width <= e.width) return c;
  }
  return HEAVY;
}

export interface ConflictPoint {
  readonly id: number;
  readonly node: NodeId;
  readonly a: ConnectorId;
  readonly b: ConnectorId;
  /** Earliest arc position of the zone along connector `a`, body front. */
  readonly sA: number;
  /** Earliest arc position of the zone along connector `b`, body front. */
  readonly sB: number;
  readonly kind: ConflictKind;
  readonly at: Vec2;
  /** Zone on `a` (or `b`) for a body of class `mine` against a body of class `theirs` on the other movement */
  zone(on: ConnectorId, mine: BodyClass, theirs: BodyClass): Zone | null;
}

/** Where two movements through a junction physically conflict. */
export class ConflictIndex {
  readonly points: ConflictPoint[] = [];
  /** References held by each connector, sorted by arc position. */
  readonly byConnector = new Map<ConnectorId, ConflictRef[]>();
  /** Sibling movements from the same lane whose bodies overlap near the split. */
  readonly diverges = new Map<ConnectorId, Diverge[]>();
  /** Movements whose zone reaches a body still waiting behind its stop line. */
  readonly queueIntrusions: { a: ConnectorId; b: ConnectorId; mine: BodyClass; theirs: BodyClass }[] = [];

  /** Conflict ids are resources held by live vehicles, so their meaning must survive a topology rebuild. */
  private readonly idByKey = new Map<string, number>();
  private nextId = 0;

  /** The zones of every pair measured by the previous build, keyed by the two sweeps' sampled geometry. */
  private pairCache = new Map<string, CachedPair>();

  /** The sampled frames of the movements, keyed by the three centrelines they are sampled along. */
  private sweepCache = new Map<string, Float64Array>();

  /** Every pair's zones known to this index, kept between sessions by the game (`seed`, `takeMeasured`). */
  private readonly store: KeptZones = { kept: new Map(), fresh: new Map() };

  /** Zones measured in an earlier session (the game keeps them in the browser, `main.ts`) */
  seed(kept: ReadonlyMap<string, Float64Array | null>): void {
    for (const [key, table] of kept) if (!this.store.kept.has(key)) this.store.kept.set(key, table);
  }

  /** The zones measured since the last call, to be kept (`seed` reads them back next session). */
  takeMeasured(): Map<string, Float64Array | null> {
    const fresh = new Map(this.store.fresh);
    this.store.fresh.clear();
    return fresh;
  }

  /** Measures, a pair at a time, the zones the next `build` of `graph` will need and the caches do not hold yet */
  /** Pairs measured (not read from the caches) by the last `build` and the last `prepare`: for the probes. */
  readonly measured = { build: 0, prepare: 0 };

  *prepare(graph: LaneletGraph, measurer?: PairMeasurer, only?: ReadonlySet<NodeId> | null): Generator<void | typeof WAITING, void> {
    this.measured.prepare = 0;
    /** The pairs to measure off the page (`measurer`), each key once. */
    const wanted: { key: string; a: Sweep; shapeA: SweepShape; b: Sweep; shapeB: SweepShape }[] = [];
    const asked = new Set<string>();
    /** Every pair these junctions read, each key once: their crossings and facts are worked out off the page too. */
    const read = new Map<string, { readonly a: Float64Array; readonly b: Float64Array }>();
    // The junctions an edit built again (`LaneletGraph.update`); every one only for a graph built whole.
    const junctions = only ? [...only].map((node) => graph.junctions.get(node)).filter((j): j is JunctionTopology => j !== undefined) : [...graph.junctions.values()];
    // The sweeps the caches do not hold, sampled by the workers when there are some: read back below.
    if (measurer?.sampleSweeps) yield* this.sampleOffPage(graph, junctions, measurer);
    this.prepared.clear();
    for (const junction of junctions) {
      rebuildWork.conflicts++;
      const ids = junction.connectors.slice().sort();
      const sweeps: Movement[] = [], pairKeys: string[] = [];
      for (const id of ids) {
        const c = graph.connectors.get(id);
        if (!c) continue;
        const keys: string[] = [];
        const sweep = sweepOf(graph, c, this.sweepCache, this.sweepCache, keys);
        if (sweep) sweeps.push({ connector: c, inbound: graph.lanelet(c.fromLane)!, outbound: graph.lanelet(c.toLane)!, sweep, shape: shapeOf(sweep), sweepKey: keys[0]! });
      }
      this.prepared.set(junction.node, { junction, ids, movements: sweeps, pairKeys });
      for (let i = 0; i < sweeps.length; i++) {
        for (let j = i + 1; j < sweeps.length; j++) {
          const a = sweeps[i]!, b = sweeps[j]!;
          const key = `${a.shape.hash}|${b.shape.hash}`;
          pairKeys.push(key);
          if (measurer?.finishPairs && !read.has(key)) read.set(key, { a: a.shape.centre, b: b.shape.centre });
          const known = this.pairCache.get(key);
          if (known && sameShape(known.a, a.shape) && sameShape(known.b, b.shape)) continue;
          const wasKept = this.store.kept.has(key);
          if (!wasKept && measurer) {
            if (!asked.has(key)) { asked.add(key); wanted.push({ key, a: a.sweep, shapeA: a.shape, b: b.sweep, shapeB: b.shape }); }
            continue;
          }
          this.pairCache.set(key, measurePair(key, a.sweep, a.shape, b.sweep, b.shape, this.store));
          if (wasKept) continue;
          this.measured.prepare++;
          yield;
        }
      }
    }
    if (measurer && wanted.length) yield* this.measureOffPage(wanted, measurer);
    if (measurer?.finishPairs && read.size) yield* this.finishOffPage(read, measurer);
  }

  /** The pairs `prepare` found new, measured by `measurer`'s workers (`conflictPool.ts`) and left in the caches. */
  private *measureOffPage(wanted: readonly { key: string; a: Sweep; shapeA: SweepShape; b: Sweep; shapeB: SweepShape }[],
    measurer: PairMeasurer): Generator<void | typeof WAITING, void> {
    // OFF THE PAGE: every new pair at once, across the measurer's workers
    const tables = yield* answered(measurer.measure(wanted.map((w) => ({ a: w.a, b: w.b, key: w.key }))), 'the pairs are measured');
    for (let k = 0; k < wanted.length; k++) {
      const w = wanted[k]!;
      const table = tables?.[k];
      this.pairCache.set(w.key, table !== undefined
        ? keepPair(w.key, w.shapeA, w.shapeB, table, this.store, !measurer.keeps)
        : measurePair(w.key, w.a, w.shapeA, w.b, w.shapeB, this.store));
      this.measured.prepare++;
      if (table === undefined) yield;
    }
  }

  /** DO NOT work them out on the page when there are workers */
  private *finishOffPage(read: ReadonlyMap<string, { readonly a: Float64Array; readonly b: Float64Array }>,
    measurer: PairMeasurer): Generator<void | typeof WAITING, void> {
    const pairs: CachedPair[] = [];
    const asks: FinishAsk[] = [];
    for (const [key, centres] of read) {
      const pair = this.pairCache.get(key);
      if (!pair?.table || (pair.crossing !== undefined && pair.facts !== undefined)) continue;
      pairs.push(pair);
      asks.push({ ...centres, table: pair.table });
    }
    const finished = asks.length ? yield* answered(measurer.finishPairs!(asks), 'the pairs are finished') : null;
    // One a build worked out meanwhile is the same answer, kept as it is.
    if (finished) {
      pairs.forEach((pair, k) => {
        const done = finished[k]!;
        if (pair.crossing === undefined) pair.crossing = done.crossing;
        pair.facts ??= done.facts;
      });
    }
  }

  /** DO NOT sample them on the page when there are workers */
  private *sampleOffPage(graph: LaneletGraph, junctions: readonly JunctionTopology[], measurer: PairMeasurer): Generator<void | typeof WAITING, void> {
    const asks: SweepAsk[] = [];
    /** The movement lanelet each ask was made from. */
    const crossings: Lanelet[] = [];
    const asked = new Set<string>();
    for (const junction of junctions) {
      for (const id of junction.connectors) {
        const c = graph.connectors.get(id);
        if (!c) continue;
        const inbound = graph.lanelet(c.fromLane), crossing = graph.lanelet(c.lanelet), outbound = graph.lanelet(c.toLane);
        if (!inbound || !crossing || !outbound) continue;
        const { c0, count } = sweepSpan(crossing.length);
        // Looked up when its three lines are digested; asked otherwise, the worker digesting them.
        const d0 = LINE_DIGESTS.get(inbound.centre.xy), d1 = LINE_DIGESTS.get(crossing.centre.xy), d2 = LINE_DIGESTS.get(outbound.centre.xy);
        if (d0 !== undefined && d1 !== undefined && d2 !== undefined) {
          const key = sweepKey(d0, d1, d2, count);
          if (this.sweepCache.has(key) || asked.has(key)) continue;
          asked.add(key);
        }
        asks.push({ inXY: inbound.centre.xy, crossXY: crossing.centre.xy, outXY: outbound.centre.xy, c0, count });
        crossings.push(crossing);
      }
    }
    const sweeps = asks.length ? yield* answered(measurer.sampleSweeps!(asks), 'the sweeps are sampled') : null;
    for (let k = 0; k < (sweeps?.length ?? 0); k++) {
      const ask = asks[k]!, sampled = sweeps![k]!;
      const [d0, d1, d2] = sampled.lines;
      if (!LINE_DIGESTS.has(ask.inXY)) LINE_DIGESTS.set(ask.inXY, d0);
      if (!LINE_DIGESTS.has(ask.crossXY)) LINE_DIGESTS.set(ask.crossXY, d1);
      if (!LINE_DIGESTS.has(ask.outXY)) LINE_DIGESTS.set(ask.outXY, d2);
      const key = sweepKey(d0, d1, d2, ask.count);
      // A frame the cache holds already is the one `sweepOf` reads back: kept, object and all.
      if (this.sweepCache.has(key)) continue;
      this.sweepCache.set(key, sampled.frame);
      FRAME_LENGTHS.set(sampled.frame, sampled.frameLengthSq);
      SHAPES.set(sampled.frame, shapeFrom(sampled.shape, ask.c0, ask.count, crossings[k]!, sampled.frame));
    }
  }

  /** What each junction made (`buildJunction`) */
  /** DO NOT read them again at the swap */
  private readonly prepared = new Map<NodeId, PreparedJunction>();

  /** The junction's record from `prepare` (`prepared`), if it was made from the very junction and lanes built now. */
  private takePrepared(graph: LaneletGraph, junction: JunctionTopology, previousSweeps: Map<string, Float64Array>, nextSweeps: Map<string, Float64Array>): PreparedJunction | null {
    const ready = this.prepared.get(junction.node);
    if (!ready) return null;
    this.prepared.delete(junction.node);
    if (ready.junction !== junction) return null;
    for (const m of ready.movements) {
      const c = m.connector;
      if (graph.connectors.get(c.id) !== c || graph.lanelet(c.fromLane) !== m.inbound || graph.lanelet(c.lanelet) !== m.sweep.crossing
        || graph.lanelet(c.toLane) !== m.outbound || (previousSweeps.get(m.sweepKey) ?? nextSweeps.get(m.sweepKey)) !== m.sweep.frame) return null;
    }
    return ready;
  }

  private readonly ofJunction = new Map<NodeId, { readonly points: number[]; readonly connectors: ConnectorId[]; readonly pairs: string[]; readonly sweeps: string[] }>();
  /** How many junctions read each cached pair and sweep: one no junction reads any more is let go. */
  private readonly pairUses = new Map<string, number>();
  private readonly sweepUses = new Map<string, number>();

  build(graph: LaneletGraph): void {
    this.points.length = 0;
    this.byConnector.clear();
    this.diverges.clear();
    this.queueIntrusions.length = 0;
    this.ofJunction.clear();
    this.pairUses.clear();
    this.sweepUses.clear();
    const previous = this.pairCache;
    const next = new Map<string, CachedPair>();
    const measuredBefore = pairsMeasured;
    const previousSweeps = this.sweepCache;
    const nextSweeps = new Map<string, Float64Array>();
    /** @rebuild Every junction: the first build, a map opened, a graph the network's delta could not follow. */
    for (const junction of graph.junctions.values()) this.buildJunction(graph, junction, previous, next, previousSweeps, nextSweeps);
    this.measured.build = pairsMeasured - measuredBefore;
    this.prepared.clear();
    this.pairCache = next;
    this.sweepCache = nextSweeps;
    // The zones kept from other maps and from roads since undone stay in memory only while they are few next to this map's
    if (this.store.kept.size > 4 * next.size + 4096) {
      for (const key of this.store.kept.keys()) if (!next.has(key) && !this.store.fresh.has(key)) this.store.kept.delete(key);
    }
    for (const list of this.byConnector.values()) list.sort((p, q) => p.s - q.s);
  }

  /** DO NOT build the index of the whole map for an edit */
  update(graph: LaneletGraph, junctions: ReadonlySet<NodeId>): void {
    const measuredBefore = pairsMeasured;
    /** What the junctions read before: let go once they are built again, so what they read again is kept. */
    const released: { readonly pairs: string[]; readonly sweeps: string[] }[] = [];
    for (const node of junctions) {
      const made = this.ofJunction.get(node);
      if (!made) continue;
      for (const id of made.points) delete this.points[id];
      const gone = new Set<ConnectorId>(made.connectors);
      for (const id of made.connectors) { this.byConnector.delete(id); this.diverges.delete(id); }
      // A reference or a diverge of a connector of another junction never names these (a pair is one junction's).
      for (let i = this.queueIntrusions.length - 1; i >= 0; i--) if (gone.has(this.queueIntrusions[i]!.a)) this.queueIntrusions.splice(i, 1);
      released.push(made);
      this.ofJunction.delete(node);
    }
    for (const node of [...junctions].sort((x, y) => x - y)) {
      const junction = graph.junctions.get(node);
      if (!junction) continue;
      this.buildJunction(graph, junction, this.pairCache, this.pairCache, this.sweepCache, this.sweepCache);
      for (const id of this.ofJunction.get(node)?.connectors ?? []) this.byConnector.get(id)?.sort((p, q) => p.s - q.s);
    }
    // DO NOT let them go before the junctions are built again
    for (const made of released) {
      for (const key of made.pairs) unuse(this.pairUses, this.pairCache, key);
      for (const key of made.sweeps) unuse(this.sweepUses, this.sweepCache, key);
    }
    this.measured.build = pairsMeasured - measuredBefore;
    this.prepared.clear();
  }

  /** One junction's conflicts, from the graph and the caches, with what it made recorded (`ofJunction`). */
  private buildJunction(graph: LaneletGraph, junction: JunctionTopology,
    previous: Map<string, CachedPair>, next: Map<string, CachedPair>,
    previousSweeps: Map<string, Float64Array>, nextSweeps: Map<string, Float64Array>): void {
    rebuildWork.conflicts++;
    const made = { points: [] as number[], connectors: [] as ConnectorId[], pairs: [] as string[], sweeps: [] as string[] };
    this.ofJunction.set(junction.node, made);
    const ready = this.takePrepared(graph, junction, previousSweeps, nextSweeps);
    const ids = ready?.ids ?? junction.connectors.slice().sort();
    made.connectors.push(...ids);
    const movements: Movement[] = [];
    if (ready) {
      for (const m of ready.movements) { nextSweeps.set(m.sweepKey, m.sweep.frame); made.sweeps.push(m.sweepKey); movements.push(m); }
    } else {
      for (const id of ids) {
        const c = graph.connectors.get(id);
        if (!c) continue;
        const sweep = sweepOf(graph, c, previousSweeps, nextSweeps, made.sweeps);
        if (sweep) movements.push({ connector: c, inbound: undefined, outbound: undefined, sweep, shape: shapeOf(sweep), sweepKey: '' });
      }
    }
    for (const key of made.sweeps) this.sweepUses.set(key, (this.sweepUses.get(key) ?? 0) + 1);

    let k = 0;
    for (let i = 0; i < movements.length; i++) {
      for (let j = i + 1; j < movements.length; j++) {
        const { connector: a, sweep: sa, shape: shapeA } = movements[i]!, { connector: b, sweep: sb, shape: shapeB } = movements[j]!;
        const pairKey = ready ? ready.pairKeys[k++]! : `${shapeA.hash}|${shapeB.hash}`;
        const pair = cachedPair(previous, next, pairKey, sa, shapeA, sb, shapeB, this.store);
        made.pairs.push(pairKey);
        this.pairUses.set(pairKey, (this.pairUses.get(pairKey) ?? 0) + 1);
        const zones = pair.zones;
        if (!zones) continue;

        if (a.fromLane === b.fromLane) {
          pushDiverge(this.diverges, a.id, b.id, zones, false);
          pushDiverge(this.diverges, b.id, a.id, zones, true);
          continue;
        }

        const facts = pair.facts ??= pairFacts(zones);
        this.recordIntrusions(a.id, b.id, facts);

        let kind: ConflictKind = 'swept';
        let at: Vec2;
        if (a.toLane === b.toLane) {
          kind = 'merge';
          at = sa.path.sampleAt(sa.crossing.length).p;
        } else {
          // Both depend only on the two sweeps, so they are kept with the pair.
          if (pair.crossing === undefined) {
            pair.crossing = firstCrossing(sa.crossing.centre.toPoints(), sb.crossing.centre.toPoints());
          }
          if (pair.crossing) {
            kind = 'cross';
            at = pair.crossing.at;
          } else {
            pair.centre ??= zoneCentre(sa, zones);
            at = pair.centre;
          }
        }
        made.points.push(this.add(junction.node, a.id, b.id, kind, at, zones, facts));
      }
    }
  }

  private recordIntrusions(a: ConnectorId, b: ConnectorId, facts: PairFacts): void {
    for (const x of facts.intrusions) this.queueIntrusions.push(x.onB ? { a: b, b: a, mine: x.mine, theirs: x.theirs } : { a, b, mine: x.mine, theirs: x.theirs });
  }

  private add(
    node: NodeId,
    a: ConnectorId,
    b: ConnectorId,
    kind: ConflictKind,
    at: Vec2,
    zones: PairZones,
    facts: PairFacts,
  ): number {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    // The key is the connector pair: a pair changing from a line crossing to a swept conflict after an edit is still the same
    const key = `${node}|${lo}|${hi}`;
    let id = this.idByKey.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.idByKey.set(key, id);
    }

    const { sA, sB } = facts;
    const point: ConflictPoint = {
      id,
      node,
      a,
      b,
      sA,
      sB,
      kind,
      at,
      zone: (on, mine, theirs) =>
        on === a ? zones.get(mine, theirs, false) : on === b ? zones.get(mine, theirs, true) : null,
    };
    // Assignment rather than push preserves the stable (possibly sparse) id.
    this.points[id] = point;
    pushRef(this.byConnector, a, { point: id, s: sA, other: b, kind, exit: facts.exitA });
    pushRef(this.byConnector, b, { point: id, s: sB, other: a, kind, exit: facts.exitB });
    return id;
  }

  refs(connector: ConnectorId): readonly ConflictRef[] {
    return this.byConnector.get(connector) ?? [];
  }

  divergesOf(connector: ConnectorId): readonly Diverge[] {
    return this.diverges.get(connector) ?? [];
  }

  /** True when the two connectors have at least one conflict point. */
  conflict(a: ConnectorId, b: ConnectorId): boolean {
    for (const r of this.refs(a)) if (r.other === b) return true;
    return false;
  }
}

// ------------------------------------------------------------------ sweeps

/** One use fewer of a cached key; the entry let go when no junction reads it. */
function unuse<V>(uses: Map<string, number>, cache: Map<string, V>, key: string): void {
  const left = (uses.get(key) ?? 1) - 1;
  if (left > 0) { uses.set(key, left); return; }
  uses.delete(key);
  cache.delete(key);
}

/** A movement's sweep (`conflictTable.ts` `SweepSamples`) and the lanelets it was sampled along. */
interface Sweep extends SweepSamples {
  readonly crossing: Lanelet;
  /** Approach, movement and exit joined, parametrised from the stop line. */
  readonly path: { sampleAt(c: number): { p: Vec2; t: Vec2 } };
}

function sweepOf(graph: LaneletGraph, c: Connector,
  previous: Map<string, Float64Array>, next: Map<string, Float64Array>, used?: string[]): Sweep | null {
  const inbound = graph.lanelet(c.fromLane);
  const crossing = graph.lanelet(c.lanelet);
  const outbound = graph.lanelet(c.toLane);
  if (!inbound || !crossing || !outbound) return null;

  const path = joinedPath(inbound.centre, crossing.centre, outbound.centre);
  const { c0, count } = sweepSpan(crossing.length);

  // The frame is a function of the three centrelines alone
  const key = sweepKey(lineDigest(inbound.centre.xy), lineDigest(crossing.centre.xy), lineDigest(outbound.centre.xy), count);
  // Sampled off the page beforehand when there are workers (`ConflictIndex.sampleOffPage`): read back here.
  const frame = previous.get(key) ?? next.get(key) ?? sweepFrame(path, c0, count);
  next.set(key, frame);
  used?.push(key);
  let frameLengthSq = FRAME_LENGTHS.get(frame);
  if (!frameLengthSq) {
    frameLengthSq = frameLengthsOf(frame);
    FRAME_LENGTHS.set(frame, frameLengthSq);
  }
  return { crossing, path, c0, count, length: crossing.length, frame, frameLengthSq, bounds: null, boxes: null, range: null };
}

/** The key of a sweep's frame in `sweepCache`: its three centrelines' digests and its sample count. */
function sweepKey(inbound: number, crossing: number, outbound: number, count: number): string {
  return `${new Digest().add(inbound).add(crossing).add(outbound).add(count).value()}`;
}

const FRAME_LENGTHS = new WeakMap<Float64Array, Float64Array>();

/** Everything `pairTable` reads from a sweep. Two equal shapes give equal zones. */
interface SweepShape {
  /** Hash of the fields below, for the cache key; equality is still checked in full. */
  readonly hash: string;
  readonly c0: number;
  readonly count: number;
  readonly length: number;
  readonly frame: Float64Array;
  /** The crossing's own centreline, which `firstCrossing` reads between samples. */
  readonly centre: Float64Array;
}

interface CachedPair {
  readonly a: SweepShape;
  readonly b: SweepShape;
  readonly zones: PairZones | null;
  /** The table the zones read (`pairTable`): what a worker finishes the pair from (`finishOffPage`). */
  readonly table: Float64Array | null;
  /** Where the two centrelines first cross; undefined until asked (`buildJunction`, `finishOffPage`). */
  crossing?: Crossing | null;
  /** Middle of the heavy-body zone on `a`; undefined until asked. */
  centre?: Vec2;
  /** What the index makes of the zones (`pairFacts`); undefined until asked (`buildJunction`, `finishOffPage`). */
  facts?: PairFacts;
}

/** A movement through a junction, swept: its connector, its sweep and shape and the key its frame is kept under. */
interface Movement {
  readonly connector: Connector;
  /** The lanes `prepare` swept it along (`takePrepared` checks they are the graph's); unset when built here. */
  readonly inbound: Lanelet | undefined;
  readonly outbound: Lanelet | undefined;
  readonly sweep: Sweep;
  readonly shape: SweepShape;
  readonly sweepKey: string;
}

/** A junction as `prepare` read it (`ConflictIndex.prepared`): its connectors, its swept movements, its pairs' keys in `buildJunction`'s order. */
interface PreparedJunction {
  readonly junction: JunctionTopology;
  readonly ids: readonly ConnectorId[];
  readonly movements: readonly Movement[];
  readonly pairKeys: readonly string[];
}

/** Each centreline's digest, kept with its point list (`sweepOf`; made by a worker, `sampleOffPage`). */
const LINE_DIGESTS = new WeakMap<Float64Array, number>();
function lineDigest(xy: Float64Array): number {
  let value = LINE_DIGESTS.get(xy);
  if (value === undefined) {
    value = digestOfLine(xy);
    LINE_DIGESTS.set(xy, value);
  }
  return value;
}

/** The shape of a sweep, kept with its frame */
const SHAPES = new WeakMap<Float64Array, SweepShape>();
function shapeOf(s: Sweep): SweepShape {
  const kept = SHAPES.get(s.frame);
  if (kept && kept.centre === s.crossing.centre.xy && kept.count === s.count && kept.c0 === s.c0 && kept.length === s.crossing.length) {
    return kept;
  }
  const shape = measureShape(s);
  SHAPES.set(s.frame, shape);
  return shape;
}

function measureShape(s: Sweep): SweepShape {
  // Only a key: a hit is confirmed by `sameShape` (`shapeDigest`).
  return shapeFrom(shapeDigest(s.frame, s.crossing.centre.xy), s.c0, s.count, s.crossing, s.frame);
}

/** A sweep's shape from its digest (`shapeDigest`, taken here or by a worker). */
function shapeFrom(digest: number, c0: number, count: number, crossing: Lanelet, frame: Float64Array): SweepShape {
  return {
    hash: `${digest.toString(36)}:${count}:${c0}:${crossing.length}`,
    c0,
    count,
    length: crossing.length,
    frame,
    centre: crossing.centre.xy,
  };
}

function sameShape(p: SweepShape, q: SweepShape): boolean {
  if (p === q) return true;
  if (p.count !== q.count || p.c0 !== q.c0 || p.length !== q.length) return false;
  return sameValues(p.frame, q.frame) && sameValues(p.centre, q.centre);
}

function sameValues(p: Float64Array, q: Float64Array): boolean {
  if (p === q) return true;
  if (p.length !== q.length) return false;
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}

/** Pairs measured by `cachedPair` since the module loaded (`ConflictIndex.measured`). */
let pairsMeasured = 0;

/** The zones kept from earlier sessions and those measured in this one, by pair key */
interface KeptZones {
  readonly kept: Map<string, Float64Array | null>;
  readonly fresh: Map<string, Float64Array | null>;
}

/** A pair measured, or read back from an earlier session. */
function measurePair(key: string, a: Sweep, shapeA: SweepShape, b: Sweep, shapeB: SweepShape, store: KeptZones): CachedPair {
  const kept = store.kept.get(key);
  if (kept !== undefined) return { a: shapeA, b: shapeB, zones: kept && zonesOf(kept), table: kept };
  return keepPair(key, shapeA, shapeB, pairTable(a, b), store);
}

/** A pair's table just measured (here or by a worker, `ConflictIndex.prepare`), kept for this session and the next. */
/** `fresh`: to be kept for the next session by the page (`takeMeasured`); not when its measurer kept it already. */
function keepPair(key: string, shapeA: SweepShape, shapeB: SweepShape, table: Float64Array | null, store: KeptZones, fresh = true): CachedPair {
  pairsMeasured++;
  store.kept.set(key, table);
  if (fresh) store.fresh.set(key, table);
  return { a: shapeA, b: shapeB, zones: table && zonesOf(table), table };
}

/** A pair's zones, answered from the previous build when neither sweep moved. */
function cachedPair(
  previous: Map<string, CachedPair>,
  next: Map<string, CachedPair>,
  key: string,
  a: Sweep,
  shapeA: SweepShape,
  b: Sweep,
  shapeB: SweepShape,
  store: KeptZones,
): CachedPair {
  const known = next.get(key) ?? previous.get(key);
  if (known && sameShape(known.a, shapeA) && sameShape(known.b, shapeB)) {
    next.set(key, known);
    return known;
  }
  const pair = measurePair(key, a, shapeA, b, shapeB, store);
  next.set(key, pair);
  return pair;
}

function zoneCentre(a: Sweep, zones: PairZones): Vec2 {
  const z = zones.get(HEAVY, HEAVY, false);
  return a.path.sampleAt(z ? (z.enter + z.exit) / 2 : 0).p;
}
