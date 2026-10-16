import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, lotCentre, moveLotCorner, planLots, zoneLots } from '@world/lots';
import { LotTool, type ZoneMode } from '@editor/lotTool';

/** THE ZONING TOOL ASKS THE LOTS BY PLACE AND KEYS ITS PROPOSAL ON WHAT CHANGED (`editor/lotTool.ts`). */
function town(mode: ZoneMode): { doc: RoadDoc; net: Network; tool: LotTool } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(120), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  const tool = new LotTool({
    doc, net, zoom: () => 1,
    settings: () => ({ mode, use: 'residential', density: 'low', eraser: false, splitKind: 'vertical', splitParts: 2 }),
    mutate: (fn) => { fn(); }, hint: () => {}, redraw: () => {},
  });
  return { doc, net, tool };
}

/** The document's whole list of lots made unreadable: what the tool asks must come by place. */
function noWholeList(doc: RoadDoc): void {
  Object.defineProperty(doc, 'lots', { get() { throw new Error('the whole list of lots was read'); } });
}

describe('the Zoning tool by place', () => {
  it('zones the lots a brush stroke passes without reading every lot', () => {
    const { doc, tool } = town('brush');
    const lots = [...doc.lotStore.all()].slice(0, 2);
    expect(lots.length).toBe(2);
    const [p, q] = lots.map(lotCentre) as [{ x: number; y: number }, { x: number; y: number }];
    noWholeList(doc);
    tool.down(1, p, false, 1);
    tool.move(1, q);
    tool.up(1, true);
    for (const lot of lots) expect(doc.lot(lot.id)!.use).toBe('residential');
    expect(tool.anyZoned()).toBe(true);
  });

  it('picks a lot\'s front by the sides near the pointer', () => {
    const { doc, tool } = town('front');
    const lot = [...doc.lotStore.all()][0]!;
    const a = lot.corners[2]!, b = lot.corners[3]!;
    noWholeList(doc);
    tool.down(1, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, false, 1);
    const now = doc.lot(lot.id)!;
    // The side clicked is the lot's front now: its first two corners.
    expect([now.corners[0], now.corners[1]].map((c) => `${c!.x},${c!.y}`).sort()).toEqual([a, b].map((c) => `${c.x},${c.y}`).sort());
  });

  it('knows whether any lot is zoned from the lots the diary names', () => {
    const { doc, tool } = town('brush');
    expect(tool.anyZoned()).toBe(false);
    const id = [...doc.lotStore.all()][0]!.id;
    zoneLots(doc, [id], { use: 'commercial', density: 'low' });
    expect(tool.anyZoned()).toBe(true);
    zoneLots(doc, [id], null);
    expect(tool.anyZoned()).toBe(false);
  });

  it('works the proposal out again when a lot\'s corner moves, the count of lots unchanged', () => {
    const { doc, tool } = town('brush');
    tool.advanceProposal(Infinity);
    expect(tool.proposalReady()).toBeGreaterThanOrEqual(0);
    const lot = [...doc.lotStore.all()][0]!;
    const from = lot.corners[2]!;
    expect(moveLotCorner(doc, from, { x: from.x + m(1), y: from.y + m(1) })).toBe(true);
    expect(tool.proposalReady()).toBe(-1);
  });
});
