import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { rebuildWork } from '@world/rebuildWork';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';

/** AN EDIT REBINDS THE VEHICLES ON WHAT IT CHANGED, NOT THE FLEET */
const BLOCK = 120;

function town(n: number): RoadDoc {
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
  const half = m(BLOCK) * (n / 2);
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -half - m(150), y: -half }).id as never, 1);
  doc.addSegment(ids[n]![n]! as never, doc.addNode({ x: half + m(150), y: half }).id as never, 1);
  return doc;
}

describe('rebinding the vehicles after an edit', () => {
  it('binds none for a road apart from the town, and only those on or bound through a road taken away', () => {
    const doc = town(4);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x0be9);
    w.rebuildTopology();
    w.trafficCount = 60;
    w.ambient.enabled = true;
    w.ambient.source = 'edges';
    w.clock.paused = false;
    for (let t = 0; t < 300; t++) step(w, { traffic: true, pedestrians: false });
    expect(w.vehicles.size).toBeGreaterThan(20);

    // A road beside the town, joined to nothing: no vehicle is on it or bound through it.
    const x = m(BLOCK) * 5;
    doc.addSegment(doc.addNode({ x, y: 0 }).id, doc.addNode({ x: x + m(60), y: 0 }).id, 1);
    net.rebuild();
    let before = rebuildWork.vehicles;
    step(w, { traffic: true, pedestrians: false });
    expect(rebuildWork.vehicles - before).toBe(0);

    // A road of the town taken away: those on it or bound through it, a part of the fleet.
    const bound = (seg: number): number => {
      const lanes = new Set<string>();
      for (const lane of w.graph.lanelets.values()) if (lane.segment === seg) lanes.add(lane.id);
      let n = 0;
      for (const v of w.vehicles.values()) if (v.route.some((id) => lanes.has(id)) || lanes.has(v.lanelet)) n++;
      return n;
    };
    const victim = [...doc.segments.keys()].sort((a, b) => bound(b) - bound(a) || a - b)[0]!;
    const through = bound(victim);
    expect(through).toBeGreaterThan(0);
    const fleet = w.vehicles.size;
    doc.removeSegment(victim);
    net.rebuild();
    before = rebuildWork.vehicles;
    step(w, { traffic: true, pedestrians: false });
    const rebound = rebuildWork.vehicles - before;
    expect(rebound).toBeGreaterThanOrEqual(through);
    expect(rebound).toBeLessThan(fleet);
  });
});
