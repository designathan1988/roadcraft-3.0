import { describe, expect, it } from 'vitest';
import { MAP_REGIONS } from '@world/bounds';
import { TERRAIN_HALF } from '@render/terrain';
import { PlateShares } from '@render/flatAtlas';

/** THE BRUSH'S STAMPS AND DABS SHARED OUT TO THE PLATES THEY REACH (`render/flatAtlas.ts` PlateShares) */
interface Dab { readonly x: number; readonly y: number; readonly radius: number; readonly ox?: number; readonly oy?: number }

/** What filtering every item for every plate gives: the lists the shares must hold. */
function filtered(list: readonly Dab[]): Dab[][] {
  return MAP_REGIONS.map((p) => list.filter((d) => Math.abs(d.x - p.cx) <= TERRAIN_HALF + d.radius && Math.abs(d.y - p.cy) <= TERRAIN_HALF + d.radius));
}

function expectShared(shares: PlateShares<Dab>, list: readonly Dab[]): void {
  const want = filtered(list);
  MAP_REGIONS.forEach((p, i) => {
    expect(shares.sources[i]).toEqual(want[i]);
    expect(shares.locals[i]!.map((d) => [d.x, d.y, d.radius, d.ox, d.oy])).toEqual(want[i]!.map((d) => [d.x - p.cx, d.y - p.cy, d.radius, d.ox === undefined ? undefined : d.ox - p.cx, d.oy === undefined ? undefined : d.oy - p.cy]));
  });
}

describe('the plates\' shares of the brush', () => {
  // Inside plates, across their edges and corners, past the map's rim.
  const at = (k: number): Dab => ({ x: Math.sin(k * 1.7) * 5800, y: Math.cos(k * 2.3) * 5800, radius: 20 + (k % 7) * 60, ...(k % 3 ? {} : { ox: k, oy: -k }) });

  it('holds on every plate what a filter of the whole list gives, through appends, undos and clears', () => {
    const shares = new PlateShares<Dab>(MAP_REGIONS);
    const list: Dab[] = [];
    shares.update(list, false);
    for (let k = 0; k < 300; k++) {
      list.push(at(k));
      if (k % 5 === 0) list.push(at(k + 1000));
      shares.update(list, false);
      if (k % 50 === 0) expectShared(shares, list);
    }
    expectShared(shares, list);
    // Undone: the last ones taken away.
    list.length -= 40;
    shares.update(list, false);
    expectShared(shares, list);
    // The oldest dropped at the cap.
    list.shift();
    list.push(at(5000));
    shares.update(list, false);
    expectShared(shares, list);
    list.length = 0;
    shares.update(list, false);
    expectShared(shares, list);
  });

  it('gives a new dab only to the plates it reaches, and keeps each copy', () => {
    const shares = new PlateShares<Dab>(MAP_REGIONS);
    const list: Dab[] = [at(1), at(2), at(3)];
    shares.update(list, false);
    const before = shares.locals.map((l) => l.slice());
    // On the corner of four plates.
    const corner = MAP_REGIONS[12]!;
    list.push({ x: corner.cx + TERRAIN_HALF, y: corner.cy + TERRAIN_HALF, radius: 10 });
    const moved = shares.update(list, false);
    expect(moved.sort((a, b) => a - b)).toEqual([12, 13, 17, 18]);
    expectShared(shares, list);
    // The items it had are the same copies: a plate's surface knows them for its own.
    shares.locals.forEach((l, i) => before[i]!.forEach((d, k) => expect(l[k]).toBe(d)));
    // Nothing new: no plate moved.
    expect(shares.update(list, false)).toEqual([]);
    // Taken again whole (the land under them moved): every plate.
    expect(shares.update(list, true)).toHaveLength(MAP_REGIONS.length);
  });
});
