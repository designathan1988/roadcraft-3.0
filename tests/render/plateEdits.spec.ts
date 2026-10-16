// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { DataTexture, type BufferAttribute, type DataArrayTexture, type Material, type WebGLRenderer } from 'three';

// The baked surfaces need a canvas's pixels; flat stand-ins do for the land's arithmetic.
vi.mock('@render/mesh/textureBaker', async (load) => {
  const real = await load<typeof import('@render/mesh/textureBaker')>();
  const flat = (): DataTexture => { const t = new DataTexture(new Uint8Array(4 * 4 * 4).fill(128), 4, 4); t.needsUpdate = true; return t; };
  return { ...real, bakeSurface: () => ({ map: flat(), normalMap: flat(), roughnessMap: flat() }) };
});

import { RoadDoc } from '@world/doc';
import { createFlatAtlas } from '@render/flatAtlas';
import { TERRAIN_BASE, TERRAIN_CELL, TERRAIN_HALF, createTerrainSurface, type TerrainSource, type TerrainSurface } from '@render/terrain';
import { buildPlateMesh } from '@render/plateMesh';
import { RELIEF_NATURAL, reliefHeight, type TerrainStamp } from '@world/terrain';
import type { PaintDab } from '@world/terrainPaint';

/** A PLATE EDITED DAB BY DAB IS THE PLATE BUILT AT ONCE (`render/terrain.ts`): only the boxes the dabs reach are written and sent. */
const home = (atlas: TerrainSurface): TerrainSurface => atlas.parts.find((p) => p.cx === 0 && p.cy === 0)!.surface;
const attribute = (s: TerrainSurface, name: string): Float32Array => (s.ground.geometry.getAttribute(name) as BufferAttribute).array as Float32Array;
const userData = (s: TerrainSurface): Record<string, unknown> => (s.ground.material as Material).userData;
/** The first index where two arrays differ, or -1 (millions of texels: not through `toEqual`). */
const firstDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
};

const STAMPS = [
  { x: 120, y: 40, radius: 60, strength: 9, mode: 'raise' as const },
  { x: 150, y: 60, radius: 45, strength: 5, mode: 'lower' as const, stroke: 3, rough: true },
  { x: 170, y: 70, radius: 45, strength: 5, mode: 'lower' as const, stroke: 3, rough: true },
  { x: -300, y: -200, radius: 80, strength: 4, mode: 'flatten' as const, level: 2 },
];
const DABS: Omit<PaintDab, 'id'>[] = [
  { kind: 'soil', x: 100, y: 30, radius: 25, strength: 1 },
  { kind: 'forest', x: 130, y: 35, radius: 40, strength: 0.8 },
  { kind: 'sandstone', x: -50, y: 80, radius: 30, strength: 1 },
  { kind: 'flowers', x: 60, y: -90, radius: 35, strength: 0.6 },
] as never;

describe('a plate edited by the brush', () => {
  it('moves its land by the stamps laid, one by one or undone, as a plate made with them', () => {
    const doc = new RoadDoc();
    const atlas = createFlatAtlas(1);
    atlas.update(doc as never, false);
    for (const s of STAMPS) { doc.addTerrainStamp(s); atlas.update(doc as never, false); }
    // Two in one frame.
    doc.addTerrainStamp({ x: 400, y: 400, radius: 50, strength: 6, mode: 'raise' });
    doc.addTerrainStamp({ x: 430, y: 410, radius: 50, strength: 6, mode: 'river' });
    atlas.update(doc as never, false);

    const whole = new RoadDoc();
    for (const s of doc.terrainStamps) whole.addTerrainStamp(s);
    const fresh = createFlatAtlas(1);
    fresh.update(whole as never, false);
    const a = home(atlas), b = home(fresh);
    expect(firstDiff(attribute(a, 'position'), attribute(b, 'position'))).toBe(-1);
    const na = attribute(a, 'normal'), nb = attribute(b, 'normal');
    for (let i = 0; i < na.length; i += 7) expect(na[i]).toBeCloseTo(nb[i]!, 5);
    expect(firstDiff(a.ground.geometry.getIndex()!.array, b.ground.geometry.getIndex()!.array)).toBe(-1);

    // The last two taken away (an undo): the land as it stood before them.
    doc.terrainStamps.length -= 2;
    doc.changes.record('terrain', null);
    atlas.update(doc as never, false);
    const before = new RoadDoc();
    for (const s of doc.terrainStamps) before.addTerrainStamp(s);
    const again = createFlatAtlas(1);
    again.update(before as never, false);
    expect(firstDiff(attribute(a, 'position'), attribute(home(again), 'position'))).toBe(-1);
  });

  it('paints the dabs laid one by one as a plate painted with them all, and sends only their boxes', () => {
    const doc = new RoadDoc();
    const atlas = createFlatAtlas(1);
    atlas.update(doc as never, false);
    atlas.updatePaint(doc as never);
    doc.addPaintDab(DABS[0]!);
    atlas.updatePaint(doc as never);
    const s = home(atlas);
    const shore = userData(s)['shore'] as DataTexture;
    // Sent whole once (three.js calls `onUpdate` after an upload).
    shore.onUpdate?.(shore);
    const paint = userData(s)['paint'] as DataArrayTexture;
    const paintVersion = paint.version, shoreVersion = shore.version;
    const copies: { min: number[]; max: number[] }[] = [];
    const renderer = { copyTextureToTexture: (_src: unknown, _dst: unknown, region: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) => {
      copies.push({ min: [region.min.x, region.min.y, region.min.z], max: [region.max.x, region.max.y, region.max.z] });
    } } as unknown as WebGLRenderer;
    s.bakeRelief(renderer, null);
    copies.length = 0;
    for (const dab of DABS.slice(1)) doc.addPaintDab(dab);
    atlas.updatePaint(doc as never);
    // The painted layers are not marked to go whole: a box of them goes, before the frame.
    expect(paint.version).toBe(paintVersion);
    s.bakeRelief(renderer, null);
    expect(copies).toHaveLength(1);
    const [c] = copies;
    expect(c!.min[2]).toBe(0);
    expect(c!.max[2]).toBe(2);
    expect((c!.max[0]! - c!.min[0]!) * (c!.max[1]! - c!.min[1]!)).toBeLessThan(paint.image.width * paint.image.height / 20);
    // The corners' texture: their rows, not the whole of it.
    expect(shore.version).toBeGreaterThan(shoreVersion);
    expect(shore.updateRanges.length).toBeGreaterThan(0);
    expect(shore.updateRanges.reduce((n, r) => n + r.count, 0)).toBeLessThan(shore.image.width * shore.image.height * 4 / 20);

    const whole = new RoadDoc();
    for (const dab of doc.terrainPaint) whole.addPaintDab(dab);
    const fresh = createFlatAtlas(1);
    fresh.update(whole as never, false);
    fresh.updatePaint(whole as never);
    const f = home(fresh);
    // The painted layers (the light's aside: it is worked out apart, `setSun`).
    const layer = paint.image.width * paint.image.height * 4;
    expect(firstDiff((paint.image.data as Uint8Array).subarray(0, 2 * layer), ((userData(f)['paint'] as DataArrayTexture).image.data as Uint8Array).subarray(0, 2 * layer))).toBe(-1);
    expect(firstDiff(shore.image.data as Float32Array, (userData(f)['shore'] as DataTexture).image.data as Float32Array)).toBe(-1);
    for (const key of ['flowerCorners', 'scrubCorners', 'forestCorners', 'sandCorners', 'basaltCorners']) {
      expect(firstDiff(userData(s)[key] as Float32Array, userData(f)[key] as Float32Array)).toBe(-1);
    }
  });

  it('keeps the plate made off the page when stamps are on it, and lays them on it', () => {
    const side = Math.round((2 * TERRAIN_HALF) / TERRAIN_CELL) + 1;
    const ground = new Float64Array(side * side);
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) ground[j * side + i] = reliefHeight(RELIEF_NATURAL, -TERRAIN_HALF + i * TERRAIN_CELL, TERRAIN_HALF - j * TERRAIN_CELL);
    const stamps = STAMPS.map((s, id) => ({ ...s, id }) as TerrainStamp);
    const source = (): TerrainSource => {
      const doc = new RoadDoc();
      return { changes: doc.changes, terrainRevision: 1, terrainStamps: stamps, terrainRelief: RELIEF_NATURAL, natureRevision: 0, nature: null, paintRevision: 0, terrainPaint: [] };
    };
    const mesh = buildPlateMesh(ground, side, TERRAIN_HALF, TERRAIN_CELL, TERRAIN_BASE);
    const madeHeights = mesh.heights.slice();
    const made = createTerrainSurface(1, { x: 0, y: 0 }, 12, mesh);
    made.update(source(), false);
    const page = createTerrainSurface(1, { x: 0, y: 0 }, 12);
    page.update(source(), false);
    const a = attribute(made, 'position'), b = attribute(page, 'position');
    // The same land: the corners the stamps reach worked out alike, the rest the field read off the page at the same corners.
    for (let i = 1; i < a.length; i += 3) expect(a[i]).toBeCloseTo(b[i]!, 3);
    // Away from the stamps, the corners are those the workers made, as they made them.
    let away = 0;
    for (let k = 0; k < side * side; k++) {
      const x = -TERRAIN_HALF + (k % side) * TERRAIN_CELL, y = TERRAIN_HALF - Math.floor(k / side) * TERRAIN_CELL;
      if (stamps.some((s) => Math.max(Math.abs(x - s.x), Math.abs(y - s.y)) < s.radius + 3 * TERRAIN_CELL)) continue;
      away++;
      if (a[k * 3 + 1] !== Math.fround(madeHeights[k]!)) expect.fail(`corner ${k} was worked out again on the page`);
    }
    expect(away).toBeGreaterThan(side * side * 0.9);
    expect(made.renderedHeightAt(120, 40)).toBe(page.renderedHeightAt(120, 40));
    expect(made.renderedHeightAt(120, 40)).toBeGreaterThan(TERRAIN_BASE + reliefHeight(RELIEF_NATURAL, 120, 40) + 1);
    // Its woods were worked out on the land without the stamps: not used.
    expect(made.woodsBase?.()).toBeNull();
  });
});

