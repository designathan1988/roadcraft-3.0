import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { SegmentId } from '@world/ids';
import { addLine, addStop, emptyTransit } from '@world/transit';
import { SimWorld } from '@sim/world';
import { laneBeside } from '@sim/agents/parking';

/** THE BUS STOPS FOLLOW AN EDIT OF THE ROADS NEAR THEM: the same lanes as made from nothing, the others not looked at */
describe('the bus stops after an edit of the roads', () => {
  it('stand by the lanes they would be given from nothing', () => {
    const doc = new RoadDoc();
    const streets: SegmentId[] = [];
    for (let k = 0; k < 6; k++) {
      const y = m(400) * k;
      streets.push(doc.addSegment(doc.addNode({ x: 0, y }).id, doc.addNode({ x: m(200), y }).id, 1)!.id as SegmentId);
    }
    let t = emptyTransit();
    const stops: number[] = [];
    for (let k = 0; k < 6; k++) {
      const s = addStop(t, { mode: 'bus', x: m(100), y: m(400) * k + m(6), segment: streets[k]! });
      t = s.data;
      stops.push(s.id);
    }
    t = addLine(t, 'bus', stops).data;
    doc.setTransit(t);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x7a2);
    w.rebuildTopology();
    const stopLanes = (w.city.transit as unknown as { stopLanes: Map<number, { lanelet: string; at: number }> }).stopLanes;
    const check = (): void => {
      w.city.transit.step(w);
      for (const s of doc.transit.stops) {
        const fresh = laneBeside(w, s.x, s.y, s.segment);
        expect(stopLanes.get(s.id)?.lanelet ?? null, `stop ${s.id}`).toBe(fresh?.lanelet ?? null);
        expect(stopLanes.get(s.id)?.at ?? null).toBe(fresh?.at ?? null);
      }
    };
    check();
    expect(stopLanes.size).toBe(6);
    // A street taken away: its stop has no lane; a street put back beside it: a lane again.
    doc.removeSegment(streets[2]!);
    net.rebuild(); w.rebuildTopology();
    check();
    expect(stopLanes.has(stops[2]!)).toBe(false);
    doc.addSegment(doc.addNode({ x: m(20), y: m(800) }).id, doc.addNode({ x: m(180), y: m(800) }).id, 1);
    net.rebuild(); w.rebuildTopology();
    check();
    doc.removeSegment(streets[4]!);
    net.rebuild(); w.rebuildTopology();
    check();
  });
});
