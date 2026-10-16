import { describe, expect, it } from 'vitest';
import type { DataTexture } from 'three';
import { Rng } from '@core/rng';
import { createWearField } from '@render/wear';

/** THE WEAR FIELD KEPT IN ITS OWN TEXTURE (`render/wear.ts`) */

describe('the wear field', () => {
  it('draws what a sum in floats rounded to 255ths drew, with no copy of the field in floats', () => {
    const size = 2048, field = createWearField(size);
    const rng = new Rng(7);
    // The sums as the field kept them before: floats capped at 1 (`Math.min(1, v + amount)`).
    const wheels = new Map<number, number>(), feet = new Map<number, number>();
    const cell = size / 2048;
    const key = (x: number, y: number): number => Math.floor((y + size / 2) / cell) * 2048 + Math.floor((x + size / 2) / cell);
    const spots = Array.from({ length: 40 }, () => [(rng.float() - 0.5) * size * 0.9, (rng.float() - 0.5) * size * 0.9] as const);
    for (let step = 0; step < 4000; step++) {
      const [x, y] = spots[Math.floor(rng.float() * spots.length)]!;
      const dt = 1 / 60;
      if (rng.float() < 0.5) {
        field.feet(x, y, dt);
        feet.set(key(x, y), Math.min(1, (feet.get(key(x, y)) ?? 0) + dt * 0.02));
      } else {
        // Straight along x: both tracks land at y +- width/2.
        field.wheels(x, y, 0, 0, dt);
        const k = key(x, y), add = dt * 0.05;
        wheels.set(k, Math.min(1, (wheels.get(k) ?? 0) + add * 2));
      }
    }
    field.tick(10);
    const bytes = (field.texture as DataTexture).image.data as Uint8Array;
    let compared = 0;
    for (const [k, v] of wheels) { expect(Math.abs(bytes[k * 4]! - Math.round(v * 255))).toBeLessThanOrEqual(1); compared++; }
    for (const [k, v] of feet) { expect(Math.abs(bytes[k * 4 + 1]! - Math.round(v * 255))).toBeLessThanOrEqual(1); compared++; }
    expect(compared).toBeGreaterThan(40);
    // Worn through: full, and no further.
    for (let i = 0; i < 4000; i++) field.wheels(spots[0]![0], spots[0]![1], 0, 0, 1);
    field.tick(10);
    expect(bytes[key(spots[0]![0], spots[0]![1]) * 4]).toBe(255);
    field.dispose();
  });
});
