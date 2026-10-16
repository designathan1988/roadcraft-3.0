import { describe, expect, it } from 'vitest';

import { HEIGHT_TILE, heightTileKey, heightTileReads, heightTileRect } from '@render/heightTile';
import { TERRAIN_BASE } from '@render/terrain';
import { plateOf } from '@world/bounds';
import { Network } from '@world/network';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { plateGround } from '../support/plateGround';

/** THE HEIGHTS A WORKER READS OVER A SQUARE OF THE MAP (`render/heightTile.ts`): the page's own numbers */

/** A street along y = 0 and one across it. */
function streets(): Network {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-200), y: 0 }).id, b = doc.addNode({ x: m(300), y: 0 }).id;
  const c = doc.addNode({ x: m(40), y: m(-200) }).id, d = doc.addNode({ x: m(40), y: m(200) }).id;
  doc.addSegment(a, b, 1);
  doc.addSegment(c, d, 1);
  const net = new Network(doc);
  net.rebuild();
  return net;
}

describe('the heights handed to a worker', () => {
  it('are the page\'s, the ground drawn and the paving, over every point of a square', () => {
    const page = plateGround(streets());
    let points = 0, paved = 0;
    const wrong: string[] = [];
    // Four squares about the crossing, and one on the next plate (bare): every point read there, none asked of the page.
    for (const [x0, y0] of [[-m(250), -m(250)], [m(10), -m(250)], [-m(250), m(10)], [m(10), m(10)], [m(1100), m(10)]] as const) {
      const key = heightTileKey(x0, y0);
      const rect = heightTileRect(key);
      // Sent as a message is.
      const reads = heightTileReads(structuredClone(page.heightTile(rect).tile));
      for (let x = rect[0]; x < rect[2]; x += m(1.37)) {
        for (let y = rect[1]; y < rect[3]; y += m(2.13)) {
          if (heightTileKey(x, y) !== key) wrong.push(`key at ${x}, ${y}`);
          const ground = reads.ground(x, y), drawn = page.terrainHeightAt(x, y);
          if (ground === undefined || !Object.is(ground, drawn)) wrong.push(`ground at ${x}, ${y}: ${ground} vs ${drawn}`);
          const there = reads.paved(x, y), pagePaved = page.pavedHeightAt(x, y);
          if (there === undefined || !Object.is(there, pagePaved)) wrong.push(`paving at ${x}, ${y}: ${there} vs ${pagePaved}`);
          points++;
          if (Number.isFinite(pagePaved)) paved++;
        }
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(points).toBeGreaterThan(5 * (HEIGHT_TILE / 1.37) * (HEIGHT_TILE / 2.13) * 0.99);
    expect(paved).toBeGreaterThan(2_000);
  });

  it('says nothing past its square', () => {
    const page = plateGround(streets());
    const rect = heightTileRect(heightTileKey(0, 0));
    const tile = page.heightTile(rect).tile;
    const reads = heightTileReads({ terrain: tile.terrain, paving: null });
    expect(tile.terrain?.plate).toBe(plateOf(0, 0));
    expect(tile.terrain?.base).toBe(TERRAIN_BASE);
    expect(reads.ground(rect[0] - m(20), rect[1])).toBeUndefined();
    expect(reads.ground(rect[2] + m(20), rect[3] + m(20))).toBeUndefined();
    expect(reads.paved(rect[0], rect[1])).toBeUndefined();
  });
});
