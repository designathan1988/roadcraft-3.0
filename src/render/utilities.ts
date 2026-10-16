import {
  BufferGeometry,
  CylinderGeometry,
  BoxGeometry,
  BufferAttribute,
  Group,
  InstancedBufferGeometry,
  DoubleSide,
  Material,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Object3D,
  RGBADepthPacking,
  PlaneGeometry,
  CanvasTexture,
  SRGBColorSpace,
  RepeatWrapping,
  type Frustum,
  type Matrix4,
} from 'three';

import type { Network } from '@world/network';
import { m } from '@world/units';
import { LAMP_BEAM_RADIUS, LAMP_POOL_RADIUS, type SceneryKit } from './scenery';
import { GROUND_ONLY, type RoadElevation } from '@world/elevation';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { footwayRiseAt } from '@world/roads/footwayRise';
import {
  POLE_ARM_DROP,
  POLE_ARM_HALF,
  POLE_ARM_THICK,
  POLE_BASE_RADIUS,
  POLE_HEIGHT,
  POLE_LAMP_DROP,
  POLE_LAMP_LONG,
  POLE_LAMP_REACH,
  POLE_LAMP_TALL,
  POLE_LAMP_WIDE,
  POLE_TOP_RADIUS,
  WIRE_COURSES,
  WIRE_OFFSETS,
  WIRE_SEGMENTS,
  type PoleArms,
  spanSag,
} from '@world/utilities';
import { angleOf } from '@core/vec2';
import { WIRE_WIND_UNIFORMS_GLSL, windUniforms, wireWindGlsl } from './wind';

/** Pin insulator on the cross-arm. */
const INSULATOR_RADIUS = m(0.07);
const INSULATOR_TALL = m(0.2);
/** Arm braces: how far below the arm they meet the mast, and their section. */
const BRACE_DROP = m(0.55);
const BRACE_THICK = m(0.05);
/** Pole-top transformer can. */
const CAN_RADIUS = m(0.28);
const CAN_TALL = m(0.95);
/** Rise of the lamp bracket from the pole to the head. */
const LAMP_TILT = (8 * Math.PI) / 180;
/** How far a wire swings at mid-span in a full gust. */
const WIRE_SWING = m(0.35);
/** Half-width of a drawn cable: thicker than life so it reads at play zoom. */
const WIRE_RADIUS = m(0.035);
import type { UtilityPole, UtilitySpan } from '@world/utilities';

/** The overhead utility network on screen: poles, cross-arms, wires and lamps. */

export interface Utilities {
  readonly group: Group;
  readonly triangles: number;
  /** Keeps the parts the camera can see, and big enough to see (`instanceRuns.ts`): nothing is drawn before the first cull. */
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

export interface Placement {
  x: number;
  y: number;
  /** Height above the ground, in world units. */
  z: number;
  yaw: number;
  /** Tilt of the part's local X axis up from level, radians (a brace, a lamp bracket). */
  roll?: number;
  sx: number;
  sy: number;
  sz: number;
}

/** The instanced parts of a pole, by index into `polePartSpecs` and `placePole`'s lists. */
const POLE_PART = {
  mast: 0, arm: 1, cap: 2, brace: 3, insulator: 4, can: 5, lampArm: 6, lampHead: 7, lens: 8, pool: 9, beam: 10,
} as const;
export const POLE_PART_COUNT = 11;

/** One instanced part: its mesh's name, shape and material, and how it takes light and shadow. */
export interface PolePartSpec {
  readonly name: string;
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly renderOrder: number;
  /** Its size as seen, metres: the thickness of a thin part, the largest side of a compact one (`RunStore.seen`). */
  readonly seen: number;
}

/** The parts in `POLE_PART` order: the catalogue's shapes and materials, the lamps' light from the scenery's kit. */
export function polePartSpecs(kit: SceneryKit): readonly PolePartSpec[] {
  const { metal, timber, housing, porcelain, steel, mastGeometry, capGeometry, insulatorGeometry, canGeometry, boxGeometry, lensGeometry } = PARTS;
  const solid = (name: string, geometry: BufferGeometry, material: Material, seen: number): PolePartSpec =>
    ({ name, geometry, material, castShadow: true, receiveShadow: true, renderOrder: 0, seen });
  return [
    solid('utility-poles', mastGeometry, timber, POLE_TOP_RADIUS * 2),
    solid('utility-arms', boxGeometry, timber, POLE_ARM_THICK),
    solid('utility-caps', capGeometry, steel, POLE_TOP_RADIUS * 2.3),
    solid('utility-braces', boxGeometry, steel, BRACE_THICK),
    solid('utility-insulators', insulatorGeometry, porcelain, INSULATOR_TALL),
    solid('utility-transformers', canGeometry, steel, CAN_TALL),
    solid('utility-lamp-arms', boxGeometry, metal, POLE_ARM_THICK * 0.8),
    solid('utility-lamp-heads', boxGeometry, housing, POLE_LAMP_LONG),
    { name: 'utility-lamp-lenses', geometry: lensGeometry, material: kit.glow, castShadow: false, receiveShadow: true, renderOrder: 0, seen: POLE_LAMP_LONG * 0.8 },
    { name: 'utility-lamp-pools', geometry: kit.pool, material: kit.poolGlow, castShadow: false, receiveShadow: false, renderOrder: 3, seen: LAMP_POOL_RADIUS * 2 },
    { name: 'utility-lamp-beams', geometry: kit.beam, material: kit.beamGlow, castShadow: false, receiveShadow: false, renderOrder: 4, seen: LAMP_BEAM_RADIUS * 2 },
  ];
}

/** The wires' materials, from the catalogue made at load. */
export function wireParts(): { readonly material: MeshStandardMaterial; readonly depth: MeshDepthMaterial } {
  return { material: PARTS.wireMaterial, depth: PARTS.wireDepth };
}

/** One pole's parts, pushed onto `out` by `POLE_PART` */
export function placePole(
  pole: UtilityPole,
  top: number,
  frame: PoleArms,
  kerb: { x: number; y: number } | null,
  groundAt: (x: number, y: number) => number,
  out: Placement[][],
): void {
  const base = top - POLE_HEIGHT;
  out[POLE_PART.mast]!.push({ x: pole.x, y: pole.y, z: base + POLE_HEIGHT / 2, yaw: 0, sx: 1, sy: 1, sz: 1 });
  // A pole cap: the weathering cap on the crown of a timber pole.
  out[POLE_PART.cap]!.push({ x: pole.x, y: pole.y, z: base + POLE_HEIGHT + m(0.03), yaw: 0, sx: 1, sy: 1, sz: 1 });

  // An instanced box is scaled on its LOCAL X and then rotated about Y
  for (const arm of frame.arms) {
    const armZ = top - POLE_ARM_DROP;
    out[POLE_PART.arm]!.push({
      x: pole.x, y: pole.y, z: armZ, yaw: angleOf(arm),
      sx: POLE_ARM_HALF * 2, sy: POLE_ARM_THICK, sz: POLE_ARM_THICK,
    });
    // Pin insulators on the arm, one under each wire of the top course.
    for (const offset of WIRE_OFFSETS) {
      out[POLE_PART.insulator]!.push({
        x: pole.x + arm.x * POLE_ARM_HALF * offset,
        y: pole.y + arm.y * POLE_ARM_HALF * offset,
        z: armZ + POLE_ARM_THICK / 2 + INSULATOR_TALL / 2,
        yaw: 0, sx: 1, sy: 1, sz: 1,
      });
    }
    // Two flat braces from the mast up to the arm, one each side.
    for (const side of [1, -1]) {
      const reach = POLE_ARM_HALF * 0.6;
      const drop = BRACE_DROP;
      out[POLE_PART.brace]!.push({
        x: pole.x + arm.x * side * reach / 2,
        y: pole.y + arm.y * side * reach / 2,
        z: armZ - drop / 2,
        yaw: angleOf({ x: arm.x * side, y: arm.y * side }),
        roll: Math.atan2(drop, reach),
        sx: Math.hypot(reach, drop),
        sy: BRACE_THICK,
        sz: BRACE_THICK * 0.5,
      });
    }
  }
  // A pole-top transformer on some poles, hung on the side away from the street.
  if (pole.id % 5 === 3) {
    const away = kerb ?? frame.arms[0] ?? { x: 0, y: 1 };
    out[POLE_PART.can]!.push({
      x: pole.x - away.x * (POLE_BASE_RADIUS + CAN_RADIUS),
      y: pole.y - away.y * (POLE_BASE_RADIUS + CAN_RADIUS),
      z: top - POLE_ARM_DROP - m(1.6),
      yaw: 0, sx: 1, sy: 1, sz: 1,
    });
  }

  if (!pole.lamp) return;
  // The light reaches out over the street, square to the kerb, whichever way the wires run
  const reach = kerb ?? frame.arms[0] ?? { x: 0, y: 1 };
  const reachYaw = angleOf(reach);
  const headX = pole.x + reach.x * POLE_LAMP_REACH;
  const headY = pole.y + reach.y * POLE_LAMP_REACH;
  const headZ = top - POLE_LAMP_DROP;
  out[POLE_PART.lampArm]!.push({
    x: pole.x + reach.x * (POLE_LAMP_REACH / 2),
    y: pole.y + reach.y * (POLE_LAMP_REACH / 2),
    z: headZ - Math.tan(LAMP_TILT) * POLE_LAMP_REACH / 2,
    yaw: reachYaw,
    // The bracket rises gently from the pole to the head, as a davit does.
    roll: LAMP_TILT,
    sx: POLE_LAMP_REACH / Math.cos(LAMP_TILT),
    sy: POLE_ARM_THICK * 0.8,
    sz: POLE_ARM_THICK * 0.8,
  });
  out[POLE_PART.lampHead]!.push({ x: headX, y: headY, z: headZ - POLE_LAMP_TALL / 2, yaw: reachYaw, sx: POLE_LAMP_LONG, sy: POLE_LAMP_TALL, sz: POLE_LAMP_WIDE });
  // The lens under the head and the pool of light on the street, lit with the street lights' own materials
  const lensZ = headZ - POLE_LAMP_TALL - m(0.004);
  const below = groundAt(headX, headY);
  out[POLE_PART.lens]!.push({ x: headX, y: headY, z: lensZ, yaw: reachYaw, sx: POLE_LAMP_LONG * 0.8, sy: 1, sz: POLE_LAMP_WIDE * 0.8 });
  out[POLE_PART.pool]!.push({ x: headX, y: headY, z: below + m(0.012), yaw: 0, sx: LAMP_POOL_RADIUS, sy: 1, sz: LAMP_POOL_RADIUS });
  // And the cone of light between them.
  out[POLE_PART.beam]!.push({ x: headX, y: headY, z: lensZ, yaw: 0, sx: LAMP_BEAM_RADIUS, sy: Math.max(m(0.004), lensZ - below), sz: LAMP_BEAM_RADIUS });
}

const placing = new Object3D();
/** A part's matrix into `array` at `offset`, as `InstancedMesh.setMatrixAt` writes it. World y is mirrored into three's z. */
export function writePlacement(placement: Placement, array: Float32Array, offset: number): void {
  placing.position.set(placement.x, placement.z, -placement.y);
  placing.rotation.set(0, placement.yaw, placement.roll ?? 0);
  placing.scale.set(placement.sx, placement.sy, placement.sz);
  placing.updateMatrix();
  placing.matrix.toArray(array, offset);
}

/** Wires a span carries: every course and offset of the arms. */
export const SPAN_WIRES = WIRE_COURSES.length * WIRE_OFFSETS.length;
/** Numbers a wire's instance holds: its two ends in three's axes, its sag, its phase in the wind. */
export const WIRE_STRIDE = 8;

/** DO NOT build the wires' vertices on the CPU again. */
export function spanWires(
  span: UtilitySpan,
  a: { readonly x: number; readonly y: number; readonly top: number; readonly arm: { x: number; y: number } },
  b: { readonly x: number; readonly y: number; readonly top: number; readonly arm: { x: number; y: number } },
  out: Float32Array,
  at: number,
): void {
  const phase = (span.id * 2.399) % (Math.PI * 2);
  let o = at;
  // Every course and offset of the arms, as `sampleWire` lays them: its ends, and its sag from their distance.
  for (const course of WIRE_COURSES) {
    for (const offset of WIRE_OFFSETS) {
      const ax = a.x + a.arm.x * POLE_ARM_HALF * offset, ay = a.y + a.arm.y * POLE_ARM_HALF * offset, az = a.top - POLE_ARM_DROP + course;
      const bx = b.x + b.arm.x * POLE_ARM_HALF * offset, by = b.y + b.arm.y * POLE_ARM_HALF * offset, bz = b.top - POLE_ARM_DROP + course;
      // In three's axes: x, height, -y.
      out[o] = ax; out[o + 1] = az; out[o + 2] = -ay;
      out[o + 3] = bx; out[o + 4] = bz; out[o + 5] = -by;
      out[o + 6] = spanSag(Math.hypot(bx - ax, by - ay)); out[o + 7] = phase;
      o += WIRE_STRIDE;
    }
  }
}

/** Half-width of a drawn cable (`WIRE_GLSL`), for the wires' bounds. */
export const WIRE_HALF_WIDTH = WIRE_RADIUS;

/** The tube every wire is drawn from */
export function wireTemplate(): InstancedBufferGeometry {
  const vertices = WIRE_SEGMENTS * 24;
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3);
  let v = 0;
  const put = (segment: number, end: number, corner: number, face: number): void => {
    position[v * 3] = segment; position[v * 3 + 1] = end; position[v * 3 + 2] = corner;
    normal[v * 3] = face;
    v++;
  };
  for (let i = 0; i < WIRE_SEGMENTS; i++) {
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      put(i, 0, k, k); put(i, 1, k, k); put(i, 1, j, k);
      put(i, 0, k, k); put(i, 1, j, k); put(i, 0, j, k);
    }
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  return geometry;
}

/** A wire's tube in the vertex shader, the arithmetic the CPU did per segment (in three's axes) */
const WIRE_GLSL = `
        attribute vec3 aStart;
        attribute vec3 aEnd;
        attribute vec2 aSagPhase;
        vec3 wireAt(float t) {
          float u = t * 2.0 - 1.0;
          vec3 p = mix(aStart, aEnd, t);
          p.y -= aSagPhase.x * (1.0 - u * u);
          return p;
        }
        vec3 wireCorner(vec3 u, vec3 w, float c) {
          return c < 0.5 ? u : c < 1.5 ? w : c < 2.5 ? -u : -w;
        }
        void wireFrame(out vec3 p0, out vec3 p1, out vec3 u, out vec3 w) {
          p0 = wireAt(position.x / ${WIRE_SEGMENTS.toFixed(1)});
          p1 = wireAt((position.x + 1.0) / ${WIRE_SEGMENTS.toFixed(1)});
          vec3 d = p1 - p0;
          float dl = length(d);
          d /= dl > 0.0 ? dl : 1.0;
          u = vec3(-d.z, 0.0, d.x);
          float ul = length(u);
          u = u / (ul > 0.0 ? ul : 1.0) * ${WIRE_RADIUS.toFixed(6)};
          w = vec3(u.y * d.z - u.z * d.y, u.z * d.x - u.x * d.z, u.x * d.y - u.y * d.x);
          float wl = length(w);
          w = w / (wl > 0.0 ? wl : 1.0) * ${WIRE_RADIUS.toFixed(6)};
        }
        vec3 wirePosition() {
          vec3 p0, p1, u, w;
          wireFrame(p0, p1, u, w);
          return (position.y < 0.5 ? p0 : p1) + wireCorner(u, w, position.z);
        }`;

/** The wires' materials: lit with the wind, and the shadow's depth, both bending the template along each wire. */
function wireMaterials(): { readonly lit: MeshStandardMaterial; readonly depth: MeshDepthMaterial } {
  // A wire is thinner than a pixel at any play zoom.
  const lit = new MeshStandardMaterial({ color: 0x1e2224, roughness: 0.55, metalness: 0.3, side: DoubleSide });
  lit.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms, { uWireAmp: { value: WIRE_SWING } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${WIRE_WIND_UNIFORMS_GLSL}${WIRE_GLSL}`)
      .replace('#include <beginnormal_vertex>', `
        vec3 nP0, nP1, nU, nW;
        wireFrame(nP0, nP1, nU, nW);
        vec3 objectNormal = normalize(wireCorner(nU, nW, normal.x) + wireCorner(nU, nW, mod(normal.x + 1.0, 4.0)));`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = wirePosition();
        float wireT = (position.x + position.y) / ${WIRE_SEGMENTS.toFixed(1)};
        float wireSwing = 4.0 * wireT * (1.0 - wireT);${wireWindGlsl('wireSwing', 'aSagPhase.y')}`);
  };
  lit.customProgramCacheKey = () => 'wire-instanced';
  // The shadow as it was: the tube at rest, without the wind.
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${WIRE_GLSL}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = wirePosition();');
  };
  depth.customProgramCacheKey = () => 'wire-instanced-depth';
  return { lit, depth };
}

/** The pole layer's materials and shapes, one set for every build (the built layer and the run's preview). */
interface UtilityParts {
  readonly metal: MeshStandardMaterial;
  readonly timber: MeshStandardMaterial;
  readonly housing: MeshStandardMaterial;
  readonly wireMaterial: MeshStandardMaterial;
  readonly wireDepth: MeshDepthMaterial;
  readonly porcelain: MeshStandardMaterial;
  readonly steel: MeshStandardMaterial;
  readonly mastGeometry: CylinderGeometry;
  readonly capGeometry: CylinderGeometry;
  readonly insulatorGeometry: CylinderGeometry;
  readonly canGeometry: CylinderGeometry;
  readonly boxGeometry: BoxGeometry;
  readonly lensGeometry: BufferGeometry;
}
/** Made once, at load (`PARTS`, the end of this file), never disposed (a few materials and small shapes) */
function makeUtilityParts(): UtilityParts {
  const parts = madeUtilityParts();
  // Each shape's bounds once, at load: the pole layer grows its meshes' bounds from them.
  for (const geometry of [parts.mastGeometry, parts.capGeometry, parts.insulatorGeometry, parts.canGeometry, parts.boxGeometry, parts.lensGeometry]) geometry.computeBoundingSphere();
  return parts;
}

function madeUtilityParts(): UtilityParts {
  const metal = new MeshStandardMaterial({
    color: 0x4a4a46,
    roughness: 0.68,
    metalness: 0.35,
  });
  // Creosoted timber: a grain of long streaks up the pole, a few knots and checks
  const timber = new MeshStandardMaterial({
    color: 0xffffff,
    map: woodTexture(),
    roughness: 0.92,
    metalness: 0,
  });
  // The luminaire as seen from above: its housing.
  const housing = new MeshStandardMaterial({ color: 0xa9b0ad, roughness: 0.5, metalness: 0.3 });
  const wires = wireMaterials();
  return {
    metal, timber, housing, wireMaterial: wires.lit, wireDepth: wires.depth,
    // A pin insulator: a glazed porcelain bell on a short pin.
    porcelain: new MeshStandardMaterial({ color: 0xd8dcd6, roughness: 0.25, metalness: 0 }),
    steel: new MeshStandardMaterial({ color: 0x8c9590, roughness: 0.45, metalness: 0.55 }),
    mastGeometry: new CylinderGeometry(POLE_TOP_RADIUS, POLE_BASE_RADIUS, POLE_HEIGHT, 12),
    capGeometry: new CylinderGeometry(POLE_TOP_RADIUS * 0.4, POLE_TOP_RADIUS * 1.15, m(0.08), 10),
    insulatorGeometry: new CylinderGeometry(INSULATOR_RADIUS * 0.55, INSULATOR_RADIUS, INSULATOR_TALL, 10),
    canGeometry: new CylinderGeometry(CAN_RADIUS, CAN_RADIUS, CAN_TALL, 14),
    boxGeometry: new BoxGeometry(1, 1, 1),
    // One face, looking down: a lens only shines down (see `lampLensGeometry`).
    lensGeometry: new PlaneGeometry(1, 1).rotateX(Math.PI / 2),
  };
}

/** Ground a pole stands on: the footway where there is one, the terrain where there is not. */
export function poleGroundAt(
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  /** The network, to stand a pole level with a footway laid flush (`footwayRiseAt`). */
  net?: Network,
): (x: number, y: number) => number {
  return (x, y) => {
    const road = elevation.roadAt(x, y, GROUND_ONLY);
    // `half` is the CASING half-width, which runs a little past the footway.
    const onFootway = road.type >= 0 && Math.abs(road.across) <= road.half;
    if (!onFootway) return terrainAt(x, y);
    return elevation.at(x, y, GROUND_ONLY) + (net ? footwayRiseAt(net, x, y) : FOOTWAY_RISE);
  };
}

let woodCache: CanvasTexture | null = null;
/** The wood of a pole: dark brown, long grain, knots and drying cracks. Shared. */
function woodTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (woodCache) return woodCache;
  const W = 128, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4e3b2a';
  g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // Grain: thin streaks of lighter and darker wood running up the pole.
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W, light = rnd() < 0.5;
    g.strokeStyle = light ? `rgba(120, 92, 64, ${0.15 + rnd() * 0.25})` : `rgba(30, 20, 12, ${0.15 + rnd() * 0.3})`;
    g.lineWidth = 0.5 + rnd() * 1.5;
    g.beginPath();
    let px = x;
    g.moveTo(px, 0);
    for (let y = 0; y <= H; y += 16) { px += (rnd() - 0.5) * 1.5; g.lineTo(px, y); }
    g.stroke();
  }
  // Knots and checks.
  for (let i = 0; i < 6; i++) {
    const x = rnd() * W, y = rnd() * H, r = 3 + rnd() * 5;
    const grad = g.createRadialGradient(x, y, 0, x, y, r * 2);
    grad.addColorStop(0, 'rgba(25, 15, 8, 0.85)');
    grad.addColorStop(1, 'rgba(25, 15, 8, 0)');
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(x, y, r, r * 2.2, 0, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 10; i++) {
    const x = rnd() * W, y = rnd() * H, len = 30 + rnd() * 90;
    g.strokeStyle = 'rgba(15, 10, 6, 0.7)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y + len); g.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(1, 2);
  woodCache = t;
  return t;
}

/** DO NOT make them lazily on the first build again: that is a material made in a frame. */
const PARTS: UtilityParts = makeUtilityParts();
