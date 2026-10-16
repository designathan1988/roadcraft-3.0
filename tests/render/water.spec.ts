import { describe, expect, it, vi } from 'vitest';
import { Mesh } from 'three';

import { unifiedWaterGeometry, type WaterStamp } from '@render/terrain';
import type { TerrainStamp } from '@world/terrain';
import {
  WATER_CLOCK_WRAP,
  WATER_DEPTH_ATTRIBUTE,
  WATER_DRIFTS,
  createWaterSurface,
  waterClock,
  waterNormalTexels,
  waterTextureSize,
} from '@render/water';

/** What the water owes the shader, stated as tests. */

/** A bowl, so a disc of water at level 0 has a real bed and a real shore. */
const bowl = (x: number, y: number): number => Math.hypot(x, y) / 12 - 20;

const disc = (level: number): WaterStamp[] => [{ x: 0, y: 0, radius: 180, level }];

function attribute(geometry: ReturnType<typeof unifiedWaterGeometry>, name: string) {
  const found = geometry.getAttribute(name);
  expect(found).toBeDefined();
  return found;
}

describe('waterNormalTexels', () => {
  it('fills one rgba texel per pixel', () => {
    expect(waterNormalTexels(64)).toHaveLength(64 * 64 * 4);
  });

  it('is deterministic, so two tiers bake the same water', () => {
    expect(Array.from(waterNormalTexels(32))).toEqual(Array.from(waterNormalTexels(32)));
  });

  it('points every normal out of the surface', () => {
    // A tangent-space normal whose z falls to or below the encoding midpoint is one pointing into the surface
    const data = waterNormalTexels(64);
    for (let i = 2; i < data.length; i += 4) expect(data[i] as number).toBeGreaterThan(127);
  });

  it('varies the foam channel rather than baking it flat', () => {
    const data = waterNormalTexels(64);
    let low = 255;
    let high = 0;
    for (let i = 3; i < data.length; i += 4) {
      low = Math.min(low, data[i] as number);
      high = Math.max(high, data[i] as number);
    }
    expect(high - low).toBeGreaterThan(40);
  });

  it('tiles: the wrap seam is no sharper than the texture is anywhere else', () => {
    // The whole reason the bake uses periodic noise.
    const size = 64;
    const data = waterNormalTexels(size);
    const at = (x: number, y: number, channel: number): number =>
      data[(y * size + x) * 4 + channel] as number;
    const columnStep = (a: number, b: number): number => {
      let total = 0;
      for (let y = 0; y < size; y++) {
        for (let c = 0; c < 3; c++) total += Math.abs(at(a, y, c) - at(b, y, c));
      }
      return total / (size * 3);
    };
    let interior = 0;
    for (let x = 1; x < size - 1; x++) interior += columnStep(x, x + 1);
    interior /= size - 2;
    expect(columnStep(size - 1, 0)).toBeLessThan(interior * 3);
  });
});

describe('the quality tier and the clock', () => {
  it('sizes the texture from the anisotropy the tier already sets', () => {
    expect(waterTextureSize(2)).toBe(128);
    expect(waterTextureSize(4)).toBe(128);
    expect(waterTextureSize(8)).toBe(256);
    expect(waterTextureSize(16)).toBe(256);
  });

  it('keeps every size a power of two', () => {
    for (const anisotropy of [1, 2, 4, 8, 16]) {
      const size = waterTextureSize(anisotropy);
      expect(size & (size - 1)).toBe(0);
    }
  });

  it('wraps the clock on a whole number of tiles, so the wrap is invisible', () => {
    // Without this the scroll offset jumps at the wrap and the river stutters once every sixteen minutes.
    for (const drift of WATER_DRIFTS) {
      for (const axis of drift) {
        expect(Number.isInteger(axis * WATER_CLOCK_WRAP)).toBe(true);
      }
    }
  });

  it('advances and then wraps', () => {
    expect(waterClock(0)).toBe(0);
    expect(waterClock(2_500)).toBeCloseTo(2.5, 9);
    expect(waterClock(WATER_CLOCK_WRAP * 1_000)).toBeCloseTo(0, 9);
    expect(waterClock(WATER_CLOCK_WRAP * 1_000 + 3_000)).toBeCloseTo(3, 9);
  });
});

describe('createWaterSurface', () => {
  it('builds a transparent, front-facing, repeating surface', () => {
    const surface = createWaterSurface(8);
    expect(surface.material.transparent).toBe(true);
    expect(surface.material.normalMap).not.toBeNull();
    expect(surface.material.normalMap?.wrapS).toBe(1_000); // RepeatWrapping
    expect(surface.material.normalMap?.wrapT).toBe(1_000);
    const image = surface.material.normalMap?.image as { width: number } | undefined;
    expect(image?.width).toBe(256);
    surface.dispose();
  });

  it('drives its own clock from the mesh it is attached to', () => {
    // A fake clock the test moves: the water reads `performance.now()`.
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const surface = createWaterSurface(4);
      const mesh = new Mesh();
      surface.attach(mesh);
      expect(surface.time.value).toBe(0);
      vi.advanceTimersByTime(30);
      // The arguments are the renderer's; nothing here reads them.
      (mesh.onBeforeRender as unknown as () => void)();
      expect(surface.time.value).toBeGreaterThan(0);
      surface.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('unifiedWaterGeometry', () => {
  it('builds nothing at all without a stamp', () => {
    expect(unifiedWaterGeometry([], bowl).getAttribute('position')).toBeUndefined();
  });

  it('builds nothing where the land stands above the surface', () => {
    // The invariant that matters most: water hanging in open air is worse than no water.
    const geometry = unifiedWaterGeometry(disc(-40), () => 0);
    expect(geometry.getAttribute('position')?.count ?? 0).toBe(0);
  });

  it('writes one depth, one uv and one normal per position', () => {
    const geometry = unifiedWaterGeometry(disc(0), bowl);
    const position = attribute(geometry, 'position');
    expect(position.count).toBeGreaterThan(0);
    expect(position.count % 3).toBe(0);
    expect(attribute(geometry, WATER_DEPTH_ATTRIBUTE).count).toBe(position.count);
    expect(attribute(geometry, 'uv').count).toBe(position.count);
    expect(attribute(geometry, 'normal').count).toBe(position.count);
  });

  it('keeps every vertex finite', () => {
    const geometry = unifiedWaterGeometry(disc(0), bowl);
    const position = attribute(geometry, 'position');
    const depth = attribute(geometry, WATER_DEPTH_ATTRIBUTE);
    // Counted, then asserted once: an `expect` per vertex took seconds.
    let bad = 0;
    for (let i = 0; i < position.count; i++) {
      if (![position.getX(i), position.getY(i), position.getZ(i), depth.getX(i)].every(Number.isFinite)) bad++;
    }
    expect(bad).toBe(0);
  });

  it('never leaves a vertex above the ground under it', () => {
    const geometry = unifiedWaterGeometry(disc(0), bowl);
    const position = attribute(geometry, 'position');
    let above = 0;
    for (let i = 0; i < position.count; i++) {
      // World y is mirrored into three's z, so the sampler wants -z back.
      if (!(position.getY(i) > bowl(position.getX(i), -position.getZ(i)))) above++;
    }
    expect(above).toBe(0);
  });

  it('carries the depth the shader tints and foams from', () => {
    const geometry = unifiedWaterGeometry(disc(0), bowl);
    const position = attribute(geometry, 'position');
    const depth = attribute(geometry, WATER_DEPTH_ATTRIBUTE);
    let deepest = 0;
    let shallowest = Infinity;
    let wrong = 0;
    for (let i = 0; i < position.count; i++) {
      const expected = position.getY(i) - bowl(position.getX(i), -position.getZ(i));
      // toBeCloseTo(expected, 3): within half a thousandth.
      if (!(Math.abs(depth.getX(i) - expected) < 5e-4) || !(depth.getX(i) > 0)) wrong++;
      deepest = Math.max(deepest, depth.getX(i));
      shallowest = Math.min(shallowest, depth.getX(i));
    }
    expect(wrong).toBe(0);
    // A flat depth would make the tint, the opacity ramp and the foam band all constant
    expect(deepest).toBeCloseTo(20, 0);
    expect(shallowest).toBeLessThan(1);
  });

  it('winds every face upwards and normals it upwards', () => {
    // Front faces, so the sheet is rasterised once rather than twice, and a plane normal
    const geometry = unifiedWaterGeometry(disc(0), bowl);
    const position = attribute(geometry, 'position');
    const normal = attribute(geometry, 'normal');
    let down = 0, tilted = 0;
    for (let i = 0; i < position.count; i += 3) {
      const ux = position.getX(i + 1) - position.getX(i);
      const uz = position.getZ(i + 1) - position.getZ(i);
      const vx = position.getX(i + 2) - position.getX(i);
      const vz = position.getZ(i + 2) - position.getZ(i);
      if (!(uz * vx - ux * vz > 0)) down++;
    }
    for (let i = 0; i < normal.count; i++) {
      if (normal.getX(i) !== 0 || normal.getY(i) !== 1 || normal.getZ(i) !== 0) tilted++;
    }
    expect(down).toBe(0);
    expect(tilted).toBe(0);
  });

  it('fills the hollow a river runs into, to the level of the river, and stops at its shore', () => {
    // A channel at -5 from the river's disc to a pit 50 deep; banks at +5.
    const ground = (x: number, y: number): number => {
      if (Math.hypot(x - 160, y) < 60) return -50;
      if (Math.abs(y) < 10 && x > -40 && x < 170) return -5;
      return Math.hypot(x, y) < 40 ? -5 : 5;
    };
    const flooded = new Map<string, number>();
    const geometry = unifiedWaterGeometry([{ x: 0, y: 0, radius: 40, level: 0 }], ground, flooded);
    const position = attribute(geometry, 'position');
    let overPit = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = -position.getZ(i);
      expect(position.getY(i)).toBeGreaterThan(ground(x, y));
      if (Math.hypot(x - 160, y) < 50) { overPit++; expect(position.getY(i)).toBeCloseTo(0, 6); }
      // Never past the banks.
      expect(ground(x, y)).toBeLessThan(5);
    }
    expect(overPit).toBeGreaterThan(100);
    expect(flooded.size).toBeGreaterThan(0);
  });

  it('leaves water that would drain into open low country where the brush put it', () => {
    const low = (x: number, y: number): number => (Math.hypot(x, y) < 40 ? -5 : -3);
    const flooded = new Map<string, number>();
    unifiedWaterGeometry([{ x: 0, y: 0, radius: 40, level: 0 }], low, flooded);
    expect(flooded.size).toBe(0);
  });

  it('runs the surface downhill when the stamps disagree about the level', () => {
    // The union's whole point: two overlapping stamps at different levels give a sloping river
    const flat = (): number => -30;
    const geometry = unifiedWaterGeometry(
      [
        { x: -120, y: 0, radius: 150, level: -2 },
        { x: 120, y: 0, radius: 150, level: -9 },
      ],
      flat,
    );
    const position = attribute(geometry, 'position');
    let west = -Infinity;
    let east = Infinity;
    for (let i = 0; i < position.count; i++) {
      if (position.getX(i) < -140) west = Math.max(west, position.getY(i));
      if (position.getX(i) > 140) east = Math.min(east, position.getY(i));
    }
    expect(west).toBeGreaterThan(east);
  });
});

describe('a crater in a map with no stamps', () => {
  it('rewrites only its own box, not the whole map', async () => {
    const { stampTail } = await import('@render/terrain');
    const { TerrainIndex, RELIEF_LEGACY, RELIEF_NATURAL } = await import('@world/terrain');
    const stamp = (id: number): TerrainStamp => ({ id, x: id, y: 0, radius: 10, strength: 1, mode: 'raise' });
    const crater = stamp(1);
    // The bomb's crater, the first stamp of a generated city, over the same land.
    expect(stampTail(new TerrainIndex([], 0), [crater], RELIEF_LEGACY, undefined)).toEqual({ removed: [], added: [crater] });
    // The land under the stamps moved too (another relief, other corners): the whole plate.
    expect(stampTail(new TerrainIndex([], 0), [crater], RELIEF_NATURAL, undefined)).toBeNull();
    expect(stampTail(new TerrainIndex([], 0), [crater], RELIEF_LEGACY, () => 0)).toBeNull();
    const old = stamp(0);
    const index = new TerrainIndex([old, crater], 0);
    // Several laid in one frame: all of them.
    expect(stampTail(index, [old, crater, stamp(2), stamp(3)], RELIEF_LEGACY, undefined)).toEqual({ removed: [], added: [stamp(2), stamp(3)] });
    // The last one undone.
    expect(stampTail(index, [old], RELIEF_LEGACY, undefined)).toEqual({ removed: [crater], added: [] });
    // Changed otherwise (the oldest dropped at the cap): the whole plate.
    expect(stampTail(index, [crater, stamp(2)], RELIEF_LEGACY, undefined)).toBeNull();
    // The same list: nothing.
    expect(stampTail(index, [old, crater], RELIEF_LEGACY, undefined)).toEqual({ removed: [], added: [] });
  });
});
