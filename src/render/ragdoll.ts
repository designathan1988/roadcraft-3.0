import type { BodyPart, Severable } from '@sim/people/view';
import { Matrix4, Quaternion, Vector3 } from 'three';

import type { Casualty } from '@sim/people/casualties';
import { m } from '@world/units';
import type { BloodDecal } from './casualties';
import type { Exhaust } from './exhaust';
import type { Gore } from './gore';
import { joltWorld, startJolt, type JointSpec, type JoltRagdoll, type JoltStatic, type JoltWorld, type PartSpec } from './ragdollJolt';
import { across, coneFrames, direction, hingeFrame, unitOr } from './ragdollAxes';

/** Ragdolls: people knocked over or killed by a blow, or tripping, their own bodies falling. */

export interface RagdollCitizens {
  capturedPose(id: number): { index: number; palette: Float32Array; transform: Matrix4 } | null;
  skeletonOf(index: number): { names: string[]; parents: number[]; inverses: Matrix4[]; local: Matrix4; bind: Matrix4 } | null;
  /** `charred`: burnt black (a bomb's direct hit). */
  drawPalette(index: number, palette: Float32Array, instance: Matrix4, charred?: boolean, alive?: boolean): void;
  clipPose(index: number, key: 'crouchUp' | 'idle' | 'getUpFront' | 'getUpBack' | 'crawl', phase: number): { palette: Float32Array; duration: number } | null;
  /** Bodies loaded now, for people with no pose of their own (indoors). */
  loadedIndices(): number[];
  /** The index to draw a piece torn off this person with (their twin, or the same body); null when none can be drawn. */
  twin?(index: number): number | null;
  /** A twin's index given back (its piece gone). */
  untwin?(index: number): void;
  /** Burns the person black (a bomb's direct hit). */
  char?(index: number): void;
  /** A bullet hole in this part of the person, bleeding into their clothes. */
  /** From world (fromX, fromY) when known: the shot's jolt through them too. */
  wound?(index: number, part: BodyPart, fromX?: number, fromY?: number): void;
  /** The person soaked in blood all over (shot to pieces). */
  drench?(index: number): void;
}

/** Somebody inside a building a blow struck: thrown out of it from where they were. */
export interface Occupant {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Height they stood at (the floor they were on). */
  readonly z: number;
  readonly heading: number;
  readonly blastX: number;
  readonly blastY: number;
  readonly power: number;
  readonly kind: 'dead' | 'torn' | 'knocked';
  /** Burnt black (right under the blow, or in a burning car). */
  readonly charred?: boolean;
  /** The body they were drawn with (a driver, a rider): thrown as themself, not as somebody else. */
  readonly index?: number | null;
}

/** A wall a body can strike: a ring on the ground (world x, y), up to a height. */
export interface RagdollWall {
  readonly ring: readonly { readonly x: number; readonly y: number }[];
  /** The highest it reaches. */
  readonly top: number;
  /** Its top at a point inside it (a roof's pitch); `top` all over when absent. */
  readonly roof?: (x: number, y: number) => number;
}

export interface RagdollWorld {
  /** Height of whatever a body lands on at world (x, y). */
  groundAt(x: number, y: number): number;
  /** The walls near a world point. */
  wallsNear(x: number, y: number, reach: number): RagdollWall[];
}

/** Somebody alive getting up at world (x, y) facing `heading`, taking `seconds` (`PeopleEngine.getUp`). */
export type GetUp = (id: number, x: number, y: number, heading: number, seconds: number, crawl?: boolean) => void;

/** The skeleton's joints the particles sit on ('' for a particle with no bone of its own). */
const JOINTS = [
  'Bip01_Pelvis', 'Bip01_Spine2', 'Bip01_Neck', 'Bip01_Head', '',
  'Bip01_L_UpperArm', 'Bip01_L_Forearm', 'Bip01_L_Hand', 'Bip01_R_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand',
  'Bip01_L_Thigh', 'Bip01_L_Calf', 'Bip01_L_Foot', 'Bip01_L_Toe0', 'Bip01_R_Thigh', 'Bip01_R_Calf', 'Bip01_R_Foot', 'Bip01_R_Toe0',
  '',
] as const;
const PEL = 0, CHE = 1, NEC = 2, HEA = 3, TOP = 4;
const LS = 5, LE = 6, LW = 7, RS = 8, RE = 9, RW = 10;
const LH = 11, LK = 12, LA = 13, LT = 14, RH = 15, RK = 16, RA = 17, RT = 18;
/** In front of the pelvis: braces the torso against folding back and forth. */
const BEL = 19;

type PartName = 'torso' | 'neck' | 'head' | 'lua' | 'lfa' | 'rua' | 'rfa' | 'lth' | 'lca' | 'lfo' | 'rth' | 'rca' | 'rfo';
type Limb = 'larm' | 'rarm' | 'lleg' | 'rleg';
/** Which part each key bone follows; a bone not listed follows its nearest listed ancestor. */
const KEY_PART: Readonly<Record<string, PartName>> = {
  Bip01: 'torso', Bip01_Pelvis: 'torso', Bip01_Spine: 'torso', Bip01_Spine1: 'torso', Bip01_Spine2: 'torso',
  Bip01_L_Clavicle: 'torso', Bip01_R_Clavicle: 'torso', Bip01_Neck: 'neck', Bip01_Head: 'head',
  Bip01_L_UpperArm: 'lua', Bip01_L_Forearm: 'lfa', Bip01_L_Hand: 'lfa', Bip01_R_UpperArm: 'rua', Bip01_R_Forearm: 'rfa', Bip01_R_Hand: 'rfa',
  Bip01_L_Thigh: 'lth', Bip01_L_Calf: 'lca', Bip01_L_Foot: 'lfo', Bip01_L_Toe0: 'lfo',
  Bip01_R_Thigh: 'rth', Bip01_R_Calf: 'rca', Bip01_R_Foot: 'rfo', Bip01_R_Toe0: 'rfo',
};
/** Each part: the particle its frame sits on, the particle its long axis points to, what turns it about that axis. */
const PARTS: Readonly<Record<PartName, { origin: number; to: number; ref: 'side' | Limb }>> = {
  torso: { origin: PEL, to: CHE, ref: 'side' },
  neck: { origin: NEC, to: HEA, ref: 'side' },
  head: { origin: HEA, to: TOP, ref: 'side' },
  lua: { origin: LS, to: LE, ref: 'larm' }, lfa: { origin: LE, to: LW, ref: 'larm' },
  rua: { origin: RS, to: RE, ref: 'rarm' }, rfa: { origin: RE, to: RW, ref: 'rarm' },
  lth: { origin: LH, to: LK, ref: 'lleg' }, lca: { origin: LK, to: LA, ref: 'lleg' }, lfo: { origin: LA, to: LT, ref: 'lleg' },
  rth: { origin: RH, to: RK, ref: 'rleg' }, rca: { origin: RK, to: RA, ref: 'rleg' }, rfo: { origin: RA, to: RT, ref: 'rleg' },
};
/** Parents first (`PART_NAMES` follows this order): each part's parent part, for `bonesWorld`. */
const PART_PARENT: Readonly<Record<PartName, PartName | null>> = {
  torso: null, neck: 'torso', head: 'neck', lua: 'torso', lfa: 'lua', rua: 'torso', rfa: 'rua',
  lth: 'torso', lca: 'lth', lfo: 'lca', rth: 'torso', rca: 'rth', rfo: 'rca',
};
const PART_NAMES = Object.keys(PARTS) as PartName[];
const LIMB_JOINTS: readonly (readonly [Limb, number, number, number])[] = [['larm', LS, LE, LW], ['rarm', RS, RE, RW], ['lleg', LH, LK, LA], ['rleg', RH, RK, RA]];
/** Each leg's knee, ankle and toe (`ankles`). */
const FEET: readonly (readonly ['lleg' | 'rleg', number, number, number])[] = [['lleg', LK, LA, LT], ['rleg', RK, RA, RT]];
/** How far a foot turns from where it stood: up (dorsiflexion), down (plantarflexion), to either side; radians. */
const ANKLE_UP = 0.35, ANKLE_DOWN = 1.2, ANKLE_SIDE = 0.45;
/** Deeper than this under the middle of a bone: a bank beside it, not ground under it - left to its ends (`collide`). */
const STEP_FACE = m(0.08);

/** The parts gone with each limb shot off (as the living lose them, `riggedCitizens` maim). */
const LOST_PARTS: Readonly<Record<Severable, readonly PartName[]>> = {
  armL: ['lfa'], armR: ['rfa'], legL: ['lca', 'lfo'], legR: ['rca', 'rfo'], head: ['head'],
};

/** The bones that collide along their length (`capsules`), and where along each the body is tested. */
const CAPSULE_BONES: readonly (readonly [number, number])[] = [
  [PEL, CHE], [CHE, NEC], [NEC, HEA], [HEA, TOP], [LS, LE], [LE, LW], [RS, RE], [RE, RW],
  [LH, LK], [LK, LA], [RH, RK], [RK, RA], [LA, LT], [RA, RT], [LS, RS], [LH, RH],
];
const CAPSULE_SAMPLES: readonly number[] = [0.33, 0.67];

/** What tears off a body right under a blow: the particles that go with it. */
const LIMBS: readonly (readonly number[])[] = [[HEA, TOP], [LS, LE, LW], [RS, RE, RW], [LH, LK, LA, LT], [RH, RK, RA, RT]];

const GRAVITY = m(9.8);
const STEP = 1 / 90;
const ITERATIONS = 10;
/** Speed kept per step in the air. */
const AIR = 0.9995;
/** Seconds a body lies before it starts to sink away, and how long that takes. */
// The dead stay where they fell (the player wants the aftermath kept, GTA-like).
const LIE = Infinity;
const SINK = 12;
/** Seconds of simulation after which a body is put to rest whatever it is doing. */
const SETTLE = 14;
/** The living: most seconds falling before they lie still, and the blend from lying into the get-up clip. */
const FALL_MOST = 4;
const RISE_BLEND = 0.7;
/** The get-up clip's length when it has not loaded yet. */
const RISE_CLIP = 1.6;
/** The clip a body that fell gets up with. */
const RISE_KEY: 'crouchUp' | 'idle' = 'crouchUp';
const MAX_BODIES = 40;
/** Seconds the gravely hurt lie writhing before they try to crawl off (face down). */
const CRAWL_AFTER = 4;
/** Seconds from lying face down to on hands and knees, ready to crawl. */
const CRAWL_UP = 1.1;
/** Bodies simulated by Jolt (`ragdollJolt.ts`), not the stick figure */
const JOLT = typeof location !== 'undefined' && new URLSearchParams(location.search).get('ragdoll') !== 'verlet';

/** Starts loading the physics the bodies fall with (Jolt): when the Actions are chosen, or the first time a body falls. */
export function warmPhysics(): void {
  if (JOLT) startJolt();
}
/** World units in a metre (Jolt works in metres). */
const METRE = m(1);
/** Jolt's parts: the trunk, the head (with the neck), and each limb's bones. */
const J_TORSO = 0, J_HEAD = 1, J_LUA = 2, J_LFA = 3, J_RUA = 4, J_RFA = 5, J_LTH = 6, J_LCA = 7, J_LFO = 8, J_RTH = 9, J_RCA = 10, J_RFO = 11;
/** The Jolt part each drawn part moves with. */
const J_PART: Readonly<Record<PartName, number>> = {
  torso: J_TORSO, neck: J_HEAD, head: J_HEAD, lua: J_LUA, lfa: J_LFA, rua: J_RUA, rfa: J_RFA,
  lth: J_LTH, lca: J_LCA, lfo: J_LFO, rth: J_RTH, rca: J_RCA, rfo: J_RFO,
};
/** What each limb is torn from: the part left with the stump. */
const J_STUMP: Readonly<Record<Severable, number>> = { armL: J_LUA, armR: J_RUA, legL: J_LTH, legR: J_RTH, head: J_TORSO };
/** Parts joined to each other (parent, child): they do not collide. */
const J_PAIRS: readonly (readonly [number, number])[] = [
  [J_TORSO, J_HEAD], [J_TORSO, J_LUA], [J_LUA, J_LFA], [J_TORSO, J_RUA], [J_RUA, J_RFA],
  [J_TORSO, J_LTH], [J_LTH, J_LCA], [J_LCA, J_LFO], [J_TORSO, J_RTH], [J_RTH, J_RCA], [J_RCA, J_RFO],
];

type Fate = 'dead' | 'torn' | 'knocked' | 'trip';

interface Stick { readonly a: number; readonly b: number; readonly min: number; readonly max: number; broken: boolean }

interface Wall extends RagdollWall { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

/** Somebody alive on the ground: falling, lying a moment, then getting up. */
interface Survivor {
  readonly id: number;
  phase: 'fall' | 'lie' | 'rise';
  t: number;
  lie: number;
  /** Down for good and hurt, writhing where they lie (`writhe`): seconds since they lay. */
  crawl?: { since: number };
  /** Where and which way they get up, and the lying bones blended from. */
  root?: Matrix4;
  from?: Matrix4[];
  clip: number;
  /** Whether the get-up clip is baked. */
  ready?: boolean;
  /** Getting up from lying (`rise`): the body moved through key poses from where it lies */
  keys?: { stages: { from: Vector3[]; to: Vector3[]; start: number; end: number; roll?: { axis: Vector3; at: Vector3; lift: number } }[] };
  pre?: number;
  blend?: number;
  /** The captured getting-up off the ground played (face down, face up), when there is one. */
  riseKey?: 'getUpFront' | 'getUpBack' | 'crawl';
  /** How far into it they go (onto hands and knees, to crawl: `writhe`); all the way when absent. */
  riseMax?: number;
}

interface Body {
  readonly index: number;
  readonly scale: number;
  readonly p: Vector3[];
  readonly o: Vector3[];
  readonly inv: number[];
  readonly radius: number[];
  readonly ground: number[];
  readonly sticks: Stick[];
  readonly bonePart: PartName[];
  readonly parents: number[];
  readonly pos0: Vector3[];
  readonly rot0: Quaternion[];
  readonly scl0: Vector3[];
  readonly origin0: Record<PartName, Vector3>;
  readonly frame0: Record<PartName, Matrix4>;
  /** Limb bend normals carried from frame to frame, so a straight limb keeps its last bend. */
  readonly normals: Record<Limb, Vector3>;
  /** +1 or -1: which way side x spine points the body's front. */
  readonly front: number;
  /** Each foot's way where it stood, in its shin's frame (`ankles`): its pitch and its turn out of the leg's plane, radians. */
  ankle: Record<'lleg' | 'rleg', { pitch: number; yaw: number }>;
  readonly inverses: Matrix4[];
  /** Each bone's bind matrix (the inverse of its inverse). */
  readonly binds: Matrix4[];
  /** Each particle's bone (-1: none of its own), for poses read off the skeleton (`particlesOf`). */
  readonly jointBone: number[];
  /** local * bind^-1 and its inverse: between the drawn instance's space and a bone's matrix. */
  readonly rebind: Matrix4;
  readonly unbind: Matrix4;
  readonly walls: Wall[];
  torn: boolean;
  /** Parts lost before the fall (shot off, `Casualty.lost`): drawn closed at their joint. */
  lostParts: Set<PartName>;
  survivor: Survivor | undefined;
  /** A limb torn off, a body of its own (`detach`) */
  pin?: { readonly root: number; readonly keep: ReadonlySet<number> };
  /** Called when the body goes (a twin given back). */
  drop?: (() => void) | undefined;
  /** Burnt black (a bomb's direct hit). */
  charred?: boolean;
  /** Whose body it was (the casualty's id), for probes. */
  recordId?: number;
  /** Shots taken on the ground, all told and by part (`shootBody`). */
  hits?: number;
  partHits?: Partial<Record<BodyPart, number>>;
  /** Shot to a heap of meat (`mush`). */
  mush?: boolean;
  /** Opened at the belly, the guts out (`openBelly`). */
  opened?: boolean;
  /** Seconds left of joint friction (`joints`): a body just struck moves as a body, not a bundle of loose sticks */
  stiff?: number;
  /** Which piece each particle is on: the body itself, or a limb torn off. */
  comp: number[];
  palettes: Float32Array[];
  readonly anchor: Matrix4;
  still: number;
  asleep: boolean;
  age: number;
  flying: number;
  pooled: boolean;
  /** Simulated by Jolt (`ragdollJolt.ts`): its parts; the colliders made for it */
  jolt?: JoltRagdoll | undefined;
  colliders?: { list: JoltStatic[]; users: number } | undefined;
  synced?: { p: Vector3[]; o: Vector3[] } | undefined;
  splats: number;
  spray: number;
  /** Its bones' world matrices and skin palettes, written in place frame after frame (`bonesWorld`, `palettes`, `risePalette`). */
  posed?: Posed | undefined;
}

/** A body's arrays kept for its drawing: made once, written every frame. */
interface Posed {
  readonly world: Matrix4[];
  readonly target: Matrix4[];
  readonly blended: Matrix4[];
  readonly solved: Uint8Array;
  readonly on: Uint8Array;
  readonly pieces: Float32Array[];
  readonly shown: Float32Array[];
  readonly rise: Float32Array;
  readonly risen: Float32Array[];
}

const tmpA = new Vector3(), tmpB = new Vector3(), tmpC = new Vector3(), tmpD = new Vector3(), tmpE = new Vector3();
/** Scratch for the drawing of a body (`bonesWorld`, `palettes`, `risePalette`): one frame's sums, nothing kept. */
const poseSide = new Vector3(), poseAxis = new Vector3(), posePos = new Vector3(), poseQuat = new Quaternion();
const poseF = new Matrix4(), poseF0t = new Matrix4(), poseBack = new Matrix4(), poseInv = new Matrix4(), poseM = new Matrix4(), poseA = new Matrix4(), poseB = new Matrix4();
const poseP0 = new Vector3(), poseQ0 = new Quaternion(), poseS0 = new Vector3(), poseP1 = new Vector3(), poseQ1 = new Quaternion(), poseS1 = new Vector3();
const PART_TURN = Object.fromEntries(PART_NAMES.map((part) => [part, new Quaternion()])) as Record<PartName, Quaternion>;
const PART_ORIGIN = Object.fromEntries(PART_NAMES.map((part) => [part, new Vector3()])) as Record<PartName, Vector3>;
/** The axes a body's frame falls back on when its particles give none (three's space: y up). */
const WORLD_UP: Readonly<Vector3> = new Vector3(0, 1, 0);
const WORLD_SIDE: Readonly<Vector3> = new Vector3(1, 0, 0);

/** An angle brought within [lo, hi] (radians, the range under a turn): itself when inside, else the nearer end round the circle. */
function clampAngle(a: number, lo: number, hi: number): number {
  const mid = (lo + hi) / 2;
  const x = mid + Math.atan2(Math.sin(a - mid), Math.cos(a - mid));
  if (x >= lo && x <= hi) return a;
  const toLo = Math.abs(Math.atan2(Math.sin(x - lo), Math.cos(x - lo)));
  const toHi = Math.abs(Math.atan2(Math.sin(x - hi), Math.cos(x - hi)));
  return toLo < toHi ? lo : hi;
}
const UP = new Vector3(0, 1, 0);

/** A frame with its x along `x` and its z as near `ref` as stays square to x. */
function frameOf(x: Vector3, ref: Vector3, out: Matrix4): Matrix4 {
  const ax = tmpA.copy(x).normalize();
  const az = tmpB.copy(ref).addScaledVector(ax, -ref.dot(ax));
  if (az.lengthSq() < 1e-10) az.set(ax.y, -ax.x, 0.3).addScaledVector(ax, -az.dot(ax));
  az.normalize();
  const ay = tmpC.crossVectors(az, ax);
  return out.makeBasis(ax, ay, az);
}

const smooth = (t: number): number => { const k = Math.min(1, Math.max(0, t)); return k * k * (3 - 2 * k); };

/** One body as the weapons lab measures it (`Ragdolls.probe`). Distances in metres. */
export interface RagdollProbe {
  /** The person's id (alive or dead: the record's), or -1 for a piece torn off. */
  readonly id: number;
  readonly phase: string;
  readonly piece: boolean;
  readonly asleep: boolean;
  readonly charred: boolean;
  /** Particles: world x, y and height (world units). */
  readonly points: readonly (readonly [number, number, number])[];
  /** Deepest a particle sits under the ground it lies on (its radius counted), metres; 0 when none does. */
  readonly underGround: number;
  /** Deepest a particle sits inside a wall, a pole, a car (below its top), metres. */
  readonly inWall: number;
  /** Worst bone off its length, as a share of it (0: all exact). */
  readonly boneError: number;
  /** Fastest particle, metres a second. */
  readonly speed: number;
  /** Parts gone. */
  readonly lost: readonly string[];
  readonly hits: number;
}

export interface Ragdolls {
  /** Takes in the casualties of blows (each once): bodies thrown from the pose they were last drawn in. */
  absorb(list: readonly Casualty[], citizens: RagdollCitizens, world: RagdollWorld): void;
  /** People inside a struck building, thrown out of it - through its walls and windows - from the floor they were on. */
  fling(list: readonly Occupant[], citizens: RagdollCitizens, world: RagdollWorld): void;
  /** A drop of blood on the ground at world (x, y) (a trail behind somebody bleeding). */
  drip(x: number, y: number, z: number, size: number): void;
  /** Called where a body is torn apart (world x, y, height z; the way it flew; how fast): the renderer throws its pieces. */
  onGore: ((x: number, y: number, z: number, dirX: number, dirY: number, speed: number, kind: 'torn' | 'dead') => void) | null;
  /** Somebody falling (a `fall` pause), from the pose they were last drawn in: tripping forwards, or knocked towards `away` */
  trip(id: number, heading: number, citizens: RagdollCitizens, world: RagdollWorld, away?: number | null): void;
  /** Whether somebody's own body is on the ground here, so the crowd does not draw them standing too. */
  hides(id: number): boolean;
  /** A shot along the line of sight from `a` to `b` (three's frame) at the bodies on the ground */
  shootBody(a: Vector3, b: Vector3): { alive: number; part: BodyPart } | 'hit' | null;
  /** Lets go of those who are up again once the simulation has them up too (`down` false). */
  release(down: (id: number) => boolean): void;
  update(dt: number, world: RagdollWorld): void;
  draw(citizens: RagdollCitizens, world: RagdollWorld): void;
  /** The blood the bodies left. */
  readonly decals: BloodDecal[];
  /** Bodies drawn, still moving, pieces, and the living among them (for probes). */
  stats(): { bodies: number; moving: number; pieces: number; living: number };
  /** Each body's pelvis, phase and fate (for probes). */
  debug(): { pelvis: number[]; head: number[]; asleep: boolean; phase: string; torn: boolean }[];
  /** Everything about each body for a test bench (the weapons lab): its particles */
  probe(): RagdollProbe[];
  /** Every body, piece and stain gone (the weapons lab's clean slate). */
  clear(): void;
}

export function createRagdolls(exhaust: Exhaust, getUp: GetUp, gore: Gore | null = null): Ragdolls {
  const bodies: Body[] = [];
  // Jolt (some 3.5 MB of WebAssembly) is loaded when the Actions are taken up (`warmPhysics`), not in every session
  let separated = false;
  const decals: BloodDecal[] = [];
  /** The casualty records already turned into bodies (`absorb`). */
  const taken = new WeakSet<Casualty>();
  let clock = 0;

  const api: { onGore: Ragdolls['onGore'] } = { onGore: null };
  const bleed = (x: number, y: number, z: number, size: number, spread: number): void => {
    if (decals.length >= 400) decals.shift();
    decals.push({ x, y, z, angle: Math.random() * Math.PI * 2, size, spread, age: 0 });
  };

  /** A body standing as it was last drawn, at rest; null when that pose is not known. */
  const build = (id: number, heading: number, citizens: RagdollCitizens, world: RagdollWorld, x: number, y: number, fate: Fate,
    given?: { index: number; palette: Float32Array; transform: Matrix4 }): Body | null => {
    const pose = given ?? citizens.capturedPose(id);
    const sk = pose ? citizens.skeletonOf(pose.index) : null;
    if (!pose || !sk) return null;
    const bones = sk.names.length;
    // Each bone's world matrix in the pose drawn.
    const rebind = sk.local.clone().multiply(sk.bind.clone().invert());
    const unbind = rebind.clone().invert();
    const binds = sk.inverses.map((inv) => inv.clone().invert());
    const pos0: Vector3[] = [], rot0: Quaternion[] = [], scl0: Vector3[] = [];
    const g = new Matrix4(), w = new Matrix4();
    for (let i = 0; i < bones; i++) {
      w.fromArray(pose.palette, i * 16).multiply(binds[i]!);
      g.multiplyMatrices(pose.transform, rebind).multiply(w);
      const p = new Vector3(), q = new Quaternion(), s = new Vector3();
      g.decompose(p, q, s);
      pos0.push(p); rot0.push(q); scl0.push(s);
    }
    const at = (name: string): Vector3 | null => { const i = sk.names.indexOf(name); return i >= 0 ? pos0[i]!.clone() : null; };
    const p: Vector3[] = [];
    for (let k = 0; k < BEL; k++) {
      const name = JOINTS[k]!;
      let v = name ? at(name) : null;
      if (k === TOP) v = p[HEA]!.clone().addScaledVector(tmpD.subVectors(p[HEA]!, p[NEC]!), 1.4);
      if (!v && (k === LT || k === RT)) v = p[k - 1]!.clone();
      if (!v) return null;
      p.push(v);
    }
    // The way the body faced: from its feet, or failing that its heading.
    const forward = new Vector3().subVectors(p[LT]!, p[LA]!).add(tmpD.subVectors(p[RT]!, p[RA]!)).setY(0);
    if (forward.lengthSq() < 1e-8) forward.set(Math.cos(heading), 0, -Math.sin(heading));
    forward.normalize();
    const scale = new Vector3().setFromMatrixScale(pose.transform).x;
    p.push(p[PEL]!.clone().addScaledVector(forward, 0.14 * scale));
    // Which part moves each bone: its own key, or the nearest key above it.
    const bonePart: PartName[] = [];
    for (let i = 0; i < bones; i++) {
      let j = i;
      let part: PartName | undefined;
      while (j >= 0 && !(part = KEY_PART[sk.names[j]!])) j = sk.parents[j]!;
      bonePart.push(part ?? 'torso');
    }
    // Sticks: the bones and a braced torso, and the ranges the joints allow.
    const sticks: Stick[] = [];
    const len = (a: number, b: number): number => p[a]!.distanceTo(p[b]!);
    const rigid = (a: number, b: number): void => { const l = len(a, b); sticks.push({ a, b, min: l, max: l, broken: false }); };
    const range = (a: number, b: number, lo: number, hi: number): void => { const l = len(a, b); sticks.push({ a, b, min: l * lo, max: l * hi, broken: false }); };
    /** How close a limb's ends may come as its middle joint folds. */
    const fold = (a: number, mid: number, b: number, lo: number): void => {
      const l = len(a, mid) + len(mid, b);
      sticks.push({ a, b, min: l * lo, max: l, broken: false });
    };
    for (const [a, b] of [
      [PEL, CHE], [PEL, LH], [PEL, RH], [LH, RH], [BEL, PEL], [BEL, LH], [BEL, RH], [BEL, CHE],
      [CHE, LH], [CHE, RH], [CHE, LS], [CHE, RS], [LS, RS], [LS, LH], [RS, RH], [LS, RH], [RS, LH], [BEL, LS], [BEL, RS],
      [CHE, NEC], [NEC, LS], [NEC, RS], [NEC, HEA], [HEA, TOP],
      [LS, LE], [LE, LW], [RS, RE], [RE, RW], [LH, LK], [LK, LA], [LA, LT], [RH, RK], [RK, RA], [RA, RT],
    ] as const) rigid(a, b);
    // The neck bends, the head nods and turns, but neither folds into the chest.
    range(HEA, CHE, 0.88, 1.03);
    range(TOP, CHE, 0.82, 1.03);
    range(TOP, BEL, 0.85, 1.1);
    // Not folded past what the clothes follow
    fold(LS, LE, LW, 0.42); fold(RS, RE, RW, 0.42);
    fold(LH, LK, LA, 0.5); fold(RH, RK, RA, 0.5);
    // Ankles: `ankles` (an angle range; a knee-to-toe distance let the foot swing round the shin).
    range(CHE, LE, 0.5, 1.6); range(CHE, RE, 0.5, 1.6);
    range(BEL, LK, 0.55, 1.45); range(BEL, RK, 0.55, 1.45);
    range(CHE, LK, 0.55, 1.25); range(CHE, RK, 0.55, 1.25);
    // Metres on this body (its drawn scale is world units per model metre).
    const metre = scale;
    sticks.push({ a: LK, b: RK, min: 0.14 * metre, max: Infinity, broken: false });
    sticks.push({ a: LA, b: RA, min: 0.1 * metre, max: Infinity, broken: false });
    sticks.push({ a: LW, b: RW, min: 0.08 * metre, max: Infinity, broken: false });
    const inv = p.map((_, k) => (k === PEL || k === CHE || k === BEL || k === LH || k === RH || k === LS || k === RS ? 0.45 : k === HEA ? 0.7 : 1));
    const radius = p.map((_, k) => metre * (k === HEA ? 0.11 : k === TOP ? 0.05 : k === PEL || k === CHE || k === BEL ? 0.12 : k === LS || k === RS || k === LH || k === RH ? 0.08
      // Limbs as thick as they are drawn: thinner, a knee or a shin sank into the ground.
      : k === LW || k === RW || k === LT || k === RT ? 0.055 : 0.07));
    const walls: Wall[] = world.wallsNear(x, y, m(35))
      // A wall the body starts in or against does not hold it: the building it is blown out of
      .filter((wall) => !inside(wall.ring, x, y) && !p.some((v, k) => {
        if (v.y > wall.top + radius[k]!) return false;
        const wx = v.x, wy = -v.z;
        if (inside(wall.ring, wx, wy)) return true;
        const e = nearestEdge(wall.ring, wx, wy);
        return Math.hypot(wx - e.x, wy - e.y) < radius[k]!;
      }))
      .map((wall) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const q of wall.ring) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
        return { ...wall, x0, y0, x1, y1 };
      });
    const side0 = new Vector3().subVectors(p[RH]!, p[LH]!).add(tmpD.subVectors(p[RS]!, p[LS]!)).normalize();
    const spine0 = new Vector3().subVectors(p[CHE]!, p[PEL]!);
    const front = new Vector3().crossVectors(side0, spine0).dot(forward) >= 0 ? 1 : -1;
    const living = fate === 'knocked' || fate === 'trip';
    const body: Body = {
      index: pose.index, scale, p, o: p.map((v) => v.clone()), inv, radius, ground: p.map(() => -Infinity), sticks,
      jointBone: JOINTS.map((n) => (n ? sk.names.indexOf(n) : -1)),
      bonePart, parents: sk.parents, pos0, rot0, scl0,
      origin0: {} as Record<PartName, Vector3>, frame0: {} as Record<PartName, Matrix4>,
      normals: { larm: side0.clone(), rarm: side0.clone(), lleg: side0.clone(), rleg: side0.clone() },
      front, ankle: { lleg: { pitch: 0, yaw: 0 }, rleg: { pitch: 0, yaw: 0 } },
      inverses: sk.inverses, binds, rebind, unbind, walls, torn: fate === 'torn', lostParts: new Set<PartName>(),
      survivor: living ? { id, phase: 'fall', t: 0, lie: fate === 'trip' ? 0.6 + Math.random() * 0.8 : 1.5 + Math.random() * 1.5, clip: RISE_CLIP } : undefined,
      comp: p.map(() => 0), palettes: [], anchor: new Matrix4(), still: 0, asleep: false, age: 0, flying: 0, pooled: false, splats: 0, spray: 0,
    };
    components(body);
    // The frames at rest, that each part's turn is measured from.
    const side = torsoSide(body, new Vector3());
    for (const [limb] of LIMB_JOINTS) body.normals[limb].copy(side);
    updateNormals(body, side, 1);
    // Each foot's way as it stood, in its shin's frame (`ankles`).
    for (const [limb, knee, ankle, toe] of FEET) {
      const s = new Vector3().subVectors(p[ankle]!, p[knee]!).normalize();
      const n = body.normals[limb].clone().addScaledVector(s, -body.normals[limb].dot(s)).normalize();
      const f = new Vector3().crossVectors(n, s);
      const d = new Vector3().subVectors(p[toe]!, p[ankle]!).normalize();
      body.ankle[limb] = { pitch: Math.atan2(d.dot(s), d.dot(f)), yaw: Math.asin(Math.max(-1, Math.min(1, d.dot(n)))) };
    }
    for (const part of PART_NAMES) {
      body.origin0[part] = p[PARTS[part].origin]!.clone();
      body.frame0[part] = partFrame(body, part, side, new Matrix4());
    }
    return body;
  };

  /** Sets every particle moving: `v(k)` its velocity. */
  const launch = (body: Body, v: (k: number, out: Vector3) => Vector3): void => {
    const vel = new Vector3();
    for (let k = 0; k < body.p.length; k++) body.o[k]!.copy(body.p[k]!).addScaledVector(v(k, vel.set(0, 0, 0)), -STEP);
  };

  /** A blast's push on a body: away from it and up, the legs taken from under it, arms and legs scattered. */
  const blast = (body: Body, c: Casualty, strength: number): Vector3 => {
    const p = body.p;
    const dir = new Vector3(c.x - c.blastX, 0, -(c.y - c.blastY));
    if (dir.lengthSq() < 1e-6) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    dir.normalize();
    const speed = strength * (0.85 + Math.random() * 0.3);
    const lift = speed * (0.45 + 0.25 * Math.random());
    let low = Infinity, high = -Infinity;
    for (const v of p) { low = Math.min(low, v.y); high = Math.max(high, v.y); }
    const com = p.reduce((s, v) => s.add(v), new Vector3()).divideScalar(p.length);
    // Pitch: head back towards the blast; a little roll and twist besides.
    const spin = new Vector3().crossVectors(dir, UP).normalize().multiplyScalar((2 + 5 * c.power) * (0.7 + 0.6 * Math.random()))
      .addScaledVector(dir, (Math.random() - 0.5) * 4)
      .addScaledVector(UP, (Math.random() - 0.5) * 5);
    const scatter = LIMB_JOINTS.map(() => new Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).multiplyScalar(speed * 0.45));
    launch(body, (k, v) => {
      const h = (p[k]!.y - low) / Math.max(1e-3, high - low);
      v.copy(dir).multiplyScalar(speed * (1.1 - 0.25 * h));
      v.y += lift;
      v.add(tmpD.crossVectors(spin, tmpC.subVectors(p[k]!, com)));
      LIMB_JOINTS.forEach(([, a, mid, b], i) => {
        if (k === b) v.add(scatter[i]!);
        else if (k === mid) v.addScaledVector(scatter[i]!, 0.6);
        else if (k === a) v.addScaledVector(scatter[i]!, 0.2);
      });
      if (k === LT) v.add(scatter[2]!);
      if (k === RT) v.add(scatter[3]!);
      return v;
    });
    return dir;
  };

  /** The particles a bullet strikes, by where it went in. */
  const STRUCK: Readonly<Record<BodyPart, readonly number[]>> = {
    head: [HEA, TOP], torso: [CHE, NEC, BEL], armL: [LE, LW], armR: [RE, RW], legL: [LK, LA], legR: [RK, RA],
  };

  /** A bullet's push: the part it went into knocked back from the shooter, the chest a little with it */
  const shove = (body: Body, c: Casualty): Vector3 => {
    const dir = new Vector3(c.x - c.blastX, 0, -(c.y - c.blastY));
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const hit = STRUCK[c.struck ?? 'torso'];
    const leg = c.struck === 'legL' || c.struck === 'legR';
    for (let k = 0; k < body.p.length; k++) {
      const push = hit.includes(k) ? m(leg ? 2.2 : 1.6) : k === CHE || k === NEC || k === HEA || k === TOP ? m(0.7) : 0;
      if (push > 0) body.o[k]!.addScaledVector(dir, -push * STEP);
    }
    // And over it goes, backwards, the way the round went: the upper body carried on along it while the knees give.
    const buckle = c.kind === 'knocked' && leg;
    const over = buckle ? new Vector3(Math.cos(c.heading), 0, -Math.sin(c.heading)) : dir;
    for (const k of [CHE, NEC, HEA, TOP, LS, RS, BEL]) body.o[k]!.addScaledVector(over, -(buckle ? m(0.9) : c.kind === 'knocked' ? m(1.5) : m(1.8)) * STEP);
    body.o[PEL]!.addScaledVector(over, -m(buckle ? 0.2 : 0.5) * STEP);
    body.asleep = false;
    return dir;
  };

  /** The body of a casualty of a blow. */
  const spawn = (c: Casualty, citizens: RagdollCitizens, world: RagdollWorld,
    given?: { index: number; palette: Float32Array; transform: Matrix4 }): void => {
    const groundHere = world.groundAt(c.x, c.y);
    const known = bodies.find((b) => b.survivor?.id === c.id);
    if (known) {
      // On the ground already, and struck again: thrown again, and killed if it was a killing blow.
      if (c.faded) {
        // Bled out where they lay: the writhing stops, the body goes still in a pool.
        known.survivor = undefined;
        known.asleep = false; known.still = 0;
        const at = known.p[PEL]!;
        bleed(at.x, -at.z, world.groundAt(at.x, -at.z), m(1.6), 20);
        return;
      }
      if (c.kind !== 'knocked') {
        // Killed where the body lies, not where they first fell from.
        known.survivor = undefined; known.torn = false;
        const at = known.p[PEL]!;
        bleed(at.x, -at.z, world.groundAt(at.x, -at.z), m(0.8), 4);
      }
      else if (known.survivor) {
        const alive = known.survivor;
        alive.phase = 'fall'; alive.t = 0; delete alive.from;
        if (c.lieFor !== undefined) alive.lie = Math.max(alive.lie, c.lieFor);
        if (c.crawl && !alive.crawl) alive.crawl = { since: 0 };
      }
      for (const limb of c.lost ?? []) if (!(c.severed ?? []).includes(limb)) for (const part of LOST_PARTS[limb]) known.lostParts.add(part);
      known.asleep = false; known.still = 0; known.flying = 0;
      const away = c.struck ? shove(known, c) : blast(known, c, c.kind === 'knocked' ? m(2.5 + 4 * c.power) : m(4 + 9 * c.power));
      sever(known, c, away, citizens);
      if (c.opened && !known.opened && !known.pin) openBelly(known, away.clone().multiplyScalar(m(1.5)), 1 + Math.floor(Math.random() * 2));
      return;
    }
    const body = build(c.id, c.heading, citizens, world, c.x, c.y, c.kind, given);
    if (!body) { if (c.kind !== 'knocked') bleed(c.x, c.y, groundHere, m(1.8), 15); return; }
    for (const limb of c.lost ?? []) for (const part of LOST_PARTS[limb]) body.lostParts.add(part);
    body.recordId = c.id;
    if (body.survivor && c.lieFor !== undefined) body.survivor.lie = c.lieFor;
    // Bled out on their feet or crawling: the strength goes and they slump over, the trunk down and to a side
    if (c.faded) {
      const side = Math.random() < 0.5 ? 1 : -1;
      const lean = new Vector3(Math.cos(c.heading + side * Math.PI / 2), -1.2, -Math.sin(c.heading + side * Math.PI / 2));
      for (const k of [CHE, NEC, HEA, TOP, LS, RS, BEL]) body.o[k]!.addScaledVector(lean, -m(1.4) * STEP);
    }
    if (body.survivor && c.crawl) body.survivor.crawl = { since: 0 };
    // A bullet does not throw a body: a small push where it went in
    const speed = c.struck ? m(0.6) : c.kind === 'knocked' ? m(2.5 + 4 * c.power) : m(4 + 9 * c.power);
    const dir = c.struck ? shove(body, c) : blast(body, c, speed);
    // Alive going down: the arms out the way they fall, to take it
    if (c.struck && c.kind === 'knocked') {
      const leg = c.struck === 'legL' || c.struck === 'legR';
      const way = leg ? new Vector3(Math.cos(c.heading), 0, -Math.sin(c.heading)) : dir;
      for (const k of [LW, RW, LE, RE]) body.o[k]!.addScaledVector(way, -m(k === LW || k === RW ? 1.4 : 0.8) * STEP).y += m(0.6) * STEP;
    }
    // Joint friction while it falls: dead weight, not a rag.
    body.stiff = 1.6;
    const chest = body.p[CHE]!;
    if (c.kind === 'torn') {
      // Torn: thrown harder, limbs flung, blood everywhere - but whole.
      for (const limb of LIMBS.filter(() => Math.random() < 0.5)) {
        const kick = new Vector3(Math.random() - 0.5, 0.3 + Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(speed * 0.5).addScaledVector(dir, speed * 0.3);
        for (const k of limb) body.o[k]!.addScaledVector(kick, -STEP);
      }
      exhaust.burst(chest.x, -chest.z, chest.y, 90, 4, m(0.6), m(0.06), 1.2);
      for (let k = 0; k < 18; k++) {
        const a = Math.random() * Math.PI * 2, r = m(1 + Math.random() * 6);
        bleed(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, groundHere, m(0.5 + Math.random() * 1.1), 0);
      }
      bleed(c.x, c.y, groundHere, m(3.4), 1.8);
      // Pieces of them: an arm, a leg, and what was inside, flung over the street.
      api.onGore?.(chest.x, -chest.z, chest.y, dir.x, -dir.z, speed, 'torn');
    } else if (c.kind === 'dead') {
      exhaust.burst(chest.x, -chest.z, chest.y, 24, 4, m(0.25), m(0.045), 0.9);
      // Dead: the pool spreads under the body where it comes to rest
      for (let k = 0; k < 4; k++) {
        const a = Math.random() * Math.PI * 2, r = m(0.8 + Math.random() * 2.5);
        bleed(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, groundHere, m(0.3 + Math.random() * 0.5), 0);
      }
      if (!c.struck && Math.random() < 0.35) api.onGore?.(chest.x, -chest.z, chest.y, dir.x, -dir.z, speed * 0.6, 'dead');
    }
    add(body);
    sever(body, c, dir, citizens);
    // A blast tears a body open (one torn apart, most often); a bullet never does it at once
    if (!c.struck && (c.kind === 'torn' ? Math.random() < 0.7 : c.kind === 'dead' && Math.random() < 0.12)) {
      openBelly(body, dir.clone().multiplyScalar(m(3)), 2 + Math.floor(Math.random() * 3));
    }
    // Shot open (`walk.ts` shot: a grave trunk wound, two or three rounds in it).
    if (c.opened && !body.opened) openBelly(body, dir.clone().multiplyScalar(m(1.5)), 1 + Math.floor(Math.random() * 2));
  };

  /** What came off at this blow thrown off the body (`detach`), and the body burnt black right under a bomb. */
  const sever = (body: Body, c: Casualty, dir: Vector3, citizens: RagdollCitizens): void => {
    // Charred first: the pieces are twins of the body as it is.
    if (c.charred) { body.charred = true; citizens.char?.(body.index); }
    for (const limb of c.severed ?? []) {
      // A bullet takes a limb off and drops it near; a blast throws it.
      const speed = (c.struck ? m(0.8 + Math.random() * 0.8) : m(2.5 + 6 * Math.max(0.15, c.power))) * (0.7 + Math.random() * 0.6);
      const spread = c.struck ? m(0.6) : m(3);
      const kick = new Vector3(dir.x * speed + (Math.random() - 0.5) * spread, (c.struck ? m(0.4 + Math.random() * 0.6) : m(1.5 + Math.random() * 3) * (0.6 + c.power)),
        dir.z * speed + (Math.random() - 0.5) * spread);
      detach(body, limb, citizens, kick);
    }
  };

  /** The people's side and the world as last given (`shootBody` comes between frames). */
  let lastCitizens: RagdollCitizens | null = null;
  let world0: RagdollWorld | null = null;

  /** A body shot to pieces: every limb and the head off it if still on, the trunk soaked through */
  const mush = (body: Body, citizens: RagdollCitizens): void => {
    body.mush = true;
    const at = body.p[body.pin ? body.pin.root : CHE]!;
    if (!body.pin) {
      for (const limb of ['head', 'armL', 'armR', 'legL', 'legR'] as const) {
        if (LOST_PARTS[limb].every((q) => body.lostParts.has(q))) continue;
        detach(body, limb, citizens, new Vector3((Math.random() - 0.5) * m(3), m(1 + Math.random() * 2), (Math.random() - 0.5) * m(3)));
      }
    }
    citizens.drench?.(body.index);
    if (!body.pin) { body.opened = false; openBelly(body, new Vector3(0, m(1), 0), 6); }
    exhaust.burst(at.x, -at.z, at.y, 80, 4, m(0.5), m(0.06), 1.1);
    const gx = at.x, gy = -at.z, g = world0?.groundAt(gx, gy) ?? at.y;
    bleed(gx, gy, g, m(body.pin ? 1.2 : 2.8), body.pin ? 6 : 14);
    for (let n = 0; n < (body.pin ? 4 : 12); n++) {
      const a = Math.random() * Math.PI * 2, r = m(0.4 + Math.random() * 2.2);
      bleed(gx + Math.cos(a) * r, gy + Math.sin(a) * r, g, m(0.3 + Math.random() * 0.6), 0);
    }
    api.onGore?.(at.x, -at.z, at.y, 0, 0, m(2), 'torn');
    body.asleep = false;
  };

  /** The belly opened: the guts hanging out of it, swinging with the body, some spilled on the ground. */
  const openBelly = (body: Body, kick: Vector3, organs = 0): void => {
    if (!gore || body.opened || body.pin) return;
    body.opened = true;
    gore.spill(() => (bodies.includes(body) ? body.p[BEL]! : null), kick);
    if (Math.random() < 0.5) gore.spill(() => (bodies.includes(body) ? body.p[PEL]! : null), kick.clone().multiplyScalar(0.6));
    if (organs > 0) gore.scatter(body.p[BEL]!.clone(), organs, kick);
    exhaust.burst(body.p[BEL]!.x, -body.p[BEL]!.z, body.p[BEL]!.y, 30, 4, m(0.2), m(0.04), 0.9);
  };

  /** A bone's end out of a stump: from joint `at`, along `from` to `at` and on, `len` long, while the body lasts. */
  const boneOut = (body: Body, from: number, at: number, len: number): void => {
    if (!gore) return;
    const tip = new Vector3(), dir = new Vector3();
    gore.bone(() => {
      if (!bodies.includes(body)) return null;
      const a = body.p[at]!;
      dir.subVectors(a, body.p[from]!);
      const l = dir.length();
      if (l < 1e-6) return null;
      tip.copy(a).addScaledVector(dir, len / l);
      return [a, tip] as const;
    });
  };

  /** The stump and the cut end of each part that can come off: the joint it went at, and the particle it points from. */
  const STUMP: Readonly<Record<Severable, { body: readonly [number, number]; piece: readonly [number, number] }>> = {
    armL: { body: [LS, LE], piece: [LW, LE] }, armR: { body: [RS, RE], piece: [RW, RE] },
    legL: { body: [LH, LK], piece: [LA, LK] }, legR: { body: [RH, RK], piece: [RA, RK] },
    head: { body: [CHE, NEC], piece: [TOP, HEA] },
  };

  const remove = (i: number): void => {
    bodies[i]?.drop?.();
    release(bodies[i]);
    bodies.splice(i, 1);
  };
  /** A body's parts out of Jolt, and its colliders once nothing else stands on them. */
  const release = (body: Body | undefined): void => {
    if (!body) return;
    body.jolt?.destroy();
    body.jolt = undefined;
    const c = body.colliders;
    if (c && --c.users <= 0) joltWorld()?.release(c.list);
    body.colliders = undefined;
  };

  /** A limb (or the head) torn off at a blow: a body of its own from here */
  const detach = (body: Body, limb: Severable, citizens: RagdollCitizens, kick: Vector3): void => {
    const parts = LOST_PARTS[limb];
    const index = citizens.twin ? citizens.twin(body.index) : body.index;
    if (index === null) { for (const part of parts) body.lostParts.add(part); return; }
    const keep = new Set<number>();
    for (const part of parts) { keep.add(PARTS[part].origin); keep.add(PARTS[part].to); }
    const root = PARTS[parts[0]!].origin;
    const piece: Body = {
      ...body,
      index,
      p: body.p.map((v) => v.clone()),
      o: body.o.map((v) => v.clone()),
      ground: body.ground.slice(),
      sticks: body.sticks.map((s) => ({ ...s, broken: s.broken || !(keep.has(s.a) && keep.has(s.b)) })),
      normals: { larm: body.normals.larm.clone(), rarm: body.normals.rarm.clone(), lleg: body.normals.lleg.clone(), rleg: body.normals.rleg.clone() },
      lostParts: new Set(PART_NAMES.filter((part) => !parts.includes(part))),
      survivor: undefined, pin: { root, keep }, drop: index !== body.index ? () => citizens.untwin?.(index) : undefined,
      comp: [], palettes: [], anchor: new Matrix4(), still: 0, asleep: false, age: 0, flying: 0, pooled: false, splats: 0, spray: 0, torn: true,
      posed: undefined,
    };
    components(piece);
    if (body.jolt) {
      // In Jolt: the joint holding it lets go, and its parts go with the piece
      const torn = [...new Set(parts.map((q) => J_PART[q]))];
      const at = body.p[limb === 'head' ? NEC : root]!.clone().divideScalar(METRE);
      const moved = body.p.map((_, k) => k).filter((k) => torn.includes(body.jolt!.partOf(k)));
      piece.jolt = body.jolt.tear(torn, J_STUMP[limb], at, moved, { particle: root, part: J_PART[parts[0]!] });
      piece.synced = body.synced ? { p: body.synced.p.map((v) => v.clone()), o: body.synced.o.map((v) => v.clone()) } : undefined;
      if (body.colliders) body.colliders.users++;
    }
    const spin = new Vector3((Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2).multiplyScalar(kick.length() * 0.6);
    for (const k of keep) piece.o[k]!.copy(piece.p[k]!).addScaledVector(kick, -STEP).addScaledVector(spin, k === root ? 0 : -STEP);
    for (const part of parts) body.lostParts.add(part);
    body.asleep = false;
    // The stump spurting.
    const at = body.p[root]!;
    exhaust.burst(at.x, -at.z, at.y, 30, 4, m(0.22), m(0.04), 0.9);
    add(piece);
    // Now and then the bone shows: out of the stump, out of the piece, or both.
    const stump = STUMP[limb];
    const roll = Math.random();
    if (roll < 0.55) boneOut(body, stump.body[0], stump.body[1], m(limb === 'head' ? 0.05 : 0.07));
    if (roll > 0.3 && roll < 0.8) boneOut(piece, stump.piece[0], stump.piece[1], m(limb === 'head' ? 0.04 : 0.06));
  };

  const add = (body: Body): void => {
    bodies.push(body);
    if (bodies.length > MAX_BODIES) {
      // The oldest of the dead goes first; the living get up on their own.
      const i = bodies.findIndex((b) => !b.survivor);
      remove(i >= 0 ? i : 0);
    }
  };

  return {
    decals,
    stats: () => ({
      bodies: bodies.length, moving: bodies.filter((b) => !b.asleep).length,
      pieces: bodies.reduce((n, b) => n + new Set(b.comp).size, 0), living: bodies.filter((b) => b.survivor).length,
    }),
    clear() {
      for (const b of bodies) { b.drop?.(); release(b); }
      bodies.length = 0;
      decals.length = 0;
    },
    probe: () => bodies.map((b) => {
      const M = b.scale || 1;
      let under = 0, inWall = 0, boneError = 0, speed = 0;
      b.p.forEach((v, k) => {
        if (b.pin && !b.pin.keep.has(k)) return;
        const g = b.ground[k]!;
        if (Number.isFinite(g)) under = Math.max(under, (g + b.radius[k]! * 0.5 - v.y) / M);
        speed = Math.max(speed, v.distanceTo(b.o[k]!) / STEP / M);
        for (const w of b.walls) {
          const x = v.x, y = -v.z;
          if (x < w.x0 || x > w.x1 || y < w.y0 || y > w.y1) continue;
          const top = w.roof ? w.roof(x, y) : w.top;
          if (v.y > top || !inside(w.ring, x, y)) continue;
          const e = nearestEdge(w.ring, x, y);
          inWall = Math.max(inWall, Math.min(Math.hypot(x - e.x, y - e.y), top - v.y) / M);
        }
      });
      for (const s of b.sticks) {
        if (s.broken || s.min !== s.max || (b.pin && !(b.pin.keep.has(s.a) && b.pin.keep.has(s.b)))) continue;
        const l = b.p[s.a]!.distanceTo(b.p[s.b]!);
        boneError = Math.max(boneError, Math.abs(l - s.min) / Math.max(1e-6, s.min));
      }
      return {
        id: b.survivor?.id ?? b.recordId ?? -1, phase: b.survivor?.phase ?? 'dead', piece: !!b.pin, asleep: b.asleep, charred: !!b.charred,
        points: b.p.map((v) => [v.x, -v.z, v.y] as const), underGround: Math.max(0, under), inWall, boneError, speed,
        lost: [...b.lostParts], hits: b.hits ?? 0,
      };
    }),
    debug: () => bodies.map((b) => ({
      pelvis: b.p[PEL]!.toArray(), head: b.p[HEA]!.toArray(), asleep: b.asleep, phase: `${b.survivor?.phase ?? 'dead'}${b.survivor ? `#${b.survivor.id}/${b.survivor.lie.toFixed(1)}${b.survivor.crawl ? 'c' : ''}` : b.pin ? '/piece' : ''}`, torn: b.torn,
    })),
    hides: (id) => bodies.some((b) => b.survivor?.id === id),
    release(down) {
      // Up: stood on the clip's last frame until the simulation lets them go too
      for (let i = bodies.length - 1; i >= 0; i--) {
        const alive = bodies[i]!.survivor;
        if (alive?.phase === 'rise' && alive.t >= (alive.pre ?? 0) + (alive.blend ?? RISE_BLEND) + alive.clip && !down(alive.id)) remove(i);
      }
    },
    drip(x, y, z, size) { bleed(x, y, z, size, 0); },
    get onGore() { return api.onGore; },
    set onGore(f) { api.onGore = f; },
    fling(list, citizens, world) {
      const loaded = citizens.loadedIndices();
      if (!loaded.length) return;
      const turn = new Quaternion(), place = new Vector3(), size = new Vector3();
      for (const o of list) {
        const index = o.index !== undefined && o.index !== null && loaded.includes(o.index) ? o.index : loaded[Math.abs(o.id) % loaded.length]!;
        const clip = citizens.clipPose(index, 'idle', (o.id % 97) / 97);
        if (!clip) continue;
        const transform = new Matrix4().compose(place.set(o.x, o.z, -o.y), turn.setFromAxisAngle(UP, o.heading + Math.PI / 2), size.setScalar(m(1)));
        // Torn: an arm, a leg, the head off; killed: now and then a limb.
        const all: Severable[] = ['head', 'armL', 'armR', 'legL', 'legR'];
        const severed = o.kind === 'torn' ? all.filter(() => Math.random() < 0.45)
          : o.kind === 'dead' && Math.random() < 0.35 ? [all[1 + Math.floor(Math.random() * 4)]!] : [];
        const c = { x: o.x, y: o.y, heading: o.heading, kind: o.kind, t: 0, id: o.id, gender: 'm', ageClass: 'adult', party: null,
          blastX: o.blastX, blastY: o.blastY, power: o.power, severed, lost: severed, charred: o.charred === true } as unknown as Casualty;
        spawn(c, citizens, world, { index, palette: clip.palette, transform });
      }
    },
    shootBody(a, b) {
      const citizens = lastCitizens;
      if (!citizens) return null;
      const ab = new Vector3().subVectors(b, a);
      const len2 = Math.max(1e-9, ab.lengthSq());
      let best: { body: Body; k: number; d: number; t: number } | null = null;
      for (const body of bodies) {
        for (let k = 0; k < body.p.length; k++) {
          if (body.pin && !body.pin.keep.has(k)) continue;
          if (k === BEL) continue;
          const v = body.p[k]!;
          const t = Math.max(0, Math.min(1, tmpA.subVectors(v, a).dot(ab) / len2));
          const d = tmpB.copy(a).addScaledVector(ab, t).distanceTo(v);
          const reach = body.radius[k]! * 1.8 + m(0.08);
          if (d < reach && (!best || t < best.t - 0.002 || (Math.abs(t - best.t) <= 0.002 && d < best.d))) best = { body, k, d, t };
        }
      }
      if (!best) return null;
      const { body, k } = best;
      const part: BodyPart = k === HEA || k === TOP ? 'head' : k === LS || k === LE || k === LW ? 'armL' : k === RS || k === RE || k === RW ? 'armR'
        : k === LH || k === LK || k === LA || k === LT ? 'legL' : k === RH || k === RK || k === RA || k === RT ? 'legR' : 'torso';
      if (body.survivor) return { alive: body.survivor.id, part };
      const dir = ab.clone().normalize();
      const at = body.p[k]!;
      // The bullet's push, the spray out of the far side, blood under it.
      if (body.jolt) body.jolt.push(k, dir.clone().multiplyScalar(2.2), 0.7);
      else body.o[k]!.addScaledVector(dir, -m(1.6) * STEP);
      body.asleep = false; body.still = 0; body.flying = 0;
      exhaust.burst(at.x + dir.x * m(0.15), -(at.z + dir.z * m(0.15)), at.y, 26, 4, m(0.18), m(0.035), 0.8);
      const gx = at.x + dir.x * m(0.5), gy = -(at.z + dir.z * m(0.5));
      bleed(gx, gy, world0?.groundAt(gx, gy) ?? at.y, m(0.5 + Math.random() * 0.4), 0);
      citizens.wound?.(body.index, part);
      body.hits = (body.hits ?? 0) + 1;
      const tally = body.partHits ??= {};
      tally[part] = (tally[part] ?? 0) + 1;
      if (part === 'torso' && !body.opened && (tally.torso ?? 0) >= 2) openBelly(body, dir.clone().multiplyScalar(m(1.2)), 1);
      // A limb shot off at the second hit (the head at the first or second).
      if (!body.pin && part !== 'torso') {
        const limb = part as Severable;
        const gone = LOST_PARTS[limb].every((q) => body.lostParts.has(q));
        if (!gone && tally[part]! >= (part === 'head' ? 1 + (Math.random() < 0.5 ? 1 : 0) : 2)) {
          const kick = dir.clone().multiplyScalar(m(1)).add(new Vector3((Math.random() - 0.5) * m(0.6), m(0.5 + Math.random() * 0.8), (Math.random() - 0.5) * m(0.6)));
          detach(body, limb, citizens, kick);
        }
      }
      // Shot to pieces: what is left a heap of meat, soaked, everything round it red.
      const bare = (['armL', 'armR', 'legL', 'legR', 'head'] as const).filter((l) => LOST_PARTS[l].every((q) => body.lostParts.has(q))).length;
      if (!body.pin && !body.mush && (body.hits >= 12 || (bare >= 3 && body.hits >= 8))) mush(body, citizens);
      else if (body.pin && body.hits >= 3 && !body.mush) mush(body, citizens);
      return 'hit';
    },
    absorb(list, citizens, world) {
      lastCitizens = citizens;
      world0 = world;
      for (const c of list) {
        // Each record once (two shots from the same place are two records).
        if (taken.has(c)) continue;
        taken.add(c);
        spawn(c, citizens, world);
      }
    },
    trip(id, heading, citizens, world, away = null) {
      if (bodies.some((b) => b.survivor?.id === id)) return;
      const pose = citizens.capturedPose(id);
      if (!pose) return;
      const x = pose.transform.elements[12]!, y = -pose.transform.elements[14]!;
      const body = build(id, heading, citizens, world, x, y, 'trip');
      if (!body) return;
      const low = Math.min(...body.p.map((v) => v.y)), high = Math.max(...body.p.map((v) => v.y));
      if (away === null) {
        // The feet caught, the body pitching forward over them, the hands going out to break the fall.
        const fwd = new Vector3(Math.cos(heading), 0, -Math.sin(heading));
        launch(body, (k, v) => {
          const h = (body.p[k]!.y - low) / Math.max(1e-3, high - low);
          v.copy(fwd).multiplyScalar(m(0.4) + m(2.2) * h);
          if (k === LW || k === RW || k === LE || k === RE) v.addScaledVector(fwd, m(1.2)).y -= m(0.6);
          return v;
        });
      } else {
        // Struck: the chest and head driven away from the blow, the feet left where they stood
        const push = new Vector3(Math.cos(away), 0, -Math.sin(away));
        launch(body, (k, v) => {
          const h = (body.p[k]!.y - low) / Math.max(1e-3, high - low);
          v.copy(push).multiplyScalar(m(0.2) + m(3.2) * h * h);
          if (k === LW || k === RW || k === LE || k === RE) v.addScaledVector(push, m(0.8)).y += m(1.2);
          if (k === HEA || k === TOP) v.addScaledVector(push, m(0.8));
          return v;
        });
      }
      add(body);
    },
    update(dt, world) {
      const wall = Math.min(0.1, Math.max(0, dt));
      clock += wall;
      // A body down without the Actions chosen (a probe, the weapons lab): the physics asked for now
      if (bodies.length) warmPhysics();
      for (const d of decals) d.age += wall;
      while (clock >= STEP) {
        clock -= STEP;
        const physics = JOLT ? joltWorld() : null;
        let simulated = false;
        for (const body of bodies) {
          if (body.asleep) continue;
          if (physics) { prepare(physics, body, world); simulated = true; } else step(body, world);
        }
        if (physics && simulated) {
          physics.step(STEP);
          for (const body of bodies) if (!body.asleep && body.jolt) sync(body, world);
        }
      }
      for (let i = bodies.length - 1; i >= 0; i--) {
        const body = bodies[i]!;
        body.age += wall;
        const alive = body.survivor;
        if (alive) {
          alive.t += wall;
          if (alive.phase === 'fall' && (body.asleep || alive.t > FALL_MOST)) { alive.phase = 'lie'; alive.t = 0; body.asleep = !alive.crawl; }
          else if (alive.phase === 'lie' && alive.crawl) {
            writhe(body, alive.crawl, wall, world);
            // A few seconds in: onto hands and knees and crawling off (CMU 111_03).
            if (alive.crawl.since > CRAWL_AFTER && lastCitizens) captured(body, alive, lastCitizens, world, faceUpOf(body), true);
          }
          else if (alive.phase === 'rise' && alive.t > (alive.pre ?? 0) + (alive.blend ?? RISE_BLEND) + alive.clip + 3) { remove(i); continue; }
          continue;
        }
        if (body.age > LIE + SINK) { remove(i); continue; }
        if (body.charred && !body.pin && body.age < 6) body.asleep = false;
        if (body.age > LIE) for (const v of body.p) v.y -= wall * m(0.12);
        if (body.asleep && !body.pooled) {
          body.pooled = true;
          // A pool of blood spreading from under each piece.
          for (const piece of body.pin ? [body.comp[body.pin.root]!] : new Set(body.comp)) {
            const at = new Vector3();
            let n = 0;
            body.p.forEach((v, k) => { if (body.comp[k] === piece) { at.add(v); n++; } });
            at.divideScalar(Math.max(1, n));
            const main = !body.pin && body.comp[PEL] === piece;
            bleed(at.x, -at.z, world.groundAt(at.x, -at.z), m(main ? (body.torn ? 2.6 : 2.0) : 0.9), main ? 30 : 12);
          }
        }
      }
    },
    draw(citizens, world) {
      lastCitizens = citizens;
      for (const body of bodies) {
        const alive = body.survivor;
        // The get-up clip asked for while they fall, so it is baked by the time they get up.
        if (alive && alive.phase !== 'rise' && !alive.ready) alive.ready = citizens.clipPose(body.index, RISE_KEY, 0) !== null;
        if (alive && alive.phase === 'lie' && alive.t >= alive.lie && (alive.ready || alive.t > alive.lie + 3)) rise(body, alive, citizens, world);
        if (alive?.phase === 'rise' && alive.keys && alive.t < (alive.pre ?? 0)) {
          keyPose(body, alive, world);
          body.palettes = palettes(body, bonesWorld(body));
        } else if (alive?.phase === 'rise' && alive.keys && !alive.from) {
          // Into the crouch: the clip takes over from the pose reached.
          keyPose(body, alive, world);
          alive.from = bonesWorld(body).map((w) => w.clone());
          body.palettes = risen(body, risePalette(body, alive, citizens));
        } else if (alive?.phase === 'rise' && alive.from && alive.root) {
          body.palettes = risen(body, risePalette(body, alive, citizens));
        } else if (!body.asleep || !body.palettes.length || body.age > LIE) {
          body.palettes = palettes(body, bonesWorld(body));
        }
        for (const palette of body.palettes) citizens.drawPalette(body.index, palette, body.anchor, body.charred === true, body.survivor !== undefined);
      }
    },
  };

  /** Getting up: which way, from how the body lies */
  function rise(body: Body, alive: Survivor, citizens: RagdollCitizens, world: RagdollWorld): void {
    const spine = new Vector3().subVectors(body.p[CHE]!, body.p[PEL]!).normalize();
    const side = torsoSide(body, new Vector3()).clone();
    const chestFront = new Vector3().crossVectors(side, spine).multiplyScalar(body.front);
    const faceUp = chestFront.y > 0;
    // Up the way a person gets up off the ground
    const facing = spine.clone().setY(0);
    if (facing.lengthSq() < 0.04) facing.copy(chestFront).setY(0).multiplyScalar(faceUp ? -1 : 1);
    if (facing.lengthSq() < 1e-6) facing.set(1, 0, 0);
    facing.normalize();
    const heading = Math.atan2(-facing.z, facing.x);
    const x = body.p[PEL]!.x, y = -body.p[PEL]!.z;
    if (captured(body, alive, citizens, world, faceUp)) return;
    const clip = citizens.clipPose(body.index, RISE_KEY, 0);
    // Played in two seconds at most: the crouch-to-stand clip runs four and more.
    alive.clip = Math.min(2, clip?.duration ?? RISE_CLIP);
    alive.root = new Matrix4().compose(
      new Vector3(x, world.groundAt(x, y), -y),
      new Quaternion().setFromAxisAngle(UP, heading + Math.PI / 2),
      new Vector3(body.scale, body.scale, body.scale),
    );
    alive.phase = 'rise';
    alive.t = 0;
    const crouch = clip ? particlesOf(body, clip.palette, alive.root) : null;
    if (!crouch) {
      alive.from = bonesWorld(body).map((w) => w.clone());
      alive.pre = 0; alive.blend = RISE_BLEND;
      getUp(alive.id, x, y, heading, RISE_BLEND + alive.clip);
      return;
    }
    const M = body.scale;
    const stages: NonNullable<Survivor['keys']>['stages'] = [];
    let now = body.p.map((v) => v.clone());
    let t = 0;
    if (faceUp) {
      // Rolled over about the body's long axis, lifted clear of the ground as it turns.
      const at = new Vector3().addVectors(body.p[PEL]!, body.p[CHE]!).multiplyScalar(0.5);
      const axis = spine.clone().setY(0).normalize();
      const after = now.map((v) => v.clone().sub(at).applyAxisAngle(axis, Math.PI).add(at));
      stages.push({ from: now, to: after, start: t, end: t + 0.8, roll: { axis, at, lift: 0.18 * M } });
      now = after;
      t += 0.8;
    }
    const fours = handsAndKnees(body, alive.root, crouch, M, world);
    stages.push({ from: now, to: fours, start: t, end: t + 0.9 });
    t += 0.9;
    stages.push({ from: fours, to: crouch, start: t, end: t + 0.6 });
    t += 0.6;
    alive.keys = { stages };
    alive.pre = t;
    alive.blend = 0.2;
    body.asleep = true;
    getUp(alive.id, x, y, heading, t + alive.blend + alive.clip);
  }

  /** Getting up as captured (CMU 140_01 face down, 140_08 face up): the clip's first frame, lying, laid where the body lies */
  function captured(body: Body, alive: Survivor, citizens: RagdollCitizens, world: RagdollWorld, faceUp: boolean, crawl = false): boolean {
    // To crawl (face down): the crawl's own first frame, on hands and knees, blended into from where they lie
    const key = crawl ? 'crawl' : faceUp ? 'getUpBack' : 'getUpFront';
    const upTo = crawl ? 0 : 0.999;
    const first = citizens.clipPose(body.index, key, 0);
    const last = citizens.clipPose(body.index, key, upTo);
    if (!first || !last) return false;
    const pel = body.p[PEL]!;
    const ground = world.groundAt(pel.x, -pel.z);
    const rootAt = (heading: number, at: Vector3): Matrix4 => new Matrix4().compose(at, new Quaternion().setFromAxisAngle(UP, heading), new Vector3(body.scale, body.scale, body.scale));
    const ang = (v: Vector3): number => Math.atan2(-v.z, v.x);
    const probe = particlesOf(body, first.palette, rootAt(0, new Vector3(pel.x, ground, pel.z)));
    if (!probe) return false;
    const along = (p: readonly Vector3[]): Vector3 => new Vector3().subVectors(p[HEA]!, p[PEL]!).setY(0);
    const heading = ang(along(body.p)) - ang(along(probe));
    let root = rootAt(heading, new Vector3(pel.x, ground, pel.z));
    const placed = particlesOf(body, first.palette, root);
    if (!placed) return false;
    root = rootAt(heading, new Vector3(pel.x + (pel.x - placed[PEL]!.x), ground, pel.z + (pel.z - placed[PEL]!.z)));
    const end = particlesOf(body, last.palette, root);
    if (!end) return false;
    const toes = new Vector3().subVectors(end[LT]!, end[LA]!).add(tmpA.subVectors(end[RT]!, end[RA]!)).setY(0);
    alive.riseKey = key;
    alive.riseMax = upTo;
    alive.root = root;
    alive.clip = first.duration * upTo / 1.15;
    alive.phase = 'rise';
    alive.t = 0;
    alive.from = bonesWorld(body).map((w) => w.clone());
    alive.pre = 0;
    alive.blend = crawl ? CRAWL_UP : 0.35;
    body.asleep = true;
    if (crawl) {
      // Crawling on the way the clip faces (a walking body's toes under the same root).
      const idle = citizens.clipPose(body.index, 'idle', 0);
      const stood = idle ? particlesOf(body, idle.palette, root) : null;
      const ahead = stood ? new Vector3().subVectors(stood[LT]!, stood[LA]!).add(tmpA.subVectors(stood[RT]!, stood[RA]!)).setY(0) : null;
      getUp(alive.id, end[PEL]!.x, -end[PEL]!.z, ahead && ahead.lengthSq() > 1e-8 ? ang(ahead) : ang(along(end)), alive.blend + alive.clip, true);
    }
    else getUp(alive.id, end[PEL]!.x, -end[PEL]!.z, toes.lengthSq() > 1e-8 ? ang(toes) : heading, alive.blend + alive.clip);
    return true;
  }

  /** Whether a body lies face up (its chest's front to the sky). */
  function faceUpOf(body: Body): boolean {
    const spine = new Vector3().subVectors(body.p[CHE]!, body.p[PEL]!).normalize();
    const side = torsoSide(body, new Vector3()).clone();
    return new Vector3().crossVectors(side, spine).multiplyScalar(body.front).y > 0;
  }

  /** The particles of the body in a pose read off its skeleton (a clip's palette under `root`). */
  function particlesOf(body: Body, palette: Float32Array, root: Matrix4): Vector3[] | null {
    const g = new Matrix4(), w = new Matrix4();
    const at = (i: number): Vector3 | null => {
      if (i < 0) return null;
      w.fromArray(palette, i * 16).multiply(body.binds[i]!);
      g.multiplyMatrices(root, body.rebind).multiply(w);
      return new Vector3().setFromMatrixPosition(g);
    };
    const p: Vector3[] = [];
    for (let k = 0; k < BEL; k++) {
      let v = at(body.jointBone[k] ?? -1);
      if (k === TOP) v = p[HEA]!.clone().addScaledVector(tmpD.subVectors(p[HEA]!, p[NEC]!), 1.4);
      if (!v && (k === LT || k === RT)) v = p[k - 1]!.clone();
      if (!v) return null;
      p.push(v);
    }
    const forward = new Vector3().subVectors(p[LT]!, p[LA]!).add(tmpD.subVectors(p[RT]!, p[RA]!)).setY(0).normalize();
    p.push(p[PEL]!.clone().addScaledVector(forward, 0.14 * body.scale));
    settle(body, p, null);
    return p;
  }

  /** On hands and knees over where the crouch will be */
  function handsAndKnees(body: Body, root: Matrix4, crouch: readonly Vector3[], M: number, world: RagdollWorld): Vector3[] {
    const origin = new Vector3().setFromMatrixPosition(root);
    const turn = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(root));
    const fwd = new Vector3(0, 0, 1).applyQuaternion(turn).setY(0).normalize();
    // Which way is the body's left: from the crouch (its hips).
    const left = new Vector3().subVectors(crouch[LH]!, crouch[RH]!).setY(0).normalize();
    const g = world.groundAt(origin.x, -origin.z);
    const L = (f: number, u: number, l: number): Vector3 => origin.clone().addScaledVector(fwd, f * M).addScaledVector(left, l * M).setY(g + u * M);
    const p: Vector3[] = [];
    p[PEL] = L(0, 0.62, 0); p[CHE] = L(0.42, 0.66, 0); p[NEC] = L(0.6, 0.66, 0); p[HEA] = L(0.74, 0.62, 0); p[TOP] = L(0.86, 0.6, 0);
    p[LS] = L(0.5, 0.64, 0.18); p[LE] = L(0.52, 0.36, 0.2); p[LW] = L(0.54, 0.08, 0.2);
    p[RS] = L(0.5, 0.64, -0.18); p[RE] = L(0.52, 0.36, -0.2); p[RW] = L(0.54, 0.08, -0.2);
    p[LH] = L(0, 0.6, 0.1); p[LK] = L(0.02, 0.07, 0.12); p[LA] = L(-0.42, 0.08, 0.12); p[LT] = L(-0.56, 0.03, 0.12);
    p[RH] = L(0, 0.6, -0.1); p[RK] = L(0.02, 0.07, -0.12); p[RA] = L(-0.42, 0.08, -0.12); p[RT] = L(-0.56, 0.03, -0.12);
    p[BEL] = L(0.02, 0.5, 0);
    settle(body, p, world);
    return p;
  }

  /** The body's sticks (lengths, the ranges of the joints) satisfied by `p`, kept above the ground. */
  function settle(body: Body, p: Vector3[], world: RagdollWorld | null): void {
    for (let it = 0; it < 24; it++) {
      for (const s of body.sticks) {
        if (s.broken) continue;
        const a = p[s.a]!, b = p[s.b]!;
        const d = tmpA.subVectors(b, a);
        const l = d.length() || 1e-6;
        const target = l < s.min ? s.min : l > s.max ? s.max : l;
        if (target === l) continue;
        const wa = body.inv[s.a]!, wb = body.inv[s.b]!;
        const diff = (l - target) / (l * (wa + wb));
        a.addScaledVector(d, wa * diff);
        b.addScaledVector(d, -wb * diff);
      }
      if (world) p.forEach((v, k) => { const floor = world.groundAt(v.x, -v.z) + body.radius[k]!; if (v.y < floor) v.y = floor; });
    }
  }

  /** The body at time `t` of its getting up from lying (`Survivor.keys`): key poses eased into one another, the body kept a body. */
  function keyPose(body: Body, alive: Survivor, world: RagdollWorld): void {
    const keys = alive.keys!;
    const stage = keys.stages.find((k) => alive.t < k.end) ?? keys.stages[keys.stages.length - 1]!;
    const u = smooth((alive.t - stage.start) / (stage.end - stage.start));
    body.p.forEach((v, k) => {
      if (stage.roll) {
        const r = stage.roll;
        v.copy(stage.from[k]!).sub(r.at).applyAxisAngle(r.axis, Math.PI * u).add(r.at);
        v.y += Math.sin(Math.PI * u) * r.lift;
      } else v.lerpVectors(stage.from[k]!, stage.to[k]!, u);
    });
    settle(body, body.p, world);
    body.o.forEach((o, k) => o.copy(body.p[k]!));
  }

  /** A getting-up body: the lying pose blended into the get-up clip's first frame, then the clip. */
  function risePalette(body: Body, alive: Survivor, citizens: RagdollCitizens): Float32Array {
    const into = alive.blend ?? RISE_BLEND;
    const t = alive.t - (alive.pre ?? 0);
    const blend = smooth(t / into);
    const phase = Math.min(1, Math.max(0, t - into) / Math.max(0.1, alive.clip)) * (alive.riseMax ?? 1);
    const clip = citizens.clipPose(body.index, alive.riseKey ?? RISE_KEY, phase);
    const bones = body.pos0.length;
    const from = alive.from!;
    const posed = posedOf(body);
    let world: readonly Matrix4[];
    if (!clip) world = from;
    else {
      const target = posed.target;
      for (let i = 0; i < bones; i++) {
        poseA.fromArray(clip.palette, i * 16).multiply(body.binds[i]!);
        target[i]!.multiplyMatrices(alive.root!, body.rebind).multiply(poseA);
      }
      // Blended in, the clip's own matrix exactly: a bone of these rigs is scaled unevenly
      if (blend >= 0.999) world = target;
      else {
        // Before that, blended as animation systems blend poses, each bone after its parent
        const blended = posed.blended, solved = posed.solved;
        solved.fill(0);
        const local = (list: readonly Matrix4[], i: number, out: Matrix4): Matrix4 => {
          const parent = body.parents[i]!;
          return parent >= 0 ? out.copy(list[parent]!).invert().multiply(list[i]!) : out.copy(list[i]!);
        };
        const solve = (i: number): Matrix4 => {
          const out = blended[i]!;
          if (solved[i]) return out;
          // The parent first: its sums share this one's scratch.
          const parent = body.parents[i]!;
          const above = parent >= 0 ? solve(parent) : null;
          local(from, i, poseA).decompose(poseP0, poseQ0, poseS0);
          local(target, i, poseB).decompose(poseP1, poseQ1, poseS1);
          poseP0.lerp(poseP1, blend); poseQ0.slerp(poseQ1, blend); poseS0.lerp(poseS1, blend);
          out.compose(poseP0, poseQ0, poseS0);
          if (above) out.premultiply(above);
          solved[i] = 1;
          return out;
        };
        for (let i = 0; i < bones; i++) solve(i);
        world = blended;
      }
    }
    body.anchor.copy(alive.root!);
    const back = poseBack.copy(body.unbind).multiply(poseInv.copy(body.anchor).invert());
    const out = posed.rise;
    for (let i = 0; i < bones; i++) poseM.multiplyMatrices(back, world[i]!).multiply(body.inverses[i]!).toArray(out, i * 16);
    return out;
  }

  /** A body into Jolt, or a change since its last step passed on: made the first time */
  function prepare(physics: JoltWorld, body: Body, world: RagdollWorld): void {
    if (!separated) { for (const [a, b] of J_PAIRS) physics.separate(a, b); separated = true; }
    // Burnt black: drawn up as burnt bodies are (`curl`), by muscle pulls.
    if (body.jolt && body.charred && !body.pin && body.age < 6) {
      const k = 9 * STEP * Math.min(1, body.age / 1.5);
      body.jolt.pull(LW, CHE, k); body.jolt.pull(RW, CHE, k);
      body.jolt.pull(LE, CHE, k * 0.4); body.jolt.pull(RE, CHE, k * 0.4);
      body.jolt.pull(LA, LH, k); body.jolt.pull(RA, RH, k);
      body.jolt.pull(LK, CHE, k * 0.8); body.jolt.pull(RK, CHE, k * 0.8);
    }
    if (!body.jolt) {
      body.colliders ??= { list: colliders(physics, body, world), users: 1 };
      body.jolt = physics.ragdoll(joltSpec(body));
      body.synced = undefined;
    }
    const s = body.synced;
    const jr = body.jolt;
    if (s) {
      for (let k = 0; k < body.p.length; k++) {
        if (body.pin && !body.pin.keep.has(k)) continue;
        if (body.p[k]!.distanceTo(s.p[k]!) > m(0.08)) {
          jr.destroy();
          body.jolt = physics.ragdoll(joltSpec(body));
          body.synced = undefined;
          prepare(physics, body, world);
          return;
        }
      }
    }
    const dv = new Vector3();
    for (let k = 0; k < body.p.length; k++) {
      if (body.pin && !body.pin.keep.has(k)) continue;
      const p = body.p[k]!, o = body.o[k]!;
      if (s && p.equals(s.p[k]!) && o.equals(s.o[k]!)) continue;
      dv.subVectors(p, o);
      if (s) dv.sub(tmpB.subVectors(s.p[k]!, s.o[k]!));
      dv.divideScalar(STEP * METRE);
      if (dv.lengthSq() < 1e-6) continue;
      const part = body.jolt.partOf(k);
      if (part < 0) continue;
      body.jolt.push(k, dv, 1 / Math.max(1, body.jolt.carried(part)));
    }
  }

  /** The particles from the parts after a Jolt step; asleep when Jolt has put the parts to sleep, or they have lain still. */
  function sync(body: Body, world: RagdollWorld): void {
    const jr = body.jolt!;
    let moved = 0;
    for (let k = 0; k < body.p.length; k++) {
      if (body.pin && !body.pin.keep.has(k)) continue;
      const at = jr.point(k, tmpA);
      if (!at) continue;
      const p = body.p[k]!;
      body.o[k]!.copy(p);
      p.copy(at).multiplyScalar(METRE);
      moved = Math.max(moved, p.distanceTo(body.o[k]!));
      body.ground[k] = world.groundAt(p.x, -p.z);
    }
    if (body.pin) {
      const { root, keep } = body.pin;
      for (let k = 0; k < body.p.length; k++) if (!keep.has(k)) { body.p[k]!.copy(body.p[root]!); body.o[k]!.copy(body.o[root]!); }
    }
    if (!body.synced) body.synced = { p: body.p.map((v) => v.clone()), o: body.o.map((v) => v.clone()) };
    else body.p.forEach((v, k) => { body.synced!.p[k]!.copy(v); body.synced!.o[k]!.copy(body.o[k]!); });
    body.flying += STEP;
    body.still = moved < m(0.0025) ? body.still + STEP : 0;
    // Asleep a moment after Jolt has put its parts to sleep (or when it lies still)
    if ((!jr.active() && body.still > 0.25) || body.still > 0.8 || body.flying > SETTLE) { body.asleep = true; jr.sleep(); }
    if (body.torn && moved > m(0.01)) {
      body.spray -= STEP;
      if (body.spray <= 0) {
        body.spray = 0.06;
        const k = Math.floor(Math.random() * body.p.length);
        exhaust.burst(body.p[k]!.x, -body.p[k]!.z, body.p[k]!.y, 3, 4, m(0.08), m(0.04), 0.7);
      }
    }
  }

  /** The ground under a body and round it */
  function colliders(physics: JoltWorld, body: Body, world: RagdollWorld): JoltStatic[] {
    const pel = body.p[PEL]!;
    const fast = body.p.some((v, k) => v.distanceTo(body.o[k]!) / STEP > m(6));
    const n = fast ? 256 : 128, cell = fast ? 0.12 : 0.1;
    const half = ((n - 1) * cell) / 2;
    const cx = pel.x / METRE, cz = pel.z / METRE;
    const list: JoltStatic[] = [physics.ground(cx - half, cz - half, n, cell, (x, z) => world.groundAt(x * METRE, -z * METRE) / METRE)];
    for (const w of body.walls) {
      const ring = w.ring.map((q) => ({ x: q.x / METRE, z: -q.y / METRE }));
      if (ring.every((q) => Math.abs(q.x - cx) > half || Math.abs(q.z - cz) > half)) continue;
      const bottom = Math.min(...w.ring.map((q) => world.groundAt(q.x, q.y))) / METRE - 0.3;
      const s = physics.prism(ring, bottom, w.top / METRE);
      if (s) list.push(s);
    }
    return list;
  }

  /** A body as Jolt parts and joints, from where its particles are (metres) */
  function joltSpec(body: Body): { parts: PartSpec[]; joints: JointSpec[]; points: Vector3[] } {
    const P = body.p.map((v) => v.clone().divideScalar(METRE));
    const R = (k: number): number => body.radius[k]! / METRE;
    // Every axis unit and every joint frame a rotation, whatever the particles are (`ragdollAxes.ts`)
    const up = direction(P[PEL]!, P[NEC]!, WORLD_UP);
    const dir = (a: number, b: number): Vector3 => direction(P[a]!, P[b]!, up);
    const side = across(new Vector3().subVectors(P[RH]!, P[LH]!).add(tmpA.subVectors(P[RS]!, P[LS]!)), up, WORLD_SIDE);
    const fwd = unitOr(new Vector3().crossVectors(side, new Vector3().subVectors(P[CHE]!, P[PEL]!)), new Vector3().crossVectors(side, up)).multiplyScalar(body.front);
    const capsule = (a: Vector3, b: Vector3, radius: number): PartSpec['shape'] => ({ kind: 'capsule', a, b, radius });
    const hand = (e: number, w: number): Vector3 => P[w]!.clone().addScaledVector(dir(e, w), 0.06);
    const width = Math.max(P[LS]!.distanceTo(P[RS]!), P[LH]!.distanceTo(P[RH]!));
    const trunkLen = P[PEL]!.distanceTo(P[NEC]!);
    const zAxis = new Vector3().crossVectors(side, up);
    const parts: PartSpec[] = [
      { shape: { kind: 'box', centre: P[PEL]!.clone().lerp(P[NEC]!, 0.5).addScaledVector(up, -0.03), axes: [side.clone(), up.clone(), zAxis], half: [width / 2 + 0.03, trunkLen / 2 + 0.05, 0.11] },
        particles: [PEL, CHE, BEL, LS, RS, LH, RH, NEC] },
      { shape: capsule(P[NEC]!, P[TOP]!, R(HEA) * 0.8), particles: [HEA, TOP] },
      { shape: capsule(P[LS]!, P[LE]!, R(LE) * 0.7), particles: [LE] },
      { shape: capsule(P[LE]!, hand(LE, LW), R(LW) * 0.8), particles: [LW] },
      { shape: capsule(P[RS]!, P[RE]!, R(RE) * 0.7), particles: [RE] },
      { shape: capsule(P[RE]!, hand(RE, RW), R(RW) * 0.8), particles: [RW] },
      { shape: capsule(P[LH]!, P[LK]!, R(LK)), particles: [LK] },
      { shape: capsule(P[LK]!, P[LA]!, R(LA) * 0.85), particles: [LA] },
      { shape: capsule(P[LA]!, P[LT]!, R(LT) * 0.8), particles: [LT] },
      { shape: capsule(P[RH]!, P[RK]!, R(RK)), particles: [RK] },
      { shape: capsule(P[RK]!, P[RA]!, R(RA) * 0.85), particles: [RA] },
      { shape: capsule(P[RA]!, P[RT]!, R(RT) * 0.8), particles: [RT] },
    ];
    const cone = (parent: number, child: number, at: number, a: number, b: number, planeCone: number, normalCone: number, twist: number, lean = 0): JointSpec => {
      // The cone's middle leant forwards (`lean`, about the side axis) from where the bone is now
      const f = coneFrames(dir(a, b), side, lean, fwd);
      return { parent, child, at: P[at]!.clone(), kind: 'cone', ...f, planeCone, normalCone, twistMin: -twist, twistMax: twist };
    };
    const hinge = (parent: number, child: number, a: number, mid: number, b: number, bends: Vector3, most: number, relaxed: number, tone: number): JointSpec => {
      // The axis it bends about, the bend the right way (`bends`: where the lower bone goes as it bends).
      const { axis, normal, bent } = hingeFrame(dir(a, mid), dir(mid, b), bends);
      return { parent, child, at: P[mid]!.clone(), kind: 'hinge', axis, normal, min: -bent - 0.05, max: most - bent, relax: -bent + relaxed, tone };
    };
    const back = fwd.clone().negate();
    const joints: JointSpec[] = [
      cone(J_TORSO, J_HEAD, NEC, NEC, TOP, 0.6, 0.5, 0.7),
      cone(J_TORSO, J_LUA, LS, LS, LE, 1.4, 1.3, 1.0),
      hinge(J_LUA, J_LFA, LS, LE, LW, fwd, 2.5, 0.4, 2),
      cone(J_TORSO, J_RUA, RS, RS, RE, 1.4, 1.3, 1.0),
      hinge(J_RUA, J_RFA, RS, RE, RW, fwd, 2.5, 0.4, 2),
      cone(J_TORSO, J_LTH, LH, LH, LK, 1.15, 0.6, 0.6, 0.5),
      hinge(J_LTH, J_LCA, LH, LK, LA, back, 2.6, 0.2, 6),
      cone(J_LCA, J_LFO, LA, LA, LT, 0.6, 0.3, 0.2),
      cone(J_TORSO, J_RTH, RH, RH, RK, 1.15, 0.6, 0.6, 0.5),
      hinge(J_RTH, J_RCA, RH, RK, RA, back, 2.6, 0.2, 6),
      cone(J_RCA, J_RFO, RA, RA, RT, 0.6, 0.3, 0.2),
    ];
    return { parts, joints, points: P };
  }

  /** One Verlet step of a body: move, then relax the sticks, the joints and the collisions together. */
  /** Somebody down for good and hurt, where they lie (GTA's writhe: on the ground in pain, going nowhere) */
  function writhe(body: Body, crawl: NonNullable<Survivor['crawl']>, dt: number, world: RagdollWorld): void {
    if (crawl.since === 0) {
      const at = body.p[PEL]!;
      bleed(at.x, -at.z, world.groundAt(at.x, -at.z), m(1.3), 25);
    }
    crawl.since += dt;
    const t = crawl.since;
    const strength = Math.min(1, t / 1.5) * Math.max(0.3, 1 - t / 40);
    for (const [knee, hip, phase] of [[LK, LH, 0], [RK, RH, 2.4]] as const) {
      const s = Math.sin(t * 1.3 + phase);
      if (s <= 0) continue;
      // In Jolt, a muscle's pull between the knee and the belly (the body as a whole unmoved)
      if (body.jolt) { body.jolt.pull(knee, BEL, 14 * dt * s * strength); continue; }
      tmpA.lerpVectors(body.p[hip]!, body.p[BEL]!, 0.5).add(tmpB.subVectors(body.p[CHE]!, body.p[PEL]!).multiplyScalar(0.3));
      body.p[knee]!.lerp(tmpA, 0.3 * dt * s * strength);
    }
    body.asleep = false;
  }

  /** A body burnt black draws up as burnt bodies do */
  function curl(body: Body): void {
    const k = 0.015 * Math.min(1, body.age / 1.5);
    const chest = body.p[CHE]!, head = body.p[HEA]!;
    tmpA.lerpVectors(chest, head, 0.6);
    body.p[LW]!.lerp(tmpA, k); body.p[RW]!.lerp(tmpA, k);
    body.p[LE]!.lerp(chest, k * 0.5); body.p[RE]!.lerp(chest, k * 0.5);
    body.p[LA]!.lerp(body.p[LH]!, k * 0.8); body.p[RA]!.lerp(body.p[RH]!, k * 0.8);
    body.p[LK]!.lerp(chest, k * 0.4); body.p[RK]!.lerp(chest, k * 0.4);
  }

  /** Joint friction: across every bone (a rigid stick), the two ends' speeds drawn a little towards their mean */
  function joints(body: Body): void {
    const { p, o } = body;
    const k = 0.12;
    for (const s of body.sticks) {
      if (s.broken || s.min !== s.max) continue;
      const a = p[s.a]!, b = p[s.b]!, oa = o[s.a]!, ob = o[s.b]!;
      const vax = a.x - oa.x, vay = a.y - oa.y, vaz = a.z - oa.z;
      const vbx = b.x - ob.x, vby = b.y - ob.y, vbz = b.z - ob.z;
      const mx = (vax + vbx) / 2, my = (vay + vby) / 2, mz = (vaz + vbz) / 2;
      oa.set(a.x - (vax + (mx - vax) * k), a.y - (vay + (my - vay) * k), a.z - (vaz + (mz - vaz) * k));
      ob.set(b.x - (vbx + (mx - vbx) * k), b.y - (vby + (my - vby) * k), b.z - (vbz + (mz - vbz) * k));
    }
  }

  function step(body: Body, world: RagdollWorld): void {
    const { p, o, inv } = body;
    let moved = 0;
    for (let k = 0; k < p.length; k++) {
      const v = p[k]!, old = o[k]!;
      const vx = (v.x - old.x) * AIR, vy = (v.y - old.y) * AIR, vz = (v.z - old.z) * AIR;
      old.copy(v);
      v.x += vx; v.y += vy - GRAVITY * STEP * STEP; v.z += vz;
      moved = Math.max(moved, Math.abs(vx) + Math.abs(vy) + Math.abs(vz));
    }
    if (body.stiff && body.stiff > 0) { body.stiff -= STEP; joints(body); }
    if (body.charred && !body.pin && body.age < 6) curl(body);
    // Walls within reach of the body this step.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of p) { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, -v.z); y1 = Math.max(y1, -v.z); }
    const pad = m(0.3);
    const near = body.walls.filter((w) => w.x0 < x1 + pad && w.x1 > x0 - pad && w.y0 < y1 + pad && w.y1 > y0 - pad);
    for (let it = 0; it < ITERATIONS; it++) {
      for (const s of body.sticks) {
        if (s.broken) continue;
        const a = p[s.a]!, b = p[s.b]!;
        const d = tmpA.subVectors(b, a);
        const l = d.length() || 1e-6;
        const target = l < s.min ? s.min : l > s.max ? s.max : l;
        if (target === l) continue;
        const wa = inv[s.a]!, wb = inv[s.b]!;
        const diff = (l - target) / (l * (wa + wb));
        a.addScaledVector(d, wa * diff);
        b.addScaledVector(d, -wb * diff);
      }
      hinges(body);
      ankles(body);
      collide(body, near, it === ITERATIONS - 1, world);
      if (it % 3 === 2 || it === ITERATIONS - 1) capsules(body, near, world);
    }
    // The bones' lengths last a little into a wall reads less than a body pulled apart; Unity's ragdoll projection does the
    for (let it = 0; it < 3; it++) {
      for (const s of body.sticks) {
        if (s.broken || s.min !== s.max) continue;
        const a = p[s.a]!, b = p[s.b]!;
        const d = tmpA.subVectors(b, a);
        const l = d.length() || 1e-6;
        const wa = inv[s.a]!, wb = inv[s.b]!;
        const diff = (l - s.min) / (l * (wa + wb));
        a.addScaledVector(d, wa * diff);
        b.addScaledVector(d, -wb * diff);
      }
    }
    if (body.pin) {
      const { root, keep } = body.pin;
      for (let k = 0; k < p.length; k++) if (!keep.has(k)) { p[k]!.copy(p[root]!); o[k]!.copy(o[root]!); }
    }
    body.flying += STEP;
    // At rest for a moment, or long enough: asleep, drawn as it lies.
    body.still = moved < m(0.0025) ? body.still + STEP : 0;
    if (body.still > 0.8 || body.flying > SETTLE) body.asleep = true;
    // A torn body sprays blood from its stumps while it flies.
    if (body.torn && moved > m(0.01)) {
      body.spray -= STEP;
      if (body.spray <= 0) {
        body.spray = 0.06;
        const k = Math.floor(Math.random() * p.length);
        exhaust.burst(p[k]!.x, -p[k]!.z, p[k]!.y, 3, 4, m(0.08), m(0.04), 0.7);
      }
    }
  }

  /** Ankles: each foot kept within the reach a real ankle has, in its shin's frame */
  function ankles(body: Body): void {
    for (const [limb, knee, ankle, toe] of FEET) {
      if (body.comp[knee] !== body.comp[ankle] || body.comp[ankle] !== body.comp[toe]) continue;
      if (body.pin && !(body.pin.keep.has(knee) && body.pin.keep.has(ankle) && body.pin.keep.has(toe))) continue;
      const a = body.p[ankle]!, t = body.p[toe]!;
      const s = tmpA.subVectors(a, body.p[knee]!);
      const sl = s.length();
      if (sl < 1e-6) continue;
      s.divideScalar(sl);
      const normal = body.normals[limb];
      const n = tmpB.copy(normal).addScaledVector(s, -normal.dot(s));
      const nl = n.length();
      if (nl < 1e-3) continue;
      n.divideScalar(nl);
      const f = tmpC.crossVectors(n, s);
      const d = tmpD.subVectors(t, a);
      const len = d.length();
      if (len < 1e-6) continue;
      const pitch = Math.atan2(d.dot(s), d.dot(f));
      const yaw = Math.asin(Math.max(-1, Math.min(1, d.dot(n) / len)));
      const rest = body.ankle[limb];
      const p2 = clampAngle(pitch, rest.pitch - ANKLE_UP, rest.pitch + ANKLE_DOWN);
      const y2 = Math.max(rest.yaw - ANKLE_SIDE, Math.min(rest.yaw + ANKLE_SIDE, yaw));
      if (p2 === pitch && y2 === yaw) continue;
      // Back within its reach, the toe moving most.
      const c = Math.cos(y2);
      const fix = tmpE.copy(f).multiplyScalar(Math.cos(p2) * c).addScaledVector(s, Math.sin(p2) * c).addScaledVector(n, Math.sin(y2))
        .multiplyScalar(len).add(a).sub(t);
      t.addScaledVector(fix, 0.8);
      a.addScaledVector(fix, -0.2);
    }
  }

  /** Knees bend forwards only and elbows backwards only: one on the wrong side of its limb's line is pushed back across. */
  function hinges(body: Body): void {
    const side = torsoSide(body, tmpD);
    const fwd = tmpE.crossVectors(side, tmpA.subVectors(body.p[CHE]!, body.p[PEL]!)).normalize().multiplyScalar(body.front);
    for (const [limb, a, mid, b] of LIMB_JOINTS) {
      // A limb torn off has no torso to measure its front by.
      if (body.comp[a] !== body.comp[PEL] || body.comp[mid] !== body.comp[PEL] || body.comp[b] !== body.comp[PEL]) continue;
      const sign = limb === 'lleg' || limb === 'rleg' ? 1 : -1;
      const pa = body.p[a]!, pk = body.p[mid]!, pb = body.p[b]!;
      const ab = tmpA.subVectors(pb, pa);
      const t = Math.max(0, Math.min(1, tmpB.subVectors(pk, pa).dot(ab) / Math.max(1e-9, ab.lengthSq())));
      const off = tmpB.copy(pa).addScaledVector(ab, t).sub(pk).negate();
      const ahead = off.dot(fwd) * sign;
      if (ahead < 0) {
        const push = -ahead * sign * 0.7;
        pk.addScaledVector(fwd, push * 0.6);
        pa.addScaledVector(fwd, -push * 0.2);
        pb.addScaledVector(fwd, -push * 0.2);
      }
    }
  }

  /** The ground, the walls and the roofs, as projections; speed into a surface is mostly lost, and some along it. */
  function collide(body: Body, walls: readonly Wall[], last: boolean, world: RagdollWorld): void {
    const { p, o, radius } = body;
    const bloody = !body.survivor;
    for (let k = 0; k < p.length; k++) {
      if (body.pin && !body.pin.keep.has(k)) continue;
      const v = p[k]!, old = o[k]!, r = radius[k]!;
      // The ground where it is now looked up once a step, a particle the sticks drew across a footway's edge was left inside
      body.ground[k] = world.groundAt(v.x, -v.z);
      const floor = body.ground[k]! + r;
      if (v.y < floor) {
        // Out along the ground's normal, the shortest way
        const e = m(0.04);
        const gx = (world.groundAt(v.x + e, -v.z) - world.groundAt(v.x - e, -v.z)) / (2 * e);
        const gz = (world.groundAt(v.x, -v.z - e) - world.groundAt(v.x, -v.z + e)) / (2 * e);
        const n = tmpA.set(-gx, 1, -gz).normalize();
        const vx = v.x - old.x, vy = v.y - old.y, vz = v.z - old.z;
        v.addScaledVector(n, (floor - v.y) * n.y);
        // Friction along the ground, and a small bounce off it.
        const vn = vx * n.x + vy * n.y + vz * n.z;
        const keep = vn < 0 ? -0.18 * vn : vn;
        old.set(v.x - ((vx - vn * n.x) * 0.82 + keep * n.x), v.y - ((vy - vn * n.y) * 0.82 + keep * n.y), v.z - ((vz - vn * n.z) * 0.82 + keep * n.z));
        if (bloody && last && vy < -m(4) * STEP && body.splats < 12 && Math.random() < 0.35) {
          body.splats++;
          bleed(v.x, -v.z, floor - r, m(0.35 + Math.random() * 0.5), 0.5);
          exhaust.burst(v.x, -v.z, floor, 5, 4, m(0.08), m(0.04), 0.6);
        }
      }
      for (const wall of walls) {
        if (v.y > wall.top + r) continue;
        const wx = v.x, wy = -v.z;
        if (wx < wall.x0 - r || wx > wall.x1 + r || wy < wall.y0 - r || wy > wall.y1 + r) continue;
        const into = inside(wall.ring, wx, wy);
        const edge = nearestEdge(wall.ring, wx, wy);
        const dx = wx - edge.x, dy = wy - edge.y;
        const away = Math.hypot(dx, dy);
        if (!into && away >= r) continue;
        const top = wall.roof ? wall.roof(wx, wy) : wall.top;
        if (v.y > top + r) continue;
        // Over the wall or the roof, coming down on it (or nearer its top than its face): onto it, like the ground.
        if (into && (old.y >= top + r * 0.5 || top + r - v.y < away + r)) {
          const vy = v.y - old.y;
          v.y = top + r;
          old.x = v.x - (v.x - old.x) * 0.8;
          old.z = v.z - (v.z - old.z) * 0.8;
          old.y = v.y + Math.min(0, vy) * 0.18;
          continue;
        }
        // Out to the face, a particle's radius off it.
        let nx = into ? -dx : dx, ny = into ? -dy : dy;
        const nl = Math.hypot(nx, ny);
        if (nl < 1e-9) continue;
        nx /= nl; ny /= nl;
        const vx = v.x - old.x, vy = -(v.z - old.z);
        v.x = edge.x + nx * r;
        v.z = -(edge.y + ny * r);
        // The speed into the wall turned back at a fifth; along it, most is kept.
        const vn = vx * nx + vy * ny;
        let tx = vx, ty = vy;
        if (vn < 0) { tx -= 1.2 * vn * nx; ty -= 1.2 * vn * ny; }
        tx *= 0.75; ty *= 0.75;
        old.x = v.x - tx;
        old.z = v.z + ty;
        if (bloody && last && vn < -m(3) * STEP && body.splats < 12) {
          body.splats++;
          bleed(edge.x + nx * m(0.3), edge.y + ny * m(0.3), world.groundAt(edge.x, edge.y), m(0.5 + Math.random() * 0.4), 1);
          exhaust.burst(v.x, -v.z, v.y, 6, 4, m(0.1), m(0.04), 0.6);
        }
      }
    }
  }

  /** The bones as capped cylinders Jakobsen, Advanced Character Physics: each limb a capsule projected out of what it */
  function capsules(body: Body, walls: readonly Wall[], world: RagdollWorld): void {
    const { p, o, radius } = body;
    for (const [a, b] of CAPSULE_BONES) {
      if (body.pin && !(body.pin.keep.has(a) && body.pin.keep.has(b))) continue;
      if (body.comp[a] !== body.comp[b]) continue;
      const pa = p[a]!, pb = p[b]!;
      for (const t of CAPSULE_SAMPLES) {
        // Tapered, from one end's radius to the other's
        const r = radius[a]! + (radius[b]! - radius[a]!) * t;
        const wa = 1 - t, wb = t, share = wa * wa + wb * wb;
        const qx = pa.x + (pb.x - pa.x) * t, qy = pa.y + (pb.y - pa.y) * t, qz = pa.z + (pb.z - pa.z) * t;
        const pen = world.groundAt(qx, -qz) + r - qy;
        // Deeper than a bank's face: the bone is beside it, not on it (`collide`).
        if (pen > 0 && pen <= STEP_FACE) {
          // Moved out, not thrown out: the old positions go with them, so the correction adds no speed
          const l = pen / share;
          pa.y += wa * l; pb.y += wb * l;
          o[a]!.y += wa * l; o[b]!.y += wb * l;
          // Friction along the ground, as for a joint.
          o[a]!.x += (pa.x - o[a]!.x) * 0.18 * wa; o[a]!.z += (pa.z - o[a]!.z) * 0.18 * wa;
          o[b]!.x += (pb.x - o[b]!.x) * 0.18 * wb; o[b]!.z += (pb.z - o[b]!.z) * 0.18 * wb;
        }
        for (const wall of walls) {
          const wx = qx, wy = -qz;
          if (wx < wall.x0 - r || wx > wall.x1 + r || wy < wall.y0 - r || wy > wall.y1 + r) continue;
          const top = wall.roof ? wall.roof(wx, wy) : wall.top;
          if (qy > top + r) continue;
          const into = inside(wall.ring, wx, wy);
          const edge = nearestEdge(wall.ring, wx, wy);
          let nx = wx - edge.x, ny = wy - edge.y;
          const away = Math.hypot(nx, ny);
          if (!into && away >= r) continue;
          if (away < 1e-9) continue;
          nx /= away; ny /= away;
          if (into) { nx = -nx; ny = -ny; }
          // Out to the face, a radius off it, the ends sharing the move.
          const depth = into ? away + r : r - away;
          const l = depth / share;
          pa.x += nx * wa * l; pa.z -= ny * wa * l;
          pb.x += nx * wb * l; pb.z -= ny * wb * l;
          o[a]!.x += nx * wa * l; o[a]!.z -= ny * wa * l;
          o[b]!.x += nx * wb * l; o[b]!.z -= ny * wb * l;
        }
      }
    }
  }

  /** The torso's side axis (left to right), from the hips and the shoulders still on it. */
  function torsoSide(body: Body, out: Vector3): Vector3 {
    out.set(0, 0, 0);
    const c = body.comp[PEL];
    if (body.comp[LH] === c && body.comp[RH] === c) out.add(tmpA.subVectors(body.p[RH]!, body.p[LH]!));
    if (body.comp[LS] === c && body.comp[RS] === c) out.add(tmpA.subVectors(body.p[RS]!, body.p[LS]!));
    if (out.lengthSq() < 1e-10) out.subVectors(body.p[BEL]!, body.p[PEL]!).cross(UP);
    return out.normalize();
  }

  /** Each limb's bend normal, carried on so it keeps its sign and survives the limb going straight. */
  function updateNormals(body: Body, side: Vector3, rate: number): void {
    // A leg's knee bends to the body's front (`hinges`), so its bend normal is the torso's side give or take the hip's turn
    const torso = !body.pin && side.lengthSq() > 0.5;
    for (const [limb, a, mid, b] of LIMB_JOINTS) {
      const u = tmpA.subVectors(body.p[mid]!, body.p[a]!), w = tmpB.subVectors(body.p[b]!, body.p[mid]!);
      const n = tmpC.crossVectors(u, w);
      const prev = body.normals[limb];
      const leg = torso && (limb === 'lleg' || limb === 'rleg');
      if (n.lengthSq() > 0.03 * u.lengthSq() * w.lengthSq()) {
        n.normalize();
        if (n.dot(leg ? side : prev) < 0) n.negate();
        prev.lerp(n, rate);
        if (prev.lengthSq() < 1e-6) prev.copy(n);
        prev.normalize();
      } else if (leg) {
        prev.lerp(side, rate);
        if (prev.lengthSq() < 1e-6) prev.copy(side);
        prev.normalize();
      } else if (prev.lengthSq() < 1e-6) prev.copy(side);
    }
  }

  function partFrame(body: Body, part: PartName, side: Vector3, out: Matrix4): Matrix4 {
    const def = PARTS[part];
    const x = poseAxis.subVectors(body.p[def.to]!, body.p[def.origin]!);
    return frameOf(x, def.ref === 'side' ? side : body.normals[def.ref], out);
  }

  /** The one palette of a body getting up, in its own list. */
  function risen(body: Body, palette: Float32Array): Float32Array[] {
    const list = posedOf(body).risen;
    list.length = 0;
    list.push(palette);
    return list;
  }

  /** The body's drawing arrays, made the first time it is drawn. */
  function posedOf(body: Body): Posed {
    const bones = body.pos0.length;
    const matrices = (): Matrix4[] => Array.from({ length: bones }, () => new Matrix4());
    return body.posed ??= {
      world: matrices(), target: matrices(), blended: matrices(), solved: new Uint8Array(bones), on: new Uint8Array(bones),
      pieces: [], shown: [], rise: new Float32Array(bones * 16), risen: [],
    };
  }

  /** Which piece each particle is on, from the sticks still whole. */
  function components(body: Body): void {
    const parent = body.p.map((_, k) => k);
    const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
    for (const s of body.sticks) if (!s.broken && Number.isFinite(s.max)) parent[find(s.a)] = find(s.b);
    body.comp = body.p.map((_, k) => find(k));
  }

  /** Every bone's world matrix, turned and placed from the particles, into the body's own array (`Posed.world`). */
  function bonesWorld(body: Body): Matrix4[] {
    const side = torsoSide(body, poseSide);
    updateNormals(body, side, 0.5);
    for (const part of PART_NAMES) {
      partFrame(body, part, side, poseF);
      poseF0t.copy(body.frame0[part]).transpose();
      PART_TURN[part].setFromRotationMatrix(poseF.multiply(poseF0t));
    }
    // Each part placed from its parent part, at its rest distance turned with the parent
    for (const part of PART_NAMES) {
      const parent = PART_PARENT[part];
      const own = body.p[PARTS[part].origin]!;
      if (!parent || body.comp[PARTS[part].origin] !== body.comp[PARTS[parent].origin]) { PART_ORIGIN[part].copy(own); continue; }
      PART_ORIGIN[part].subVectors(body.origin0[part], body.origin0[parent]).applyQuaternion(PART_TURN[parent]).add(PART_ORIGIN[parent]);
    }
    const world = posedOf(body).world;
    for (let i = 0; i < body.pos0.length; i++) {
      const part = body.bonePart[i]!;
      const r = PART_TURN[part];
      posePos.subVectors(body.pos0[i]!, body.origin0[part]).applyQuaternion(r).add(PART_ORIGIN[part]);
      poseQuat.multiplyQuaternions(r, body.rot0[i]!);
      world[i]!.compose(posePos, poseQuat, body.scl0[i]!);
    }
    return world;
  }

  /** The skin matrices of the body (one palette per piece) from its bones' world matrices, written into the body's own arrays. */
  function palettes(body: Body, world: readonly Matrix4[]): Float32Array[] {
    const anchor = body.anchor.makeScale(body.scale, body.scale, body.scale).setPosition(body.p[PEL]!);
    // bind * local^-1 * anchor^-1: from the world back into a bone's matrix.
    const back = poseBack.copy(body.unbind).multiply(poseInv.copy(anchor).invert());
    const bones = body.pos0.length;
    const posed = posedOf(body);
    const on = posed.on;
    const out = posed.shown;
    out.length = 0;
    // Each piece once, in the order its first particle comes (as a Set of `comp` gave them).
    for (let k = 0; k < body.comp.length; k++) {
      const piece = body.comp[k]!;
      if (body.comp.indexOf(piece) !== k) continue;
      let any = false;
      for (let i = 0; i < bones; i++) {
        const part = body.bonePart[i]!;
        on[i] = body.comp[PARTS[part].origin] === piece && !body.lostParts.has(part) ? 1 : 0;
        any ||= on[i] === 1;
      }
      if (!any) continue;
      const palette = posed.pieces[out.length] ??= new Float32Array(bones * 16);
      // The piece's own root: its topmost bone (the shoulder of an arm, the hip of a leg).
      let root = -1;
      for (let i = 0; i < bones && root < 0; i++) if (on[i] && !(body.parents[i]! >= 0 && on[body.parents[i]!])) root = i;
      if (root < 0) root = 0;
      for (let i = 0; i < bones; i++) {
        if (on[i]) {
          poseM.multiplyMatrices(back, world[i]!).multiply(body.inverses[i]!);
        } else {
          // Not on this piece: shrunk to the joint it was torn from
          let j = body.parents[i]!;
          while (j >= 0 && !on[j]) j = body.parents[j]!;
          const t = tmpB.setFromMatrixPosition(world[j >= 0 ? j : root]!).applyMatrix4(back);
          poseM.set(0, 0, 0, t.x, 0, 0, 0, t.y, 0, 0, 0, t.z, 0, 0, 0, 1);
        }
        poseM.toArray(palette, i * 16);
      }
      out.push(palette);
    }
    return out;
  }
}

function inside(ring: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function nearestEdge(ring: readonly { x: number; y: number }[], x: number, y: number): { x: number; y: number } {
  let bx = x, by = y, bd = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!;
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
    const px = a.x + dx * t, py = a.y + dy * t, d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bd) { bd = d; bx = px; by = py; }
  }
  return { x: bx, y: by };
}
