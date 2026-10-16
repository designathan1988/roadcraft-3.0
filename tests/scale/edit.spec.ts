import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { laneletWork } from '@world/lanelets';
import { networkWork, rebuildWork } from '@world/rebuildWork';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { trapLanes } from '@sim/routing/router';

/** THE SAME EDIT COSTS THE SAME ON A SMALL MAP AND A LARGE ONE */
const BLOCK = 120;

function grid(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * (i - n / 2), y: m(BLOCK) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  return doc;
}

/** Everything the game runs after a road edit, as the frame loop runs it. */
function catchUp(net: Network, w: SimWorld): void {
  net.rebuild();
  const prep = w.prepareVehicleTopology();
  while (!prep.next().done) { /* a slice a frame in the game */ }
  w.rebuildTopology();
  w.walkwaysNow();
  // The junctions and signals in node order, as stage 1 and the frame read them each tick.
  w.signalisedControllers();
  trapLanes(w, 1);
  // The road ends a lane reaches (`laneReach.ts`), asked as a car made at a road end asks.
  const first = [...w.graph.lanelets.values()].find((lane) => lane.kind === 'link');
  if (first) w.laneReaches.exitsFrom(w, first.id, 1 as never);
}

/** The work of the world being measured's lane reach (`LaneReaches.work`), read by `counters`. */
let reachWork = 0;
const counters = (): Record<string, number> => ({
  'net.sources': networkWork.sources,
  'net.junctions': networkWork.junctions,
  'net.segments': networkWork.segments,
  'net.marks': networkWork.marks,
  'lanes.segments': laneletWork.segments,
  'lanes.nodes': laneletWork.nodes,
  conflicts: rebuildWork.conflicts,
  walkways: rebuildWork.walkways,
  signals: rebuildWork.signals,
  sidewalks: rebuildWork.sidewalks,
  spans: rebuildWork.spans,
  'sim.lanes': rebuildWork.lanes,
  routing: rebuildWork.routing,
  reach: reachWork,
});

/** What one isolated road beside the grid costs each product, once the grid is built. */
function editWork(n: number): Record<string, number> {
  const doc = grid(n);
  const net = new Network(doc);
  const w = new SimWorld(doc, net, 0x5ca1e);
  catchUp(net, w);
  reachWork = w.laneReaches.work;
  const before = counters();
  const x = m(BLOCK) * (n / 2 + 2);
  const a = doc.addNode({ x, y: 0 });
  const b = doc.addNode({ x: x + m(60), y: 0 });
  doc.addSegment(a.id, b.id, 1);
  catchUp(net, w);
  reachWork = w.laneReaches.work;
  const after = counters();
  const out: Record<string, number> = {};
  for (const key of Object.keys(after)) out[key] = after[key]! - before[key]!;
  return out;
}

describe('the cost of one road edit', () => {
  it('does not grow with the map, but for the products still in the baseline, whose growth may only fall', () => {
    const small = editWork(3);
    const large = editWork(12);
    const baseline = JSON.parse(readFileSync(join(process.cwd(), 'tests/scale/baseline.json'), 'utf8')) as Record<string, number>;
    const report: string[] = [];
    for (const key of Object.keys(small)) {
      const ratio = small[key]! > 0 ? large[key]! / small[key]! : large[key]! > 0 ? Infinity : 1;
      const allowed = baseline[key];
      if (allowed === undefined) {
        if (ratio > 1.05) report.push(`${key}: grows with the map (${small[key]} -> ${large[key]}, x${ratio.toFixed(2)})`);
      } else if (ratio > allowed * 1.001) {
        report.push(`${key}: x${ratio.toFixed(2)}, more than the baseline's x${allowed}`);
      } else if (ratio <= 1.05) {
        report.push(`${key}: no longer grows with the map (x${ratio.toFixed(2)}): take it out of tests/scale/baseline.json`);
      }
    }
    expect(report).toEqual([]);
  });
});
