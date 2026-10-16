import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { addLine, addStop, addTrack, emptyTransit, railGraph, railPath } from '@world/transit';
import { SimWorld } from '@sim/world';

/** A TRAIN LINE'S LOOP HOLDS EACH POINT ONCE. */

interface RailView {
  readonly points: readonly Vec2[];
  readonly at: readonly number[];
  readonly length: number;
  readonly stations: readonly { readonly stop: number; readonly s: number; readonly turn: boolean }[];
  readonly crossings: readonly unknown[];
}

function lineOn(stations: readonly Vec2[]): { w: SimWorld; stops: number[] } {
  const doc = new RoadDoc();
  // A street across the track, for a level crossing out and one back.
  const a = doc.addNode({ x: m(120), y: m(-60) }).id, b = doc.addNode({ x: m(120), y: m(60) }).id;
  doc.addSegment(a as never, b as never, 1);
  let t = emptyTransit();
  const track = addTrack(t, 'train', [{ x: 0, y: 0 }, { x: m(100), y: 0 }, { x: m(200), y: 0 }, { x: m(300), y: m(50) }]);
  t = track.data;
  const stops: number[] = [];
  for (const p of stations) {
    const s = addStop(t, { mode: 'train', x: p.x, y: p.y, track: track.id });
    t = s.data;
    stops.push(s.id);
  }
  t = addLine(t, 'train', stops).data;
  doc.setTransit(t);
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x7a1);
  w.rebuildTopology();
  return { w, stops };
}

const railsOf = (w: SimWorld): readonly RailView[] => (w.city.transit as unknown as { rails: RailView[] }).rails;

describe('a train line loop', () => {
  for (const stations of [
    [{ x: m(50), y: 0 }, { x: m(150), y: 0 }, { x: m(250), y: m(25) }],
    [{ x: m(30), y: 0 }, { x: m(170), y: 0 }],
  ]) {
    it(`has no stretch of length zero (${stations.length} stations)`, () => {
      const { w, stops } = lineOn(stations);
      w.city.transit.step(w);
      const [rail] = railsOf(w);
      expect(rail).toBeDefined();
      const pts = rail!.points;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
        expect(Math.hypot(q.x - p.x, q.y - p.y), `stretch ${i} of ${pts.length}`).toBeGreaterThan(0);
      }
      // The same line: its legs' lengths end to end, each station where its leg begins.
      const g = railGraph(w.doc.transit, 'train');
      const order = [...stops, ...stops.slice(1, -1).reverse()].map((id) => w.doc.transit.stops.find((s) => s.id === id)!);
      let s = 0;
      const begins: number[] = [];
      for (let i = 0; i < order.length; i++) {
        const leg = railPath(g, order[i]!, order[(i + 1) % order.length]!)!;
        begins.push(s);
        for (let k = 1; k < leg.length; k++) s += Math.hypot(leg[k]!.x - leg[k - 1]!.x, leg[k]!.y - leg[k - 1]!.y);
      }
      expect(rail!.length).toBeCloseTo(s, 6);
      expect(rail!.stations.map((st) => st.s)).toEqual(begins.map((b) => expect.closeTo(b, 6)));
      expect(rail!.stations.map((st) => st.turn)).toEqual(order.map((_, i) => i === 0 || i === stops.length - 1));
      // Each lane of the street crossed once out and once back.
      const perLane = new Map<string, number>();
      for (const c of rail!.crossings as { lanelet: string }[]) perLane.set(c.lanelet, (perLane.get(c.lanelet) ?? 0) + 1);
      expect(perLane.size).toBeGreaterThan(0);
      for (const n of perLane.values()) expect(n).toBe(2);
      // The trains run along it with a finite place and heading.
      for (let k = 0; k < 200; k++) w.city.transit.step(w);
      for (const train of w.city.transit.trains()) {
        for (const car of train.cars) expect(Number.isFinite(car.x) && Number.isFinite(car.y) && Number.isFinite(car.heading)).toBe(true);
      }
    });
  }

  it('keeps each train\'s discs while it stands, the same discs as made anew each tick', () => {
    const { w } = lineOn([{ x: m(30), y: 0 }, { x: m(170), y: 0 }, { x: m(280), y: m(40) }]);
    const transit = w.city.transit;
    const inner = transit as unknown as {
      rails: { line: { mode: string }; trains: { key: string; s: number; v: number; dwell: number }[] }[];
      pointAt(rail: unknown, s: number): { x: number; y: number; heading: number };
    };
    // The discs as they were made before they were kept: a map by train, the moving trains' track ahead first.
    const anew = (): { x: number; y: number; r: number }[][] => {
      const zones = new Map<string, { x: number; y: number; r: number }[]>();
      const zone = (key: string): { x: number; y: number; r: number }[] => { let z = zones.get(key); if (!z) zones.set(key, z = []); return z; };
      for (const rail of inner.rails) {
        if (rail.line.mode === 'metro') continue;
        for (const train of rail.trains) {
          if (train.v < m(1) && train.dwell > 7) continue;
          const reach = Math.max(m(30), train.v * 7);
          for (let d = m(4); d < reach; d += m(3)) { const p = inner.pointAt(rail, train.s + d); zone(train.key).push({ x: p.x, y: p.y, r: m(1.9) }); }
        }
      }
      for (const t of transit.trains()) {
        if (t.metro) continue;
        for (const car of t.cars) {
          for (let d = -m(18) / 2 + m(1.5); d <= m(18) / 2 - m(1.5) + 1e-6; d += m(2.5)) {
            zone(t.key).push({ x: car.x + Math.cos(car.heading) * d, y: car.y + Math.sin(car.heading) * d, r: m(1.8) });
          }
        }
      }
      return [...zones.values()];
    };
    let standing = 0;
    for (let k = 0; k < 2400; k++) {
      transit.step(w);
      if (inner.rails.some((r) => r.trains.some((t) => t.v < m(1) && t.dwell > 7))) standing++;
      expect(transit.trainZones().map((z) => z.map((d) => ({ ...d })))).toEqual(anew());
    }
    expect(standing).toBeGreaterThan(100);
  });
});

