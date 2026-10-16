import type { BufferAttribute } from 'three';

/** Most update ranges one attribute keeps waiting for a draw; past it the whole array goes (a plate nobody draws is edited again and again). */
const MAX_RANGES = 128;

/** The whole attribute marked changed AS A RANGE: a box marked after it, before the draw, would otherwise send only its rows (three.js sends ranges only, when there are any). */
export function markAll(attribute: BufferAttribute): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, attribute.array.length);
  attribute.needsUpdate = true;
}

/** DO NOT set `needsUpdate` alone for a corner edit: a 301 x 301 plate is resent whole. */
export function markBox(attribute: BufferAttribute, itemSize: number, rowLength: number, x0: number, x1: number, y0: number, y1: number): void {
  attribute.needsUpdate = true;
  const rows = y1 - y0 + 1;
  const width = x1 - x0 + 1;
  if (attribute.updateRanges.length + rows > MAX_RANGES || width * 2 > rowLength) {
    if (attribute.updateRanges.length >= MAX_RANGES) { attribute.clearUpdateRanges(); attribute.addUpdateRange(0, attribute.array.length); return; }
    attribute.addUpdateRange((y0 * rowLength + x0) * itemSize, ((y1 - y0) * rowLength + width) * itemSize);
    return;
  }
  for (let y = y0; y <= y1; y++) attribute.addUpdateRange((y * rowLength + x0) * itemSize, width * itemSize);
}
