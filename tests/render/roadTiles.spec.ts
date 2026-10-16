import { readFileSync } from 'node:fs';
import { MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { Digest } from '@core/digest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import type { SceneMaterials } from '@render/materials';
import { buildRoadSurfaces, roadSurfaceSteps, type SurfaceReuse } from '@render/roadSurfaces';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import { buildDefaultTown } from '../world/support/town/defaultTown';
import { TUNED_UNIT } from '@world/units';
import { refillArrays } from '@render/mesh/gpuOnly';

/** The 0.4 m unit these scenes were laid out in: lengths below in it, times U. */
const U = TUNED_UNIT;

/** The road surfaces are built a tile at a time, and a tile an edit does not reach is copied from the build before. */

const materials = new Proxy({}, {
  get: (_target, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial(),
}) as unknown as SceneMaterials;

/** Gently rolling ground, read the way the terrain mesh would be. */
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);

function fixture(): RoadDoc {
  return RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);
}

function fingerprint(root: Object3D): number {
  const digest = new Digest();
  root.traverse((object) => {
    const geometry = (object as { geometry?: BufferGeometry }).geometry;
    if (!geometry) return;
    digest.addText(object.name);
    // `color` only where the material reads it (`SurfaceSpec` reads): its presence is part of the fingerprint.
    for (const name of ['position', 'normal', 'uv', 'color']) {
      const attribute = geometry.getAttribute(name);
      digest.addText(attribute ? name : `-${name}`);
      if (attribute) digest.addAll(attribute.array);
    }
    digest.addAll(geometry.getIndex()!.array);
  });
  return digest.value();
}

function reuseFor(elevation: () => RoadElevation): SurfaceReuse {
  return {
    tiles: new Map(),
    // The ground here is a fixed function, so the roads are all there is to digest.
    dependsOn: (minX, minY, maxX, maxY) => elevation().digest(minX, minY, maxX, maxY),
    paint: new Map(),
    chunks: new Map(),
    inputs: new SurfaceInputs(),
  };
}

describe('road surface tiles', () => {
  const doc = fixture();
  const net = new Network(doc);
  net.rebuild();
  let elevation = buildRoadElevation(net, ground);
  const reuse = reuseFor(() => elevation);
  const cold = buildRoadSurfaces(net, elevation, materials, ground, reuse);
  // Before the next build: a block it keeps moves to that build's group (`adopt`).
  const coldPrint = fingerprint(cold.group);

  it('builds every tile the first time', () => {
    expect(cold.built).toBeGreaterThan(20);
    expect(cold.reused).toBe(0);
  });

  it('builds nothing again when nothing changed', () => {
    const again = buildRoadSurfaces(net, elevation, materials, ground, reuse);
    expect(again.built).toBe(0);
    expect(again.reused).toBe(cold.built);
    expect(fingerprint(again.group)).toBe(coldPrint);
  });

  it('rebuilds only what an edit reaches, into exactly the mesh a fresh build makes', () => {
    const first = [...doc.nodes.values()][0]!;
    const far = doc.addNode({ x: first.x + 40, y: first.y - 260 });
    doc.addSegment(first.id, far.id, 2);
    net.rebuild();
    elevation = buildRoadElevation(net, ground);

    const warm = buildRoadSurfaces(net, elevation, materials, ground, reuse);
    expect(warm.built).toBeGreaterThan(0);
    expect(warm.reused).toBeGreaterThan(warm.built * 2);

    const fresh = buildRoadSurfaces(net, elevation, materials, ground, reuseFor(() => elevation));
    expect(fresh.reused).toBe(0);
    expect(fingerprint(warm.group)).toBe(fingerprint(fresh.group));
    expect(warm.triangles).toBe(fresh.triangles);
  });

  it('forgets a structural level that is no longer built', () => {
    for (const segment of [...doc.segments.values()]) {
      if (segment.structure !== 'ground') doc.setSegmentStructure(segment.id, 'ground');
    }
    net.rebuild();
    elevation = buildRoadElevation(net, ground);
    buildRoadSurfaces(net, elevation, materials, ground, reuse);
    expect([...reuse.tiles.keys()]).toEqual(['ground']);
  });

  it('draws a road raised in one stroke as one surface, not a piece at a time', () => {
    // Four pieces at authored heights, bending a little at each node: one alignment pass.
    const doc = new RoadDoc();
    const pts: [number, number, number][] = [[0, 0, 0], [60, 4, 5], [120, 0, 9], [180, 6, 5], [240, 0, 0]];
    const nodes = pts.map(([x, y, h]) => doc.addNode({ x, y }, h));
    for (let i = 1; i < nodes.length; i++) doc.addSegment(nodes[i - 1]!.id, nodes[i]!.id, 1);
    const net = new Network(doc);
    net.rebuild();
    const reuse = reuseFor(() => buildRoadElevation(net, ground));
    buildRoadSurfaces(net, buildRoadElevation(net, ground), materials, ground, reuse);
    expect([...reuse.tiles.keys()].filter((id) => id.startsWith('alignment-'))).toHaveLength(1);
  });
  it('builds again only the tiles a street reaches, when it changes the order the lines are painted in', () => {
    // A street of a new class at the east end of the parking town
    const doc = RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')));
    const net = new Network(doc);
    net.rebuild();
    let elevation = buildRoadElevation(net, ground);
    const reuse = reuseFor(() => elevation);
    buildRoadSurfaces(net, elevation, materials, ground, reuse);
    const end = [...doc.nodes.values()].filter((n) => n.incident.length === 1).sort((p, q) => q.x - p.x)[0]!;
    doc.addSegment(end.id, doc.addNode({ x: end.x - 177 * U, y: end.y + 178 * U }).id, 1);
    net.rebuild();
    elevation = buildRoadElevation(net, ground);
    const warm = buildRoadSurfaces(net, elevation, materials, ground, reuse);
    expect(warm.built).toBeLessThan(15);
    const fresh = buildRoadSurfaces(net, elevation, materials, ground, reuseFor(() => elevation));
    expect(fingerprint(warm.group)).toBe(fingerprint(fresh.group));
  });

  it('sends the GPU only the blocks of tiles an edit reaches, keeping the mesh of every other block', () => {
    // Every tile used to be merged into one mesh per surface on every edit and sent whole
    const stable = new Map<PropertyKey, unknown>();
    const kept = new Proxy({}, {
      get: (_target, key) => {
        if (key === 'scale') return new Proxy({}, { get: () => 4 });
        if (!stable.has(key)) stable.set(key, new MeshBasicMaterial());
        return stable.get(key);
      },
    }) as unknown as SceneMaterials;
    const town = new RoadDoc();
    buildDefaultTown(town);
    const net = new Network(town);
    net.rebuild();
    let elevation = buildRoadElevation(net, ground);
    const reuse: SurfaceReuse = reuseFor(() => elevation);
    const before = buildRoadSurfaces(net, elevation, kept, ground, reuse);
    const end = [...town.nodes.values()].filter((n) => n.incident.length === 1).sort((p, q) => q.x - p.x)[0]!;
    town.addSegment(end.id, town.addNode({ x: end.x + 60, y: end.y + 20 }).id, 1);
    net.rebuild();
    elevation = buildRoadElevation(net, ground);
    const after = buildRoadSurfaces(net, elevation, kept, ground, reuse);
    const same = after.meshes.filter((mesh) => before.meshes.includes(mesh)).length;
    expect(after.meshes.length).toBeGreaterThan(8);
    expect(same).toBeGreaterThan(after.meshes.length * 0.6);
    // The blocks the street reached merged again, their unchanged tiles built again from their rings.
    expect(after.remade).toBeGreaterThan(0);
    const fresh = buildRoadSurfaces(net, elevation, kept, ground, reuseFor(() => elevation));
    expect(fingerprint(after.group)).toBe(fingerprint(fresh.group));

    // The roads still drawn keep every block they share until the swap
    const drawn = after.group.children.length;
    town.addSegment(end.id, town.addNode({ x: end.x + 40, y: end.y - 50 }).id, 1);
    net.rebuild();
    elevation = buildRoadElevation(net, ground);
    const steps = roadSurfaceSteps(net, elevation, kept, ground, reuse);
    let step = steps.next();
    while (!step.done) step = steps.next();
    const next = step.value;
    const shared = next.meshes.filter((mesh) => after.meshes.includes(mesh));
    expect(shared.length).toBeGreaterThan(next.meshes.length * 0.6);
    expect(after.group.children.length).toBe(drawn);
    for (const mesh of shared) expect(mesh.parent).toBe(after.group);
    next.adopt();
    for (const mesh of next.meshes) expect(mesh.parent).toBe(next.group);
    expect(next.group.children.length).toBe(next.meshes.length);
  });

  it('changes the solve only near a short street joined to a long one, and the cache stays exact over many edits', () => {
    // A street's whole profile was in the digest of every block it passes
    const town = new RoadDoc();
    buildDefaultTown(town);
    const net = new Network(town);
    net.rebuild();
    let elevation = buildRoadElevation(net, ground);
    const reuse = reuseFor(() => elevation);
    buildRoadSurfaces(net, elevation, materials, ground, reuse);
    const middles = [...town.nodes.values()].filter((n) => n.incident.length === 2);
    for (let k = 0; k < 2; k++) {
      const at = middles[(k * 7919) % middles.length]!;
      const before = elevation;
      town.addSegment(at.id, town.addNode({ x: at.x + 30 + 10 * k, y: at.y + 35 }).id, 1);
      net.rebuild();
      elevation = buildRoadElevation(net, ground);
      let changed = 0;
      for (let x = -2400; x < 2400; x += 160) for (let y = -2400; y < 2400; y += 160) {
        if (before.digest(x, y, x + 160, y + 160) !== elevation.digest(x, y, x + 160, y + 160)) changed++;
      }
      expect(changed).toBeLessThan(25);
      const warm = buildRoadSurfaces(net, elevation, materials, ground, reuse);
      const fresh = buildRoadSurfaces(net, elevation, materials, ground, reuseFor(() => elevation));
      expect(fingerprint(warm.group)).toBe(fingerprint(fresh.group));
    }
  });

  it('keeps no tile arrays between builds, and a lost context gets every block back the same from the rings', () => {
    // The tiles were kept whole (`reuse.tiles`, and again by the blocks they were merged into, and by each block's refill)
    const net = new Network(fixture());
    net.rebuild();
    const elevation = buildRoadElevation(net, ground);
    const reuse = reuseFor(() => elevation);
    const built = buildRoadSurfaces(net, elevation, materials, ground, reuse);
    for (const tiles of reuse.tiles.values()) for (const surfaces of tiles.values()) {
      expect(surfaces.every((name) => typeof name === 'string')).toBe(true);
    }
    for (const { parts } of reuse.chunks.values()) expect(parts.every((digest) => typeof digest === 'number')).toBe(true);
    // Each block let go of its arrays (uploaded), then filled again as a restored context does.
    for (const mesh of built.meshes) {
      const geometry = mesh.geometry;
      const before = fingerprint(mesh);
      for (const attribute of [...Object.values(geometry.attributes), geometry.getIndex()!]) {
        (attribute as { array: ArrayLike<number> | null }).array = null;
      }
      refillArrays(mesh);
      expect(fingerprint(mesh)).toBe(before);
    }
  });
});
