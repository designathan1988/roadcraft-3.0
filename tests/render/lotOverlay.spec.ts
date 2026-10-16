import { describe, expect, it } from 'vitest';
import { createLotOverlay, type LotOverlayInput, type LotPart } from '@render/lotOverlay';
import { ChangeJournal } from '@world/changes';
import { sampleLattice } from './support/latticeSampler';

/** THE LOTS COLOURED INTO THE GROUND (`render/lotOverlay.ts`). */

/** The parts a lot tool hands the scene, and the log of which changed (`editor/lotTool.ts` PartLog, as the scene reads it). */
class Parts implements LotOverlayInput {
  readonly parts = new Map<string, LotPart>();
  serial = 0;
  private readonly log: { id: string; serial: number }[] = [];
  put(id: string, part: LotPart | null): void {
    if (part) this.parts.set(id, part); else this.parts.delete(id);
    this.log.push({ id, serial: ++this.serial });
  }
  changedSince(serial: number): readonly string[] { return [...new Set(this.log.filter((e) => e.serial > serial).map((e) => e.id))]; }
}

/** Lot `i` of a grid of lots: its outline and fill, and its front. */
function lot(i: number, zoned = false, hovered = false, built = false): LotPart {
  const x = (i % 20) * 24, y = Math.floor(i / 20) * 32;
  const corners = [{ x, y }, { x: x + 22, y }, { x: x + 22, y: y + 30 }, { x, y: y + 30 }];
  return {
    polygons: [{ corners, fill: zoned ? 0x56bb73 : null, fillAlpha: zoned ? 0.45 : 0, line: hovered ? 0xffd25e : 0xffffff, lineAlpha: 0.85, width: hovered ? 0.7 : 0.35, order: i, ...(built ? { built: true } : {}) }],
    lines: [{ a: corners[0]!, b: corners[1]!, colour: 0x5ee0ff, dashed: false, width: 0.8, order: 1e9 + i }],
    points: [],
  };
}
function lots(n: number, zonedAt = -1, builtAt = -1): Parts {
  const parts = new Parts();
  for (let i = 0; i < n; i++) parts.put(`l${i}`, lot(i, i === zonedAt, false, i === builtAt));
  return parts;
}

describe('lot overlay', () => {
  it('draws every lot at once, from the first call', () => {
    const overlay = createLotOverlay();
    overlay.set(lots(400, 7));
    // 400 outlines, 400 front lines.
    expect(overlay.lattice.size).toBe(800);
    // The zoned lot is filled at its middle; a lot next to it is not.
    const zoned = sampleLattice(overlay.lattice, 7 * 24 + 11, 15);
    expect(zoned?.records.some((r) => r.fill && r.inside)).toBe(true);
    const plain = sampleLattice(overlay.lattice, 8 * 24 + 11, 15);
    expect(plain?.records.some((r) => r.fill && r.inside) ?? false).toBe(false);
    overlay.dispose();
  });

  it('draws again only the parts that changed, and their cells', () => {
    const overlay = createLotOverlay();
    const parts = lots(400);
    overlay.set(parts);
    const all = overlay.lattice.cellsWritten;
    overlay.lattice.cellsWritten = 0;
    // One lot zoned, then the pointer over another: their cells only.
    parts.put('l37', lot(37, true));
    overlay.set(parts);
    parts.put('l120', lot(120, false, true));
    overlay.set(parts);
    expect(overlay.lattice.cellsWritten).toBeGreaterThan(0);
    expect(overlay.lattice.cellsWritten).toBeLessThan(all / 20);
    expect(sampleLattice(overlay.lattice, 37 % 20 * 24 + 11, Math.floor(37 / 20) * 32 + 15)?.records.some((r) => r.fill && r.inside)).toBe(true);
    overlay.lattice.cellsWritten = 0;
    // Nothing changed: nothing written.
    overlay.set(parts);
    expect(overlay.lattice.cellsWritten).toBe(0);
    overlay.dispose();
  });

  it('keeps a built lot\'s ground level, read again only where the ground moved', () => {
    let ground = 2;
    let asked = 0;
    const overlay = createLotOverlay(() => { asked++; return ground; });
    const changes = new ChangeJournal();
    const parts = lots(40, 5, 5);
    overlay.set(parts, changes);
    // The built lot and the 40 front lines ask the ground, once each; of the lots, only the built one carries a level.
    expect(asked).toBe(41);
    // Frames go by, nothing changed: nothing asked again.
    asked = 0;
    overlay.set(parts, changes);
    expect(asked).toBe(0);
    const yard = sampleLattice(overlay.lattice, 5 * 24 + 11, 15);
    expect(yard?.records.some((r) => r.level === 2)).toBe(true);
    // On the edge of a lot with no building: its outline, with no level.
    const plain = sampleLattice(overlay.lattice, 8 * 24 + 0.1, 15);
    expect(plain?.records.length).toBeGreaterThan(0);
    expect(plain?.records.filter((r) => r.distance < 1).every((r) => r.level === null)).toBe(true);
    // A building elsewhere moves no ground: nothing read again.
    asked = 0;
    changes.record('buildings', [[0, 0, 10, 10]]);
    overlay.set(parts, changes);
    expect(asked).toBe(0);
    // The ground levelled: the level read again, and redrawn.
    ground = 3.5;
    changes.record('ground', [[100, 0, 160, 40]]);
    overlay.set(parts, changes);
    // Only what lies where it moved: the built lot and the front lines near it, not the 40.
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(8);
    expect(sampleLattice(overlay.lattice, 5 * 24 + 11, 15)?.records.some((r) => r.level === 3.5)).toBe(true);
    overlay.dispose();
  });

  it('takes away what is no longer drawn', () => {
    const overlay = createLotOverlay();
    const parts = lots(100, 3);
    overlay.set(parts);
    for (let i = 50; i < 100; i++) parts.put(`l${i}`, null);
    overlay.set(parts);
    expect(overlay.lattice.size).toBe(100);
    expect(sampleLattice(overlay.lattice, 10 * 24 + 11, 3 * 32 + 15)).toBeNull();
    // Another input (the tool put down and taken up): read whole, what it does not hold taken away.
    const other = lots(10, 3);
    overlay.set(other);
    expect(overlay.lattice.size).toBe(20);
    overlay.set(null);
    expect(overlay.lattice.size).toBe(0);
    overlay.dispose();
  });
});
