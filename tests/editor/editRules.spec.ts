import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { roadStructure } from '@world/structures';
import { commitRoadPath, moveNodeChecked, type DraftResult } from '@editor/commit';
import { guardRoadEdit } from '@editor/editRules';
import { anchorForHeight, anchorHeightOffset, findAnchor, type Anchor } from '@editor/snap';
import { commitRoundabout } from '@editor/roundabout';
import { applyOp, freshState } from '../fuzz/support/ops';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit these scenes were laid out in: every length below is in it, times U. */
const U = TUNED_UNIT;

/** The editing rules (`editor/editRules.ts`) */
function empty(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** A straight road drawn as the road tool lays it, anchors resolved under its ends: its ends in U */
function draw(doc: RoadDoc, net: Network, a: [number, number], b: [number, number], type = 1, h0 = 0, h1 = 0): DraftResult {
  const resolve = (p: [number, number], h: number): { anchor: Anchor; height: number } => {
    const at = { x: p[0] * U, y: p[1] * U };
    const found = anchorForHeight(doc, net, findAnchor(doc, net, at, 1 / U, undefined, h), h);
    const anchor: Anchor = found.kind === 'free' ? { kind: 'free', at } : found;
    return { anchor, height: anchor.kind === 'free' ? h : anchorHeightOffset(doc, net, anchor, h) };
  };
  const start = resolve(a, h0);
  const end = resolve(b, h1);
  const result = commitRoadPath(doc, net, start.anchor, end.anchor, type, [{
    start: { at: start.anchor.at, heightOffset: start.height },
    end: { at: end.anchor.at, heightOffset: end.height },
    curve: null,
  }]);
  if (result.committed) net.rebuild();
  return result;
}

const degrees = (doc: RoadDoc): number[] => [...doc.nodes.values()].map((n) => n.incident.length).sort();

describe('editing rules: what is still drawn', () => {
  it('a crossroads and a T', () => {
    const { doc, net } = empty();
    expect(draw(doc, net, [-200, 0], [200, 0]).committed).toBe(true);
    expect(draw(doc, net, [0, -200], [0, 200]).committed).toBe(true);
    expect(degrees(doc)).toContain(4);
    expect(draw(doc, net, [-100, 0], [-100, 200]).committed).toBe(true);
    expect(degrees(doc)).toContain(3);
    expect(net.impossible.size + net.squeezed.size).toBe(0);
  });

  it('parallel roads a proper distance apart', () => {
    const { doc, net } = empty();
    expect(draw(doc, net, [-200, 0], [200, 0], 3).committed).toBe(true);
    expect(draw(doc, net, [-200, 80], [200, 80], 3).committed).toBe(true);
  });

  it('an overpass with clearance, and a ramp up from a road', () => {
    const { doc, net } = empty();
    expect(draw(doc, net, [-200, 0], [200, 0]).committed).toBe(true);
    const high = roadStructure('elevated').clearance + 2 * U;
    expect(draw(doc, net, [0, -260], [0, 260], 1, high, high).committed).toBe(true);
    expect(degrees(doc).some((d) => d > 2)).toBe(false);
    expect(draw(doc, net, [200, 0], [400, 100], 1, 0, 20 * U).committed).toBe(true);
  });

  it('a roundabout', () => {
    const { doc, net } = empty();
    expect(commitRoundabout(doc, net, { x: 0, y: 0 }, 100 * U).committed).toBe(true);
  });
});

describe('editing rules: what is refused, and why', () => {
  it('a road drawn on top of another', () => {
    const { doc, net } = empty();
    draw(doc, net, [-200, 0], [200, 0], 2);
    const before = doc.toJSON();
    // Its ends off the road, its middle along it, a few metres over.
    expect(draw(doc, net, [-300, 20], [300, 20], 2)).toMatchObject({ committed: false, reason: 'overlap' });
    expect(doc.toJSON()).toEqual(before);
    // Drawn along the road itself, the ends snap onto it: nothing new to lay.
    expect(draw(doc, net, [-180, 8], [180, 10], 2)).toMatchObject({ committed: false, reason: 'duplicate' });
  });

  it('a road across another with too little height to pass over it', () => {
    const { doc, net } = empty();
    draw(doc, net, [-200, 0], [200, 0]);
    // Between the join tolerance and the clearance: the crossing test names it.
    expect(draw(doc, net, [0, -200], [0, 200], 1, 6 * U, 6 * U)).toMatchObject({ committed: false, reason: 'clearance' });
  });

  it('two roads meeting under 25 degrees', () => {
    const { doc, net } = empty();
    draw(doc, net, [-200, 0], [200, 0]);
    expect(draw(doc, net, [200, 0], [0, 50])).toMatchObject({ committed: false, reason: 'sharp' });
  });

  it('a junction whose legs are too short to separate the lanes', () => {
    const { doc, net } = empty();
    draw(doc, net, [0, 0], [300, 0], 3);
    expect(draw(doc, net, [150, 0], [150, 200], 3).committed).toBe(true);
    // An avenue leaving 40 units on at 53 degrees
    expect(draw(doc, net, [190, 0], [100, -120], 3)).toMatchObject({ committed: false, reason: 'squeezed' });
    // The same avenue at a right angle, a staggered junction: built.
    expect(draw(doc, net, [190, 0], [190, -200], 3).committed).toBe(true);
  });

  it('a road at the foot of a ramp, leaving it no run to come down in (P82, fuzz seed 3)', () => {
    // A curved road set 17.27 units up at one end
    const state = freshState();
    expect(applyOp(state, { op: 'path', a: [330.41 * U, 116.68 * U], b: [604.65 * U, 464.51 * U], type: 2,
      curve: { t: 0.51, h: 59.09 * U }, h0: 17.27 * U, h1: 0 })).toBe(true);
    const before = state.doc.toJSON();
    expect(applyOp(state, { op: 'draw', a: [330.41 * U, 116.68 * U], b: [350.66 * U, 219.17 * U], type: 1, curve: null,
      structure: 'ground' })).toBe(false);
    expect(state.doc.toJSON()).toEqual(before);
  });

  it('a lane added that widens a road onto its neighbour, undone', () => {
    const { doc, net } = empty();
    draw(doc, net, [-200, 0], [200, 0], 1);
    draw(doc, net, [-200, 40], [200, 40], 1);
    const id = [...doc.segments.keys()][0]!;
    const before = doc.toJSON();
    const result = guardRoadEdit(doc, net, (work) => { work.setSegmentLanes(id, 8); return true; });
    expect(result).toEqual({ changed: false, refused: 'overlap' });
    expect(doc.toJSON()).toEqual(before);
    expect(net.revision).toBe(doc.revision);
  });

  it('a node dropped so that its road lies on another', () => {
    const { doc, net } = empty();
    draw(doc, net, [-200, 0], [200, 0], 1);
    draw(doc, net, [-200, 60], [200, 60], 1);
    const node = [...doc.nodes.values()].find((n) => n.x === 200 * U && n.y === 60 * U)!;
    const before = doc.toJSON();
    expect(moveNodeChecked(doc, net, node.id, { x: 200 * U, y: 6 * U })).toMatchObject({ committed: false, reason: 'overlap' });
    // A refused drop is put back by the check itself (the Move tool keeps no copy of the map).
    expect(doc.toJSON()).toEqual(before);
    expect(net.revision).toBe(doc.revision);
  });
});

describe('editing rules: old damage never blocks', () => {
  it('a map with a node already too sharp still takes roads elsewhere, and roads to it', () => {
    const { doc, net } = empty();
    // Built the way a loaded map arrives: no rule in the way.
    const hub = doc.addNode({ x: 0, y: 0 });
    const far1 = doc.addNode({ x: 200 * U, y: 0 });
    const far2 = doc.addNode({ x: 200 * U, y: 25 * U });
    doc.addSegment(hub.id, far1.id, 1);
    doc.addSegment(hub.id, far2.id, 1);
    net.rebuild();
    expect(net.impossible.has(hub.id)).toBe(true);
    expect(draw(doc, net, [-600, 400], [-200, 400]).committed).toBe(true);
    expect(draw(doc, net, [0, 0], [-200, 0]).committed).toBe(true);
  });
});
