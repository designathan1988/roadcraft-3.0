import { beforeEach, describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { FLAT_GROUND, buildRoadElevation, type RoadElevation } from '@world/elevation';
import type { SectionMaterials } from '@world/roadSection';
import { Level } from '@world/roadTypes';
import { applyOp, freshState, type FuzzOp } from '../fuzz/support/ops';
import {
  ROAD_GROUND_CLEARANCE,
  TUNNEL_BORE,
  TUNNEL_GRADE,
  roadStructure,
} from '@world/structures';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit these scenes were laid out in: every length below is in it, times U. */
const U = TUNED_UNIT;

/** The elevation field is the single source of height for every road surface */

function flatGround(): (x: number, y: number) => number {
  return () => 0;
}

function hill(cx: number, cy: number, radius: number, height: number) {
  return (x: number, y: number): number => {
    const d = Math.hypot(x - cx, y - cy);
    if (d >= radius) return 0;
    const u = 1 - d / radius;
    return height * u * u * (3 - 2 * u);
  };
}

function crossNetwork(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const north = doc.addNode({ x: 0, y: -300 * U });
  const south = doc.addNode({ x: 0, y: 300 * U });
  const west = doc.addNode({ x: -300 * U, y: 0 });
  const east = doc.addNode({ x: 300 * U, y: 0 });
  doc.addSegment(north.id, centre.id, 3);
  doc.addSegment(centre.id, south.id, 3);
  doc.addSegment(west.id, centre.id, 2);
  doc.addSegment(centre.id, east.id, 2);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** The largest jump the field makes between two points `step` apart. */
function worstStep(field: RoadElevation, radius: number, step: number): number {
  let worst = 0;
  for (let x = -radius; x <= radius; x += step) {
    for (let y = -radius; y <= radius; y += step) {
      const here = field.at(x, y);
      worst = Math.max(worst, Math.abs(field.at(x + step, y) - here), Math.abs(field.at(x, y + step) - here));
    }
  }
  return worst;
}

/** Continuity, measured rather than assumed. */
function continuityRatio(field: RoadElevation, radius: number): number {
  const coarse = worstStep(field, radius, 2 * U);
  const fine = worstStep(field, radius, 0.5 * U);
  return fine / Math.max(1e-9, coarse);
}

it('keeps an elevated ramp within grade after a short-span split', () => {
  const state = freshState();
  const ops = [
    { op: 'draw', a: [539.89 * U, -698.3 * U], b: [685.21 * U, -608.5 * U], type: 0, curve: null, structure: 'ground' },
    { op: 'draw', a: [563.79 * U, -674.76 * U], b: [656.27 * U, -700 * U], type: 3, curve: { t: 0.39, h: -31.07 * U }, structure: 'ground' },
    { op: 'removeNode', pick: 0.34 },
    { op: 'structure', pick: 0.67, structure: 'elevated' },
    { op: 'removeNode', pick: 0.08 },
    { op: 'split', pick: 0.1, at: 0.65 },
  ] as FuzzOp[];
  for (const op of ops) applyOp(state, op);
  const elevation = buildRoadElevation(state.net, flatGround());
  for (const [id, ribbon] of state.net.ribbons) {
    if (state.doc.segment(id)?.structure !== 'elevated') continue;
    let previous: number | null = null;
    for (let s = 0; s <= ribbon.full.length; s += 0.25 * U) {
      const p = ribbon.full.sampleAt(s).p;
      const height = elevation.onSegment(id, p.x, p.y);
      if (previous !== null) expect(Math.abs(height - previous)).toBeLessThan(0.05 * U);
      previous = height;
    }
  }
});

describe('road elevation on flat ground', () => {
  let field: RoadElevation;
  beforeEach(() => {
    const { net } = crossNetwork();
    field = buildRoadElevation(net, flatGround());
  });

  it('lays the deck one clearance above the ground', () => {
    expect(field.at(120 * U, 0)).toBeCloseTo(ROAD_GROUND_CLEARANCE, 6);
  });

  it('is flat across the junction, so the plate cannot dish', () => {
    const centre = field.at(0, 0);
    for (const [x, y] of [[8, 8], [-8, 8], [14, 0], [0, -14], [20, 20]] as const) {
      expect(field.at(x * U, y * U)).toBeCloseTo(centre, 6);
    }
  });

  it('has no step anywhere: continuity is what keeps the mesh watertight', () => {
    expect(worstStep(field, 340 * U, 4 * U)).toBeLessThan(0.05 * U);
    expect(continuityRatio(field, 340 * U)).toBeLessThan(0.4);
  });
});

describe('road elevation over a hill', () => {
  const terrain = hill(0, 0, 160 * U, 18 * U);
  let field: RoadElevation;
  beforeEach(() => {
    const { net } = crossNetwork();
    field = buildRoadElevation(net, terrain);
  });

  it('cuts into what rises above it and fills over what falls away', () => {
    // The contract a road at grade actually has.
    let deepestCut = 0;
    let highestFill = 0;
    for (let s = -300 * U; s <= 300 * U; s += 3 * U) {
      for (const [x, y] of [[s, 0], [0, s]] as const) {
        const offset = field.at(x, y) - terrain(x, y);
        deepestCut = Math.min(deepestCut, offset);
        highestFill = Math.max(highestFill, offset);
      }
    }
    expect(deepestCut).toBeLessThan(-1 * U);
    expect(highestFill).toBeGreaterThan(0.2 * U);
  });

  it('keeps the earthwork bounded', () => {
    // A cut is a design decision, not a licence to excavate the map.
    for (let s = -300 * U; s <= 300 * U; s += 3 * U) {
      for (const [x, y] of [[s, 0], [0, s]] as const) {
        expect(Math.abs(field.at(x, y) - terrain(x, y))).toBeLessThan(10 * U);
      }
    }
  });

  it('is far smoother than the ground it crosses', () => {
    // The point of the whole exercise, stated as a number: the designed line must curve less than the ground does.
    let road = 0;
    let ground = 0;
    const d = 4 * U;
    for (let x = -290 * U; x <= 290 * U; x += d) {
      road += Math.abs(field.at(x - d, 0) - 2 * field.at(x, 0) + field.at(x + d, 0));
      ground += Math.abs(terrain(x - d, 0) - 2 * terrain(x, 0) + terrain(x + d, 0));
    }
    expect(road).toBeLessThan(ground * 0.6);
  });

  it('follows the hill rather than bridging it', () => {
    expect(field.at(0, 0)).toBeGreaterThan(9 * U);
    expect(field.at(290 * U, 0)).toBeLessThan(3 * U);
  });

  it('respects the ground road gradient limit', () => {
    let steepest = 0;
    for (let s = -300 * U; s < 300 * U; s += 2 * U) {
      steepest = Math.max(steepest, Math.abs(field.at(s + 2 * U, 0) - field.at(s, 0)) / (2 * U));
    }
    // 12% is the stated limit; the plate and the blend may add a hair.
    expect(steepest).toBeLessThan(0.14);
  });

  it('still keeps every leg of the junction at one height', () => {
    const centre = field.at(0, 0);
    for (const [x, y] of [[10, 10], [-10, 10], [16, 0], [0, -16]] as const) {
      expect(Math.abs(field.at(x * U, y * U) - centre)).toBeLessThan(0.01 * U);
    }
  });

  it('has no step anywhere over broken ground', () => {
    // A quarter of the sampling step: the field is Lipschitz, not cliffed.
    expect(continuityRatio(field, 340 * U)).toBeLessThan(0.4);
  });

  it('is decided by the road, not the ground, everywhere a surface is drawn', () => {
    // The widest casing is 32.5 units (a 24 m boulevard and its verge); nothing the mesh builds reaches further.
    for (let s = -280 * U; s <= 280 * U; s += 7 * U) {
      for (const across of [-32, -16, 0, 16, 32]) {
        const onRoad = field.at(s, across * U);
        const centre = field.at(s, 0);
        expect(Math.abs(onRoad - centre)).toBeLessThan(0.02 * U);
      }
    }
  });
});

describe('raised structures', () => {
  function elevatedChain(structure: 'elevated' | 'bridge', span: number) {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: -span, y: 0 });
    const b = doc.addNode({ x: -span / 3, y: 0 });
    const c = doc.addNode({ x: span / 3, y: 0 });
    const d = doc.addNode({ x: span, y: 0 });
    doc.addSegment(a.id, b.id, 2);
    const raised = doc.addSegment(b.id, c.id, 2);
    doc.addSegment(c.id, d.id, 2);
    doc.setSegmentStructure(raised!.id, structure);
    const net = new Network(doc);
    net.rebuild();
    return { doc, net, raised: raised!.id, landing: [b.id, c.id] as const };
  }

  it('lands exactly on the road at grade it connects to', () => {
    const { net, landing } = elevatedChain('elevated', 900 * U);
    const field = buildRoadElevation(net, flatGround());
    for (const node of landing) {
      expect(field.nodeHeight(node)).toBeCloseTo(ROAD_GROUND_CLEARANCE, 6);
    }
  });

  it('reaches its design clearance when the span is long enough', () => {
    const { net } = elevatedChain('elevated', 1_400 * U);
    const field = buildRoadElevation(net, flatGround());
    const spec = roadStructure('elevated');
    expect(field.at(0, 0)).toBeGreaterThan(spec.clearance * 0.9);
  });

  it('lowers the deck rather than steepening the ramp on a short span', () => {
    const { net } = elevatedChain('elevated', 220 * U);
    const field = buildRoadElevation(net, flatGround());
    let steepest = 0;
    for (let x = -220 * U; x < 220 * U; x += 2 * U) {
      steepest = Math.max(steepest, Math.abs(field.at(x + 2 * U, 0) - field.at(x, 0)) / (2 * U));
    }
    expect(steepest).toBeLessThan(0.165);
  });

  it('keeps the ground pass and the raised pass apart', () => {
    const { net } = elevatedChain('elevated', 1_400 * U);
    const field = buildRoadElevation(net, flatGround());
    const ground = new Set(['ground' as const]);
    const raised = new Set(['elevated' as const]);
    expect(field.at(0, 0, raised)).toBeGreaterThan(field.at(0, 0, ground) + 5 * U);
  });
});

describe('ramps between a raised deck and the ground', () => {
  const rolling = (x: number, y: number): number => 3 * U * Math.sin(x / (90 * U)) + 2 * U * Math.sin((x + y) / (37 * U));

  /** One elevated segment of `span`, alone (both ends on the ground) or between two roads at grade. */
  function elevated(span: number, ground: (x: number, y: number) => number, standalone = true) {
    const doc = new RoadDoc();
    const b = doc.addNode({ x: -span / 2, y: 0 });
    const c = doc.addNode({ x: span / 2, y: 0 });
    if (!standalone) {
      doc.addSegment(doc.addNode({ x: -span / 2 - 300 * U, y: 0 }).id, b.id, 2);
      doc.addSegment(c.id, doc.addNode({ x: span / 2 + 300 * U, y: 0 }).id, 2);
    }
    const raised = doc.addSegment(b.id, c.id, 2)!;
    doc.setSegmentStructure(raised.id, 'elevated');
    const net = new Network(doc);
    net.rebuild();
    const field = buildRoadElevation(net, ground);
    const heights: number[] = [];
    // One height every U: the indices below count 0.4 m steps.
    for (let i = 0; i * U <= span + 1e-9; i++) heights.push(field.onSegment(raised.id, -span / 2 + i * U, 0));
    return { field, heights, span, b: b.id, c: c.id };
  }

  /** The two ramps and the deck between them. */
  function anatomy(heights: readonly number[]) {
    const grade = (i: number): number => Math.abs((heights[i + 4] as number) - (heights[i] as number)) / (4 * U);
    const foot = heights[0] as number;
    const upStart = heights.findIndex((h) => h > foot + 0.02 * U);
    // The first units of a ramp are its sag curve, where the grade is still building up from level and is below a deck's
    const SAG = 12;
    let upEnd = upStart;
    while (upEnd < heights.length - 5 && (grade(upEnd) > 0.052 || upEnd - upStart < SAG)) upEnd++;
    const end = heights.length - 1;
    const tail = heights[end] as number;
    let downStart = end;
    while (downStart > 0 && (heights[downStart] as number) <= tail + 0.02 * U) downStart--;
    let downEnd = downStart;
    while (downEnd > 4 && (grade(downEnd - 4) > 0.052 || downStart - downEnd < SAG)) downEnd--;
    let steepest = 0;
    for (let i = 0; i + 4 < heights.length; i++) steepest = Math.max(steepest, grade(i));
    return {
      rampA: upEnd - upStart,
      rampB: downStart - downEnd,
      deck: (downEnd - upEnd) / heights.length,
      deckFrom: upEnd,
      deckTo: downEnd,
      steepest,
      top: Math.max(...heights) - foot,
    };
  }

  it('climbs to its full height in at most 100 units, and is level at full height between', () => {
    // The player's complaint, twice: "the ramp must be a few metres, not a thing with no end".
    for (const standalone of [true, false]) {
      const { heights } = elevated(600 * U, flatGround(), standalone);
      const shape = anatomy(heights);
      expect(shape.top).toBeGreaterThan(roadStructure('elevated').clearance - 0.1 * U);
      expect(shape.rampA).toBeLessThanOrEqual(100);
      expect(shape.rampB).toBeLessThanOrEqual(100);
      expect(shape.deck).toBeGreaterThanOrEqual(0.6);
      expect(shape.steepest).toBeLessThan(0.162);
      // Level: the deck between the ramps is within the crest's rounding of its height
      const deck = heights.slice(shape.deckFrom, shape.deckTo);
      expect(Math.max(...deck) - Math.min(...deck)).toBeLessThan(0.25 * U);
      const top = Math.max(...heights);
      expect(heights.filter((h) => h > top - 0.25 * U).length / heights.length).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('keeps short ramps and a straight deck on rolling ground', () => {
    for (const standalone of [true, false]) {
      const { heights, span } = elevated(600 * U, rolling, standalone);
      const shape = anatomy(heights);
      expect(shape.rampA).toBeLessThanOrEqual(100);
      expect(shape.rampB).toBeLessThanOrEqual(100);
      expect(shape.deck).toBeGreaterThanOrEqual(0.6);
      // A straight line from end to end: it does not follow the land.
      const from = shape.deckFrom;
      const to = shape.deckTo;
      for (let i = from; i <= to; i += 10) {
        const t = (i - from) / Math.max(1, to - from);
        const chord = (heights[from] as number) + ((heights[to] as number) - (heights[from] as number)) * t;
        expect(Math.abs((heights[i] as number) - chord)).toBeLessThan(0.3 * U);
      }
      // ...and it still stands clear of the ground under it.
      for (let i = from; i <= to; i += 5) {
        expect((heights[i] as number) - rolling(-span / 2 + i * U, 0)).toBeGreaterThan(8 * U);
      }
    }
  });

  it('climbs one clearance over its landing however low the landing sits', () => {
    // Landings sunk below the plain by 0, 4 and 8 units.
    const lengths: number[] = [];
    for (const depth of [0, 4, 8]) {
      const sunk = (x: number): number => -depth * U * Math.exp(-(((Math.abs(x) - 300 * U) / (150 * U)) ** 2));
      const shape = anatomy(elevated(600 * U, sunk).heights);
      expect(shape.steepest).toBeLessThan(0.162);
      lengths.push(shape.rampA);
    }
    // The deck starts one clearance over the junction it lands on and runs straight to the other end
    for (const length of lengths) expect(length).toBeLessThanOrEqual(100);
  });

  it('lowers the deck of a span too short for two ramps, never steepens it', () => {
    const shape = anatomy(elevated(120 * U, flatGround()).heights);
    expect(shape.steepest).toBeLessThan(0.162);
    expect(shape.top).toBeLessThan(roadStructure('elevated').clearance);
  });

  it('spans a valley level as a bridge, rim to rim', () => {
    const valley = (x: number): number => (Math.abs(x) < 180 * U ? -20 * U * (1 - Math.abs(x) / (180 * U)) : 0);
    const doc = new RoadDoc();
    const b = doc.addNode({ x: -350 * U, y: 0 });
    const c = doc.addNode({ x: 350 * U, y: 0 });
    doc.addSegment(doc.addNode({ x: -650 * U, y: 0 }).id, b.id, 2);
    const span = doc.addSegment(b.id, c.id, 2)!;
    doc.addSegment(c.id, doc.addNode({ x: 650 * U, y: 0 }).id, 2);
    doc.setSegmentStructure(span.id, 'bridge');
    const net = new Network(doc);
    net.rebuild();
    const field = buildRoadElevation(net, valley);
    expect(field.onSegment(span.id, 0, 0)).toBeGreaterThan(field.onSegment(span.id, -170 * U, 0) - 0.1 * U);
  });

  it('brings a raised road that simply ends down to the ground', () => {
    // A raised dead end used to stay at its full height: a deck ending in mid-air.
    const { field, b, c, span } = elevated(600 * U, flatGround());
    expect(field.nodeHeight(b)).toBeCloseTo(ROAD_GROUND_CLEARANCE, 3);
    expect(field.nodeHeight(c)).toBeCloseTo(ROAD_GROUND_CLEARANCE, 3);
    expect(field.at(0, 0)).toBeGreaterThan(roadStructure('elevated').clearance - 0.1 * U);
    expect(span).toBe(600 * U);
  });

  it('stays continuous through the ramps and over the deck', () => {
    const { field } = elevated(600 * U, rolling, false);
    let coarse = 0;
    let fine = 0;
    for (let x = -400 * U; x <= 400 * U; x += 2 * U) {
      coarse = Math.max(coarse, Math.abs(field.at(x + 2 * U, 0) - field.at(x, 0)));
      fine = Math.max(fine, Math.abs(field.at(x + 0.5 * U, 0) - field.at(x, 0)));
    }
    expect(fine / coarse).toBeLessThan(0.4);
  });
});

describe('where a leg meets its junction plate', () => {
  /** Broken ground: three waves, ±19 units, the kind a few brush strokes leave. */
  const hilly = (x: number, y: number): number =>
    U * (9 * Math.sin(x / (140 * U)) + 6 * Math.sin((x - y) / (70 * U)) + 4 * Math.cos(y / (55 * U)));

  type Layout = 'all-elevated' | 'elevated-over-ground' | 'elevated-landing-on-streets';

  /** A crossroads whose four arms are CHAINS of `count` segments of `length`: a boulevard north-south, `typeEW` east-west. */
  function crossroads(typeEW: number, count: number, length: number, layout: Layout) {
    const doc = new RoadDoc();
    const centre = doc.addNode({ x: 0, y: 0 });
    const arms = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
    arms.forEach(([dx, dy], arm) => {
      let previous = centre;
      for (let k = 1; k <= count; k++) {
        const node = doc.addNode({ x: dx * length * k, y: dy * length * k });
        const segment = doc.addSegment(previous.id, node.id, arm % 2 === 0 ? 3 : typeEW);
        if (!segment) throw new Error('the fixture failed to build a segment');
        const raised = layout === 'all-elevated' ||
          (layout === 'elevated-over-ground' && arm % 2 === 0) ||
          (layout === 'elevated-landing-on-streets' && k < count);
        if (raised) doc.setSegmentStructure(segment.id, 'elevated');
        previous = node;
      }
    });
    const net = new Network(doc);
    net.rebuild();
    return { doc, net };
  }

  /** The worst height difference across every seam between a leg and the junction plate it ends on: at the junction outline */
  function worstSeam(doc: RoadDoc, net: Network, field: RoadElevation): number {
    let worst = 0;
    for (const [id, ribbon] of net.ribbons) {
      const segment = doc.segment(id);
      const trims = net.trims.get(id);
      if (!segment || !trims) continue;
      const line = ribbon.full;
      const only = new Set([segment.structure]);
      const half = ribbon.road.width / 2;
      for (const end of ['a', 'b'] as const) {
        const node = end === 'a' ? segment.a : segment.b;
        const trim = trims[end][Level.Casing] ?? 0;
        const plate = field.nodeHeight(node);
        // Where only the structure changes on one road (a ramp landing) the node is a seam, not a plate
        const seam = net.transitions.has(node);
        for (const delta of [-0.5, 0, 0.5]) {
          const reach = Math.min(line.length, Math.max(0, trim + delta * U));
          const s = end === 'a' ? reach : line.length - reach;
          const frame = line.sampleAt(s);
          const road = field.onSegment(id, frame.p.x, frame.p.y);
          worst = Math.max(worst, Math.abs(road - (seam ? road : plate)));
          for (const across of [-0.9, -0.45, 0, 0.45, 0.9]) {
            const x = frame.p.x + frame.n.x * half * across;
            const y = frame.p.y + frame.n.y * half * across;
            worst = Math.max(worst, Math.abs(field.at(x, y, only) - (seam ? road : plate)));
          }
        }
        if (seam) {
          // ...and the two roads meet at the node at one height: no step.
          const n = doc.node(node)!;
          for (const other of n.incident) {
            if (other === id) continue;
            worst = Math.max(worst, Math.abs(field.onSegment(id, n.x, n.y) - field.onSegment(other, n.x, n.y)));
          }
        }
      }
    }
    return worst;
  }

  const cases: Array<[string, (x: number, y: number) => number]> = [['flat', flatGround()], ['hilly', hilly]];
  for (const [ground, terrain] of cases) {
    for (const [name, typeEW] of [['boulevards', 3], ['a boulevard and an avenue', 2]] as const) {
      for (const layout of ['all-elevated', 'elevated-over-ground', 'elevated-landing-on-streets'] as const) {
        it(`meets it exactly: ${name}, ${layout}, ${ground} ground`, () => {
          for (const [count, length] of [[3, 150], [2, 200]] as const) {
            const { doc, net } = crossroads(typeEW, count, length * U, layout);
            const field = buildRoadElevation(net, terrain);
            // Invariant 3: the plate is flat and every leg is flat over its reach at the SAME height.
            expect(worstSeam(doc, net, field)).toBeLessThan(1e-3 * U);
          }
        });
      }
    }
  }

  it('stays continuous over an elevated crossroads on broken ground', () => {
    for (const layout of ['all-elevated', 'elevated-over-ground'] as const) {
      const { net } = crossroads(2, 3, 150 * U, layout);
      const field = buildRoadElevation(net, hilly);
      expect(continuityRatio(field, 200 * U)).toBeLessThan(0.4);
    }
  });
});

describe('tunnels', () => {
  /** A straight road driven through the middle of a hill. */
  function throughHill(structure: 'ground' | 'tunnel', length = 900 * U) {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: -length / 2, y: 0 });
    const b = doc.addNode({ x: length / 2, y: 0 });
    const segment = doc.addSegment(a.id, b.id, 2);
    if (!segment) throw new Error('the fixture failed to build its segment');
    doc.setSegmentStructure(segment.id, structure);
    const net = new Network(doc);
    net.rebuild();
    const ground = hill(0, 0, 320 * U, 40 * U);
    return { doc, net, ground, field: buildRoadElevation(net, ground), a: a.id, b: b.id };
  }

  it('dives under the hill it passes through', () => {
    const { field, ground } = throughHill('tunnel');
    const cover = ground(0, 0) - field.at(0, 0);
    expect(cover).toBeGreaterThan(TUNNEL_BORE);
  });

  it('meets the ground at both portals', () => {
    // The ends are where a tunnel joins the street network, so they must be at grade.
    const { field, a, b, ground } = throughHill('tunnel');
    for (const node of [a, b]) {
      const height = field.nodeHeight(node);
      const x = node === a ? -450 * U : 450 * U;
      expect(Math.abs(height - (ground(x, 0) + ROAD_GROUND_CLEARANCE))).toBeLessThan(1.5 * U);
    }
  });

  it('is solved quite differently from the same road at grade', () => {
    // A road at grade cuts into the crest by a few units; a tunnel goes under it by its whole design depth.
    const bored = throughHill('tunnel');
    const surface = throughHill('ground');
    const crest = surface.ground(0, 0);
    expect(surface.field.at(0, 0)).toBeGreaterThan(crest - 8 * U);
    expect(bored.field.at(0, 0)).toBeLessThan(surface.field.at(0, 0) - 20 * U);
  });

  it('stays continuous along its whole length', () => {
    // A step in the field is a crack in the mesh, and the sunken solver is a second place a discontinuity could be introduced.
    const { field } = throughHill('tunnel');
    let worst = 0;
    for (let x = -600 * U; x <= 600 * U; x += 2 * U) {
      worst = Math.max(worst, Math.abs(field.at(x + 2 * U, 0) - field.at(x, 0)));
    }
    expect(worst).toBeLessThan(2 * U * TUNNEL_GRADE * 2.5);
  });

  it('gets less deep as the span gets shorter', () => {
    // Honest failure, stated as a monotone property rather than as a threshold
    const long = throughHill('tunnel', 900 * U);
    const short = throughHill('tunnel', 180 * U);
    const shorter = throughHill('tunnel', 90 * U);
    const cover = (t: ReturnType<typeof throughHill>): number => t.ground(0, 0) - t.field.at(0, 0);
    expect(cover(long)).toBeGreaterThan(cover(short));
    expect(cover(short)).toBeGreaterThan(cover(shorter));
    expect(cover(shorter)).toBeLessThan(TUNNEL_BORE);
  });

  it('leaves the ground shaper intact over the bore and open at the mouth', () => {
    const { field, ground } = throughHill('tunnel');
    const deep = field.shapeAt(0, 0, ground(0, 0));
    expect(deep.weight).toBeLessThan(0.01);
    const mouth = field.shapeAt(-430 * U, 0, ground(-430 * U, 0));
    expect(mouth.weight).toBeGreaterThan(0.5);
  });
});

describe("a road's look in the solve", () => {
  /** The summary digest of one road paved with `materials`. */
  const lookOf = (materials: SectionMaterials): number => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: 100, y: 0 });
    const seg = doc.addSegment(a.id, b.id, 1)!;
    doc.setSegmentSection(seg.id, { laneWidth: 3.5, sidewalk: 3, median: 0, speedKmh: 50, priority: 1, materials });
    const net = new Network(doc);
    net.rebuild();
    return buildRoadElevation(net, FLAT_GROUND).summaries!().get(seg.id)!.digest;
  };

  it('reads the materials, not the order their keys were written in', () => {
    expect(lookOf({ carriageway: 'cobble', footwayLeft: 'stone' })).toBe(lookOf({ footwayLeft: 'stone', carriageway: 'cobble' }));
    expect(lookOf({ carriageway: 'cobble', footwayLeft: 'stone' })).not.toBe(lookOf({ carriageway: 'cobble', footwayRight: 'stone' }));
    expect(lookOf({ carriageway: 'cobble' })).not.toBe(lookOf({ carriageway: 'concrete' }));
  });
});
