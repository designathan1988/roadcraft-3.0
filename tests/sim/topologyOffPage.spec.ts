import { describe, expect, it, vi } from 'vitest';
import { SimWorld } from '@sim/world';
import { Network } from '@world/network';
import { type LaneletGraph } from '@world/lanelets';
import { WAITING } from '@world/conflictPoints';
import { type PairMeasurer, type SampledSweep, type SweepSamples, finishPair, pairTable, sampleSweep } from '@world/conflictTable';
import type { ChosenTurn } from '@world/junctionTurns';
import type { JunctionSurface } from '@world/turnPaths';
import { chooseTurnOf } from '@world/turnChoice';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import type { RoadDoc } from '@world/doc';
import { Polyline } from '@core/polyline';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate } from '../fuzz/support/runner';
import { conflictLines, graphLines } from '../world/support/graphLines';
import { m } from '@world/units';
import { roundCorners } from '@world/walkingLines';
import { Digest } from '@core/digest';
import { buildJunctionOf } from '@world/junctionBuild';
import { restoreInto } from '@editor/history';

/** The generated towns' radius: a few dozen junctions, every kind the generator lays, inside a test's time. */
const TOWN = m(260);
/** A smaller one, where the town's size is not what is checked. */
const SMALL_TOWN = m(200);

/** THE TRAFFIC'S TOPOLOGY PREPARED OFF THE PAGE (`SimWorld.prepareVehicleTopology` with workers, `conflictPool.ts`) */
interface Workers extends PairMeasurer {
  /** Every frame a worker sampled, as the page received it. */
  readonly frames: Set<Float64Array>;
  /** Every connector path a worker made, as the page received it. */
  readonly paths: Set<Float64Array>;
  readonly asked: { sweeps: number; pairs: number; turns: number; finished: number; corners: number; junctions: number };
}

function workers(failSweeps = false): Workers {
  const frames = new Set<Float64Array>();
  const paths = new Set<Float64Array>();
  const asked = { sweeps: 0, pairs: 0, turns: 0, finished: 0, corners: 0, junctions: 0 };
  return {
    frames,
    paths,
    buildJunctions(asks) {
      if (failSweeps) return Promise.reject(new Error('no workers'));
      asked.junctions += asks.length;
      const sent = structuredClone(asks);
      const lines = new Map<Float64Array, Polyline>(), rings = new Map<Float64Array, { x: number; y: number }[]>();
      const answer = structuredClone(sent.map((a) => buildJunctionOf(a, lines, rings)));
      for (const j of answer) for (const c of j.connectors) paths.add(c.path);
      return Promise.resolve(answer);
    },
    asked,
    measure(pairs) {
      asked.pairs += pairs.length;
      const plain = (s: SweepSamples) => ({ c0: s.c0, count: s.count, length: s.length, frame: s.frame, frameLengthSq: s.frameLengthSq });
      const sent = structuredClone(pairs.map((p) => ({ a: plain(p.a), b: plain(p.b) })));
      const fresh = (s: ReturnType<typeof plain>): SweepSamples => ({ ...s, bounds: null, boxes: null, range: null });
      return Promise.resolve(structuredClone(sent.map((p) => pairTable(fresh(p.a), fresh(p.b)))));
    },
    chooseTurns(asks, surfaces) {
      asked.turns += asks.length;
      const sent = structuredClone(asks), rings = structuredClone(surfaces);
      const made = new Map<string, JunctionSurface>();
      return Promise.resolve(structuredClone(sent.map((t) => chooseTurnOf(t, rings.get(t.surfaceKey)!, made))) as ChosenTurn[]);
    },
    sampleSweeps(asks) {
      if (failSweeps) return Promise.reject(new Error('no workers'));
      asked.sweeps += asks.length;
      const sent = structuredClone(asks);
      const lines = new Map<Float64Array, { line: Polyline; digest: number }>();
      const answer: SampledSweep[] = structuredClone(sent.map((a) => sampleSweep(a, lines)));
      for (const s of answer) frames.add(s.frame);
      return Promise.resolve(answer);
    },
    roundCorners(asks) {
      asked.corners += asks.length;
      return Promise.resolve(structuredClone(structuredClone(asks).map((a) => roundCorners(a))));
    },
    finishPairs(pairs) {
      asked.finished += pairs.length;
      const sent = structuredClone(pairs);
      return Promise.resolve(structuredClone(sent.map((p) => finishPair(Polyline.fromFlat(p.a).toPoints(), Polyline.fromFlat(p.b).toPoints(), p.table))));
    },
  };
}

/** The pairs the index holds, with their zones, and their crossing and facts as far as they are known. */
const pairsOf = (w: SimWorld) => (w.conflicts as unknown as { pairCache: Map<string, { zones: unknown; crossing?: unknown; facts?: unknown }> }).pairCache;

/** The topology brought up to the network as the frame loop does (`TopologyCatchUp`): WAITING waits for the workers. */
async function catchUp(w: SimWorld, measurer?: PairMeasurer): Promise<void> {
  const prep = w.prepareVehicleTopology(measurer);
  for (let step = prep.next(); !step.done; step = prep.next()) {
    if (step.value === WAITING) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // With workers, every pair with zones knows its crossing and its facts before the index is built: none is worked out on the page.
  if (measurer?.finishPairs) {
    for (const pair of pairsOf(w).values()) if (pair.zones) { expect(pair.crossing).not.toBeUndefined(); expect(pair.facts).not.toBeUndefined(); }
  }
  w.rebuildVehicleTopology();
}

const internals = (w: SimWorld) => w as unknown as { prepGraph: LaneletGraph };

/** The graph the agents run on and the conflict index, taken over from the preparation */
function expectAsBuiltHere(off: SimWorld, here: SimWorld, where: string): void {
  expect(graphLines(off.graph), `${where}: graph taken over`).toEqual(graphLines(here.graph));
  expect(conflictLines(off.conflicts).sort(), `${where}: conflicts taken over`).toEqual(conflictLines(here.conflicts).sort());
}
/** The graph's maps in their own order, and each junction's lists: a whole build placed off the page in the page's order */
const orderOf = (g: LaneletGraph): string[] => [
  [...g.lanelets.keys()].join(','), [...g.connectors.keys()].join(','),
  [...g.junctions].map(([node, j]) => `${node}:${j.connectors.join('/')}:${j.inbound.join('/')}`).join(','),
  [...g.exits].map(([lane, exits]) => `${lane}:${exits.join('/')}`).join(','),
];

/** A whole build: both graphs, taken over and prepared, in the order a world that never prepared builds them. */
function expectSameOrder(off: SimWorld, page: SimWorld, here: SimWorld, where: string): void {
  expect(orderOf(internals(off).prepGraph), `${where}: prepared graph, in order`).toEqual(orderOf(internals(page).prepGraph));
  expect(orderOf(off.graph), `${where}: graph, in order`).toEqual(orderOf(here.graph));
}

/** Every connector of the graph was shaped by a worker: no turn path made on the page. */
function expectNoTurnOnPage(g: LaneletGraph, off: Workers, where: string): void {
  for (const c of g.connectors.values()) expect(off.paths.has(g.lanelet(c.lanelet)!.centre.xy), `${where}: ${c.id} shaped on the page`).toBe(true);
}

const sweepsOf = (w: SimWorld) => (w.conflicts as unknown as { sweepCache: Map<string, Float64Array> }).sweepCache;

/** Everything the two preparations must agree on: both graphs, the conflicts, the sweeps and the tables measured. */
function expectSame(off: SimWorld, page: SimWorld, measuredOff: Map<string, Float64Array | null>, measuredPage: Map<string, Float64Array | null>, where: string): void {
  expect(graphLines(internals(off).prepGraph), `${where}: prepared graph`).toEqual(graphLines(internals(page).prepGraph));
  expect(graphLines(off.graph), `${where}: graph`).toEqual(graphLines(page.graph));
  expect(conflictLines(off.conflicts).sort(), `${where}: conflicts`).toEqual(conflictLines(page.conflicts).sort());
  const sweeps = (w: SimWorld) => [...sweepsOf(w)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  expect(sweeps(off), `${where}: sweeps`).toEqual(sweeps(page));
  const tables = (m: Map<string, Float64Array | null>) => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  expect(tables(measuredOff), `${where}: pair tables`).toEqual(tables(measuredPage));
  expect(walkLines(off), `${where}: walkways`).toEqual(walkLines(page));
}

/** The residents' walkways, every one with its id, ends, reach and every point of its line. */
const walkLines = (w: SimWorld): string[] => w.walkwaysNow().walkways().map((way) => `${way.id} ${way.kind} ${way.a} ${way.b} ${way.segment ?? '-'} ${way.node ?? '-'} `
  + `${way.structure} ${way.kerb} ${way.lo} ${way.hi} ${way.width} ${way.unmarked ?? '-'} ${new Digest().addAll(way.path.xy).value()}`);

/** Every sweep the index holds was sampled by a worker: none on the page. */
function expectNoneOnPage(w: SimWorld, off: Workers): void {
  for (const frame of sweepsOf(w).values()) expect(off.frames.has(frame)).toBe(true);
}

/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

function pair(doc: RoadDoc): { off: SimWorld; page: SimWorld; net: Network } {
  const net = new Network(doc);
  net.rebuild();
  return { off: new SimWorld(doc, net, 7), page: new SimWorld(doc, net, 7), net };
}

describe('the traffic topology prepared off the page', () => {
  it('builds a generated city as the page does, no sweep sampled on the page', async () => {
    const { off, page } = pair(layCity(planCity({ ...DEFAULT_CITY, seed: 3, size: 'small', radius: TOWN })));
    const measurer = workers();
    await catchUp(off, measurer);
    await catchUp(page);
    const here = new SimWorld(off.doc, off.net, 7);
    here.rebuildTopology();
    expectAsBuiltHere(off, here, 'city');
    expectSameOrder(off, page, here, 'city');
    expect(off.graph.connectors.size).toBeGreaterThan(100);
    expect(off.graph.junctions.size).toBeGreaterThan(20);
    // Every junction built by the workers, every turn chosen there with it: none asked on its own, none shaped here.
    expect(measurer.asked.junctions).toBe(off.graph.junctions.size);
    expect(measurer.asked.turns).toBe(0);
    expectNoTurnOnPage(off.graph, measurer, 'city');
    expect(measurer.asked.sweeps).toBeGreaterThan(off.graph.connectors.size / 2);
    expect(measurer.asked.pairs).toBeGreaterThan(0);
    expect(measurer.asked.finished).toBeGreaterThan(0);
    // The walkways' corners rounded by the workers, the same lines (`expectSame`).
    expect(measurer.asked.corners).toBeGreaterThan(20);
    expect(off.conflicts.measured.build).toBe(0);
    expectNoneOnPage(off, measurer);
    expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), 'city');
  });

  it('opens a city whose zones an earlier session kept as the page does, the pairs finished off the page', async () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 4, size: 'small', radius: SMALL_TOWN }));
    const first = pair(doc).page;
    await catchUp(first);
    const kept = first.conflicts.takeMeasured();
    const { off, page } = pair(doc);
    off.conflicts.seed(kept);
    page.conflicts.seed(kept);
    const measurer = workers();
    await catchUp(off, measurer);
    await catchUp(page);
    // Every table read back, none measured; the pairs still finished by the workers.
    expect(measurer.asked.pairs).toBe(0);
    expect(measurer.asked.finished).toBeGreaterThan(0);
    expectNoneOnPage(off, measurer);
    expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), 'city kept');
  });

  it('builds the city as the page does when the workers cannot build its junctions nor sample the sweeps', async () => {
    const { off, page } = pair(layCity(planCity({ ...DEFAULT_CITY, seed: 5, size: 'small', radius: SMALL_TOWN })));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await catchUp(off, workers(true));
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
    await catchUp(page);
    expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), 'city, junctions and sweeps on the page');
  });

  /** A MAP OPENED (`main.ts` `applySnapshot`: the document replaced, the network built whole, the world reset) */
  it('opens a map, and the same map again, as the page does, no turn shaped on the page', async () => {
    const { off, page, net } = pair(layCity(planCity({ ...DEFAULT_CITY, seed: 6, size: 'small', radius: SMALL_TOWN })));
    const measurer = workers();
    await catchUp(off, measurer);
    await catchUp(page);
    const other = layCity(planCity({ ...DEFAULT_CITY, seed: 7, size: 'small', radius: SMALL_TOWN })).toJSON();
    for (const [where, data] of [['map opened', other], ['same map again', other]] as const) {
      restoreInto(off.doc, structuredClone(data), net);
      off.reset();
      page.reset();
      const asked = measurer.asked.junctions;
      await catchUp(off, measurer);
      await catchUp(page);
      expect(measurer.asked.junctions - asked, where).toBe(off.graph.junctions.size);
      expectNoTurnOnPage(off.graph, measurer, where);
      expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), where);
      const here = new SimWorld(off.doc, net, 7);
      here.rebuildTopology();
      expectAsBuiltHere(off, here, where);
      expectSameOrder(off, page, here, where);
    }
  });

  for (let seed = 1; seed <= 3; seed++) it(`keeps what the page keeps after every op of fuzz sequence ${seed}`, async () => {
    const ops = generate(seed, 24);
    const state = freshState();
    const off = new SimWorld(state.doc, state.net, 7), page = new SimWorld(state.doc, state.net, 7);
    const here = new SimWorld(state.doc, state.net, 7);
    const measurer = workers();
    await catchUp(off, measurer);
    await catchUp(page);
    here.rebuildTopology();
    let edits = 0;
    for (let i = 0; i < ops.length; i++) {
      let changed: boolean;
      try { changed = applyOp(state, ops[i]!); } catch (error) { recordRejected(error); break; }
      if (!changed) continue;
      edits++;
      await catchUp(off, measurer);
      await catchUp(page);
      expectNoneOnPage(off, measurer);
      expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), `seed ${seed} op ${i} (${ops[i]!.op})`);
      here.rebuildTopology();
      expectAsBuiltHere(off, here, `seed ${seed} op ${i} (${ops[i]!.op})`);
    }
    expect(edits).toBeGreaterThan(0);
  });

  /** A PREPARATION GIVEN UP while the workers choose its turns */
  it('finishes the junctions of a preparation given up while its turns were chosen', async () => {
    let givenUp = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const ops = generate(seed, 24);
      const state = freshState();
      const off = new SimWorld(state.doc, state.net, 7), page = new SimWorld(state.doc, state.net, 7);
      const here = new SimWorld(state.doc, state.net, 7);
      const measurer = workers();
      await catchUp(off, measurer);
      await catchUp(page);
      for (let i = 0; i + 1 < ops.length; i++) {
        let changed: boolean;
        try { changed = applyOp(state, ops[i]!); } catch (error) { recordRejected(error); break; }
        if (!changed) continue;
        // Prepared up to the workers' first answer awaited, then given up for the next edit.
        const prep = off.prepareVehicleTopology(measurer);
        let step = prep.next();
        while (!step.done && step.value !== WAITING) step = prep.next();
        // Run to its end without waiting (nothing for the workers): its walkways were brought up, so are the page's
        if (step.done) page.walkwaysNow();
        const plan = internals(off).prepGraph.turnPlan;
        if (plan && plan.provisional.size > 0) givenUp++;
        try { changed = applyOp(state, ops[++i]!); } catch (error) { recordRejected(error); break; }
        await catchUp(off, measurer);
        await catchUp(page);
        here.rebuildTopology();
        const where = `seed ${seed} ops ${i - 1}, ${i}`;
        expect(internals(off).prepGraph.turnPlan, `${where}: plan finished`).toBeNull();
        expectNoneOnPage(off, measurer);
        expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), where);
        expectAsBuiltHere(off, here, where);
      }
    }
    // The case is met: preparations were given up with junctions on stand-ins.
    expect(givenUp).toBeGreaterThan(0);
  });
});
