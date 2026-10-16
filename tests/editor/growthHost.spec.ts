import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GrowthHost, type GrowthDone } from '@/growthHost';
import type { ToGrowth } from '@/growthProtocol';
import { GrowthRun } from '@/growthRun';
import { layCity, widenCityFootways, zoneCity } from '@editor/cityGenerator';
import { LOT_PLAN_VERSION, growOnLot } from '@editor/zoning';
import type { BuildingId } from '@world/buildings/types';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import type { RoadDoc } from '@world/doc';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { Network } from '@world/network';
import { plateGround } from '../support/plateGround';

/** THE CITY'S GROWTH IN ITS WORKER (`growthHost.ts`, `growthRun.ts`): the page's buildings, byte for byte */

/** The worker in this thread: its own `GrowthRun`, every message cloned as a message is and handed on when `drain` says. */
class FakeWorker {
  static queue: (() => void)[] = [];
  static made = 0;
  /** The heights asked of the page: squares, points, rounds. */
  static asked = { tiles: 0, points: 0, rounds: 0 };
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private readonly run = new GrowthRun();
  constructor() { FakeWorker.made++; }
  postMessage(message: ToGrowth): void {
    const m = structuredClone(message);
    FakeWorker.queue.push(() => {
      const reply = m.kind === 'grow' ? this.run.start(m) : this.run.heights(m);
      if (!reply) return;
      if (reply.kind === 'need') {
        FakeWorker.asked.tiles += reply.tiles.length;
        FakeWorker.asked.points += reply.points.length / 3;
        FakeWorker.asked.rounds++;
      }
      const back = structuredClone(reply);
      FakeWorker.queue.push(() => this.onmessage?.({ data: back }));
    });
  }
  terminate(): void {}
}
const drain = (): void => { while (FakeWorker.queue.length) FakeWorker.queue.shift()!(); };

/** A small generated city, its lots cut and zoned, nothing grown. */
function city(): { doc: RoadDoc; net: Network } {
  const plan = planCity({ ...DEFAULT_CITY, size: 'small' });
  const doc = layCity(plan);
  widenCityFootways(doc);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  zoneCity(doc, net, plan);
  return { doc, net };
}

const STAMP = { builtAt: 42, decay: 0, lotPlan: LOT_PLAN_VERSION };
/** Lots worked on (grown or set aside) in each run. */
const STEPS = 60;

/** The page's own way, as it grew before the worker: `growOnLot`, then the stamp put. */
function grownOnPage(doc: RoadDoc, net: Network, steps: number): Set<number> {
  const ground = plateGround(net);
  const refused = new Set<number>();
  for (let k = 0; k < steps; k++) {
    const id = growOnLot({ doc, net, groundAt: ground.terrainHeightAt, pavedAt: ground.pavedHeightAt }, refused, 0x5eed);
    const fresh = id === null ? undefined : doc.buildings.get(id as BuildingId);
    if (fresh) doc.buildings.put({ ...fresh, ...STAMP });
  }
  return refused;
}

/** The same lots worked on through the host and its worker, batch after batch; `between`: done while the first batch is out. */
function grownInWorker(doc: RoadDoc, net: Network, steps: number, between?: () => void): { refused: Set<number>; batches: GrowthDone[] } {
  const host = new GrowthHost(doc, net, plateGround(net), (_cause, fn) => fn());
  const refused = new Set<number>();
  const batches: GrowthDone[] = [];
  let left = steps;
  while (left > 0) {
    expect(host.grow({ cause: 'city generated', refused, stamp: STAMP, seed: 0x5eed, most: left }, (done) => {
      batches.push(done);
      left -= done.grown + done.refused;
    })).toBe(true);
    if (between && batches.length === 0) { between(); between = undefined; }
    drain();
  }
  return { refused, batches };
}

const text = (doc: RoadDoc, refused: Set<number>): string =>
  JSON.stringify({ buildings: [...doc.buildings.all()], lots: [...doc.lotStore.all()], refused: [...refused], next: doc.buildings.nextId });

describe('the city grown in its worker', () => {
  beforeEach(() => {
    FakeWorker.queue = [];
    FakeWorker.made = 0;
    FakeWorker.asked = { tiles: 0, points: 0, rounds: 0 };
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('grows the page\'s buildings, byte for byte, the heights read off the squares handed over', () => {
    const page = city();
    const pageRefused = grownOnPage(page.doc, page.net, STEPS);
    const off = city();
    const { refused, batches } = grownInWorker(off.doc, off.net, STEPS);
    expect(FakeWorker.made).toBe(1);
    // The heights came in squares (a few for the whole run), next to no point asked of the page.
    expect(FakeWorker.asked.tiles).toBeGreaterThan(0);
    expect(FakeWorker.asked.rounds).toBeLessThan(STEPS / 3);
    expect(FakeWorker.asked.points).toBeLessThan(STEPS);
    expect(page.doc.buildings.size).toBeGreaterThan(STEPS / 2);
    expect(batches.reduce((n, b) => n + b.grown, 0)).toBe(off.doc.buildings.size);
    expect(text(off.doc, refused)).toBe(text(page.doc, pageRefused));
    console.log(`GROWTH ${STEPS} lots in ${batches.length} batches: ${FakeWorker.asked.rounds} rounds of heights, ${FakeWorker.asked.tiles} squares, ${FakeWorker.asked.points} points`);
  });

  it('leaves a batch grown while the document moved, and grows again on the document as it is', () => {
    // On the page: a lot unzoned first, then the growth.
    const page = city();
    const lot = page.doc.lots[3]!.id;
    zoneLots(page.doc, [lot], null);
    const pageRefused = grownOnPage(page.doc, page.net, STEPS);
    // In the worker: the lot unzoned while the first batch is out; that batch is not taken.
    const off = city();
    const { refused, batches } = grownInWorker(off.doc, off.net, STEPS, () => zoneLots(off.doc, [lot], null));
    expect(batches[0]).toEqual({ grown: 0, refused: 0, done: false });
    expect(text(off.doc, refused)).toBe(text(page.doc, pageRefused));
  });

  it('grows on the page when its worker cannot start', () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('no workers here'); } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const page = city();
    const pageRefused = grownOnPage(page.doc, page.net, 12);
    const here = city();
    // Told at once, each batch on the page.
    const { refused, batches } = grownInWorker(here.doc, here.net, 12);
    expect(batches.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    expect(text(here.doc, refused)).toBe(text(page.doc, pageRefused));
  });
});
