import { describe, expect, it } from 'vitest';

import {
  RIVER_CARVE,
  RELIEF_LEGACY,
  RELIEF_NATURAL,
  ROUGH_REACH_MIN,
  naturalRelief,
  TERRAIN_MAX_HEIGHT,
  TERRAIN_MIN_HEIGHT,
  TerrainIndex,
  baseRelief,
  sampleTerrainHeight,
  terrainInfluence,
  type TerrainStamp,
} from '@world/terrain';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit these scenes were laid out in: every length below in it, times U. */
const U = TUNED_UNIT;

const stamp = (over: Partial<TerrainStamp> = {}): TerrainStamp => ({
  id: 1,
  x: 0,
  y: 0,
  radius: 100,
  strength: 10,
  mode: 'raise',
  ...over,
});

describe('base relief', () => {
  it('is deterministic', () => {
    expect(baseRelief(123.5, -88.25)).toBe(baseRelief(123.5, -88.25));
  });

  it('is continuous: a small step never moves the ground far', () => {
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const x = -2000 + i * 10;
      worst = Math.max(worst, Math.abs(baseRelief(x, 37) - baseRelief(x + 0.5, 37)));
    }
    expect(worst).toBeLessThan(0.5);
  });

  it('stays inside a gradient a road at grade can absorb', () => {
    // 12% is the ground road's limit; the land must not routinely exceed it or every road becomes an embankment.
    let steepest = 0;
    for (let x = -2000 * U; x < 2000 * U; x += 7 * U) {
      for (let y = -2000 * U; y < 2000 * U; y += 293 * U) {
        steepest = Math.max(steepest, Math.abs(baseRelief(x + 7 * U, y) - baseRelief(x, y)) / (7 * U));
      }
    }
    expect(steepest).toBeLessThan(0.3);
  });

  it('is not flat — a flat plane is what made the scene read as a drawing', () => {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < 500; i++) {
      const value = baseRelief(i * 13.7, i * -9.1);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    expect(high - low).toBeGreaterThan(8);
  });
});

describe('terrain stamps', () => {
  it('raises at the centre and fades to nothing at the rim', () => {
    const base = baseRelief(0, 0);
    expect(sampleTerrainHeight([stamp()], 0, 0) - base).toBeCloseTo(10, 5);
    expect(sampleTerrainHeight([stamp()], 100, 0)).toBeCloseTo(baseRelief(100, 0), 5);
  });

  it('lowers by the same amount it raises', () => {
    const up = sampleTerrainHeight([stamp({ mode: 'raise' })], 12, 5) - baseRelief(12, 5);
    const down = baseRelief(12, 5) - sampleTerrainHeight([stamp({ mode: 'lower' })], 12, 5);
    expect(up).toBeCloseTo(down, 9);
  });

  it('carves a river deeper than a lower of the same strength', () => {
    const lower = baseRelief(0, 0) - sampleTerrainHeight([stamp({ mode: 'lower' })], 0, 0);
    const river = baseRelief(0, 0) - sampleTerrainHeight([stamp({ mode: 'river' })], 0, 0);
    expect(river / lower).toBeCloseTo(RIVER_CARVE, 6);
  });

  it('clamps to the height range', () => {
    // Enough dabs at the brush's own ceiling to overshoot it, so the test measures the clamp and not the strength of the pile.
    const tall = Array.from({ length: 60 }, (_, i) => stamp({ id: i, radius: 300, strength: 40 }));
    expect(sampleTerrainHeight(tall, 0, 0)).toBeLessThanOrEqual(TERRAIN_MAX_HEIGHT);
    expect(sampleTerrainHeight(tall, 0, 0)).toBeGreaterThan(TERRAIN_MAX_HEIGHT - 1);
    const deep = Array.from({ length: 60 }, (_, i) => stamp({ id: i, radius: 300, strength: 40, mode: 'lower' }));
    expect(sampleTerrainHeight(deep, 0, 0)).toBeGreaterThanOrEqual(TERRAIN_MIN_HEIGHT);
    expect(sampleTerrainHeight(deep, 0, 0)).toBeLessThan(TERRAIN_MIN_HEIGHT + 1);
  });

  it('allows mountains and pits a town can be planned around', () => {
    // The whole point of the wide range: a real landform, not a garden terrace.
    const hill = Array.from({ length: 36 }, (_, i) => stamp({ id: i, radius: 300 * U, strength: 40 * U, x: ((i % 9) * 150 - 600) * U }));
    expect(sampleTerrainHeight(hill, 0, 0) - baseRelief(0, 0)).toBeGreaterThan(250 * U);
    const pit = Array.from({ length: 36 }, (_, i) => stamp({ id: i, radius: 300 * U, strength: 40 * U, mode: 'lower' }));
    expect(baseRelief(0, 0) - sampleTerrainHeight(pit, 0, 0)).toBeGreaterThan(250 * U);
  });

  it('influence is monotone from rim to centre', () => {
    for (let i = 1; i <= 10; i++) {
      expect(terrainInfluence(i / 10)).toBeGreaterThan(terrainInfluence((i - 1) / 10));
    }
  });
});

describe('TerrainIndex', () => {
  const stamps = Array.from({ length: 60 }, (_, i) =>
    stamp({ id: i, x: (i % 10) * 90 - 400, y: Math.floor(i / 10) * 90 - 250, radius: 70, strength: 3 }),
  );

  it('answers exactly what a linear scan answers', () => {
    const index = new TerrainIndex(stamps, 1);
    for (let i = 0; i < 200; i++) {
      const x = -600 + i * 6;
      const y = -300 + ((i * 37) % 600);
      expect(sampleTerrainHeight(index, x, y)).toBeCloseTo(sampleTerrainHeight(stamps, x, y), 9);
    }
  });

  it('grown stamp by stamp answers what an index of them all answers', () => {
    // Strokes, rough dabs, a flatten and a river: the order of the stamps over a point matters to all of them.
    const laid = stamps.map((s, i) => ({ ...s, ...(i % 4 === 0 ? { stroke: Math.floor(i / 8) } : {}), ...(i % 5 === 0 ? { rough: true } : {}),
      mode: (i % 11 === 0 ? 'flatten' : i % 13 === 0 ? 'river' : i % 3 === 0 ? 'lower' : 'raise') as TerrainStamp['mode'], level: 2 }));
    const grown = new TerrainIndex(laid.slice(0, 7), 1);
    for (const s of laid.slice(7)) grown.add(s, 2);
    const whole = new TerrainIndex(laid, 2);
    expect(grown.stamps).toEqual(whole.stamps);
    for (let i = 0; i < 400; i++) {
      const x = -600 + i * 3.1, y = -300 + ((i * 37) % 600);
      expect(sampleTerrainHeight(grown, x, y)).toBe(sampleTerrainHeight(whole, x, y));
    }
    // The last ones undone: what an index of those left answers.
    for (let k = 0; k < 20; k++) grown.pop(3);
    const left = new TerrainIndex(laid.slice(0, laid.length - 20), 3);
    expect(grown.stamps).toEqual(left.stamps);
    for (let i = 0; i < 400; i++) {
      const x = -600 + i * 3.1, y = -300 + ((i * 37) % 600);
      expect(sampleTerrainHeight(grown, x, y)).toBe(sampleTerrainHeight(left, x, y));
      expect(grown.near(x, y)).toEqual(left.near(x, y));
    }
  });

  it('copies the stamp list rather than aliasing it', () => {
    const live = [...stamps];
    const index = new TerrainIndex(live, 1);
    live.push(stamp({ id: 999 }));
    expect(index.stamps.length).toBe(60);
  });
});

describe('levelling', () => {
  it('pulls the ground towards a stamp’s own target height', () => {
    const at = { x: 40, y: -18 };
    const before = sampleTerrainHeight([], at.x, at.y);
    const target = before + 9;
    const stamp: TerrainStamp = {
      id: 1,
      x: at.x,
      y: at.y,
      radius: 90,
      strength: 10,
      mode: 'flatten',
      level: target,
    };
    const after = sampleTerrainHeight([stamp], at.x, at.y);
    expect(after).toBeCloseTo(target, 6);
  });

  it('is unchanged for a stamp written before the target existed', () => {
    // The old rule scaled the ground towards sea level.
    const at = { x: -120, y: 65 };
    const base: Omit<TerrainStamp, 'level'> = {
      id: 2,
      x: at.x,
      y: at.y,
      radius: 70,
      strength: 6,
      mode: 'flatten',
    };
    const legacy = sampleTerrainHeight([base as TerrainStamp], at.x, at.y);
    const explicit = sampleTerrainHeight([{ ...base, level: 0 }], at.x, at.y);
    expect(explicit).toBeCloseTo(legacy, 9);
  });

  it('leaves the ground alone outside the brush', () => {
    const stamp: TerrainStamp = {
      id: 3, x: 0, y: 0, radius: 50, strength: 10, mode: 'flatten', level: 30,
    };
    const far = { x: 400, y: 400 };
    expect(sampleTerrainHeight([stamp], far.x, far.y)).toBeCloseTo(
      sampleTerrainHeight([], far.x, far.y),
      9,
    );
  });
});

describe('terrain revision', () => {
  it('stays put when a document is replaced by an edit that left the land alone', async () => {
    const { RoadDoc } = await import('@world/doc');
    const doc = new RoadDoc();
    doc.addTerrainStamp({ x: 0, y: 0, radius: 80, strength: 10, mode: 'raise' });
    const before = doc.terrainRevision;
    // What drawing a road does: edit a clone, then replace the document with it.
    const work = doc.clone();
    const a = work.addNode({ x: -200, y: 0 });
    const b = work.addNode({ x: 200, y: 0 });
    work.addSegment(a.id, b.id, 2);
    doc.replaceWith(work);
    expect(doc.segments.size).toBe(1);
    expect(doc.terrainRevision).toBe(before);
  });

  it('moves when the replacement changes a stamp', async () => {
    const { RoadDoc } = await import('@world/doc');
    const doc = new RoadDoc();
    doc.addTerrainStamp({ x: 0, y: 0, radius: 80, strength: 10, mode: 'raise' });
    const before = doc.terrainRevision;
    const work = doc.clone();
    work.addTerrainStamp({ x: 50, y: 0, radius: 40, strength: 4, mode: 'lower' });
    doc.replaceWith(work);
    expect(doc.terrainStamps).toHaveLength(2);
    expect(doc.terrainRevision).toBeGreaterThan(before);
  });
});

describe('a brush stroke', () => {
  const dab = (id: number, x: number, over: Partial<TerrainStamp> = {}): TerrainStamp =>
    ({ id, x, y: 0, radius: 100, strength: 40, mode: 'raise', ...over });

  it('moves the ground by its strength however often it passes (opacity, not flow)', () => {
    // A hundred dabs held on one spot: summed, the ground reached the ceiling and came out a flat-topped cylinder
    const held = Array.from({ length: 100 }, (_, i) => dab(i + 1, 0, { stroke: 1 }));
    expect(sampleTerrainHeight(held, 0, 0) - baseRelief(0, 0)).toBeCloseTo(40, 6);
    // The falloff keeps its shape: half way out, the single dab's height.
    expect(sampleTerrainHeight(held, 50, 0) - baseRelief(50, 0)).toBeCloseTo(40 * terrainInfluence(0.5), 6);
  });

  it('lays a ridge of even height along its path', () => {
    const path = Array.from({ length: 11 }, (_, i) => dab(i + 1, i * 20, { stroke: 7 }));
    const crest = [20, 70, 130, 180].map((x) => sampleTerrainHeight(path, x, 0) - baseRelief(x, 0));
    // Between two dabs a fifth of a radius apart the crest dips by 3% at most.
    for (const h of crest) { expect(h).toBeGreaterThan(38.8); expect(h).toBeLessThanOrEqual(40 + 1e-9); }
  });

  it('builds up stroke by stroke, and dabs of no stroke still add as before', () => {
    const two = [dab(1, 0, { stroke: 1 }), dab(2, 0, { stroke: 1 }), dab(3, 0, { stroke: 2 })];
    expect(sampleTerrainHeight(two, 0, 0) - baseRelief(0, 0)).toBeCloseTo(80, 6);
    const loose = [dab(1, 0), dab(2, 0), dab(3, 0)];
    expect(sampleTerrainHeight(loose, 0, 0) - baseRelief(0, 0)).toBeCloseTo(120, 6);
  });

  it('reads the same through the spatial index', () => {
    const path = Array.from({ length: 30 }, (_, i) => dab(i + 1, (i % 10) * 15, { stroke: 1 + Math.floor(i / 10) }));
    const index = new TerrainIndex(path, 1);
    for (const x of [-40, 0, 33, 90, 160]) expect(sampleTerrainHeight(index, x, 12)).toBeCloseTo(sampleTerrainHeight(path, x, 12), 9);
  });
});

describe('natural brush (rough dabs)', () => {
  const lift = (stamps: TerrainStamp[], x: number, y: number): number => sampleTerrainHeight(stamps, x, y) - baseRelief(x, y);

  it('leaves a dab without the flag exactly the smooth dome', () => {
    for (const r of [0, 25, 50, 75, 99]) {
      expect(lift([stamp()], r, 0)).toBeCloseTo(10 * terrainInfluence(1 - r / 100), 9);
    }
  });

  it('never reaches past its radius, and always within ROUGH_REACH_MIN of it', () => {
    const rough = stamp({ rough: true, x: 400, y: -300 });
    for (let a = 0; a < 64; a++) {
      const angle = (a / 64) * Math.PI * 2;
      const at = (r: number): number => lift([rough], 400 + Math.cos(angle) * r, -300 + Math.sin(angle) * r);
      expect(at(100.5)).toBe(0);
      expect(at(ROUGH_REACH_MIN * 100 - 2)).toBeGreaterThan(0);
    }
  });

  it('is not a circle: the same distance lifts the ground by different amounts round it', () => {
    const rough = stamp({ rough: true });
    const ring = Array.from({ length: 32 }, (_, a) => lift([rough], Math.cos(a / 5.1) * 60, Math.sin(a / 5.1) * 60));
    expect(Math.max(...ring) - Math.min(...ring)).toBeGreaterThan(0.5);
  });
});

describe('relief versions', () => {
  it('reads the old field unless the index is on the natural land', () => {
    expect(sampleTerrainHeight(new TerrainIndex([], 0), 300, -200)).toBeCloseTo(baseRelief(300, -200), 9);
    expect(sampleTerrainHeight(new TerrainIndex([], 0, RELIEF_NATURAL), 300, -200)).toBeCloseTo(naturalRelief(300, -200), 9);
  });

  it('keeps a saved map on its own land, and a natural map natural, through JSON', async () => {
    const { RoadDoc } = await import('@world/doc');
    const legacy = RoadDoc.fromJSON({ ...new RoadDoc().toJSON() });
    expect(legacy.terrainRelief).toBe(RELIEF_LEGACY);
    expect('relief' in legacy.toJSON()).toBe(false);
    const natural = new RoadDoc();
    natural.terrainRelief = RELIEF_NATURAL;
    expect(RoadDoc.fromJSON(natural.toJSON()).terrainRelief).toBe(RELIEF_NATURAL);
    expect(natural.clone().terrainRelief).toBe(RELIEF_NATURAL);
  });

  it('has plains and hills, within a range a map can hold', () => {
    let low = Infinity;
    let high = -Infinity;
    for (let x = -2400; x <= 2400; x += 60) {
      for (let y = -2400; y <= 2400; y += 60) {
        const h = naturalRelief(x, y);
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
    }
    expect(high - low).toBeGreaterThan(80);
    expect(high).toBeLessThan(300);
    expect(low).toBeGreaterThan(-200);
  });
});
