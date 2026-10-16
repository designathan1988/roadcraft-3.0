import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Box3, MeshBasicMaterial, Vector3, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import type { SceneMaterials } from '@render/materials';
import { buildRoadSurfaces, roadSurfaceSteps, type RoadSurfaces, type SurfaceReuse } from '@render/roadSurfaces';
import { SurfaceInputs, surfaceInputWork } from '@render/roadSurfaceInputs';
import type { NodeId, SegmentId } from '@world/ids';
import { generateBody } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { TileMesher, type TileMeshes } from '@render/roadTileMesh';
import type { RoadTiler, TileJob } from '@render/roadTilePool';

/** THE ROADS' TILES MADE OFF THE PAGE (`roadTilePool.ts`): the steps with a tiler that does what the workers do */
const materials = new Proxy({}, {
  get: (_target, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial(),
}) as unknown as SceneMaterials;
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);

function bytesOf(root: Object3D): string {
  const hash = createHash('sha256');
  let meshes = 0;
  root.traverse((object) => {
    const geometry = (object as { geometry?: BufferGeometry }).geometry;
    if (!geometry) return;
    meshes++;
    hash.update(object.name);
    // `color` and `roadSection` only where the material reads them (`mergeTiles`): none on these plain materials.
    for (const name of ['position', 'normal', 'uv', 'color', 'roadSection']) {
      if (!geometry.getAttribute(name)) { hash.update(`no ${name}`); continue; }
      const array = geometry.getAttribute(name).array as Float32Array;
      hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
    const index = geometry.getIndex()!.array as Uint32Array;
    hash.update(new Uint8Array(index.buffer, index.byteOffset, index.byteLength));
  });
  return `${meshes} ${hash.digest('hex')}`;
}

/** Shares a batch is cut into, as the pool cuts it between its workers: each reads only the roads handed to it. */
const SHARES = 3;

/** A tiler that does what the pool and its workers do, here: everything crossing a thread copied as messages are. */
function workerTiler(): RoadTiler & { asked: number; groundAsked: number } {
  const tiler = {
    asked: 0,
    groundAsked: 0,
    tiles: (job: TileJob) => {
      tiler.asked += job.tiles.length;
      const per = Math.ceil(job.tiles.length / SHARES);
      const made: TileMeshes[] = [];
      for (let k = 0; k * per < job.tiles.length; k++) {
        const share = job.tiles.slice(k * per, (k + 1) * per);
        const mesher = new TileMesher(structuredClone({ pass: job.pass, tiles: share, data: job.dataFor(share.map((t) => t.rect)).data }));
        let need = mesher.need();
        for (;;) {
          const asked = structuredClone(need);
          tiler.groundAsked += asked.length / 2;
          mesher.give(need, Float64Array.from({ length: asked.length / 2 }, (_, i) => job.terrainAt(asked[i * 2]!, asked[i * 2 + 1]!)));
          const done = mesher.run();
          if ('tiles' in done) { made.push(...structuredClone(done.tiles)); break; }
          need = done.need;
        }
      }
      return Promise.resolve(made.map((tile) => new Map(tile)));
    },
    check: () => {},
  };
  return tiler;
}

/** The grid and bends with what only some maps have: a node lifted by the player */
function authored(): RoadDoc {
  const file = JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')) as { document: {
    nodes: { id: number; heightOffset?: number }[]; segments: { id: number; structure: string; section?: unknown }[] } };
  const { nodes, segments } = file.document;
  const ground = segments.filter((s) => s.structure === 'ground');
  ground[0]!.section = { laneWidth: m(3), sidewalk: m(4), sidewalkLeft: m(2), sidewalkRight: m(4), median: 0, speedKmh: 50, priority: 1,
    flushLeft: true, materials: { footwayLeft: 'stone', carriageway: 'cobble' } };
  ground[3]!.section = { laneWidth: m(3.2), sidewalk: m(3), median: 0, speedKmh: 50, priority: 1, materials: { carriageway: 'concrete', footwayRight: 'concrete' } };
  nodes[5]!.heightOffset = m(4);
  return RoadDoc.fromJSON(file.document as never);
}

async function stepped(net: Network, tiler: RoadTiler, groundMaterial?: MeshBasicMaterial): Promise<RoadSurfaces> {
  const elevation = buildRoadElevation(net, ground);
  const steps = roadSurfaceSteps(net, elevation, materials, ground, undefined, groundMaterial, tiler);
  for (;;) {
    const step = steps.next();
    if (step.done) { step.value.adopt(); return step.value; }
    // Waiting on the tiler: its answer comes in a later task, as a worker's does.
    if (step.value === 'wait') await new Promise((done) => setTimeout(done, 0));
  }
}

describe('road surface tiles made off the page', () => {
  for (const [name, make, lawn] of [
    ['the grid and bends fixture', () => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document), false],
    ['a generated city', () => layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' })), true],
    ['the fixture with a road at authored heights, a flush footway and paving', authored, false],
  ] as const) it(`build ${name} as the page does, byte for byte`, async () => {
    const doc = make();
    const net = new Network(doc);
    net.rebuild();
    if (make === authored) expect(net.flushCells.size).toBeGreaterThan(0);
    // The ground verge on the terrain's own material (its UV in world x, y) in one of the two.
    const groundMaterial = lawn ? new MeshBasicMaterial() : undefined;
    const here = buildRoadSurfaces(net, buildRoadElevation(net, ground), materials, ground, undefined, groundMaterial);
    const tiler = workerTiler();
    const off = await stepped(net, tiler, groundMaterial);
    expect(tiler.asked).toBeGreaterThan(20);
    // Every tile made off the page, the ground read on the page only where a worker asked.
    expect(off.built).toBe(tiler.asked);
    expect(tiler.groundAsked).toBeGreaterThan(0);
    expect(bytesOf(off.group)).toBe(bytesOf(here.group));
    // Each block bounded by its tiles' boxes (`surfaceTiles.ts`): the box its vertices give, a sphere holding them.
    let blocks = 0;
    const p = new Vector3();
    off.group.traverse((object) => {
      const geometry = (object as { geometry?: BufferGeometry }).geometry;
      if (!geometry) return;
      blocks++;
      const position = geometry.getAttribute('position');
      const exact = new Box3().setFromBufferAttribute(position as never);
      expect(geometry.boundingBox!.equals(exact), object.name).toBe(true);
      const sphere = geometry.boundingSphere!;
      for (let i = 0; i < position.count; i++) expect(sphere.distanceToPoint(p.fromBufferAttribute(position as never, i))).toBeLessThanOrEqual(1e-3);
    });
    expect(blocks).toBeGreaterThan(0);
  });
});

/** THE INPUTS KEPT BETWEEN BUILDS (`roadSurfaceInputs.ts`) */
describe('road surface inputs kept between builds', () => {
  // Materials that stay the same between builds, so a block whose tiles did not change keeps its mesh.
  const stable = new Map<PropertyKey, unknown>();
  const kept = new Proxy({}, {
    get: (_target, key) => {
      if (key === 'scale') return new Proxy({}, { get: () => 4 });
      if (!stable.has(key)) stable.set(key, new MeshBasicMaterial());
      return stable.get(key);
    },
  }) as unknown as SceneMaterials;
  const doc = authored();
  const net = new Network(doc);
  net.rebuild();
  let elevation = buildRoadElevation(net, ground);
  const reuse: SurfaceReuse = {
    tiles: new Map(),
    dependsOn: (minX, minY, maxX, maxY) => elevation.digest(minX, minY, maxX, maxY),
    paint: new Map(),
    chunks: new Map(),
    inputs: new SurfaceInputs(),
  };
  buildRoadSurfaces(net, elevation, kept, ground, reuse);
  const roads = doc.segments.size;

  /** The edit, the network and the solve brought up to it, then the kept build against one from nothing. */
  const after = (edit: () => void, everywhere = false): RoadSurfaces => {
    edit();
    net.rebuild();
    elevation = buildRoadElevation(net, ground);
    surfaceInputWork.segments = 0;
    surfaceInputWork.nodes = 0;
    const warm = buildRoadSurfaces(net, elevation, kept, ground, reuse);
    // The items the edit touched made again, never the whole map - but for a change of every road's paint.
    if (everywhere) expect(surfaceInputWork.segments).toBe(doc.segments.size);
    else expect(surfaceInputWork.segments).toBeLessThan(roads / 2);
    const fresh = buildRoadSurfaces(net, elevation, kept, ground);
    expect(warm.reused).toBeGreaterThan(0);
    expect(bytesOf(warm.group)).toBe(bytesOf(fresh.group));
    fresh.dispose();
    return warm;
  };
  const nodes = (): NodeId[] => [...doc.nodes.keys()].sort((p, q) => p - q);
  const ofDegree = (n: number): NodeId[] => nodes().filter((id) => doc.node(id)!.incident.length === n);

  it('adds a road, then moves a node', () => {
    const end = doc.node(ofDegree(1)[0]!)!;
    after(() => { doc.addSegment(end.id, doc.addNode({ x: end.x + m(30), y: end.y + m(40) }).id, 1); });
    const corner = doc.node(ofDegree(3)[0]!)!;
    after(() => { doc.moveNode(corner.id, { x: corner.x + m(3), y: corner.y - m(2) }); });
  });

  it('deletes a road, then raises a node by hand into an alignment of its own', () => {
    const ground = [...doc.segments.values()].filter((s) => s.structure === 'ground').sort((p, q) => p.id - q.id);
    after(() => { doc.removeSegment(ground[ground.length - 1]!.id); });
    const before = [...reuse.tiles.keys()].filter((id) => id.startsWith('alignment-')).length;
    const middle = ofDegree(2).find((id) => doc.node(id)!.heightOffset === 0)!;
    after(() => { doc.setNodeHeightOffset(middle, m(5)); });
    expect([...reuse.tiles.keys()].filter((id) => id.startsWith('alignment-')).length).toBeGreaterThan(before);
  });

  it('lowers it again, and changes the standard of the paint', () => {
    const raised = nodes().filter((id) => doc.node(id)!.heightOffset > 0);
    after(() => { doc.setNodeHeightOffset(raised[raised.length - 1]!, 0); });
    after(() => { doc.setMarkingStyle('br'); }, true);
  });

  it('makes a junction a mini-roundabout, puts a crossing mid-block and parking along a street', () => {
    after(() => { doc.setNodeControl(ofDegree(3)[1]!, 'mini'); });
    const through = ofDegree(2).find((id) => doc.node(id)!.heightOffset === 0)!;
    after(() => { expect(doc.setNodeCrossing(through, 'zebra', doc.node(through)!.incident[0]! as SegmentId)).toBe(true); });
    const street = [...doc.segments.values()].filter((s) => s.structure === 'ground').sort((p, q) => p.id - q.id)[1]!;
    after(() => { doc.setSegmentParking(street.id, { left: 'parallel', right: 'parallel' }); });
    // A lot with parking of its own beside that street: its bays keep clear of the entrance.
    const ribbon = net.ribbons.get(street.id)!;
    const mid = ribbon.full.sampleAt(ribbon.full.length / 2);
    const out = ribbon.road.width / 2 + m(6);
    const lot = { ...generateBody('residential', 30, 30, 2), x: mid.p.x + mid.n.x * out, y: mid.p.y + mid.n.y * out, rotation: 0,
      elements: [{ id: 1, kind: 'parking', x: 0, y: 0, facing: 0, w: m(8), d: m(8), z: 0, h: 0 }] } as unknown as Building;
    expect(after(() => { doc.buildings.add(lot); }).built).toBeGreaterThan(0);
  });
});
