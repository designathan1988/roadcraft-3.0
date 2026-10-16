import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ForkMap, forkWork } from '@core/forkMap';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { Change } from '@world/changes';
import type { NodeId, SegmentId } from '@world/ids';
import type { Building, BuildingId } from '@world/buildings/types';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { History } from '@editor/history';
import { commitRoadPath, duplicateSegment, joinSegments, moveNodeChecked, reconcileMovedNode, splitSegment, type DraftResult } from '@editor/commit';
import { m } from '@world/units';
import { growCity } from './cityAudit';

/** AN EDIT'S WORKING COPY COSTS WHAT THE EDIT TOUCHES (`RoadDoc.fork`, 2026-10-15) */

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fixture = (name: string): string => {
  const data = JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf8')) as { document?: unknown };
  return JSON.stringify(data.document ?? data);
};

/** What a diary entry says, without its time. */
const said = (e: Change): unknown => ({ serial: e.serial, kind: e.kind, rects: e.rects, ids: e.ids ?? null, cause: e.cause, parent: e.parent ?? null, detail: e.detail ?? null });

/** The k-th of a collection, by a fraction: the same pick on two equal documents. */
function nth<T>(items: Iterable<T>, at: number): T | undefined {
  const list = [...items];
  return list.length ? list[Math.floor(at * list.length) % list.length] : undefined;
}

/** Every index by place of a document, asked over the whole map, as plain data. */
function places(doc: RoadDoc): unknown {
  // Over everything the document holds and where the edits below put things (DO NOT ask over the whole plane: a filing reads every cell asked).
  let x0 = -100, y0 = -2100, x1 = 1400, y1 = 400;
  const take = (x: number, y: number): void => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const n of doc.nodes.values()) take(n.x, n.y);
  for (const q of doc.poles.values()) take(q.x, q.y);
  for (const i of doc.landscape.values()) take(i.x, i.y);
  for (const b of doc.barriers.values()) for (const q of b.points) take(q.x, q.y);
  for (const l of doc.lotStore.all()) for (const q of l.corners) take(q.x, q.y);
  for (const b of doc.buildings.all()) take(b.x, b.y);
  const all = [x0 - 200, y0 - 200, x1 + 200, y1 + 200] as const;
  return {
    poles: doc.polesIn(all).map((p) => p.id).sort((a, b) => a - b),
    spans: [...doc.poles.keys()].map((id) => doc.spansAt(id).map((s) => s.id)),
    landscape: doc.landscapeIn(all).map((i) => i.id),
    barriers: doc.barriersIn(all).map((b) => b.id),
    trees: doc.treesIn(all).length,
    elements: doc.elementsIn(all).length,
    lots: doc.lotsIn(all).map((l) => l.id),
    buildings: doc.buildings.near(all[0], all[1], all[2], all[3]).map((b) => b.id),
    names: [...doc.streetNamesInUse].sort(),
    marks: doc.allocatorMarks(),
    nextLot: doc.nextLotId,
    keys: doc.lotKeys.length,
  };
}

/** What a network derived from its document, as plain data in its own order: ribbons, junctions, trims, marks, filings. */
function derived(doc: RoadDoc, net: Network): unknown {
  const all = [-1e5, -1e5, 1e5, 1e5] as const;
  return {
    ribbons: [...net.ribbons].map(([id, r]) => [id, r.full.length]),
    junctions: [...net.junctions].map(([id, byLevel]) => [id, [...byLevel.keys()]]),
    trims: [...net.trims],
    plates: [...net.plateReach],
    impossible: [...net.impossible],
    squeezed: [...net.squeezed],
    transitions: [...net.transitions],
    cells: [net.segmentCells.idsMeeting(all), net.junctionCells.idsMeeting(all), net.flushCells.idsMeeting(all)],
    lines: [...doc.segments.keys()].map((id) => net.polylines.get(doc, id).length),
    revisions: [net.revision, net.trafficRevision],
  };
}

type Edit = (doc: RoadDoc, net: Network, at: number) => void;

/** Edits of every kind a document has, each choosing what it edits from the document it is given. */
const EDITS: readonly [string, Edit][] = [
  ['split a road', (doc, net, at) => {
    const id = nth(doc.segments.keys(), at);
    if (id === undefined) return;
    const line = net.polylines.get(doc, id);
    if (line.length > 40) splitSegment(doc, net, id, line.length / 2, line.sampleAt(line.length / 2).p);
  }],
  ['join at a node', (doc, _net, at) => {
    const node = nth([...doc.nodes.values()].filter((n) => n.incident.length === 2), at);
    if (node) joinSegments(doc, node.id);
  }],
  ['copy a road', (doc, net, at) => { const id = nth(doc.segments.keys(), at); if (id !== undefined) duplicateSegment(doc, net, id); }],
  ['move a node and reconcile it', (doc, net, at) => {
    const node = nth(doc.nodes.values(), at);
    if (!node) return;
    doc.moveNode(node.id, { x: node.x + 7, y: node.y - 5 });
    reconcileMovedNode(doc, net, node.id);
  }],
  ['retype, lanes, direction, bend', (doc, _net, at) => {
    const id = nth(doc.segments.keys(), at);
    if (id === undefined) return;
    doc.setSegmentType(id, (doc.requireSegment(id).type + 1) % 3);
    doc.setSegmentLanes(id, 4);
    doc.setSegmentCurve(id, { t: 0.5, h: 6 });
    doc.setSegmentDirection(id, 'aToB');
    doc.setSegmentCutWalls(id, true);
    doc.setSegmentStructure(id, 'tunnel');
  }],
  ['junction settings', (doc, _net, at) => {
    const node = nth([...doc.nodes.values()].filter((n) => n.incident.length >= 2), at);
    if (!node) return;
    const [a, b] = node.incident as [SegmentId, SegmentId];
    doc.setNodeControl(node.id, 'signal');
    doc.setMovementBlocked(node.id, a, b, true);
    doc.setNodeHeightOffset(node.id, node.heightOffset + 2);
    if (node.incident.length === 2) doc.setNodeCrossing(node.id, 'zebra', a);
  }],
  ['take a road away', (doc, _net, at) => {
    const id = nth(doc.segments.keys(), at);
    if (id === undefined) return;
    doc.removeSegment(id);
    doc.pruneOrphanNodes();
  }],
  ['a new road from free ends', (doc, _net, at) => {
    const a = doc.addNode({ x: 100 + at * 900, y: -2000 });
    const b = doc.addNode({ x: 300 + at * 900, y: -2000 });
    doc.addSegment(a.id, b.id, 1);
  }],
  ['take a node away', (doc, _net, at) => { const node = nth(doc.nodes.values(), at); if (node) doc.removeNode(node.id); }],
  ['poles and wires', (doc, _net, at) => {
    const p = doc.addPole({ x: at * 500, y: 40 }, true);
    const q = doc.addPole({ x: at * 500 + 60, y: 40 });
    doc.addPoleSpan(p.id, q.id);
    const old = nth(doc.poles.keys(), at * 0.5);
    if (old !== undefined && old !== p.id && old !== q.id) doc.removePole(old);
  }],
  ['street furniture', (doc, _net, at) => {
    doc.addLandscapeMany([{ kind: 'bench', at: { x: at * 300, y: 12 } }, { kind: 'streetname', at: { x: at * 300 + 8, y: 12 }, extra: { text: `Rua ${Math.floor(at * 10)}` } }]);
    const old = nth(doc.landscape.keys(), at);
    if (old !== undefined) doc.removeLandscape(old);
  }],
  ['walls', (doc, _net, at) => {
    doc.addBarrier('fence', [{ x: at * 200, y: 70 }, { x: at * 200 + 50, y: 90 }]);
    const old = nth(doc.barriers.keys(), at * 0.3);
    if (old !== undefined) doc.removeBarrier(old);
  }],
  ['the land and its brushes', (doc, _net, at) => {
    doc.addTerrainStamp({ mode: 'raise', x: at * 400, y: 300, radius: 80, strength: 3 });
    doc.addPaintDab({ kind: 'grass', x: at * 400, y: 310, radius: 20, strength: 1 });
    doc.addFogDab({ x: at * 400, y: 320, radius: 30, strength: 0.5, height: 20 } as never);
    doc.plantTrees([{ x: at * 400, y: 330, height: 20, yaw: 0, seed: at }, { x: at * 400 + 10, y: 335, height: 20, yaw: 1, seed: at }]);
    doc.cutTrees(at * 400 + 10, 335, 4);
    doc.addElements([{ kind: 'rock', x: at * 400, y: 340, size: 2, yaw: 0, seed: at } as never]);
    doc.addCloud({ x: at * 400, y: 350, size: 90, height: 300, density: 0.5, yaw: 0 } as never);
    doc.setWeather({ rain: at });
    doc.setBalance(1_000_000 - Math.floor(at * 1000));
  }],
  ['buildings and lots', (doc, _net, at) => {
    const b = nth(doc.buildings.all(), at) as Building | undefined;
    if (b) {
      doc.buildings.put({ ...b, x: b.x + 1 });
      doc.buildings.add({ ...b, x: b.x + 200 } as Omit<Building, 'id'>);
      const other = nth(doc.buildings.all(), 1 - at) as Building | undefined;
      if (other && other.id !== b.id) doc.buildings.remove(other.id as BuildingId);
    }
    const lot = nth(doc.lotStore.all(), at);
    if (lot) doc.lotStore.apply({ put: [{ ...lot, corners: lot.corners.map((q) => ({ x: q.x + 1, y: q.y })) }] }, 'test');
    const gone = nth(doc.lotStore.all(), 1 - at);
    if (gone && gone !== lot) doc.lotStore.apply({ remove: [gone.id] }, 'test');
    doc.lotStore.addKeys([`k${Math.floor(at * 1e6)}`], undefined, 'test');
  }],
  ['people and transit', (doc, _net, at) => {
    doc.savePerson({ id: doc.nextPersonId(), name: `P${Math.floor(at * 100)}` } as never);
    doc.setTransit({ ...doc.transit });
  }],
];

/** Two equal documents with their networks, from one file. */
function twins(text: string): { a: RoadDoc; na: Network; b: RoadDoc; nb: Network } {
  const a = RoadDoc.fromJSON(JSON.parse(text), { repair: false });
  const b = RoadDoc.fromJSON(JSON.parse(text), { repair: false });
  const na = new Network(a), nb = new Network(b);
  na.rebuild();
  nb.rebuild();
  return { a, na, b, nb };
}

/** Every edit made directly on `a`, and on a fork of `b` taken back: the two documents must stay the same, diary included. */
function sameEdits(text: string, seed: number, steps: number): void {
  const { a, na, b, nb } = twins(text);
  const rand = random(seed);
  const fromA = a.changes.version, fromB = b.changes.version;
  expect(fromB).toBe(fromA);
  for (let step = 0; step < steps; step++) {
    const [name, edit] = EDITS[Math.floor(rand() * EDITS.length)]!;
    const at = rand();
    edit(a, na, at);
    if (na.revision !== a.revision) na.rebuild();
    const work = b.fork();
    const workNet = nb.fork(work);
    edit(work, workNet, at);
    if (workNet.revision !== work.revision) workNet.rebuild();
    b.replaceWith(work);
    nb.takeBack(workNet);
    expect(b.changes.since(fromB)?.map(said), `${name} (step ${step}): the diary`).toEqual(a.changes.since(fromA)?.map(said));
    expect(places(b), `${name} (step ${step}): the indices by place`).toEqual(places(a));
    expect(derived(b, nb), `${name} (step ${step}): the network taken back`).toEqual(derived(a, na));
  }
  expect(b.toJSON()).toEqual(a.toJSON());
  expect(nb.revision).toBe(na.revision);
}

describe('a working copy taken back is the same edits made in place', () => {
  it('on a grown city (roads, lots, buildings)', () => {
    const { doc } = growCity({ seed: 1, size: 'small', style: 'blocks' });
    sameEdits(JSON.stringify(doc.toJSON()), 11, 40);
  });

  for (const name of ['grid-and-bends.json', 'player-city.json', 'poles-varied-blocks.json']) {
    it(`on the fixture ${name}`, () => {
      sameEdits(fixture(name), name.length, 40);
    });
  }

  it('refuses a copy of the document as it stood before a later change', () => {
    const { a } = twins(fixture('grid-and-bends.json'));
    const work = a.fork();
    work.addNode({ x: 10, y: 10 });
    a.addNode({ x: 20, y: 20 });
    expect(() => a.replaceWith(work)).toThrow(/before a later change/);
  });
});

/** A road across the map from a to b, as the road tool lays it. */
const road = (doc: RoadDoc, net: Network, a: { x: number; y: number }, b: { x: number; y: number }, dryRun = false): DraftResult =>
  commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
    [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }], null, undefined, undefined, { dryRun });

/** A document's content, its records by id */
function content(doc: RoadDoc): string {
  const data = doc.toJSON() as unknown as Record<string, unknown>;
  const byId = (v: unknown): unknown => Array.isArray(v) && v.every((x) => typeof (x as { id?: unknown })?.id === 'number')
    ? [...(v as { id: number }[])].sort((p, q) => p.id - q.id) : v;
  return JSON.stringify(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, byId(v)])));
}

describe('roads drawn through the fork', () => {
  it('leave the map the old whole copy left, undo and redo it exactly, and the dry run leaves it alone', () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small', style: 'grid' }));
    const { a, na, b, nb } = twins(JSON.stringify(doc.toJSON()));
    // The old way: every edit on an independent copy of the whole document, compared and copied back.
    const old = a as unknown as { fork: () => RoadDoc; takeBack: (work: RoadDoc) => void };
    old.fork = () => a.clone();
    old.takeBack = (work) => a.replaceWith(work);
    const ha = new History(), hb = new History();
    /** An edit as the game makes one: one undo step each. */
    const step = <T>(h: History, d: RoadDoc, edit: () => T): T => { h.begin(d); const out = edit(); h.end(d); return out; };
    const xs = [...b.nodes.values()].map((n) => n.x), ys = [...b.nodes.values()].map((n) => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const rand = random(5);
    const states = [content(b)];
    let committed = 0;
    for (let i = 0; i < 8; i++) {
      const p = { x: x0 + rand() * (x1 - x0), y: y0 + rand() * (y1 - y0) };
      const q = { x: p.x + (rand() - 0.5) * m(240), y: p.y + (rand() - 0.5) * m(240) };
      const text = JSON.stringify(b.toJSON()), version = b.changes.version;
      const preview = road(b, nb, p, q, true);
      expect(JSON.stringify(b.toJSON()), 'the dry run left the map alone').toBe(text);
      expect(b.changes.version).toBe(version);
      const was = step(ha, a, () => road(a, na, p, q));
      // The whole copy's diary is written anew (`replaceWith`): its network catches up, as the game's does after an edit.
      if (na.revision !== a.revision) na.rebuild();
      const now = step(hb, b, () => road(b, nb, p, q));
      expect({ ...now, elevation: undefined, stations: undefined }).toEqual({ ...was, elevation: undefined, stations: undefined });
      expect(preview.committed).toBe(now.committed);
      if (now.committed) { committed++; states.push(content(b)); }
      expect(b.toJSON()).toEqual(a.toJSON());
      const node = nth(b.nodes.values(), rand());
      if (node) {
        const to = { x: node.x + m(4), y: node.y + m(2) };
        const moved = step(hb, b, () => moveNodeChecked(b, nb, node.id as NodeId, to));
        expect(moved).toEqual(step(ha, a, () => moveNodeChecked(a, na, node.id as NodeId, to)));
        if (moved.committed) states.push(content(b));
        expect(b.toJSON()).toEqual(a.toJSON());
      }
    }
    expect(committed).toBeGreaterThan(1);
    // Every step taken back and given again: each state the map stood in, exactly.
    for (let k = states.length - 2; k >= 0; k--) {
      expect(hb.undo(b)).toBe(true);
      ha.undo(a);
      expect(content(b), `undo to state ${k}`).toBe(states[k]);
      expect(b.toJSON()).toEqual(a.toJSON());
    }
    for (let k = 1; k < states.length; k++) {
      expect(hb.redo(b)).toBe(true);
      ha.redo(a);
      expect(content(b), `redo to state ${k}`).toBe(states[k]);
      expect(b.toJSON()).toEqual(a.toJSON());
    }
  });
});

/** A large map: a grid of 40 x 40 blocks, street furniture along it, a power line, planted trees and lots */
function largeMap(): RoadDoc {
  const doc = new RoadDoc();
  const n = 40, block = m(120), half = (n * block) / 2;
  const ids: NodeId[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: block * i - half, y: block * j - half }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, 1);
      if (j < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, 1);
    }
  }
  const furniture: { kind: 'bench'; at: { x: number; y: number } }[] = [];
  const trees: { x: number; y: number; height: number; yaw: number; seed: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = block * i - half, y = block * j - half;
      for (let k = 0; k < 5; k++) furniture.push({ kind: 'bench', at: { x: x + m(20) * (k + 1), y: y + m(9) } });
      trees.push({ x: x + m(40), y: y + m(40), height: m(8), yaw: 0, seed: 0.5 });
    }
  }
  doc.addLandscapeMany(furniture);
  doc.plantTrees(trees);
  let last: number | null = null;
  for (let k = 0; k < 600; k++) {
    const pole = doc.addPole({ x: -half + m(8) * k, y: -half + m(9) });
    if (last !== null) doc.addPoleSpan(last as never, pole.id);
    last = pole.id;
  }
  const lots = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = block * i - half + m(15), y = block * j - half + m(15);
      lots.push({ corners: [{ x, y }, { x: x + m(30), y }, { x: x + m(30), y: y + m(30) }, { x, y: y + m(30) }] });
    }
  }
  doc.lotStore.apply({ add: lots }, 'test');
  return doc;
}

describe('a one-road edit copies what it touches', () => {
  it('on a large map: well under 1% of its records', () => {
    const doc = largeMap();
    const net = new Network(doc);
    net.rebuild();
    const records = doc.nodes.size + doc.segments.size + doc.poles.size + doc.poleSpans.size + doc.landscape.size +
      doc.barriers.size + doc.buildings.size + doc.lotStore.size + doc.lotKeys.length + doc.terrainStamps.length + doc.terrainPaint.length +
      doc.trees.length + doc.elements.length + doc.zoneMarks.length;
    // Across three blocks, crossing two roads between their junctions: each is split.
    const from = { x: m(-170), y: m(47) }, to = { x: m(170), y: m(53) };
    const before = forkWork.copied;
    const preview = road(doc, net, from, to, true);
    const done = road(doc, net, from, to);
    const copied = forkWork.copied - before;
    expect(done.committed).toBe(true);
    expect(preview.committed).toBe(true);
    console.log(`one road drawn (dry run + commit) on ${records} records: ${copied} copied`);
    expect(records).toBeGreaterThan(10_000);
    expect(copied).toBeLessThan(records / 100);
  });

  it('its network is a working copy too: it holds what the edit rebuilt, and takes back the network a full build makes', () => {
    const doc = largeMap();
    const net = new Network(doc);
    net.rebuild();
    const work = doc.fork();
    const workNet = net.fork(work);
    const id = nth(doc.segments.keys(), 0.5)!;
    work.setSegmentLanes(id, 4);
    workNet.rebuild();
    const written = (map: ReadonlyMap<unknown, unknown>): number => {
      const { gone, replaced, added } = (map as ForkMap<unknown, unknown>).changes();
      return gone.size + replaced.size + added.size;
    };
    const own = written(workNet.ribbons) + written(workNet.junctions) + written(workNet.trims) + written(workNet.plateReach);
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThan((net.ribbons.size + net.junctions.size + net.trims.size + net.plateReach.size) / 100);
    expect(net.ribbons.get(id)).not.toBe(workNet.ribbons.get(id));
    doc.takeBack(work);
    net.takeBack(workNet);
    const full = new Network(doc);
    full.rebuild();
    const sorted = (d: unknown): unknown => JSON.parse(JSON.stringify(d, (_k, v: unknown) =>
      Array.isArray(v) && v.every((e) => Array.isArray(e)) ? [...(v as unknown[][])].sort((p, q) => String(p[0]).localeCompare(String(q[0]))) : v));
    expect(sorted(derived(doc, net))).toEqual(sorted(derived(doc, full)));
  });
});

describe('a copy put back (`clone`, then `replaceWith`: a refused edit undone)', () => {
  /** A grown city with poles, wires, furniture and a wall. */
  function town(): RoadDoc {
    const { doc } = growCity({ seed: 3, size: 'small', style: 'blocks' });
    const nodes = [...doc.nodes.values()];
    for (let k = 0; k + 1 < 12; k += 2) {
      const p = doc.addPole({ x: nodes[k]!.x + 9, y: nodes[k]!.y + 9 }), q = doc.addPole({ x: nodes[k + 1]!.x + 9, y: nodes[k + 1]!.y + 9 });
      doc.addPoleSpan(p.id, q.id);
      doc.addLandscape('bench', { x: nodes[k]!.x + 12, y: nodes[k]!.y });
    }
    doc.addBarrier('wall', [{ x: 0, y: 0 }, { x: 30, y: 0 }]);
    return doc;
  }

  it('puts back exactly what the copy holds, read by the ids either diary names', () => {
    const doc = town();
    const before = doc.clone();
    const want = content(before);
    const node = [...doc.nodes.values()].find((n) => n.incident.length === 2)!;
    doc.moveNode(node.id, { x: node.x + 7, y: node.y - 3 });
    const pole = [...doc.poles.values()][2]!;
    doc.removePole(pole.id);
    const bench = doc.addLandscape('bench', { x: 50, y: 50 });
    const wall = [...doc.barriers.values()][0]!;
    doc.removeBarrier(wall.id);
    doc.buildings.remove([...doc.buildings.all()][1]!.id);
    // What no edit touched, held before: the same records after, never copied again.
    const still = { node: [...doc.nodes.values()].at(-1)!, segment: [...doc.segments.values()].at(-1)!, pole: [...doc.poles.values()].at(-1)!, item: [...doc.landscape.values()][0]! };
    const v = doc.changes.version;
    doc.replaceWith(before);
    expect(content(doc)).toBe(want);
    expect(doc.nodes.get(still.node.id)).toBe(still.node);
    expect(doc.segments.get(still.segment.id)).toBe(still.segment);
    expect(doc.poles.get(still.pole.id)).toBe(still.pole);
    expect(doc.landscape.get(still.item.id)).toBe(still.item);
    const written = doc.changes.since(v)!;
    // Only the kinds that moved, and of each only the records that did.
    expect(new Set(written.map((e) => e.kind))).toEqual(new Set(['roads', 'traffic', 'utilities', 'landscape', 'barriers', 'buildings']));
    expect(written.find((e) => e.kind === 'landscape')!.ids).toEqual([bench.id]);
    expect(written.find((e) => e.kind === 'barriers')!.ids).toEqual([wall.id]);
    expect(written.find((e) => e.kind === 'utilities')!.ids).toContain(pole.id);
    expect(written.find((e) => e.kind === 'roads')!.ids!.length).toBeLessThan(12);
  });

  it('and when the copy was edited too, ends as the copy', () => {
    const doc = town();
    const copy = doc.clone();
    const [n1, n2] = [...doc.nodes.values()].filter((n) => n.incident.length === 2);
    doc.moveNode(n1!.id, { x: n1!.x + 5, y: n1!.y });
    copy.moveNode(n2!.id, { x: n2!.x - 5, y: n2!.y });
    copy.addLandscape('bin', { x: 70, y: 70 });
    doc.addPole({ x: 90, y: 90 });
    doc.replaceWith(copy);
    expect(content(doc)).toBe(content(copy));
  });
});
