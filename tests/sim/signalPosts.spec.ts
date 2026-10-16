import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import { signalGroupsOf, signalPosts } from '@world/signalPosts';
import { m } from '@world/units';
import { Rng } from '@core/rng';
import type { SimWorld } from '@sim/world';
import { simOf } from './support/bodies';

/** THE SIGNAL POSTS ARE THE WORLD'S, AND THE SIMULATION FOLLOWS THEM. */

/** A grid of crossroads, every junction on "automatic". */
function gridTown(): { doc: RoadDoc; junctions: NodeId[] } {
  const doc = new RoadDoc();
  const n = 3, step = 240;
  const ids: NodeId[][] = [];
  for (let i = 0; i < n; i++) {
    ids.push([]);
    for (let j = 0; j < n; j++) ids[i]!.push(doc.addNode({ x: i * step, y: j * step }).id);
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, 1);
      if (j + 1 < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, 1);
    }
  }
  // Arms out of the grid, so the corners are crossroads too.
  for (let k = 0; k < n; k++) {
    doc.addSegment(doc.addNode({ x: -300, y: k * step }).id, ids[0]![k]!, 1);
    doc.addSegment(ids[n - 1]![k]!, doc.addNode({ x: (n - 1) * step + 300, y: k * step }).id, 1);
    doc.addSegment(doc.addNode({ x: k * step, y: -300 }).id, ids[k]![0]!, 1);
    doc.addSegment(ids[k]![n - 1]!, doc.addNode({ x: k * step, y: (n - 1) * step + 300 }).id, 1);
  }
  return { doc, junctions: ids.flat() };
}

const key = (p: { node: NodeId; segment: number; x: number; y: number }): string => `${p.node}:${p.segment}:${p.x}:${p.y}`;

function indexed(sim: SimWorld, junctions: readonly NodeId[]): string[] {
  const out = new Set<string>();
  for (const node of junctions) {
    const record = sim.doc.node(node)!;
    for (const post of sim.signalPosts.near(record.x, record.y, m(60))) if (post.node === node) out.add(key(post));
  }
  return [...out].sort();
}

describe('the signal posts the walkers keep clear of', () => {
  it('follow the advisor\'s switches, a junction at a time, as the world places them', () => {
    const { doc, junctions } = gridTown();
    const sim = simOf(doc, 0x5eed, 1);
    const apply = (): boolean => (sim as unknown as { applyAutoControl(): boolean }).applyAutoControl();
    sim.signalPosts.follow(sim);
    expect(indexed(sim, junctions)).toEqual(signalPosts(sim.net, signalGroupsOf(sim.graph)).map(key).sort());
    const rng = new Rng(7);
    let switched = 0;
    for (let round = 0; round < 12; round++) {
      const before = sim.signalChangesSince(-1).serial;
      const turned = new Set<NodeId>();
      for (const node of junctions) {
        if (rng.float() < 0.4) continue;
        const now = sim.graph.junctions.get(node)!.signalised;
        sim.advisor.choices.set(node, now ? 'priority' : 'signal');
        turned.add(node);
      }
      apply();
      // The simulation says which junctions changed: exactly those turned.
      const { nodes } = sim.signalChangesSince(before);
      expect(nodes).not.toBeNull();
      expect([...new Set(nodes)].sort((a, b) => a - b)).toEqual([...turned].sort((a, b) => a - b));
      switched += turned.size;
      sim.signalPosts.follow(sim);
      expect(indexed(sim, junctions)).toEqual(signalPosts(sim.net, signalGroupsOf(sim.graph)).map(key).sort());
    }
    expect(switched).toBeGreaterThan(20);
    // An edit of the roads: the junctions it reached
    const before = sim.signalChangesSince(-1).serial;
    doc.addSegment(doc.addNode({ x: 120, y: -150 }).id, doc.addNode({ x: 120, y: -250 }).id, 1);
    sim.net.rebuild();
    sim.rebuildTopology();
    expect(sim.signalChangesSince(before).nodes).not.toBeNull();
    sim.signalPosts.follow(sim);
    expect(indexed(sim, junctions)).toEqual(signalPosts(sim.net, signalGroupsOf(sim.graph)).map(key).sort());
  });
});
