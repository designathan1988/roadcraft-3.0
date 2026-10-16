import {
  type Frustum,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  type InstancedMesh,
  InterleavedBufferAttribute,
  type Matrix4,
  Mesh,
  Sphere,
  Vector3,
} from 'three';

import type { Change, ChangeRect } from '@world/changes';
import type { RoadDoc } from '@world/doc';
import type { PoleId, SpanId } from '@world/ids';
import type { Network } from '@world/network';
import { PoleIndex } from '@world/poleIndex';
import { kerbward } from '@world/poleLines';
import { m } from '@world/units';
import { POLE_HEIGHT, type PoleArms, poleArmsAt, type UtilityPole, type UtilitySpan } from '@world/utilities';
import { type InstanceRuns, type PixelCut, type Run, RunBuilder, type RunStore, createInstanceRuns, warmMeshes } from './instanceRuns';
import { SHADOW_REACH, type SceneryKit } from './scenery';
import {
  POLE_PART_COUNT,
  type Placement,
  SPAN_WIRES,
  type Utilities,
  WIRE_HALF_WIDTH,
  WIRE_STRIDE,
  placePole,
  polePartSpecs,
  spanWires,
  wireParts,
  wireTemplate,
  writePlacement,
} from './utilities';

/** DO NOT build the whole layer again for a change; DO NOT pace or hold it. */

/** What a pole layer is built from: the document's poles and spans, or a planned run (`buildPolePreview`). */
export interface PoleSource {
  readonly poles: ReadonlyMap<PoleId, UtilityPole>;
  readonly spans: ReadonlyMap<SpanId, UtilitySpan>;
  /** The spans reaching a pole, in the order they were strung (`RoadDoc.spansAt`). */
  spansAt(id: PoleId): Iterable<UtilitySpan>;
  /** Which poles get a mast, arms and lamp here; a pole a preview only ties into is standing already. */
  readonly draws?: (pole: UtilityPole) => boolean;
}

/** The document's poles as a layer's source. */
export const docPoles = (doc: RoadDoc): PoleSource => ({ poles: doc.poles, spans: doc.poleSpans, spansAt: (id) => doc.spansAt(id) });

/** How far from a pole a change of the roads or the ground can move it: its kerb (`kerbward`), its lamp's pool. */
const POLE_REACH = m(12);

interface PoleState {
  readonly x: number;
  readonly y: number;
  readonly top: number;
  readonly kerb: { x: number; y: number } | null;
  readonly frame: PoleArms;
  /** Its parts as instances (`instanceRuns.ts`): taken away by the same object; null for a pole only tied into. */
  readonly run: Run | null;
}

/** The parts' stores as the instance layer keeps them: one mesh a part, culled and cut by size on the screen. */
const partStores = (kit: SceneryKit): RunStore[] => polePartSpecs(kit).map((spec) => ({
  name: spec.name, geometry: spec.geometry, material: spec.material, castShadow: spec.castShadow, receiveShadow: spec.receiveShadow,
  renderOrder: spec.renderOrder, tinted: false, cards: false, seen: spec.seen,
}));
/** Under half a pixel across, a part is not drawn (the poles' far level). */
const SEEN_PIXELS = 0.5;

/** Every span's wires: one tube template, `SPAN_WIRES` instances a span in a block of their own. */
class WireStore {
  private mesh: Mesh | null = null;
  private data = new Float32Array(0);
  private buffer: InstancedInterleavedBuffer | null = null;
  private capacity = 0;
  count = 0;
  private readonly owner: SpanId[] = [];
  private readonly written: number[] = [];
  private whole = false;
  private readonly box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  private sag = 0;
  private boundsMoved = false;
  private static readonly BLOCK = SPAN_WIRES * WIRE_STRIDE;

  constructor(private readonly group: Group) {}

  private reserve(needed: number): void {
    if (needed <= this.capacity) return;
    const capacity = Math.max(needed, this.capacity * 2, 16);
    const data = new Float32Array(capacity * WireStore.BLOCK);
    data.set(this.data.subarray(0, this.count * WireStore.BLOCK));
    // One draw for every wire: the tube's template, and each wire's eight numbers as instances
    const geometry: InstancedBufferGeometry = wireTemplate();
    const buffer = new InstancedInterleavedBuffer(data, WIRE_STRIDE, 1);
    geometry.setAttribute('aStart', new InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('aEnd', new InterleavedBufferAttribute(buffer, 3, 3));
    geometry.setAttribute('aSagPhase', new InterleavedBufferAttribute(buffer, 2, 6));
    const { material, depth } = wireParts();
    const mesh = new Mesh(geometry, material);
    // The shadow drawn from the same bent tube (three draws a caster's shadow with its depth material).
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.name = 'utility-wires';
    if (this.mesh) {
      geometry.boundingSphere = (this.mesh.geometry as InstancedBufferGeometry).boundingSphere;
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.group.add(mesh);
    this.mesh = mesh;
    this.data = data;
    this.buffer = buffer;
    this.capacity = capacity;
    this.whole = true;
  }

  /** A span's wires strung: its block. */
  add(span: UtilitySpan, a: Parameters<typeof spanWires>[1], b: Parameters<typeof spanWires>[2]): number {
    this.reserve(this.count + 1);
    const block = this.count++;
    this.owner[block] = span.id;
    const at = block * WireStore.BLOCK;
    spanWires(span, a, b, this.data, at);
    if (!this.whole) this.written.push(block);
    const d = this.data, x = this.box;
    for (let i = at; i < at + WireStore.BLOCK; i += WIRE_STRIDE) {
      for (const k of [i, i + 3]) {
        if (d[k]! < x[0]! || d[k + 1]! < x[1]! || d[k + 2]! < x[2]! || d[k]! > x[3]! || d[k + 1]! > x[4]! || d[k + 2]! > x[5]!) {
          x[0] = Math.min(x[0]!, d[k]!); x[1] = Math.min(x[1]!, d[k + 1]!); x[2] = Math.min(x[2]!, d[k + 2]!);
          x[3] = Math.max(x[3]!, d[k]!); x[4] = Math.max(x[4]!, d[k + 1]!); x[5] = Math.max(x[5]!, d[k + 2]!);
          this.boundsMoved = true;
        }
      }
      if (d[i + 6]! > this.sag) { this.sag = d[i + 6]!; this.boundsMoved = true; }
    }
    return block;
  }

  /** A block let go: the last span's wires move into it. Returns the span whose block `count` became `block`. */
  remove(block: number): SpanId | null {
    const last = --this.count;
    if (block === last) return null;
    this.data.copyWithin(block * WireStore.BLOCK, last * WireStore.BLOCK, (last + 1) * WireStore.BLOCK);
    const moved = this.owner[last]!;
    this.owner[block] = moved;
    if (!this.whole) this.written.push(block);
    return moved;
  }

  /** The wires drawn, the blocks written sent; bounds from the wires' ends, their sag and the tube's radius (three would read the template's). */
  flush(): void {
    const mesh = this.mesh, buffer = this.buffer;
    if (!mesh || !buffer) return;
    const geometry = mesh.geometry as InstancedBufferGeometry;
    geometry.instanceCount = this.count * SPAN_WIRES;
    mesh.visible = this.count > 0;
    if (this.whole || this.written.length * 2 > this.count) {
      buffer.clearUpdateRanges();
      buffer.needsUpdate = true;
    } else if (this.written.length) {
      for (const block of this.written) if (block < this.count) buffer.addUpdateRange(block * WireStore.BLOCK, WireStore.BLOCK);
      buffer.needsUpdate = true;
    }
    this.written.length = 0;
    this.whole = false;
    if (this.boundsMoved && this.count > 0) {
      const x = this.box;
      geometry.boundingSphere = new Sphere(new Vector3((x[0]! + x[3]!) / 2, (x[1]! + x[4]!) / 2, (x[2]! + x[5]!) / 2),
        Math.hypot(x[3]! - x[0]!, x[4]! - x[1]!, x[5]! - x[2]!) / 2 + this.sag + WIRE_HALF_WIDTH);
      this.boundsMoved = false;
    }
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
  }
}

export class PoleLayer implements Utilities {
  readonly group = new Group();
  private readonly stores: readonly RunStore[];
  private readonly parts: InstanceRuns;
  /** The poles' runs placed and taken away since the last flush. */
  private readonly coming = new Set<Run>();
  private readonly going: Run[] = [];
  private readonly matrix = new Float32Array(16);
  private readonly wires: WireStore;
  private readonly poles = new Map<PoleId, PoleState>();
  /** Each span strung here, with its block. */
  private readonly spans = new Map<SpanId, { readonly span: UtilitySpan; block: number }>();
  /** The poles drawn here by place, and the spans strung to each: what an edit takes away is found here. */
  private readonly index = new PoleIndex();
  private readonly scratch: Placement[][] = Array.from({ length: POLE_PART_COUNT }, () => []);

  /** `width`: the view's width in pixels, for the cut by size (none: every part in view is drawn). */
  constructor(kit: SceneryKit, name = 'utilities', width?: () => number) {
    this.group.name = name;
    this.stores = partStores(kit);
    const cut: PixelCut | null = width ? { least: SEEN_PIXELS, width } : null;
    this.parts = createInstanceRuns(`${name}-parts`, this.stores, SHADOW_REACH, cut);
    this.group.add(this.parts.group);
    this.wires = new WireStore(this.group);
  }

  get triangles(): number {
    return this.parts.triangles;
  }

  cull(frustum: Frustum, view: Matrix4): void {
    this.parts.cull(frustum, view);
  }

  /** One mesh of each part, one instance each: what compiles the parts' programs ahead (`compileAhead`). */
  warm(): InstancedMesh[] {
    return warmMeshes(this.stores);
  }

  /** The poles this layer holds inside a rectangle, where it drew them. */
  polesIn(rect: ChangeRect): PoleId[] {
    return this.index.near(rect).filter((id) => {
      const pole = this.poles.get(id)!;
      return pole.x >= rect[0] && pole.x <= rect[2] && pole.y >= rect[1] && pole.y <= rect[3];
    });
  }

  /** Every pole this layer holds. */
  ids(): IterableIterator<PoleId> {
    return this.poles.keys();
  }

  /** Every pole and span of the source, on an empty layer, in the source's order: the layer a full build makes */
  fill(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource): void {
    for (const pole of source.poles.values()) this.place(net, groundAt, source, pole, undefined);
    for (const span of source.spans.values()) this.string(span);
    this.flush();
  }

  /** These poles placed again as the source has them */
  redo(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource, seeds: Iterable<PoleId>): void {
    const fresh = new Set(seeds);
    const dirty = new Set(fresh);
    for (const id of fresh) {
      for (const sid of this.index.spansAt(id)) { const s = this.spans.get(sid)!.span; dirty.add(s.a === id ? s.b : s.a); }
      if (source.poles.has(id)) for (const s of source.spansAt(id)) dirty.add(s.a === id ? s.b : s.a);
    }
    if (dirty.size === 0) return;
    // The spans reaching them, as strung here and as the source has them.
    const strung = new Set<SpanId>();
    const wanted = new Map<SpanId, UtilitySpan>();
    for (const id of dirty) {
      for (const sid of this.index.spansAt(id)) strung.add(sid);
      if (source.poles.has(id)) for (const s of source.spansAt(id)) wanted.set(s.id, s);
    }
    for (const sid of strung) this.unstring(sid);
    for (const id of dirty) {
      const was = this.poles.get(id);
      if (was) this.unplace(id, was);
      const pole = source.poles.get(id);
      if (pole) this.place(net, groundAt, source, pole, fresh.has(id) || !was || was.x !== pole.x || was.y !== pole.y ? undefined : was.kerb);
    }
    for (const span of wanted.values()) this.string(span);
    this.flush();
  }

  /** The diary's changes since the layer was last brought up (none with a null rectangle: that is a whole build) */
  follow(net: Network, groundAt: (x: number, y: number) => number, doc: RoadDoc, entries: readonly Change[]): void {
    const seeds = new Set<PoleId>();
    for (const entry of entries) {
      const pad = entry.kind === 'utilities' ? 0 : POLE_REACH;
      for (const r of entry.rects ?? []) {
        const rect: ChangeRect = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
        for (const pole of doc.polesIn(rect)) {
          if (pole.x >= rect[0] && pole.x <= rect[2] && pole.y >= rect[1] && pole.y <= rect[3]) seeds.add(pole.id);
        }
        for (const id of this.polesIn(rect)) seeds.add(id);
      }
    }
    this.redo(net, groundAt, docPoles(doc), seeds);
  }

  /** A pole framed and its parts placed; its way to the kerb kept from before, or undefined to read it (`kerbward`). */
  private place(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource,
    pole: UtilityPole, kept: { x: number; y: number } | null | undefined): void {
    const top = groundAt(pole.x, pole.y) + POLE_HEIGHT;
    // Towards the carriageway: the nearest kerb, or null off the streets.
    const kerb = kept !== undefined ? kept : kerbward(net, { x: pole.x, y: pole.y }, m(6));
    // A pole with no wire yet stands square to its street.
    const frame = poleArmsAt(pole, source.spansAt(pole.id), source.poles, () => kerb ?? { x: 0, y: 1 });
    let run: Run | null = null;
    if (source.draws?.(pole) ?? true) {
      const out = this.scratch;
      for (const list of out) list.length = 0;
      placePole(pole, top, frame, kerb, groundAt, out);
      const builder = new RunBuilder(this.stores);
      out.forEach((list, part) => {
        for (const placement of list) {
          writePlacement(placement, this.matrix, 0);
          builder.add(part, this.matrix, Math.max(Math.abs(placement.sx), Math.abs(placement.sy), Math.abs(placement.sz)));
        }
      });
      run = builder.build();
      this.coming.add(run);
    }
    this.poles.set(pole.id, { x: pole.x, y: pole.y, top, kerb, frame, run });
    this.index.putPole(pole);
  }

  private unplace(id: PoleId, state: PoleState): void {
    // A run placed since the last flush never reached the layer: it is only not placed.
    if (state.run && !this.coming.delete(state.run)) this.going.push(state.run);
    this.poles.delete(id);
    this.index.deletePole(id);
  }

  /** A span's wires, when both its poles stand here; framed as each end frames it. */
  private string(span: UtilitySpan): void {
    if (this.spans.has(span.id)) return;
    const a = this.poles.get(span.a), b = this.poles.get(span.b);
    if (!a || !b) return;
    const block = this.wires.add(span,
      { x: a.x, y: a.y, top: a.top, arm: a.frame.bySpan.get(span.id) ?? { x: 0, y: 1 } },
      { x: b.x, y: b.y, top: b.top, arm: b.frame.bySpan.get(span.id) ?? { x: 0, y: 1 } });
    this.spans.set(span.id, { span, block });
    this.index.putSpan(span);
  }

  private unstring(id: SpanId): void {
    const held = this.spans.get(id);
    if (!held) return;
    const moved = this.wires.remove(held.block);
    if (moved !== null) this.spans.get(moved)!.block = held.block;
    this.spans.delete(id);
    this.index.deleteSpan(held.span);
  }

  private flush(): void {
    if (this.coming.size || this.going.length) {
      this.parts.update({ added: [...this.coming], removed: this.going });
      this.coming.clear();
      this.going.length = 0;
    }
    this.wires.flush();
  }

  dispose(): void {
    // The instances and the wires are this layer's; the parts' shapes and materials are shared (`PARTS`).
    this.parts.dispose();
    this.wires.dispose();
    this.group.clear();
  }
}

/** The layer of every pole of a source, built whole (a load, a preview, the shaders' warm-up). */
export function buildUtilities(
  net: Network,
  groundAt: (x: number, y: number) => number,
  kit: SceneryKit,
  source: PoleSource = docPoles(net.doc),
  name = 'utilities',
  width?: () => number,
): PoleLayer {
  const layer = new PoleLayer(kit, name, width);
  layer.fill(net, groundAt, source);
  return layer;
}

/** A planned pole run, as the editor would build it: in order, each pole new or already standing. */
export interface PolePreviewInput {
  readonly poles: readonly { readonly x: number; readonly y: number; readonly lamp: boolean; readonly standing: boolean }[];
}

/** The run under the pointer, drawn as it will stand */
export function buildPolePreview(
  net: Network,
  groundAt: (x: number, y: number) => number,
  kit: SceneryKit,
  input: PolePreviewInput,
): PoleLayer {
  const poles = new Map<PoleId, UtilityPole>();
  const spans = new Map<SpanId, UtilitySpan>();
  const reaching = new Map<PoleId, UtilitySpan[]>();
  const standing = new Set<PoleId>();
  input.poles.forEach((pole, index) => {
    const id = (index + 1) as PoleId;
    poles.set(id, { id, x: pole.x, y: pole.y, lamp: pole.lamp });
    if (pole.standing) standing.add(id);
    if (index === 0) return;
    const span: UtilitySpan = { id: index as SpanId, a: index as PoleId, b: id };
    spans.set(span.id, span);
    for (const end of [span.a, span.b]) reaching.set(end, [...(reaching.get(end) ?? []), span]);
  });
  return buildUtilities(net, groundAt, kit,
    { poles, spans, spansAt: (id) => reaching.get(id) ?? [], draws: (pole) => !standing.has(pole.id) }, 'utility-preview');
}
