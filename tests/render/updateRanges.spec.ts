import { BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';

import { markAll, markBox } from '@render/mesh/updateRanges';

/** THE BYTES A CORNER EDIT SENDS (`mesh/updateRanges.ts`): the rows of the box, not the whole plate. */
const ROW = 301;
const plate = (itemSize: number): BufferAttribute => new BufferAttribute(new Float32Array(ROW * ROW * itemSize), itemSize);
const sent = (a: BufferAttribute): number => a.updateRanges.reduce((n, r) => n + r.count, 0);

describe('markBox', () => {
  it('sends a narrow box row by row, only its columns', () => {
    const a = plate(3);
    markBox(a, 3, ROW, 10, 19, 100, 104);
    expect(a.updateRanges).toHaveLength(5);
    expect(a.updateRanges[0]).toEqual({ start: (100 * ROW + 10) * 3, count: 10 * 3 });
    expect(sent(a)).toBe(5 * 10 * 3);
    expect(a.version).toBe(1);
  });

  it('sends a wide box as one run from its first corner to its last', () => {
    const a = plate(1);
    markBox(a, 1, ROW, 0, 300, 10, 12);
    expect(a.updateRanges).toEqual([{ start: 10 * ROW, count: 2 * ROW + 301 }]);
  });

  it('falls back to the whole array when ranges pile up unseen', () => {
    const a = plate(1);
    for (let k = 0; k < 400; k++) markBox(a, 1, ROW, 5, 6, 0, 3);
    expect(a.updateRanges.length).toBeLessThanOrEqual(128);
    expect(sent(a)).toBeGreaterThanOrEqual(0);
  });

  it('markAll sends the whole array, the ranges waiting dropped', () => {
    const a = plate(3);
    markBox(a, 3, ROW, 1, 2, 1, 2);
    markAll(a);
    expect(a.updateRanges).toEqual([{ start: 0, count: ROW * ROW * 3 }]);
  });

  it('a box marked after the whole array, before the draw, still sends the whole array', () => {
    const a = plate(3);
    markAll(a);
    markBox(a, 3, ROW, 1, 2, 1, 2);
    // three.js merges the ranges it is given (`WebGLAttributes.updateBuffer`): the whole array is among them.
    expect(a.updateRanges.some((r) => r.start === 0 && r.count === ROW * ROW * 3)).toBe(true);
    for (let k = 0; k < 400; k++) markBox(a, 3, ROW, 5, 6, k % 300, k % 300);
    expect(a.updateRanges.some((r) => r.start === 0 && r.count === ROW * ROW * 3)).toBe(true);
  });
});
