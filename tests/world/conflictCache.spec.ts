import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc as Doc } from '@world/doc';
import type { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { BODY_CLASSES, ConflictIndex, WAITING } from '@world/conflictPoints';
import { type PairMeasurer, type SweepSamples, pairTable } from '@world/conflictTable';
import type { NodeId } from '@world/ids';
import { fixtureDoc } from '../sim/support/bodies';

/** The conflict index reuses the zones of every pair of movements whose swept geometry did not change since the previous */

function graphOf(doc: RoadDoc): LaneletGraph {
  const net = new Network(doc);
  net.rebuild();
  const graph = new LaneletGraph();
  graph.build(doc, net);
  return graph;
}

/** Everything the simulation reads from an index, keyed by connector pair. */
function snapshot(index: ConflictIndex): unknown {
  const keyOf = new Map<number, string>();
  const points = index.points
    .filter((p) => p !== undefined)
    .map((p) => {
      const key = `${p.node}|${p.a}|${p.b}`;
      keyOf.set(p.id, key);
      const zones: unknown[] = [];
      for (const on of [p.a, p.b]) {
        for (const mine of BODY_CLASSES) {
          for (const theirs of BODY_CLASSES) zones.push(p.zone(on, mine, theirs));
        }
      }
      return { key, kind: p.kind, at: p.at, sA: p.sA, sB: p.sB, zones };
    })
    .sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));

  const refs = [...index.byConnector.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([connector, list]) => [
      connector,
      list.map((r) => ({ point: keyOf.get(r.point), s: r.s, other: r.other, kind: r.kind, exit: r.exit })),
    ]);

  const diverges = [...index.diverges.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([connector, list]) => [
      connector,
      list.map((d) => ({
        other: d.other,
        exits: BODY_CLASSES.flatMap((mine) => BODY_CLASSES.map((theirs) => d.otherExit(mine, theirs))),
      })),
    ]);

  return { points, refs, diverges, intrusions: index.queueIntrusions };
}

/** Adds one leg to the busiest junction it can, so the edit changes one node. */
function addLeg(doc: RoadDoc): NodeId {
  const busiest = [...doc.nodes.values()]
    .filter((n) => n.incident.length >= 3)
    .sort((a, b) => b.incident.length - a.incident.length || a.id - b.id)[0];
  if (!busiest) throw new Error('fixture has no junction');
  const far = doc.addNode({ x: busiest.x + 180, y: busiest.y + 330 });
  if (!doc.addSegment(busiest.id, far.id, 1)) throw new Error('could not add a leg');
  return busiest.id;
}

/** What a worker of `conflictPool.ts` does, here */
const offPage: PairMeasurer = {
  measure(pairs) {
    const fresh = (s: SweepSamples): SweepSamples => ({
      c0: s.c0, count: s.count, length: s.length, frame: s.frame.slice(), frameLengthSq: s.frameLengthSq.slice(), bounds: null, boxes: null, range: null,
    });
    return Promise.resolve(pairs.map((p) => pairTable(fresh(p.a), fresh(p.b))?.slice() ?? null));
  },
};

describe('conflict zone cache', () => {
  it('gives the same index when its pairs are measured off the page', async () => {
    const graph = graphOf(fixtureDoc());
    const index = new ConflictIndex();
    const steps = index.prepare(graph, offPage);
    let waited = 0;
    for (let step = steps.next(); !step.done; step = steps.next()) {
      if (step.value === WAITING) { waited++; await Promise.resolve(); }
    }
    expect(waited).toBeGreaterThan(0);
    expect(index.measured.prepare).toBeGreaterThan(0);
    index.build(graph);
    // Every pair the build needs came back from the workers.
    expect(index.measured.build).toBe(0);
    const cold = new ConflictIndex();
    cold.build(graph);
    expect(snapshot(index)).toEqual(snapshot(cold));
  });

  it('gives the same index as a cold build after an edit', () => {
    const doc = fixtureDoc();
    const warm = new ConflictIndex();
    warm.build(graphOf(doc));

    addLeg(doc);
    const graph = graphOf(doc);
    warm.build(graph);
    const cold = new ConflictIndex();
    cold.build(graph);

    expect(snapshot(warm)).toEqual(snapshot(cold));
  });

  it('gives the same index when a junction loses a leg again', () => {
    const doc = fixtureDoc();
    const warm = new ConflictIndex();
    warm.build(graphOf(doc));
    const node = addLeg(doc);
    warm.build(graphOf(doc));

    const added = doc.requireNode(node).incident.at(-1);
    if (added === undefined) throw new Error('leg missing');
    doc.removeSegment(added);
    doc.pruneOrphanNodes();
    const graph = graphOf(doc);
    warm.build(graph);
    const cold = new ConflictIndex();
    cold.build(graph);

    expect(snapshot(warm)).toEqual(snapshot(cold));
  });

  it('measures nothing again on an unchanged rebuild', () => {
    const graph = graphOf(fixtureDoc());
    const index = new ConflictIndex();
    index.build(graph);
    expect(index.measured.build).toBeGreaterThan(0);
    index.build(graph);
    expect(index.measured.build).toBe(0);
  });
  it('measures no pair again when nothing changed, in a town laid out symmetrically', () => {
    // The parking town is symmetric about the origin.
    const doc = Doc.fromJSON(JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')));
    const graph = graphOf(doc);
    const index = new ConflictIndex();
    index.build(graph);
    index.build(graph);
    expect(index.measured.build).toBe(0);
  });

  it('leaves nothing for the build to measure once a graph is prepared', () => {
    const doc = fixtureDoc();
    const index = new ConflictIndex();
    index.build(graphOf(doc));
    const nodes = [...doc.nodes.values()];
    const a = nodes[0]!;
    doc.addSegment(a.id, doc.addNode({ x: a.x + 30, y: a.y + 220 }).id, 1);
    const graph = graphOf(doc);
    const steps = index.prepare(graph);
    while (!steps.next().done) { /* measured a pair at a time */ }
    index.build(graph);
    expect(index.measured.build).toBe(0);
    const cold = new ConflictIndex();
    cold.build(graph);
    expect(snapshot(index)).toEqual(snapshot(cold));
  });
});
