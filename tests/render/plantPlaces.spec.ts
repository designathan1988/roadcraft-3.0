import { describe, expect, it } from 'vitest';

import { MAP_REGIONS } from '../../src/world/bounds';
import { m } from '../../src/world/units';
import { CellKeep, keepCellAt, keepCellsOver } from '../../src/render/candidateKeep';
import { type Candidate, type CoverGround, cellHash, forestIn, rocksIn, scrubIn, shoreIn } from '../../src/render/plantPlaces';
import { TERRAIN_HALF } from '../../src/render/terrain';

/** A painted wood, scrub and stones in two discs across a plate's edge, and a river's banks along a line. */
const ground: CoverGround = {
  forestAt: (x, y) => Math.max(0, 1 - Math.hypot(x - m(1_030), y - m(40)) / m(90)),
  coverAt: (kind, x, y) => {
    const d = kind === 'scrub' ? Math.hypot(x - m(1_000), y + m(30)) : Math.hypot(x + m(20), y - m(10));
    return Math.max(0, 1 - d / m(70));
  },
  shoreLevelAt: (x, y) => (Math.abs(y - m(300) - x * 0.1) < m(15) ? m(2) + (x % 7) * 0.01 : null),
};
const water = { minX: -m(200), maxX: m(400), minY: m(270), maxY: m(350) };

/** The whole-map sweep the places were made by before they were made cell by cell (the oracle): one lattice a plate. */
function sweep(spacing: number, make: (i: number, j: number, cx: number, cy: number) => Candidate | null): Candidate[] {
  const out: Candidate[] = [];
  for (const plate of MAP_REGIONS) {
    const first = Math.ceil((plate.cx - plate.half + TERRAIN_HALF) / spacing), last = Math.floor((plate.cx + plate.half + TERRAIN_HALF) / spacing) - 1;
    const firstY = Math.ceil((plate.cy - plate.half + TERRAIN_HALF) / spacing), lastY = Math.floor((plate.cy + plate.half + TERRAIN_HALF) / spacing) - 1;
    for (let j = firstY; j <= lastY; j++) for (let i = first; i <= last; i++) {
      const c = make(i, j, -TERRAIN_HALF + (i + 0.5) * spacing, -TERRAIN_HALF + (j + 0.5) * spacing);
      if (c) out.push(c);
    }
  }
  return out;
}

const byCell = <C extends Candidate>(list: readonly C[]): Map<number, C[]> => {
  const cells = new Map<number, C[]>();
  for (const c of list) {
    const k = keepCellAt(c.x, c.y);
    const l = cells.get(k);
    if (l) l.push(c); else cells.set(k, [c]);
  }
  return cells;
};

describe('the plants and stones made cell by cell', () => {
  it('makes in each cell the very places of the whole sweep, in its order', () => {
    const forest = sweep(m(12), (i, j, cx, cy) => {
      const density = ground.forestAt(cx, cy);
      if (density < 0.04 || cellHash(i, j, 1) > density * 0.92) return null;
      return { x: cx + (cellHash(i, j, 2) - 0.5) * m(12) * 0.9, y: cy + (cellHash(i, j, 3) - 0.5) * m(12) * 0.9 } as Candidate;
    });
    const rocks = sweep(m(3.2), (i, j, cx, cy) => {
      const density = ground.coverAt('rocks', cx, cy);
      if (density < 0.04 || cellHash(i, j, 41) > Math.sqrt(density) * 0.7) return null;
      return { x: cx + (cellHash(i, j, 42) - 0.5) * m(3.2) * 0.9, y: cy + (cellHash(i, j, 43) - 0.5) * m(3.2) * 0.9 } as Candidate;
    });
    expect(forest.length).toBeGreaterThan(20);
    expect(rocks.length).toBeGreaterThan(200);
    const cells = new Set<number>();
    keepCellsOver([-m(400), -m(400), m(1_300), m(500)], cells);
    for (const [want, got] of [[forest, forestIn], [rocks, rocksIn]] as const) {
      const expected = byCell(want);
      let seen = 0;
      for (const cell of cells) {
        const made = got(cell, ground).map((c) => [c.x, c.y]);
        expect(made).toEqual((expected.get(cell) ?? []).map((c) => [c.x, c.y]));
        seen += made.length;
      }
      expect(seen).toBe(want.length);
    }
    // The scrub lies across the plates' edge at x = 1024 m: each plate's own lattice lays its side of it.
    const scrub = [...cells].flatMap((cell) => scrubIn(cell, ground));
    expect(scrub.length).toBeGreaterThan(500);
    expect(scrub.some((c) => c.x < m(1_024)) && scrub.some((c) => c.x > m(1_024))).toBe(true);
  });

  it('lays the rivers\' stones of the water\'s box, each in its cell, as one sweep of the box does', () => {
    const s = m(3), reach = m(12);
    const expected: [number, number][] = [];
    for (let j = Math.floor((water.minY - reach + TERRAIN_HALF) / s); j <= Math.ceil((water.maxY + reach + TERRAIN_HALF) / s); j++) {
      for (let i = Math.floor((water.minX - reach + TERRAIN_HALF) / s); i <= Math.ceil((water.maxX + reach + TERRAIN_HALF) / s); i++) {
        const x = -TERRAIN_HALF + (i + cellHash(i, j, 51)) * s, y = -TERRAIN_HALF + (j + cellHash(i, j, 52)) * s;
        if (ground.shoreLevelAt(x, y) !== null) expected.push([x, y]);
      }
    }
    const cells = new Set<number>();
    keepCellsOver([-m(400), m(100), m(600), m(500)], cells);
    const got = [...cells].flatMap((cell) => shoreIn(cell, ground, water).map((c) => [c.x, c.y] as [number, number]));
    expect(got.length).toBe(expected.length);
    expect(new Set(got.map(String))).toEqual(new Set(expected.map(String)));
  });
});

describe('a keep of places cell by cell', () => {
  it('tests only the places new to a cell, and tells only the cells that changed', () => {
    let tests = 0;
    const keep = new CellKeep<{ x: number; y: number; id: number }>((c) => { tests++; return c.id % 2 ? null : c.id; });
    const a = { x: 1, y: 1, id: 0 }, b = { x: 2, y: 1, id: 1 }, c = { x: m(70), y: 1, id: 2 };
    keep.relist(keepCellAt(1, 1), [a, b]);
    keep.relist(keepCellAt(m(70), 1), [c]);
    expect(tests).toBe(3);
    expect(keep.takeChangedCells().size).toBe(2);
    // The same places again, made afresh: nothing tested, nothing changed.
    keep.relist(keepCellAt(1, 1), [{ ...a }, { ...b }]);
    expect(tests).toBe(3);
    expect(keep.takeChangedCells().size).toBe(0);
    expect(keep.standingIn(keepCellAt(1, 1)).map((s) => s.z)).toEqual([0]);
    // One place more: only it tested.
    keep.relist(keepCellAt(1, 1), [a, b, { x: 3, y: 2, id: 4 }]);
    expect(tests).toBe(4);
    expect([...keep.takeChangedCells()]).toEqual([keepCellAt(1, 1)]);
    // A change reaching one place tests it alone; a cell emptied is told and let go.
    keep.refresh([[m(69), 0, m(71), 2]], 0);
    expect(tests).toBe(5);
    keep.relist(keepCellAt(m(70), 1), []);
    expect([...keep.takeChangedCells()]).toEqual([keepCellAt(m(70), 1)]);
    expect([...keep.cellKeys()]).toEqual([keepCellAt(1, 1)]);
  });
});
