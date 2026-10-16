import type { Vec2 } from '@core/vec2';

/** THE LOTS OVERLAY IN PARTS (`lotTool.ts` overlayFor): what the scene draws of the lots, by id, and which parts changed when */

/** One part of what the scene draws of the lots (a lot, a proposed lot, the gesture): the shape of `render/lotOverlay.ts` `LotPart`. */
export interface LotPart {
  /** `built`: a lot with a building, whose yard's paving is coloured too; `order`: the shape's place in the drawing, later over earlier. */
  readonly polygons: readonly { corners: readonly Vec2[]; fill: number | null; fillAlpha: number; line: number; lineAlpha: number; width: number; built?: boolean; order: number }[];
  readonly lines: readonly { a: Vec2; b: Vec2; colour: number; dashed: boolean; width: number; order: number }[];
  readonly points: readonly { p: Vec2; colour: number; radius: number; order: number }[];
}

/** What the scene draws of the lots (the shape of `render/lotOverlay.ts` `LotOverlayInput`), and the labels of the 2D layer. */
export interface LotOverlay {
  readonly parts: ReadonlyMap<string, LotPart>;
  readonly serial: number;
  changedSince(serial: number): readonly string[] | null;
  /** Labels for the 2D layer: a lot's size, a side's length. */
  readonly labels: { at: Vec2; kind: 'size'; width: number; depth: number }[] | { at: Vec2; kind: 'length'; length: number }[];
}

/** The parts drawn by id, each replaced only when what it draws changed, and a log of the changes for the scene (`LotOverlay`). */
export class PartLog implements LotOverlay {
  readonly parts = new Map<string, LotPart>();
  serial = 0;
  labels: LotOverlay['labels'] = [];
  /** The ids changed, oldest first, and the serial of each change; changes at or before `floor` are forgotten. */
  private ids: string[] = [];
  private serials: number[] = [];
  private floor = 0;

  /** A part put (null: taken away). */
  put(id: string, part: LotPart | null): void {
    if (part) this.parts.set(id, part);
    else if (!this.parts.delete(id)) return;
    this.ids.push(id);
    this.serials.push(++this.serial);
    // The log forgotten once it outgrows the parts twice over: a reader behind it reads every part, once.
    if (this.ids.length > 2 * this.parts.size + 256) { this.ids = []; this.serials = []; this.floor = this.serial; }
  }

  changedSince(serial: number): readonly string[] | null {
    if (serial < this.floor) return null;
    let lo = 0, hi = this.serials.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.serials[mid]! <= serial) lo = mid + 1; else hi = mid; }
    return lo === this.ids.length ? [] : [...new Set(this.ids.slice(lo))];
  }
}

/** Where each band of shapes is drawn (`LotPart` order): the lots' fills and outlines (their own order), the proposed lots', the lot being drawn, the lots' fronts, the gesture's lines, the lots' corners, the gesture's points. */
export const ORDER_PROPOSED = 1e9, ORDER_DRAWN = 2e9, ORDER_LOT_LINES = 3e9, ORDER_LINES = 5e9, ORDER_LOT_POINTS = 6e9, ORDER_POINTS = 8e9;
