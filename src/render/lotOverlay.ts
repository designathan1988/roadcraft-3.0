import {
  DataTexture, NearestFilter, RGBAIntegerFormat, UnsignedIntType, Vector4,
  type Material, type WebGLProgramParametersWithUniforms,
} from 'three';
import type { Vec2 } from '@core/vec2';
import type { ChangeJournal, ChangeKind, ChangeRect } from '@world/changes';
import { JournalCursor } from '@world/derived';
import { MAP_HALF } from '@world/bounds';
import {
  DASH, GAP, FLAG_BUTT, FLAG_DASHED, FLAG_LEVEL, FLAG_FILL, FLAG_INSIDE, FLAG_STROKE, LOT_CELL, LotLattice, TEXTURE_WIDTH, TILE_CELLS, type LatticeShape,
} from './lotLattice';

/** DO NOT go back to geometry laid on the ground per lot */
export interface LotPart {
  /** `order`: each shape's place in the drawing, later over earlier (`LatticeShape.order`). */
  readonly polygons: readonly {
    readonly corners: readonly Vec2[];
    readonly fill: number | null;
    readonly fillAlpha: number;
    readonly line: number;
    readonly lineAlpha: number;
    /** Line width, metres on the ground. */
    readonly width: number;
    /** A lot with a building: its yard's paving and paths - the building's own parts, not the ground - are coloured too */
    readonly built?: boolean;
    readonly order: number;
  }[];
  readonly lines: readonly { readonly a: Vec2; readonly b: Vec2; readonly colour: number; readonly dashed: boolean; readonly width: number; readonly order: number }[];
  readonly points: readonly { readonly p: Vec2; readonly colour: number; readonly radius: number; readonly order: number }[];
}

/** DO NOT hand the overlay every lot again for one that changed: what it draws, in parts by id, and which parts changed when */
export interface LotOverlayInput {
  /** Every part drawn by id (a lot, a proposed lot, the gesture); a part is a new object whenever what it draws changed. */
  readonly parts: ReadonlyMap<string, LotPart>;
  /** The serial of the latest change of the parts. */
  readonly serial: number;
  /** The ids of the parts put, replaced or taken away after `serial`, or null when it cannot say (read them all). */
  changedSince(serial: number): readonly string[] | null;
}

/** A colour (0xRRGGBB, sRGB) and an alpha as the lattice keeps them: RGBA8, red lowest. */
function rgba(colour: number, alpha: number): number {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  if (a === 0) return 0;
  return ((colour >> 16) & 255 | (((colour >> 8) & 255) << 8) | ((colour & 255) << 16) | (a << 24)) >>> 0;
}

/** The lattice's texture when there is nothing: an integer texture still, for the `usampler2D`. */
const EMPTY = new DataTexture(new Uint32Array(4), 1, 1, RGBAIntegerFormat, UnsignedIntType);
EMPTY.internalFormat = 'RGBA32UI';
EMPTY.needsUpdate = true;

/** Shared by every ground material (`applyLotOverlay`), set by the overlay: the lattice's texture and its frame */
const UNIFORMS = {
  uLots: { value: EMPTY },
  uLotsGrid: { value: new Vector4(MAP_HALF, LOT_CELL, Math.ceil((2 * MAP_HALF) / LOT_CELL), 0) },
  uLotsTiles: { value: Math.ceil(Math.ceil((2 * MAP_HALF) / LOT_CELL) / TILE_CELLS) },
};

/** How far above or below a built lot's ground level a building's level surface is still its yard (metres) */
const LEVEL_REACH = 0.75;
/** A building's surface facing up at least this much (world normal's y): a wall's never is. */
const FACING_UP = 0.9;

const LOT_PARS = /* glsl */ `
  uniform highp usampler2D uLots;
  uniform vec4 uLotsGrid;
  uniform float uLotsTiles;
  uvec4 lotTexel(uint a) { return texelFetch(uLots, ivec2(int(a & ${TEXTURE_WIDTH - 1}u), int(a >> ${Math.log2(TEXTURE_WIDTH)}u)), 0); }
  float lotCross(vec2 u, vec2 v) { return u.x * v.y - u.y * v.x; }
  vec3 lotLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
  vec4 lotColour(uint c) {
    vec4 v = vec4(uvec4(c, c >> 8u, c >> 16u, c >> 24u) & 255u) / 255.0;
    return vec4(lotLinear(v.rgb), v.a);
  }
  // The lots over \`base\` at world point w (x, y), dw/dx and dw/dy the
  // pixel's footprint Nehab & Hoppe 2008: parity for inside, the nearest edge's distance scaled to pixels for the
  // \`building\`: a building's level surface at world height \`height\`: only
  // the built lots whose ground level is within LEVEL_REACH of it draw there (the yard's paving, not a flat roof).
  vec3 lotOver(vec3 base, vec2 w, vec2 dx, vec2 dy, float height, bool building) {
    vec2 g = (w + uLotsGrid.x) / uLotsGrid.y;
    if (any(lessThan(g, vec2(0.0))) || any(greaterThanEqual(g, vec2(uLotsGrid.z)))) return base;
    ivec2 c = ivec2(g);
    ivec2 t = c / ${TILE_CELLS};
    int tile = t.y * int(uLotsTiles) + t.x;
    uint block = lotTexel(uint(tile >> 2))[tile & 3];
    if (block == 0u) return base;
    int local = (c.y - t.y * ${TILE_CELLS}) * ${TILE_CELLS} + (c.x - t.x * ${TILE_CELLS});
    uint entry = lotTexel(block + uint(local >> 2))[local & 3];
    uint count = entry & 255u;
    if (count == 0u) return base;
    uint at = entry >> 8u;
    if (count == 255u) { count = lotTexel(at).x; at += 1u; }
    // Cell-local, as the edges are stored: the cell's centre is (c + 0.5) cells from the map's corner.
    vec2 p = (w + uLotsGrid.x) - (vec2(c) + 0.5) * uLotsGrid.y;
    // Premultiplied, each over the ones before: every fill under every stroke.
    vec4 fills = vec4(0.0), strokes = vec4(0.0);
    for (uint r = 0u; r < count; r++) {
      uvec4 h = lotTexel(at);
      at += 1u;
      uint n = h.z & 1023u;
      uint flags = (h.z >> 10u) & 63u;
      float hw = unpackHalf2x16(h.z >> 16u).x;
      bool levelled = (flags & ${FLAG_LEVEL}u) != 0u;
      float level = 0.0;
      if (levelled) { level = uintBitsToFloat(lotTexel(at).x); at += 1u; }
      if (building && (!levelled || abs(height - level) > ${LEVEL_REACH.toFixed(3)})) { at += n; continue; }
      if ((flags & ${FLAG_BUTT}u) != 0u) {
        // A line with square ends, as a ribbon: across, the band of its
        // width; along, cut at its ends - or at its dash's (dashes of
        // ${DASH} m every ${DASH + GAP} m from its start).
        uvec4 q = lotTexel(at);
        at += n;
        vec2 a = uintBitsToFloat(q.xy), ab = uintBitsToFloat(q.zw) - a;
        float len = length(ab);
        vec2 u = ab / len, nrm = vec2(-u.y, u.x);
        float along = dot(p - a, u), across = abs(dot(p - a, nrm));
        float lo = 0.0, hi = len;
        if ((flags & ${FLAG_DASHED}u) != 0u) {
          float d0 = floor(along / ${(DASH + GAP).toFixed(4)}) * ${(DASH + GAP).toFixed(4)};
          float next = d0 + ${(DASH + GAP).toFixed(4)};
          float d1 = d0 + ${DASH.toFixed(4)};
          if (along > d1 && next < len && next - along < along - d1) { d0 = next; d1 = next + ${DASH.toFixed(4)}; }
          lo = max(d0, 0.0); hi = min(d1, len);
        }
        float mppN = max(length(vec2(dot(dx, nrm), dot(dy, nrm))), 1e-6);
        float mppU = max(length(vec2(dot(dx, u), dot(dy, u))), 1e-6);
        float ds = across / mppN, ws = hw / mppN;
        vec4 s = lotColour(h.y);
        float cover = (smoothstep(-1.0, 1.0, ws - ds) - smoothstep(-1.0, 1.0, -ws - ds))
          * smoothstep(-1.0, 1.0, min(along - lo, hi - along) / mppU) * s.a;
        strokes = vec4(s.rgb * cover, cover) + strokes * (1.0 - cover);
        continue;
      }
      vec2 ref = unpackHalf2x16(h.w);
      bool inside = (flags & ${FLAG_INSIDE}u) != 0u;
      float best = 1e9;
      vec2 dir = vec2(1.0, 0.0);
      vec2 rp = p - ref;
      for (uint e = 0u; e < n; e++) {
        uvec4 q = lotTexel(at + e);
        vec2 a = uintBitsToFloat(q.xy), b = uintBitsToFloat(q.zw);
        vec2 ab = b - a;
        // The way from the reference to the pixel crossing this edge flips the side.
        if (((lotCross(ab, ref - a) > 0.0) != (lotCross(ab, p - a) > 0.0)) && ((lotCross(rp, a - ref) > 0.0) != (lotCross(rp, b - ref) > 0.0))) inside = !inside;
        float len2 = dot(ab, ab);
        float s = len2 > 0.0 ? clamp(dot(p - a, ab) / len2, 0.0, 1.0) : 0.0;
        vec2 v = p - (a + ab * s);
        float d = length(v);
        if (d < best) {
          best = d;
          dir = d > 1e-5 ? v / d : (len2 > 0.0 ? normalize(vec2(-ab.y, ab.x)) : vec2(1.0, 0.0));
        }
      }
      at += n;
      // Metres a pixel across, along the way to the nearest edge (the Jacobian of the view).
      float mpp = max(length(vec2(dot(dx, dir), dot(dy, dir))), 1e-6);
      if ((flags & ${FLAG_FILL}u) != 0u) {
        vec4 f = lotColour(h.x);
        float cover = smoothstep(-1.0, 1.0, (inside ? best : -best) / mpp) * f.a;
        fills = vec4(f.rgb * cover, cover) + fills * (1.0 - cover);
      }
      if ((flags & ${FLAG_STROKE}u) != 0u) {
        // An outline (round at its corners) or a dot.
        vec4 s = lotColour(h.y);
        float ds = best / mpp, ws = hw / mpp;
        float cover = (smoothstep(-1.0, 1.0, ws - ds) - smoothstep(-1.0, 1.0, -ws - ds)) * s.a;
        strokes = vec4(s.rgb * cover, cover) + strokes * (1.0 - cover);
      }
    }
    base = base * (1.0 - fills.a) + fills.rgb;
    return base * (1.0 - strokes.a) + strokes.rgb;
  }
`;

/** Makes a material colour the lots into itself */
export function applyLotOverlay(material: Material, key: string, options: { readonly world?: string; readonly building?: boolean } = {}): void {
  const { world, building = false } = options;
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  const varying = world ?? 'vLotWorld';
  const declare = `${world ? '' : 'varying vec3 vLotWorld;'}\n${building ? 'varying float vLotUp;' : ''}`;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, UNIFORMS);
    if (!world || building) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${declare}`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          {
            vec4 lotWorld = vec4(transformed, 1.0);
            vec3 lotNormal = objectNormal;
            #ifdef USE_BATCHING
              lotWorld = batchingMatrix * lotWorld;
              lotNormal = mat3(batchingMatrix) * lotNormal;
            #endif
            #ifdef USE_INSTANCING
              lotWorld = instanceMatrix * lotWorld;
              lotNormal = mat3(instanceMatrix) * lotNormal;
            #endif
            ${world ? '' : 'vLotWorld = (modelMatrix * lotWorld).xyz;'}
            // The surface's own normal in the world, not the normal map's:
            // a wall is a wall however its bricks are bumped.
            ${building ? 'vLotUp = normalize(mat3(modelMatrix) * lotNormal).y;' : ''}
          }`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${declare}\n${LOT_PARS}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (uLotsGrid.w > 0.5) {
          // World (x, y): three's z is the world's -y.
          vec2 lotW = vec2(${varying}.x, -${varying}.z);
          vec2 lotDx = dFdx(lotW), lotDy = dFdy(lotW);
          ${building
            ? `if (vLotUp > ${FACING_UP.toFixed(2)}) gl_FragColor.rgb = lotOver(gl_FragColor.rgb, lotW, lotDx, lotDy, ${varying}.y, true);`
            : 'gl_FragColor.rgb = lotOver(gl_FragColor.rgb, lotW, lotDx, lotDy, 0.0, false);'}
        }`);
  };
  material.customProgramCacheKey = () => `${previousKey()}-lots-${key}`;
}

/** A part's shapes (`LotPart`) as the lattice draws them, and the points their ground levels were read at. */
function shapesOf(part: LotPart, levelAt: (x: number, y: number) => number, read: Vec2[]): LatticeShape[] {
  const out: LatticeShape[] = [];
  /** A shape's ground level: the ground at its points' mean (a built lot's: under its building, its pad). */
  const level = (points: readonly Vec2[]): number => {
    let x = 0, y = 0;
    for (const q of points) { x += q.x; y += q.y; }
    read.push({ x: x / points.length, y: y / points.length });
    return levelAt(x / points.length, y / points.length);
  };
  for (const poly of part.polygons) {
    const ring = poly.corners;
    if (ring.length < 3) continue;
    const fill = poly.fill === null ? 0 : rgba(poly.fill, poly.fillAlpha);
    const line = rgba(poly.line, poly.lineAlpha);
    if (!fill && !line) continue;
    const edges = new Float64Array(ring.length * 4);
    ring.forEach((q, i) => { const r = ring[(i + 1) % ring.length]!; edges.set([q.x, q.y, r.x, r.y], i * 4); });
    out.push({ edges, fill, line, halfWidth: poly.width / 2, dashed: false, butt: false, order: poly.order, ...(poly.built ? { level: level(ring) } : {}) });
  }
  for (const l of part.lines) {
    // A line of no length drew nothing as a ribbon, and draws nothing here.
    if (l.a.x === l.b.x && l.a.y === l.b.y) continue;
    // A line or a dot is drawn over a yard's paving too (a lot's front, its arrow)
    out.push({ edges: Float64Array.of(l.a.x, l.a.y, l.b.x, l.b.y), fill: 0, line: rgba(l.colour, 1), halfWidth: l.width / 2, dashed: l.dashed, butt: true, order: l.order, level: level([l.a, l.b]) });
  }
  for (const d of part.points) {
    out.push({ edges: Float64Array.of(d.p.x, d.p.y, d.p.x, d.p.y), fill: 0, line: rgba(d.colour, 1), halfWidth: d.radius, dashed: false, butt: false, order: d.order, level: level([d.p]) });
  }
  return out;
}

/** What moves the ground a built lot's level is read from (`surfaceHeightAt`): its level is read again there. */
const GROUND_KINDS: readonly ChangeKind[] = ['terrain', 'roads', 'ground', 'elevation', 'surfaces'];

/** `groundAt`: the ground's height (`surfaceHeightAt`), read once for each shape with a level, at its middle, when its part is drawn. */
export function createLotOverlay(groundAt: (x: number, y: number) => number = () => 0) {
  const lattice = new LotLattice(MAP_HALF);
  let texture: DataTexture | null = null;
  /** The parts in the lattice by id: the part drawn, its shapes, and the lattice cells its levels were read in. */
  const held = new Map<string, { readonly part: LotPart; readonly shapes: readonly LatticeShape[]; readonly cells: readonly number[] }>();
  /** The parts whose levels were read in a lattice cell: those a ground change reaches, found by place. */
  const levelsByCell = new Map<number, Set<string>>();
  /** The input last drawn and the serial of its parts it was drawn at (`LotOverlayInput.changedSince`). */
  let source: LotOverlayInput | null = null;
  let seen = -1;
  /** The diary of what moves the ground the levels were read from. */
  const groundCursor = new JournalCursor(GROUND_KINDS);
  const cellOf = (x: number, y: number): number =>
    Math.floor((y + MAP_HALF) / LOT_CELL) * lattice.cellsPerSide + Math.floor((x + MAP_HALF) / LOT_CELL);
  /** The ground's level at a point, to the centimetre. */
  const levelAt = (x: number, y: number): number => Math.round(groundAt(x, y) * 100) / 100;
  const make = (id: string, part: LotPart): void => {
    const read: Vec2[] = [];
    const shapes = shapesOf(part, levelAt, read);
    for (const shape of shapes) lattice.add(shape);
    const cells = [...new Set(read.map((q) => cellOf(q.x, q.y)))];
    for (const cell of cells) {
      let set = levelsByCell.get(cell);
      if (!set) levelsByCell.set(cell, set = new Set());
      set.add(id);
    }
    held.set(id, { part, shapes, cells });
  };
  const drop = (id: string): void => {
    const was = held.get(id);
    if (!was) return;
    for (const shape of was.shapes) lattice.remove(shape);
    for (const cell of was.cells) {
      const set = levelsByCell.get(cell);
      set?.delete(id);
      if (set?.size === 0) levelsByCell.delete(cell);
    }
    held.delete(id);
  };
  /** The parts whose levels were read where the ground moved (all of them, with no rectangles). */
  const onMovedGround = (entries: readonly { readonly rects: readonly ChangeRect[] | null }[] | null): Set<string> => {
    const out = new Set<string>();
    if (entries === null || entries.some((e) => e.rects === null)) {
      for (const ids of levelsByCell.values()) for (const id of ids) out.add(id);
      return out;
    }
    const n = lattice.cellsPerSide;
    for (const { rects } of entries) {
      for (const [x0, y0, x1, y1] of rects!) {
        const cx0 = Math.max(0, Math.floor((x0 + MAP_HALF) / LOT_CELL)), cx1 = Math.min(n - 1, Math.floor((x1 + MAP_HALF) / LOT_CELL));
        const cy0 = Math.max(0, Math.floor((y0 + MAP_HALF) / LOT_CELL)), cy1 = Math.min(n - 1, Math.floor((y1 + MAP_HALF) / LOT_CELL));
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) for (const id of levelsByCell.get(cy * n + cx) ?? []) out.add(id);
      }
    }
    return out;
  };

  /** The lattice's writes sent to its texture: in place, or a texture of the new size. */
  const upload = (): void => {
    const { whole, ranges } = lattice.takeUpload();
    const rows = lattice.rows;
    if (!texture || texture.image.height !== rows) {
      texture?.dispose();
      texture = new DataTexture(lattice.data, TEXTURE_WIDTH, rows, RGBAIntegerFormat, UnsignedIntType);
      texture.internalFormat = 'RGBA32UI';
      texture.minFilter = NearestFilter;
      texture.magFilter = NearestFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      UNIFORMS.uLots.value = texture;
      return;
    }
    // A compaction left the size and replaced the array: sent whole.
    texture.image.data = lattice.data;
    if (whole) { texture.clearUpdateRanges(); texture.needsUpdate = true; return; }
    if (!ranges.length) return;
    for (let i = 0; i < ranges.length; i += 2) texture.addUpdateRange(ranges[i]!, ranges[i + 1]!);
    texture.needsUpdate = true;
  };

  return {
    /** The lattice: for the tests, the work an edit cost. */
    lattice,
    /** Draws `input` (null: no lots) into the ground from the next frame: the parts it says changed, and those whose ground moved. */
    set(input: LotOverlayInput | null, changes?: ChangeJournal): void {
      const regrade = changes ? onMovedGround(groundCursor.read(changes)) : new Set<string>();
      if (!input) {
        if (source === null && held.size === 0) return;
        source = null;
        seen = -1;
        lattice.clear();
        held.clear();
        levelsByCell.clear();
        UNIFORMS.uLotsGrid.value.w = 0;
        upload();
        return;
      }
      const ids = source === input ? input.changedSince(seen) : null;
      source = input;
      seen = input.serial;
      let moved = false;
      if (ids === null) {
        // Every part read: those gone or replaced taken away, the rest kept as drawn.
        for (const [id, was] of [...held]) if (input.parts.get(id) !== was.part) { drop(id); moved = true; }
        for (const [id, part] of input.parts) if (!held.has(id)) { make(id, part); moved = true; }
      } else {
        for (const id of ids) {
          const part = input.parts.get(id);
          if (held.get(id)?.part === part) continue;
          drop(id);
          if (part) make(id, part);
          moved = true;
        }
      }
      // The levels read again where the ground moved: those parts drawn again.
      for (const id of regrade) {
        const was = held.get(id);
        if (!was) continue;
        drop(id);
        make(id, was.part);
        moved = true;
      }
      if (!moved) return;
      lattice.flush();
      UNIFORMS.uLotsGrid.value.w = lattice.size > 0 ? 1 : 0;
      upload();
    },
    dispose(): void {
      lattice.clear();
      if (texture) { texture.dispose(); texture = null; }
      UNIFORMS.uLots.value = EMPTY;
      UNIFORMS.uLotsGrid.value.w = 0;
    },
  };
}
