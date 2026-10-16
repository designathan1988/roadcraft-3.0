import { describe, expect, it } from 'vitest';

import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { FrameWriter } from '@sim/frame';
import { SimMirror, shownPoseInto } from '@sim/mirror';
import { newPose, vehiclePoseInto } from '@sim/pose';
import { signalStateFor } from '@sim/signals/query';
import { indicatorSide, pathCurvature } from '@sim/vehicles/shown';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import type { BuildingId } from '@world/buildings/types';
import { greenCity, layCity, widenCityFootways, zoneCity } from '@editor/cityGenerator';
import { growOnLot } from '@editor/zoning';

/** THE PAGE'S MIRROR OF THE SIMULATION (`sim/frame.ts`, `sim/mirror.ts`) */

function city(): { doc: ReturnType<typeof layCity>; net: Network } {
  const plan = planCity({ ...DEFAULT_CITY, size: 'small' });
  const doc = layCity(plan);
  widenCityFootways(doc);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  greenCity(doc, net, DEFAULT_CITY.seed);
  const zoned = zoneCity(doc, net, plan);
  const refused = new Set<number>();
  for (let guard = 0; guard < zoned * 3 + 50; guard++) {
    const id = growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed);
    if (id === null) {
      if (!doc.lots.some((l) => l.use && (l.building === undefined || !doc.buildings.has(l.building as BuildingId)) && !refused.has(l.id))) break;
      continue;
    }
  }
  if (net.revision !== doc.revision) net.rebuild();
  return { doc, net };
}

describe('the mirror of the simulation', () => {
  it('draws every vehicle, person and signal head as the world itself would, tick after tick', () => {
    const { doc, net } = city();
    const sim = new SimWorld(doc, net, 0x5917);
    sim.rebuildTopology();
    sim.clock.paused = false;
    sim.usePedestrianEngine(createAgentWalkEngine());
    sim.ambient.enabled = true;
    sim.ambient.source = 'edges';
    sim.trafficCount = 120;
    sim.pedestrianCount = 120;
    const writer = new FrameWriter();
    const mirror = new SimMirror();
    const real = newPose(), shown = newPose();
    let vehicles = 0, parked = 0, peds = 0, heads = 0, signalling = 0, lampsMoved = 0;
    for (let tick = 0; tick < 300; tick++) {
      step(sim, { traffic: true, pedestrians: true });
      // Cloned as the worker's message is (`postMessage`).
      mirror.take(structuredClone(writer.write(sim)));
      // A frame asks to be drawn for its signals only when a lamp or a signalled junction changed.
      if (mirror.signalsMoved) lampsMoved++;
      if (tick % 5) continue;
      // The vehicles on the roads: the same, in the same order, at the same pose for any share of the tick.
      const road = sim.vehiclesInIdOrder().filter((v) => vehiclePoseInto(sim, v, 1, real));
      expect(mirror.road.map((v) => v.id)).toEqual(road.map((v) => v.id));
      road.forEach((v, k) => {
        const m = mirror.road[k]!;
        for (const alpha of [0, 0.37, 1]) {
          vehiclePoseInto(sim, v, alpha, real);
          shownPoseInto(m, alpha, shown);
          expect([shown.p.x, shown.p.y, shown.angle]).toEqual([real.p.x, real.p.y, real.angle]);
        }
        expect([m.v, m.prev.v, m.age, m.seats, m.color, m.archetype, m.slain ?? false]).toEqual([v.v, v.prev.v, v.age, v.seats, v.color, v.archetype, v.slain ?? false]);
        expect([m.people, m.peopleAge, m.doors, m.kerbStop]).toEqual([v.people, v.peopleAge, v.doors, v.kerbStop]);
        expect([m.indicator, m.curvature]).toEqual([v.free ? 0 : indicatorSide(sim, v), v.free ? 0 : pathCurvature(sim, v)]);
        if (m.indicator !== 0) signalling++;
        vehicles++;
      });
      // The cars standing in bays.
      expect(new Set(mirror.parked.keys())).toEqual(new Set(sim.ambient.parked.map((v) => v.id)));
      for (const v of sim.ambient.parked) {
        const m = mirror.parked.get(v.id)!;
        vehiclePoseInto(sim, v, 0.5, real);
        shownPoseInto(m, 0.5, shown);
        expect([shown.p.x, shown.p.y, shown.angle]).toEqual([real.p.x, real.p.y, real.angle]);
        expect([m.free?.lot, m.seats, m.doors]).toEqual([v.free?.lot, v.seats, v.doors]);
        parked++;
      }
      // The people: every field.
      expect(mirror.pedViews.length).toBe(sim.pedViews.length);
      sim.pedViews.forEach((p, k) => {
        expect(JSON.parse(JSON.stringify(mirror.pedViews[k]))).toEqual(JSON.parse(JSON.stringify(p)));
        peds++;
      });
      // The signal heads.
      for (const c of sim.signalisedControllers()) {
        const shownController = mirror.controller(c.node)!;
        for (const g of sim.graph.junctions.get(c.node)!.groups) {
          expect(signalStateFor(shownController as never, g.id)).toBe(signalStateFor(c, g.id));
          heads++;
        }
      }
    }
    expect(vehicles).toBeGreaterThan(5_000);
    expect(signalling).toBeGreaterThan(50);
    expect(parked).toBeGreaterThan(100);
    expect(peds).toBeGreaterThan(5_000);
    expect(heads).toBeGreaterThan(0);
    expect(lampsMoved).toBeGreaterThan(0);
    expect(lampsMoved).toBeLessThan(150);
  }, 10_000);
});
