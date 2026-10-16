import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InstancedMesh } from 'three';

import { createAgentMeshes } from '@render/agents';
import { archetypeById } from '@sim/vehicles/archetypes';
import type { ShownVehicle, SimMirror } from '@sim/mirror';
import type { VehicleId } from '@sim/vehicles/state';
import type { Network } from '@world/network';
import { ChangeJournal } from '@world/changes';
import { FLEET_CEILING } from '@sim/params';
import { m } from '@world/units';

/** Parked cars as the renderer draws them: written once, then copied each frame (`parkedDraws`). */

/** A car standing in its bay with nobody in it: what `sync` takes as parked. */
function parkedCar(id: number, x: number, y: number, lot: number | undefined = 1): ShownVehicle {
  // Nobody aboard: its engine off and its instances copied from frame to frame (`sync` `still`).
  return {
    id: id as VehicleId, archetype: archetypeById('sedan'), color: '#a83a2c', free: { x, y, angle: 0.3, px: x, py: y, pangle: 0.3, lot },
    v: 0, prev: { v: 0 }, age: 0, seats: 0, people: [], peopleAge: [], doors: [], kerbStop: null, slain: false,
    ends: { x0: x, y0: y, h0: 0.3, yaw0: 0, x1: x, y1: y, h1: 0.3, yaw1: 0, before: true },
    segment: undefined, indicator: 0, curvature: 0, odometer: 0,
  };
}

/** The simulation as the page sees it (`SimMirror`): no traffic, the parked cars, nobody walking. */
function worldWith(parked: readonly ShownVehicle[]): SimMirror {
  return { tick: 0, road: [], parked: new Map(parked.map((v) => [v.id, v])), pedViews: [], fleetVersion: 0, has: () => true } as unknown as SimMirror;
}

/** The network as `sync` reads it: the diary of changes. */
const netWith = (changes = new ChangeJournal()): Network => ({ doc: { changes } }) as unknown as Network;

const meshesOf = (agents: ReturnType<typeof createAgentMeshes>, test: RegExp): InstancedMesh[] =>
  agents.meshes.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true && test.test(o.name));
const drawn = (meshes: readonly InstancedMesh[]): number => meshes.reduce((n, mesh) => n + (mesh.visible ? mesh.count : 0), 0);

describe('parked cars drawn by copying their first frame', () => {
  // The page the meshes are made in: the cooked bodies only (`?bodies=cooked`), no procedural crowd.
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '?bodies=cooked' }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('keep their steering wheel in the copied frames', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const world = worldWith([parkedCar(1, 0, 0), parkedCar(2, m(10), 0)]);
    const net = netWith();
    const wheels = meshesOf(agents, /^car-.*-wheel$/);
    expect(wheels.length).toBeGreaterThan(0);
    agents.sync(world, net, 0, true);
    const first = drawn(wheels);
    expect(first).toBe(2);
    // The second frame copies what the first wrote (`replay`).
    agents.sync(world, net, 0, true);
    expect(drawn(wheels)).toBe(first);
    agents.dispose();
  });

  it('stand on the ground again after the ground under them changed', () => {
    let lot = 0;
    const changes = new ChangeJournal();
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => lot);
    const world = worldWith([parkedCar(1, m(5), m(5))]);
    const net = netWith(changes);
    const bodies = meshesOf(agents, /^car-.*-shell$/);
    const height = (): number => {
      const mesh = bodies.find((b) => b.visible && b.count > 0);
      if (!mesh) throw new Error('no body drawn');
      return mesh.instanceMatrix.array[13]!;
    };
    agents.sync(world, net, 0, true);
    expect(height()).toBeCloseTo(0, 6);
    // The lot raised by 2 m, and the diary told where (the ground cut and filled).
    lot = m(2);
    changes.record('ground', [[0, 0, m(10), m(10)]]);
    agents.sync(world, net, 0, true);
    expect(height()).toBeCloseTo(m(2), 6);
    // A change elsewhere does not move it (it is not asked again).
    lot = m(7);
    changes.record('ground', [[m(100), m(100), m(110), m(110)]]);
    agents.sync(world, net, 0, true);
    expect(height()).toBeCloseTo(m(2), 6);
    agents.dispose();
  });

  it('are all drawn past the fleet ceiling', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const count = FLEET_CEILING + 300;
    const cars: ShownVehicle[] = [];
    for (let i = 0; i < count; i++) cars.push(parkedCar(i + 1, (i % 60) * m(8), Math.floor(i / 60) * m(8)));
    const world = worldWith(cars);
    const net = netWith();
    const bodies = meshesOf(agents, /^car-.*-(shell|shell-lite|far)$/);
    const wheels = meshesOf(agents, /^vehicle-wheels$/);
    agents.sync(world, net, 0, true);
    expect(drawn(bodies)).toBe(count);
    expect(drawn(wheels)).toBe(count * 4);
    // And copied in the next frame.
    agents.sync(world, net, 0, true);
    expect(drawn(bodies)).toBe(count);
    expect(drawn(wheels)).toBe(count * 4);
    agents.dispose();
  });
});
