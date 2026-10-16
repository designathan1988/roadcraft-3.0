import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, lotCentre, planLots, zoneLots } from '@world/lots';
import { LotTool, type ZoneMode } from '@editor/lotTool';
import type { LotOverlay } from '@editor/lotParts';

/** THE LOTS OVERLAY IS DRAWN BY WHAT CHANGED: THE LOTS THE DIARY NAMES AND THOSE THE GESTURE MARKS (`editor/lotTool.ts`). */
function town(mode: ZoneMode = 'brush'): { doc: RoadDoc; tool: LotTool; fresh: () => LotTool } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(120), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  const make = (): LotTool => new LotTool({
    doc, net, zoom: () => 1,
    settings: () => ({ mode, use: 'residential', density: 'low', eraser: false, splitKind: 'vertical', splitParts: 2 }),
    mutate: (fn) => { fn(); }, hint: () => {}, redraw: () => {},
  });
  return { doc, tool: make(), fresh: make };
}

/** What the parts draw, written out to compare two overlays (a test, not a hot path). */
const drawn = (overlay: LotOverlay): string => JSON.stringify([...overlay.parts].sort(([a], [b]) => (a < b ? -1 : 1)));

describe('the lots overlay with the other tools', () => {
  it('draws the zoned lots, and again only the lots zoned since', () => {
    const { doc, tool } = town();
    expect(tool.anyZoned()).toBe(false);
    const ids = [...doc.lotStore.all()].map((l) => l.id);
    expect(ids.length).toBeGreaterThan(3);
    zoneLots(doc, [ids[0]!, ids[1]!], { use: 'residential', density: 'low' });
    expect(tool.anyZoned()).toBe(true);
    const first = tool.overlayFor(false);
    expect([...first.parts.keys()].sort()).toEqual([`l${ids[0]}`, `l${ids[1]}`].sort());
    // Frames go by: nothing changed, nothing to draw again.
    const serial = first.serial;
    expect(tool.overlayFor(false).changedSince(serial)).toEqual([]);

    zoneLots(doc, [ids[2]!], { use: 'commercial', density: 'low' });
    const next = tool.overlayFor(false);
    expect(next.changedSince(serial)).toEqual([`l${ids[2]}`]);
    expect(next.parts.size).toBe(3);
  });
});

describe('the lots overlay in the Zoning tool', () => {
  it('draws again the lots the pointer leaves and enters, not every lot', () => {
    const { doc, tool, fresh } = town();
    // The proposal of the street land is worked out first.
    while (tool.advanceProposal(50)) { /* until ready */ }
    const first = tool.overlayFor(true);
    const lots = [...doc.lotStore.all()];
    expect(first.parts.size).toBeGreaterThanOrEqual(lots.length);
    let serial = first.serial;
    tool.hover = lotCentre(lots[0]!);
    expect(tool.overlayFor(true).changedSince(serial)).toEqual([`l${lots[0]!.id}`]);
    serial = first.serial;
    tool.hover = lotCentre(lots[1]!);
    expect([...tool.overlayFor(true).changedSince(serial)!].sort()).toEqual([`l${lots[0]!.id}`, `l${lots[1]!.id}`].sort());
    serial = first.serial;
    // A lot zoned under the pointer: that lot.
    zoneLots(doc, [lots[1]!.id], { use: 'residential', density: 'low' });
    expect(tool.overlayFor(true).changedSince(serial)).toEqual([`l${lots[1]!.id}`]);

    // Drawn by parts, it is what a tool drawing all of it now draws.
    const whole = fresh();
    while (whole.advanceProposal(50)) { /* until ready */ }
    whole.hover = tool.hover;
    expect(drawn(tool.overlayFor(true))).toBe(drawn(whole.overlayFor(true)));
  });

  it('marks a brush stroke\'s lots as it passes them, and lays them down when let go', () => {
    const { doc, tool, fresh } = town();
    while (tool.advanceProposal(50)) { /* until ready */ }
    const lots = [...doc.lotStore.all()];
    tool.overlayFor(true);
    tool.down(1, lotCentre(lots[0]!), false, 1);
    const serial = tool.overlayFor(true).serial;
    tool.move(1, lotCentre(lots[2]!));
    const changed = tool.overlayFor(true).changedSince(serial)!;
    expect(changed.length).toBeLessThan(lots.length);
    expect(changed).toContain(`l${lots[2]!.id}`);
    tool.up(1, true);
    const whole = fresh();
    while (whole.advanceProposal(50)) { /* until ready */ }
    expect(drawn(tool.overlayFor(true))).toBe(drawn(whole.overlayFor(true)));
  });

  it('draws the street land proposed as lots, and again only those the pointer or the brush reach', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-120), y: 0 }).id, b = doc.addNode({ x: m(120), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    const make = (): LotTool => new LotTool({
      doc, net, zoom: () => 1,
      settings: () => ({ mode: 'brush', use: 'commercial', density: 'low', eraser: false, splitKind: 'vertical', splitParts: 2 }),
      mutate: (fn) => { fn(); }, hint: () => {}, redraw: () => {},
    });
    const tool = make();
    while (tool.advanceProposal(50)) { /* until ready */ }
    const first = tool.overlayFor(true);
    const proposed = [...first.parts.keys()].filter((id) => id.startsWith('p'));
    expect(proposed.length).toBeGreaterThan(3);
    const corners = (id: string): { x: number; y: number }[] => first.parts.get(id)!.polygons[0]!.corners as { x: number; y: number }[];
    const middle = (id: string): { x: number; y: number } => lotCentre({ corners: corners(id) });
    let serial = first.serial;
    tool.hover = middle(proposed[1]!);
    expect(tool.overlayFor(true).changedSince(serial)).toEqual([proposed[1]]);
    serial = first.serial;
    tool.down(1, middle(proposed[1]!), false, 1);
    tool.move(1, middle(proposed[2]!));
    tool.hover = middle(proposed[2]!);
    const changed = tool.overlayFor(true).changedSince(serial)!;
    expect([...changed].sort()).toEqual([proposed[1]!, proposed[2]!].sort());
    // Drawn by parts, it is what a tool drawing all of it now draws: the stroke's lots filled.
    expect(first.parts.get(proposed[1]!)!.polygons[0]!.fillAlpha).toBe(0.6);
    tool.up(1, false);
    const whole = make();
    while (whole.advanceProposal(50)) { /* until ready */ }
    whole.hover = tool.hover;
    expect(drawn(tool.overlayFor(true))).toBe(drawn(whole.overlayFor(true)));
  });
});

