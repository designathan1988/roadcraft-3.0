import { gaitSpeed, type BodyPart, type PersonAgeClass, type Severable } from '@sim/people/view';
import { simplified } from './mesh/simplify';
import {
  BoxGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  SphereGeometry,
  type BufferGeometry,
  type Material,
  type WebGLRenderer,
} from 'three';

import { newPose, pedPoseInto } from '@sim/pose';
import { TERRAIN_MAX_HEIGHT, TERRAIN_MIN_HEIGHT } from '@world/terrain';
import { roadFrameInto } from './vehicleFrame';
import {
  ARCHETYPES,
  archetypeById,
  type Archetype,
  type VehicleShape,
} from '@sim/vehicles/archetypes';
import { type ShownVehicle as SimVehicle, type SimMirror, shownPoseInto } from '@sim/mirror';
import type { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import type { ChangeKind } from '@world/changes';
import { ChangeSweep } from '@world/derived';
import { m, perM } from '@world/units';
import { hypot2 } from '@core/scalar';
import { DT, FLEET_CEILING, PED_CEILING } from '@sim/params';
import { STAGGER_FROM, STAGGER_TIME, staggerSpeed } from '@sim/agents/walk';
import { buildCarModel, carStyleOf, carStylesFor } from './carBody';
import { CROWD_IDS, createRiggedCitizens, type CitizenClipKey, type ClipIdentity } from './riggedCitizens';
import { createProceduralCrowd, type ProcClip, type ProceduralPerson } from './people/proceduralCrowd';
import { randomPerson } from '@people/spec';
import { ageFromYears } from '@people/body/macro';
import { PLAYER_ID } from '@sim/ambient/playerId';
import type { RagdollCitizens } from './ragdoll';
import type { Company } from './citizenCasting';
import { kerbTransfer, seatPerson, type KerbStop } from '@sim/vehicles/kerbStops';
import { footwayRiseAt } from '@world/roads/footwayRise';
import { walkingRise } from '@world/curbRamps';
import { groundGradient } from './groundShear';
import { blinkOn, steerAngle } from './vehicleSignals';
import {
  axleStations, buildBusModel, buildTruckModel, buildTwoWheelerModel, seatFitScale, rimGeometry, spokedRimGeometry,
  merge, tyreGeometry, type TwoWheelerModel, type VehicleModel,
} from './vehicleModels';
import { HELMET_SEGMENTS, STEER_FULL } from './riderPoses';
import { NIGHT_LUMINANCE, nightGain } from './lightLevels';
import { DOOR_SWING, createKerbFigure, kerbFigure, occupantPlays, type Play } from './occupants';
import { createBlobShadows } from './blobShadows';

/** Vehicles and riders use the original instanced batches. */

/** DO NOT stop drawing at this number again: past 1,200 parked cars, the rest vanished from the town. */
const MAX_VEHICLES = FLEET_CEILING;
const MAX_PEDS = PED_CEILING;
/** What a car off the road stands on (`offRoadDeck`): the terrain and the ground as cut and filled, the roads' heights */
const OFF_ROAD_GROUND: readonly ChangeKind[] = ['terrain', 'ground', 'elevation', 'roads', 'lots', 'buildings'];
/** Two-wheeler riders' own batches (frames, wheels, helmets). */
const MAX_RIDERS = 400;

/** Zoom at which the closest band switches on. */
const NEAR_DETAIL_ZOOM = perM(1.375);

/** Below this zoom a vehicle is its far proxy (`VehicleModel.far`) */
const FAR_BODY_ZOOM = perM(1.75);
/** From this zoom the cabin and the people in it are drawn (the tier may ask for more, `QualitySettings.occupantZoom`). */
const OCCUPANT_ZOOM = perM(3);

/** Each vehicle's own level, by the screen's scale where it stands */
const VEHICLE_HYSTERESIS = 0.1;
/** A car's length, for the smallest scale anything is drawn at (2 px). */
const CAR_LENGTH = m(4.5);
/** How far past its cell a parked car's body and shadow reach, and the heights a car in a bay can stand at (the terrain's range, a deck over it). */
const PARKED_REACH = m(16);
const PARKED_LOW = TERRAIN_MIN_HEIGHT;
const PARKED_HIGH = TERRAIN_MAX_HEIGHT + m(60);
/** At most this many vehicles whole at once: past it, the smallest on the screen are drawn a level down. */
const VEHICLE_NEAR_CAP = 200;

const SIDES = [1, -1] as const;

/** Lamp state for the vehicle currently being drawn. */
interface LampState {
  /** Headlamp colour: lit, or the unlit lens of a parked car. */
  head: number;
  tail: number;
  /** Lit indicator side: +1 left, -1 right, 0 none. Already includes the flash. */
  indicate: number;
  /** Front-wheel steering angle, radians, positive to the left. */
  steer: number;
  /** Rolling angle of the wheels, radians. */
  spin: number;
  /** Angle of a bicycle's cranks, radians. */
  crank: number;
}

interface AgentRenderOptions {
  readonly pedestrianDetail?: 0 | 1 | 2;
  readonly pedestrianVisible?: (x: number, y: number, height: number) => boolean;
  /** Whether a vehicle of this reach, centred here, can be on screen or cast a shadow onto it. */
  readonly vehicleVisible?: (x: number, y: number, height: number, radius: number) => boolean;
  /** Zoom from which vehicle cabins and occupants are drawn. */
  readonly occupantZoom?: number;
  /** Each motor vehicle drawn: where its tail smoke leaves from (`exhaust.ts`). */
  readonly exhaust?: (x: number, y: number, z: number, angle: number, length: number, speed: number, dusty: boolean) => void;
  /** The bodies of people killed by a blow (`ragdoll.ts`), drawn with the crowd's own meshes. */
  readonly ragdolls?: (citizens: RagdollCitizens) => void;
  /** Somebody whose own body lies on the ground (`ragdoll.ts`): not drawn standing as well. */
  readonly hiddenPed?: (id: number) => boolean;
  /** Where the camera is: the people nearest it get their hair's strands (`?bodies=proc`). */
  readonly eye?: Vector3;
  /** How tall something `height` high standing at (x, y, z) is on the screen, pixels */
  readonly personPixels?: (x: number, y: number, z: number, height: number) => number;
  /** Pixels a world unit across the screen at (x, y, z): each vehicle's level of detail. */
  readonly screenScale?: (x: number, y: number, z: number) => number;
  /** The most pixels a world unit spans anywhere in the box (heights `lo` to `hi`), 0 when it is off the view: the parked cars' cells. */
  readonly areaPixels?: (minX: number, minY: number, maxX: number, maxY: number, lo: number, hi: number) => number;
  /** Whether shadows are drawn at all (the quality tier): the far ones' soft discs follow it. */
  readonly shadows?: boolean;
}

export interface AgentMeshes {
  readonly meshes: readonly Object3D[];
  /** Whether the last `sync` switched the two-wheelers between casting into the shadow map and a soft disc under them */
  readonly castersChanged: boolean;
  sync(world: SimMirror, net: Network, alpha: number, detailed: boolean, zoom?: number, options?: AgentRenderOptions): void;
  /** Every figure drawn last frame and the body it was cast as (`citizenCasting.ts`). */
  census(): ReturnType<ReturnType<typeof createRiggedCitizens>['census']>;
  /** The burnt-out shell of this vehicle's own body */
  carcass(vehicle: { readonly id: number; readonly archetype: Archetype }, intact?: boolean): BufferGeometry | null;
  /** How far each procedural person's drawn skeleton is from a body (the weapons lab's mesh probe) */
  meshProbe(): { id: number; stretch: number; stretchBone: string; scale: number; scaleBone: string; held: boolean; clip: string }[];
  /** What is posing a procedural person now (the weapons lab): the baked clip played */
  animProbe(id: number): { clip: string; time: number; duration: number; weight: number; paused: boolean; layers: string[]; source: 'animation' | 'physics' } | null;
  /** Plays `clip` on a person whatever they are doing (the lab's clip check); null gives them back. */
  forceClip(id: number, clip: ProcClip | null): void;
  /** The body a vehicle's driver or rider is drawn with, for their body when they are thrown out (`Occupant.index`). */
  driverBody(vehicle: Pick<SimVehicle, 'id' | 'people' | 'peopleAge' | 'archetype'>, x: number, y: number): number | null;
  /** Called for each walker drawn bleeding (a limb lost), to drip blood where they go. */
  setBleed(fn: (id: number, x: number, y: number, z: number) => void): void;
  /** Lamps burn brighter than white after dark, so headlights and tail lights glow. */
  setNight(dark: number): void;
  /** The procedural people's skeletons, worked out on the GPU: once a frame, after `sync`, before the scene is drawn. */
  renderPalettes(renderer: WebGLRenderer): void;
  dispose(): void;
}

/** Time constant of the pitch and roll ease, seconds. */
const SUSPENSION_TAU = 0.06;

type ElevationAt = (x: number, y: number, segment?: SegmentId) => number;

// ---------------------------------------------------------------- variation

/** A cheap integer avalanche hash. */
export function agentHash(id: number): number {
  let h = (id | 0) + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** A slice of a hash as an index into `n` items. */
const pick = (h: number, shift: number, n: number): number => (h >>> shift) % n;
/** Reads a palette entry, with the indexing narrowed away. */
const from = (palette: readonly number[], h: number, shift: number): number =>
  palette[pick(h, shift, palette.length)] as number;

/** Skin tones, light to dark. */
export const SKIN_TONES: readonly number[] = [
  0xf2d3b6, 0xe6b98f, 0xd19a6a, 0xa9714a, 0x7d4e30, 0x4e3120,
];

export const SHIRT_COLOURS: readonly number[] = [
  0xd8dde2, 0x2f5f92, 0xb8432f, 0x3f7d5c, 0xe0b83f, 0x8a4f8c, 0x2b2f36, 0xd77c3a, 0xf0e6d2,
  0x5d6b7a,
];

const HELMET_COLOURS: readonly number[] = [0x1c1e22, 0xd8dbe0, 0xc0392b, 0x2c5f9e, 0xe0a33a];

/** Tints for parts that are never painted the vehicle's own colour. */
const RUBBER = 0x15181b;
const HUB = 0x9aa0a6;
const TRIM = 0x1b2328;
const CHROME = 0xb9bec4;
/** A number plate is retro-reflective, so unlit white is the honest material. */
const PLATE = 0xf0efe6;
/** A bus's destination blind: amber on black, read as lit amber. */
const DESTINATION = 0xffb13b;

/** Seconds a change of a person's clip cross-fades over: about half a step at a walk */
const CLIP_FADE = 0.3;
/** The gaits, whose phase is the ground covered (one stride a cycle) and runs on from one into another. */
const gaitClip = (c: ProcClip): boolean => c === 'walk' || c === 'run' || c === 'sprint' || c === 'hurtWalk' || c === 'hurtRun';
const HEADLAMP = 0xfff3c4;
const TAILLAMP = 0xff3b2f;
/** A parked car's lamps, switched off: clear and red lenses, unlit. */
const HEADLAMP_OFF = 0x8c8f8e;
const TAILLAMP_OFF = 0x5e1712;
/** A tail lamp with the brakes on. */
const BRAKELAMP = 0xff1a08;
/** The amber of an indicator, on the side the vehicle is moving towards. */
const INDICATOR = 0xffa11c;
/** Deceleration, in units per second per second, at which the brake lights come on. */
const BRAKE_DECEL = 1.0;
/** How much brighter each lit lamp burns after dark (`lightLevels.ts`), by its colour */
const LAMP_GAIN: ReadonlyMap<number, number> = new Map([
  [HEADLAMP, nightGain(HEADLAMP, NIGHT_LUMINANCE.headlamp)],
  [TAILLAMP, nightGain(TAILLAMP, NIGHT_LUMINANCE.tailLamp)],
  [BRAKELAMP, nightGain(BRAKELAMP, NIGHT_LUMINANCE.brakeLamp)],
  [INDICATOR, nightGain(INDICATOR, NIGHT_LUMINANCE.indicator)],
  [DESTINATION, nightGain(DESTINATION, NIGHT_LUMINANCE.destination)],
]);
const BOX_BODY = 0xe6e8ea;

/** Height of a seated head above the middle of its torso. */
const SEAT_HEAD_RISE = m(0.38);

export interface VehicleLook {
  /** Figures to draw, driver first. Never more than the class has seats. */
  readonly occupants: number;
  /** Bit 0 is the offside window, bit 1 the kerbside one. Set means down. */
  readonly windowsDown: number;
  /** How far a lowered window is down: 0.45 part-way, 1 fully into the door. */
  readonly windowDrop: number;
  readonly driverSkin: number;
  readonly driverShirt: number;
  readonly passengerSkin: number;
  readonly passengerShirt: number;
  readonly helmet: number;
  /** Second body colour, for a truck's box and a bus's roof. */
  readonly accent: number;
  /** A panoramic glass roof. */
  readonly glassRoof: boolean;
  /** A contrasting black roof panel. */
  readonly blackRoof: boolean;
}

/** How a door's window is drawn with a share `drop` of it lowered (0 shut, 1 fully down) */
export function windowPane(door: { glass: BufferGeometry }, drop: number): { visible: boolean; up: number; sy: number } {
  if (drop >= 0.98) return { visible: false, up: 0, sy: 0 };
  if (drop <= 0) return { visible: true, up: 0, sy: 1 };
  if (!door.glass.boundingBox) door.glass.computeBoundingBox();
  const bottom = door.glass.boundingBox?.min.y ?? 0;
  const sy = 1 - drop;
  return { visible: true, up: bottom * (1 - sy), sy };
}

/** Everything about how one vehicle's occupants and windows look, from its id. */
export function vehicleLook(id: number, seats: number): VehicleLook {
  const h = agentHash(id ^ 0x2545f491);
  const g = agentHash(id ^ 0x27220a95);
  const room = Math.max(1, Math.floor(seats));
  return {
    occupants: 1 + pick(h, 6, room),
    // Most cars closed; three in ten with a window or both front ones down.
    windowsDown: pick(h, 2, 10) < 7 ? 0 : pick(h, 2, 10) - 6,
    windowDrop: pick(g, 9, 2) === 0 ? 0.45 : 1,
    driverSkin: from(SKIN_TONES, h, 14),
    driverShirt: from(SHIRT_COLOURS, h, 20),
    passengerSkin: from(SKIN_TONES, g, 6),
    passengerShirt: from(SHIRT_COLOURS, g, 12),
    helmet: from(HELMET_COLOURS, g, 18),
    accent: pick(g, 24, 3) === 0 ? BOX_BODY : from(SHIRT_COLOURS, g, 26),
    // Always a solid roof: a glass one showed the whole cabin from above, and read as a car with its roof missing.
    glassRoof: false,
    blackRoof: pick(g, 28, 5) === 0,
  };
}

// ---------------------------------------------------------------- two-wheelers

/** Crank turns per wheel turn of a bicycle. */
const CRANK_RATIO = 0.57;
/** Steepest lean drawn, radians (about 35 degrees). */
const MAX_LEAN = 0.6;
const GRAVITY = m(9.81);
/** How fast a lean follows the bend, per second. */
const LEAN_RATE = 6;
const leans = new WeakMap<SimVehicle, { lean: number; age: number }>();

/** A vehicle's pose and its frame on the road, written in place for each vehicle drawn */
const POSE = newPose();
const WANT = { deck: 0, pitch: 0, roll: 0 };

/** How far a two-wheeler leans into the bend it is on */
function leanOf(v: SimVehicle): number {
  const target = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, Math.atan((v.v * v.v * v.curvature) / GRAVITY)));
  const state = leans.get(v);
  if (!state) {
    leans.set(v, { lean: target, age: v.age });
    return target;
  }
  const dt = Math.max(0, Math.min(0.2, v.age - state.age));
  state.age = v.age;
  state.lean += (target - state.lean) * (1 - Math.exp(-dt * LEAN_RATE));
  return state.lean;
}

// ---------------------------------------------------------------- people in vehicles

const riderPlays: { key: CitizenClipKey; phase: number; weight: number }[] = [];


const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** How much a two-wheeler is under way, 0 stopped (a foot down) to 1 riding. */
const riderMoving = (v: SimVehicle): number => smooth01((v.v / m(1) - 0.2) / 0.8);

// ---------------------------------------------------------------- doors and seats

/** Open fraction of one door, 0 shut to 1 fully open, from the simulation. */
function doorOpening(v: SimVehicle, door: number): number {
  return v.doors[door] ?? 0;
}

// ---------------------------------------------------------------- body plans

/** Per-class geometry, derived once at module load. */
interface BodyPlan {
  readonly shape: VehicleShape;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly wheelRadius: number;
  /** Tyre width. */
  readonly tread: number;
  /** Axle positions along the body, front first. */
  readonly axleAlong: readonly number[];
  /** Lateral offset of a wheel from the centreline. Zero for two-wheelers. */
  readonly axleSide: number;
  readonly cabinLength: number;
  readonly cabinAlong: number;
  readonly seats: number;
  /** Seated torso centre, and the head above it. */
  readonly seatY: number;
  readonly headY: number;
  /** First seat row, and the step back to the next. */
  readonly seatAlong: number;
  readonly seatPitch: number;
  readonly seatSide: number;
}

function bodyPlan(a: Archetype): BodyPlan {
  const twoWheeler = a.shape === 'motorcycle' || a.shape === 'bicycle';
  const bus = a.shape === 'bus';
  const truck = a.shape === 'truck';
  const tread = twoWheeler ? a.width * (a.shape === 'bicycle' ? 0.14 : 0.3) : a.width * 0.14;

  // Two axles straddle the body; three put one under the nose and a bogie at the back
  const axleAlong: readonly number[] = axleStations(a);

  // Seat heights put the heads inside the glazed band of each body plan
  const seatY = a.height * (bus ? 0.55 : truck ? 0.5 : 0.46);
  return {
    shape: a.shape,
    length: a.length,
    width: a.width,
    height: a.height,
    wheelRadius: a.wheelRadius,
    tread,
    axleAlong,
    axleSide: twoWheeler ? 0 : a.width * 0.5 - tread * 0.5,
    cabinLength: a.length * a.cabinFraction,
    cabinAlong: a.length * a.cabinShift,
    seats: a.seats,
    seatY,
    headY: seatY + SEAT_HEAD_RISE,
    seatAlong: bus ? a.length * 0.36 : a.length * a.cabinShift,
    seatPitch: bus ? -a.length * 0.24 : truck ? 0 : -a.length * 0.2,
    seatSide: a.width * 0.24,
  };
}

const PLANS: ReadonlyMap<string, BodyPlan> = new Map(
  ARCHETYPES.map((a) => [a.id, bodyPlan(a)] as const),
);
const FALLBACK_PLAN = bodyPlan(archetypeById('sedan'));
const planOf = (a: Archetype): BodyPlan => PLANS.get(a.id) ?? FALLBACK_PLAN;

// ---------------------------------------------------------------- meshes

interface Part {
  readonly mesh: InstancedMesh;
  /** Write cursor, reset at the top of every sync. */
  n: number;
  /** Whether this sync wrote a colour, so the colours need uploading. */
  tinted: boolean;
}

function instanced(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  count: number,
  castShadow = true,
): Part {
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // Every part carries a colour per instance, white until tinted.
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
  mesh.instanceColor.setUsage(DynamicDrawUsage);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  // Instances move every frame, so a bounding sphere computed once is wrong
  mesh.frustumCulled = false;
  mesh.count = 0;
  return { mesh, n: 0, tinted: false };
}

/** `groundAt`: what a walker off the streets stands on (a yard, a terrace, the paving, the land); `roughGroundAt` */
export function createAgentMeshes(elevationAt: ElevationAt, onAssetsReady: () => void = () => {},
  groundAt?: (x: number, y: number) => number,
  lotAt?: (building: number, x: number, y: number) => number,
  roughGroundAt?: (x: number, y: number) => number): AgentMeshes {
  // Paint, trim and the cabin read a vertex colour that multiplies the instance colour
  const paint = new MeshPhysicalMaterial({
    roughness: 0.38, metalness: 0.28, clearcoat: 1, clearcoatRoughness: 0.07,
    envMapIntensity: 1.35, vertexColors: true,
  });
  const trim = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.35, vertexColors: true });
  const glassMaterial = new MeshStandardMaterial({
    color: 0x7896a2,
    roughness: 0.12,
    metalness: 0.04,
    transparent: true,
    // Keep a cool tint while letting seated people read through the panes.
    opacity: 0.34,
    envMapIntensity: 0.8,
    // Panes are single sheets seen from both sides
    side: DoubleSide,
    // In ONE pass. three draws a transparent double-sided material twice, back faces then front
    forceSinglePass: true,
    depthWrite: false,
  });
  // The cabin: seats, dashboard, wheel.
  const cabinMaterial = new MeshStandardMaterial({ roughness: 0.9, metalness: 0.02, vertexColors: true });
  const rubber = new MeshStandardMaterial({ roughness: 0.92, metalness: 0.05 });
  // Unlit, so a lamp stays bright inside a shadow — the only thing in the scene for which that is correct.
  const lampMaterial = new MeshBasicMaterial({ toneMapped: false });
  const lampDark = { value: 0 };
  lampMaterial.onBeforeCompile = (shader) => {
    shader.uniforms['uDark'] = lampDark;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDark;\nvarying float vGlow;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= 1.0 + uDark * vGlow;');
  };
  lampMaterial.customProgramCacheKey = () => 'vehicle-lamp-glow';
  const cloth = new MeshStandardMaterial({ roughness: 0.85, metalness: 0 });

  const unitBox = new BoxGeometry(1, 1, 1);
  // A dog's body: shoulders a little wider than the waist.
  const torsoGeometry = new BoxGeometry(1, 1, 1);
  taper(torsoGeometry, 0.92, 1.2);
  const wheelGeometry = tyreGeometry();
  const hubGeometry = rimGeometry();
  // A bicycle's tyre is a thin hoop and its wheel is spokes, not a disc.
  const thinTyreGeometry = tyreGeometry(0.035);
  const spokedGeometry = spokedRimGeometry();
  const headGeometry = new SphereGeometry(0.5, 10, 7);

  const wheels = instanced('vehicle-wheels', wheelGeometry, rubber, MAX_VEHICLES * 6);
  const hubs = instanced('vehicle-hubs', hubGeometry, trim, MAX_VEHICLES * 6, false);
  const thinWheels = instanced('bicycle-wheels', thinTyreGeometry, rubber, MAX_RIDERS * 2);
  const spokes = instanced('bicycle-spokes', spokedGeometry, trim, MAX_RIDERS * 2, false);
  const lamps = instanced('vehicle-lamps', unitBox, lampMaterial, MAX_VEHICLES * 9, false);
  /** Each lamp's glow (`LAMP_GAIN`): a per-instance attribute of the lamps' box, replaced when they grow (`growPart`). */
  let lampGlow = new InstancedBufferAttribute(new Float32Array(MAX_VEHICLES * 9), 1);
  lampGlow.setUsage(DynamicDrawUsage);
  unitBox.setAttribute('glow', lampGlow);
  // A motorcyclist's helmet: a smooth shell, glossy like paint.
  const helmetGeometry = merge([new SphereGeometry(0.5, HELMET_SEGMENTS.width, HELMET_SEGMENTS.height)]);
  const helmets = instanced('rider-helmets', helmetGeometry, paint, MAX_RIDERS);

  const parts: readonly Part[] = [wheels, hubs, thinWheels, spokes, lamps, helmets];
  /** One set of instanced meshes per car class, built from its own model (`vehicleModels.ts`) */
  interface CarParts {
    readonly model: VehicleModel;
    /** The body, glazing and cabin with every door shut: one instance each. */
    readonly shell: Part;
    readonly glass: Part;
    readonly interior: Part;
    /** The same while a door moves: the pieces, and each leaf on its own. */
    readonly openShell: Part;
    readonly openGlass: Part;
    readonly openInterior: Part;
    readonly doors: readonly Part[];
    readonly doorGlass: readonly Part[];
    readonly doorCards: readonly (Part | null)[];
    readonly trim: Part;
    /** The roof panel in paint, or in glass on a car with a panoramic roof. */
    readonly roof: Part | null;
    readonly roofGlass: Part | null;
    readonly accent: Part | null;
    /** The body, roof and accent of the middle level: the same, casting no shadow (a soft disc instead). */
    readonly shellLite: Part;
    readonly roofLite: Part | null;
    readonly accentLite: Part | null;
    readonly far: Part;
    readonly steering: Part | null;
  }
  const carParts = new Map<string, CarParts>();
  /** Which body a vehicle is drawn with: its class and, for a car, the style its id picks. */
  const bodyKey = (vehicle: SimVehicle): string => {
    const a = vehicle.archetype;
    if (a.shape === 'bus') return `${a.id}:bus`;
    if (a.shape === 'truck') return `${a.id}:truck`;
    return `${a.id}:${carStyleOf(a, agentHash(vehicle.id ^ 0x57e1))}`;
  };
  const modelGeometries: BufferGeometry[] = [];
  // One set per class and body style: a sedan may be drawn as an estate and an SUV as a pick-up
  const bodies: { key: string; model: VehicleModel }[] = [];
  for (const archetype of ARCHETYPES) {
    if (archetype.shape === 'car') {
      for (const style of carStylesFor(archetype)) bodies.push({ key: `${archetype.id}:${style}`, model: buildCarModel(archetype, style) });
    } else if (archetype.shape === 'bus') bodies.push({ key: `${archetype.id}:bus`, model: buildBusModel(archetype) });
    else if (archetype.shape === 'truck') bodies.push({ key: `${archetype.id}:truck`, model: buildTruckModel(archetype) });
  }
  for (const { key, model } of bodies) {
    const id = key.replace(':', '-');
    const own = new Set<BufferGeometry>([model.shell, model.glass, model.interior, model.openShell, model.openGlass,
      model.openInterior, model.trim, model.far, ...model.doors.flatMap((d) => [d.panel, d.glass, ...(d.card ? [d.card] : [])])]);
    if (model.roof) own.add(model.roof);
    if (model.accent) own.add(model.accent);
    if (model.steering) own.add(model.steering.geometry);
    modelGeometries.push(...own);
    carParts.set(key, {
      model,
      shell: instanced(`car-${id}-shell`, model.shell, paint, MAX_VEHICLES),
      glass: instanced(`car-${id}-glass`, model.glass, glassMaterial, MAX_VEHICLES, false),
      interior: instanced(`car-${id}-interior`, model.interior, cabinMaterial, MAX_VEHICLES, false),
      openShell: instanced(`car-${id}-openshell`, model.openShell, paint, MAX_VEHICLES),
      openGlass: instanced(`car-${id}-openglass`, model.openGlass, glassMaterial, MAX_VEHICLES, false),
      openInterior: instanced(`car-${id}-openinterior`, model.openInterior, cabinMaterial, MAX_VEHICLES, false),
      doors: model.doors.map((d, i) => instanced(`car-${id}-door${i}`, d.panel, paint, MAX_VEHICLES)),
      doorGlass: model.doors.map((d, i) => instanced(`car-${id}-doorglass${i}`, d.glass, glassMaterial, MAX_VEHICLES, false)),
      doorCards: model.doors.map((d, i) => d.card ? instanced(`car-${id}-doorcard${i}`, d.card, cabinMaterial, MAX_VEHICLES, false) : null),
      trim: instanced(`car-${id}-trim`, model.trim, trim, MAX_VEHICLES, false),
      roof: model.roof ? instanced(`car-${id}-roof`, model.roof, paint, MAX_VEHICLES) : null,
      roofGlass: model.roof ? instanced(`car-${id}-roofglass`, model.roof, glassMaterial, MAX_VEHICLES, false) : null,
      accent: model.accent ? instanced(`car-${id}-accent`, model.accent, paint, MAX_VEHICLES) : null,
      shellLite: instanced(`car-${id}-shell-lite`, model.shell, paint, MAX_VEHICLES, false),
      roofLite: model.roof ? instanced(`car-${id}-roof-lite`, model.roof, paint, MAX_VEHICLES, false) : null,
      accentLite: model.accent ? instanced(`car-${id}-accent-lite`, model.accent, paint, MAX_VEHICLES, false) : null,
      // A car under twelve pixels: its shadow is the soft disc under it.
      far: instanced(`car-${id}-far`, model.far, paint, MAX_VEHICLES, false),
      steering: model.steering ? instanced(`car-${id}-wheel`, model.steering.geometry, cabinMaterial, MAX_VEHICLES, false) : null,
    });
  }
  // The far proxy is drawn under FAR_BODY_ZOOM, a car under nine pixels long
  for (const c of carParts.values()) {
    // At most nine pixels long: an error of 5% of the car is under half a pixel there.
    void simplified(c.far.mesh.geometry, 0.03, 0.05).then((coarse) => {
      if (coarse === c.far.mesh.geometry) return;
      modelGeometries.push(coarse);
      c.far.mesh.geometry = coarse;
    });
    // The body without its cabin the middle band, from the far proxy's nine pixels up to the occupants' zoom, a hundred or
    for (const part of [c.shellLite, c.roofLite, c.accentLite]) {
      if (!part) continue;
      void simplified(part.mesh.geometry, 0.25, 0.005).then((lighter) => {
        if (lighter === part.mesh.geometry) return;
        modelGeometries.push(lighter);
        part.mesh.geometry = lighter;
      });
    }
  }
  const carPartList: Part[] = [...carParts.values()].flatMap((c) => [
    c.shell, c.glass, c.interior, c.openShell, c.openGlass, c.openInterior, ...c.doors, ...c.doorGlass,
    ...c.doorCards.filter((p): p is Part => p !== null), c.trim, c.far, c.shellLite,
    ...[c.roof, c.roofGlass, c.accent, c.steering, c.roofLite, c.accentLite].filter((p): p is Part => p !== null),
  ]);

  interface TwoWheelerParts {
    readonly model: TwoWheelerModel;
    readonly body: Part;
    readonly trim: Part;
    readonly steering: Part;
    readonly cranks: Part | null;
  }
  const twoWheelerParts = new Map<string, TwoWheelerParts>();
  for (const archetype of ARCHETYPES) {
    if (archetype.shape !== 'motorcycle' && archetype.shape !== 'bicycle') continue;
    const model = buildTwoWheelerModel(archetype);
    const id = archetype.id;
    modelGeometries.push(model.body, model.trim, model.steering, ...(model.cranks ? [model.cranks] : []));
    twoWheelerParts.set(id, {
      model,
      body: instanced(`bike-${id}-body`, model.body, paint, MAX_RIDERS),
      trim: instanced(`bike-${id}-trim`, model.trim, trim, MAX_RIDERS),
      steering: instanced(`bike-${id}-steering`, model.steering, trim, MAX_RIDERS, false),
      cranks: model.cranks ? instanced(`bike-${id}-cranks`, model.cranks, trim, MAX_RIDERS, false) : null,
    });
  }
  const twoWheelerPartList: Part[] = [...twoWheelerParts.values()].flatMap((t) =>
    [t.body, t.trim, t.steering, ...(t.cranks ? [t.cranks] : [])]);
  const allParts: readonly Part[] = [...parts, ...carPartList, ...twoWheelerPartList];

  // The scenery's people: the few bodies of the scenery cast
  const pedestrians = createRiggedCitizens(CROWD_IDS, onAssetsReady);
  // The walkers drawn as procedural people (`people/proceduralCrowd.ts`, the player's choice of 2026-10-06)
  const procedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('bodies') === 'cooked'
    ? null : createProceduralCrowd({ unit: m(1) });
  /** Each walker's person; a person whose walker left (at the end of a road) waits in `procSpare` for the next one. */
  const procPeople = new Map<number, { person: ProceduralPerson | null; seen: number; at?: Matrix4; age?: PersonAgeClass; cover?: number }>();
  /** Whether a body suits a walker's age (the simulation's child, adult or elder: their pace, their company) */
  const procSuits = (person: ProceduralPerson, age: PersonAgeClass | undefined): boolean =>
    age === undefined || (age === 'child' ? person.band === 'child' : age === 'elder' ? person.band === 'senior'
      : person.band === 'young' || person.band === 'adult');
  /** A spare body of that age, taken out of the pool; null when there is none. */
  const procSpareFor = (age: PersonAgeClass | undefined): ProceduralPerson | null => {
    const i = procSpare.findIndex((p) => procSuits(p, age));
    return i >= 0 ? procSpare.splice(i, 1)[0]! : null;
  };
  const procSpare: ProceduralPerson[] = [];
  const PROC_CAP = PED_CEILING;
  /** Walkers waiting for a body of their own. */
  const procWaiting: number[] = [];
  let procBuilding = false;
  let procBuiltAt = 0;
  const PROC_BUILD_GAP_MS = 120;
  // Two spare bodies built while the map opens, drawn hidden
  if (procedural) {
    for (const seed of [0x51a7e, 0x2b0d1]) {
      void procedural.add(randomPerson(-seed, seed)).then((person) => {
        person.matrix.makeScale(0, 0, 0);
        procSpare.push(person);
      }, () => {});
    }
    // And the rest of the classes while the map is still opening, before the first walkers come in (`warmClasses`).
    void procedural.warmClasses().catch(() => {});
  }
  const procBuildNext = (): void => {
    if (procBuilding || !procWaiting.length) return;
    const now = performance.now();
    if (now - procBuiltAt < PROC_BUILD_GAP_MS) return;
    // A walker who got a freed body meanwhile, or left, needs none.
    let id: number | undefined;
    while (procWaiting.length) {
      const next = procWaiting.shift()!;
      const e = procPeople.get(next);
      if (e && !e.person) { id = next; break; }
    }
    if (id === undefined) return;
    const target = id;
    procBuilding = true;
    // Bodies of the other ages left over in the pool: the oldest given back
    while (procSpare.length > 12) procedural!.ragdoll.untwin(procSpare.shift()!);
    // Of the walker's age: a child 5 to 13, an elder 66 to 88, an adult between.
    const age = procPeople.get(target)?.age;
    const roll = ((Math.imul(target ^ 0x9e37, 2246822519) >>> 0) % 1000) / 1000;
    const years = age === 'child' ? 5 + roll * 8 : age === 'elder' ? 66 + roll * 22 : 18 + roll * 42;
    void procedural!.add(randomPerson(target, (Math.imul(target, 2654435761) >>> 0) + 1, age ? { body: { age: ageFromYears(years) } } : {})).then((person) => {
      const e = procPeople.get(target);
      if (e && !e.person) e.person = person;
      else { person.matrix.makeScale(0, 0, 0); procSpare.push(person); }
    }, () => { procPeople.delete(target); }).finally(() => { procBuilding = false; procBuiltAt = performance.now(); });
  };
  let procFrame = 0;
  /** This frame's measure of a person on the screen (`AgentRenderOptions.personPixels`). */
  let procPixels: AgentRenderOptions['personPixels'] | null = null;
  const procMatrix = new Matrix4(), procTurn = new Matrix4(), procSize = new Matrix4();
  /** A person drawn this frame: their pose picked (`procPose`), and a change of clip made a cross-fade. */
  const procDraw = (id: number, x: number, y: number, heading: number, deck: number, speed: number, walking: boolean, dt: number, activity?: string,
    lost?: readonly Severable[], act?: { readonly t: number; readonly hold: number },
    wound?: { readonly part: BodyPart; readonly grave: boolean }, age?: PersonAgeClass): void => {
    const before = procPeople.get(id)?.person ?? null;
    const was = before?.clip;
    const wasPhase = before?.phase ?? 0;
    procPose(id, x, y, heading, deck, speed, walking, dt, activity, lost, act, wound, age);
    const person = procPeople.get(id)?.person ?? null;
    // Somebody new in this body this frame starts as they are: nothing to fade from.
    if (!person || person !== before || was === undefined) return;
    const metres = speed / m(1);
    const out = person.fade;
    if (out) {
      out.phase += gaitClip(out.clip) ? dt * metres / Math.max(0.1, procedural!.stride(person, out.clip))
        : dt / procedural!.clipDuration(person, out.clip);
      out.weight -= dt / CLIP_FADE;
      if (out.weight <= 0) person.fade = undefined;
    }
    // One gait into another goes on through the same stride (`procPose`): no fade.
    if (person.clip !== was && !(gaitClip(was) && gaitClip(person.clip))) {
      person.fade = { clip: was, phase: wasPhase, weight: 1 };
    }
  };
  const procPose = (id: number, x: number, y: number, heading: number, deck: number, speed: number, walking: boolean, dt: number, activity?: string,
    lost?: readonly Severable[], act?: { readonly t: number; readonly hold: number },
    wound?: { readonly part: BodyPart; readonly grave: boolean }, age?: PersonAgeClass): void => {
    let entry = procPeople.get(id);
    if (!entry) {
      const spare = procSpareFor(age);
      if (spare) {
        // Somebody new in that body: none of the last one's wounds.
        procedural?.ragdoll.heal(spare);
        entry = { person: spare, seen: procFrame, ...(age ? { age } : {}) };
        procPeople.set(id, entry);
      } else {
        if (procPeople.size >= PROC_CAP) return;
        entry = { person: null, seen: procFrame, ...(age ? { age } : {}) };
        procPeople.set(id, entry);
        procWaiting.push(id);
      }
    }
    entry.seen = procFrame;
    const person = entry.person;
    if (!person) return;
    procMatrix.makeTranslation(x, deck, -y)
      .multiply(procTurn.makeRotationY(heading + Math.PI / 2))
      .multiply(procSize.makeScale(m(1), m(1), m(1)));
    person.matrix.copy(procMatrix);
    // How tall they stand on the screen: the level they are drawn at (`crowdLod.ts`).
    person.pixels = procPixels ? procPixels(x, y, deck, m(person.height)) : undefined;
    // Where they were last drawn: a ragdoll takes them from there when they drop out of the street
    (entry.at ??= new Matrix4()).copy(procMatrix);
    person.activity = activity;
    person.lost = lost;
    const forced = procForced.get(id);
    if (forced) {
      if (person.clip !== forced) { person.clip = forced; person.phase = 0; }
      person.phase += dt / procedural!.clipDuration(person);
      return;
    }
    procFrozen.delete(id);
    if (activity === 'flinch' && act) {
      // A first wound (`walk.ts` FLINCH), as GTA's shot peds take it
      person.activity = 'hurt';
      // The hit itself first, as captured (Quaternius Hit_Chest, a third of a second); then knocked back
      const hitFor = procedural!.ragdoll.duration(person, 'hit');
      const back = staggerSpeed(act.t) / m(1);
      if (act.t < hitFor) {
        if (person.clip !== 'hit') person.clip = 'hit';
        person.phase = Math.min(0.999, act.t / hitFor);
      } else if (back > 0.05) {
        // Knocked back: steps back as captured (CMU 76_11), played over the stagger.
        if (person.clip !== 'staggerBack') person.clip = 'staggerBack';
        person.phase = Math.min(0.999, (act.t - STAGGER_FROM) / STAGGER_TIME * 0.85);
      } else {
        if (person.clip !== 'idle') { person.clip = 'idle'; person.phase = 0; }
        person.phase += dt / procedural!.clipDuration(person);
      }
      const k = Math.min(1, Math.max(0, (act.t - 0.12) / 0.3));
      procedural!.ragdoll.posture(person, { hunch: (wound?.grave ? 0.55 : 0.42) * k, reach: Math.min(1, Math.max(0, (act.t - 0.2) / 0.35)), part: wound?.part ?? 'torso' });
      return;
    }
    if ((activity === 'crouch' || activity === 'mourn') && act && !wound) {
      // Crouching in fear (a `crouch` act): down into it (the crouch-down clip), held, and up again before the act ends
      const down = 0.5, up = 0.9;
      const next: ProcClip = act.t < down ? 'duck' : act.t > act.hold - up ? 'getUp' : 'cower';
      if (person.clip !== next) { person.clip = next; person.phase = 0; }
      if (next === 'duck') person.phase = Math.min(0.999, act.t / down);
      else if (next === 'getUp') person.phase = Math.min(0.999, (act.t - (act.hold - up)) / up);
      else person.phase += dt / procedural!.clipDuration(person);
      // Both hands over the head while down (GTA's cower), on as they duck; grieving beside somebody they walked with
      if (activity === 'mourn') {
        person.activity = 'cry';
        entry.cover = 0;
        procedural!.ragdoll.posture(person, null);
        return;
      }
      entry.cover = Math.min(1, act.t / 0.4) * Math.min(1, Math.max(0, (act.hold - act.t) / 0.5));
      procedural!.ragdoll.posture(person, { hunch: 0, reach: 0, part: 'torso', cover: entry.cover });
      return;
    }
    if (activity === 'crawl') {
      // Dragging themself off, gravely hurt: the captured crawl (CMU 111_03), stepped by the ground covered.
      person.activity = 'hurt';
      if (person.clip !== 'crawl') { person.clip = 'crawl'; person.phase = 0; }
      person.phase += dt * (speed / m(1)) / Math.max(0.05, procedural!.stride(person));
      entry.cover = 0;
      procedural!.ragdoll.posture(person, null);
      return;
    }
    if (activity === 'look' && act && !wound) {
      // A bystander's first moment after a shot (`walk.ts` frighten): turned to it, standing scared
      if (person.clip !== 'nervous') { person.clip = 'nervous'; person.phase = 0; }
      person.phase += dt / procedural!.clipDuration(person);
      entry.cover = 0;
      procedural!.ragdoll.posture(person, null);
      return;
    }
    // Hurt: a hand pressed to the wound over the captured hurt gaits - the injured run while they flee, the limp after
    const metres = speed / m(1);
    const hurtRun = wound !== undefined && walking && metres > (person.clip === 'hurtRun' ? 1.3 : 1.7);
    // Fleeing in panic: both hands over the head as they run
    const panicRun = !wound && activity === 'panic' && walking && metres > 1.6;
    entry.cover = (entry.cover ?? 0) + ((panicRun ? 1 : 0) - (entry.cover ?? 0)) * Math.min(1, dt * 5);
    procedural!.ragdoll.posture(person, wound ? { hunch: wound.grave ? 0.5 : walking && metres > 0.15 ? 0.08 : 0.42, reach: 1, part: wound.part }
      : entry.cover > 0.02 ? { hunch: 0, reach: 0, part: 'torso', cover: entry.cover } : null);
    if (wound) person.activity = 'hurt';
    // Running from danger runs, past a brisk walk; struck with fear
    if (activity === 'fall') {
      if (person.clip !== 'idle') { person.clip = 'idle'; person.phase = 0; }
      procedural!.ragdoll.posture(person, null);
      return;
    }
    const was = person.clip;
    const moving = walking && metres > 0.15;
    const sprint = metres > (was === 'sprint' ? 3.6 : 4.2);
    const run = metres > (was === 'run' || was === 'sprint' ? 2.1 : 2.6);
    const clip: ProcClip = activity === 'photo' && !moving ? 'photo'
      : moving ? (wound ? (hurtRun ? 'hurtRun' : 'hurtWalk') : sprint ? 'sprint' : run ? 'run' : 'walk') : 'idle';
    // Walk, run and sprint all start on the same foot: the stride goes on through a change of pace.
    if (person.clip !== clip) {
      if (!(gaitClip(was) && gaitClip(clip))) person.phase = 0;
      person.clip = clip;
    }
    if (gaitClip(clip)) person.phase += dt * metres / Math.max(0.1, procedural!.stride(person));
    else person.phase += dt / procedural!.clipDuration(person);
  };
  /** The cooked bodies as the ragdolls ask for them: no captured getting-up off the ground (the key poses then). */
  const riggedRagdoll: RagdollCitizens = Object.assign(Object.create(pedestrians) as typeof pedestrians, {
    clipPose: (index: number, key: 'crouchUp' | 'idle' | 'getUpFront' | 'getUpBack' | 'crawl', phase: number) =>
      key === 'getUpFront' || key === 'getUpBack' || key === 'crawl' ? null : pedestrians.clipPose(index, key, phase),
  });
  /** Gone from the street: hidden; gone a second, its person freed for the next walker. */
  const procFinish = (eye: Vector3 | undefined, live: ReadonlySet<number>): void => {
    for (const [id, entry] of procPeople) {
      if (entry.seen === procFrame) continue;
      if (!entry.person) { if (!live.has(id)) procPeople.delete(id); continue; }
      if (procHeld.has(id)) continue;
      entry.person.matrix.makeScale(0, 0, 0);
      // Kept a few frames off the street
      if (!live.has(id) && procFrame - entry.seen > 3) { procPeople.delete(id); procSpare.push(entry.person); }
    }
    // A freed body goes at once to a walker still waiting for one.
    for (let i = 0; i < procWaiting.length && procSpare.length; i++) {
      const e = procPeople.get(procWaiting[i]!);
      if (!e || e.person) continue;
      const spare = procSpareFor(e.age);
      if (spare) { procedural?.ragdoll.heal(spare); e.person = spare; procWaiting.splice(i--, 1); }
    }
    procBuildNext();
    // `procedural.update` runs after the ragdolls have posed those they hold (`sync`).
    void eye;
    procFrame++;
  };
  /** The ragdolls' view of the people (`ragdoll.ts` RagdollCitizens) */
  const procHeld = new Set<number>(), procHeldNow = new Set<number>();
  /** The walkers of the simulation this frame (`sync`), one set for every frame. */
  const procLive = new Set<number>();
  /** People made to play a clip (`forceClip`), and those whose clip did not move this frame. */
  const procForced = new Map<number, ProcClip>();
  const procFrozen = new Set<number>();
  /** Drips blood where a wounded walker drawn procedurally goes (`setBleed`). */
  let procBleed: ((id: number, x: number, y: number, z: number) => void) | null = null;
  /** Pieces torn off procedural people, drawn apart (`RagdollCitizens.twin`): indices from `TWIN_BASE` down. */
  const procTwins = new Map<number, ProceduralPerson>();
  const TWIN_BASE = -1_000_000_000;
  let procTwinNext = 0;
  const procOf = (index: number): ProceduralPerson | null => (index <= TWIN_BASE ? procTwins.get(index) ?? null
    : index < 0 ? procPeople.get(-1 - index)?.person ?? null : null);
  const procScale = new Matrix4();
  const procRagdoll: RagdollCitizens = {
    capturedPose(id) {
      const entry = procPeople.get(id);
      const person = entry?.person;
      const palette = person && entry.at && procedural ? procedural.ragdoll.pose(person) : null;
      if (!person || !palette || !entry.at) return pedestrians.capturedPose(id);
      return { index: -1 - id, palette, transform: entry.at.clone().multiply(procScale.makeScale(person.scale, person.scale, person.scale)) };
    },
    skeletonOf(index) {
      const person = procOf(index);
      return person && procedural ? procedural.ragdoll.skeleton(person) : pedestrians.skeletonOf(index);
    },
    drawPalette(index, palette, instance, charred, alive) {
      const person = procOf(index);
      if (!person || !procedural) { pedestrians.drawPalette(index, palette, instance, charred); return; }
      // On the ground: in pain if alive, slack if not.
      person.activity = alive ? 'hurt' : 'dead';
      if (index <= TWIN_BASE) {
        person.matrix.copy(instance).multiply(procScale.makeScale(1 / person.scale, 1 / person.scale, 1 / person.scale));
        procedural.ragdoll.hold(person, palette);
        return;
      }
      // The first piece of the body is the person; pieces torn off are their twins (`twin`).
      const id = -1 - index;
      if (procHeldNow.has(id)) return;
      procHeldNow.add(id);
      person.matrix.copy(instance).multiply(procScale.makeScale(1 / person.scale, 1 / person.scale, 1 / person.scale));
      procedural.ragdoll.hold(person, palette);
    },
    clipPose(index, key, phase) {
      const person = procOf(index);
      if (!person || !procedural) return key === 'crawl' ? null : pedestrians.clipPose(index, key === 'getUpFront' || key === 'getUpBack' ? 'crouchUp' : key, phase);
      const clip = key === 'crouchUp' ? 'getUp' : key === 'getUpFront' ? 'riseFront' : key === 'getUpBack' ? 'riseBack' : key === 'crawl' ? 'crawl' : 'idle';
      const palette = procedural.ragdoll.standing(person, phase, clip);
      return palette ? { palette, duration: clip === 'idle' ? 1.2 : procedural.ragdoll.duration(person, clip) } : null;
    },
    loadedIndices: () => pedestrians.loadedIndices(),
    twin(index) {
      const person = procOf(index);
      // A cooked body draws as many palettes as it has pieces.
      if (!person || !procedural) return index >= 0 ? index : null;
      const twin = procedural.ragdoll.twin(person);
      if (!twin) return null;
      const key = TWIN_BASE - procTwinNext++;
      procTwins.set(key, twin);
      return key;
    },
    untwin(index) {
      const twin = procTwins.get(index);
      if (!twin || !procedural) return;
      procedural.ragdoll.untwin(twin);
      procTwins.delete(index);
    },
    char(index) {
      const person = procOf(index);
      if (person && procedural) procedural.ragdoll.char(person, true);
    },
    wound(index, part) {
      const person = procOf(index);
      if (!person || !procedural) return;
      procedural.ragdoll.wound(person, part);
      // The jerk of the hit is the captured one now (the `hit` clip, `procDraw` flinch), not a turn of the spine laid over the clip.
    },
    drench(index) {
      const person = procOf(index);
      if (person && procedural) procedural.ragdoll.drench(person);
    },
  };
  /** The soft shadow under a vehicle below the whole level (`blobShadows.ts`). */
  const vehicleBlobs = createBlobShadows('vehicle-shadows', MAX_VEHICLES, 0.4);
  const meshes = [...allParts.map((part) => part.mesh), vehicleBlobs.mesh, pedestrians.group, ...(procedural ? [procedural.group] : [])];

  const object = new Object3D();
  // Yaw outermost, so the third Euler component becomes a rotation about the agent's own lateral axis
  object.rotation.order = 'YXZ';
  const colour = new Color();

  // The palettes hold a few dozen distinct strings between them, so caching by the string avoids running the CSS parser
  const hexCache = new Map<string, number>();
  const hexOf = (css: string): number => {
    let hex = hexCache.get(css);
    if (hex === undefined) {
      colour.set(css);
      hex = colour.getHex();
      hexCache.set(css, hex);
    }
    return hex;
  };

  // Frame of the agent currently being written.
  let occupantBand = 0;
  let fx = 0;
  let fy = 0;
  let fdx = 1;
  let fdy = 0;
  let fyaw = 0;
  let fdeck = 0;
  // Lean of a two-wheeler into a bend, radians, positive to the left
  let froll = 0;
  let fcos = 1;
  let fsin = 0;
  /** THE vehicle's one transform, as a rotation */
  const fq = new Quaternion();
  const qPitch = new Quaternion();
  const qRoll = new Quaternion();
  const qPart = new Quaternion();
  const qLocal = new Quaternion();
  const vOffset = new Vector3();
  const AXIS_Y = new Vector3(0, 1, 0);
  const AXIS_Z = new Vector3(0, 0, 1);
  const AXIS_X = new Vector3(1, 0, 0);
  const eulerScratch = new Object3D();
  eulerScratch.rotation.order = 'YXZ';

  const frameAt = (x: number, y: number, angle: number, deck: number, roll = 0, pitch = 0, roadRoll = 0): void => {
    fx = x;
    fy = y;
    fyaw = angle;
    fdx = Math.cos(angle);
    fdy = Math.sin(angle);
    fdeck = deck;
    froll = roll;
    fcos = Math.cos(roll);
    fsin = Math.sin(roll);
    fq.setFromAxisAngle(AXIS_Y, angle);
    qPitch.setFromAxisAngle(AXIS_Z, pitch);
    qRoll.setFromAxisAngle(AXIS_X, roadRoll - roll);
    fq.multiply(qPitch).multiply(qRoll);
  };

  /** A point in the current frame (forward, up, left) to world (x, y) and height. */
  const toWorld = (along: number, up: number, side: number, out: { x: number; y: number; h: number }): void => {
    vOffset.set(along, up, -side).applyQuaternion(fq);
    out.x = fx + vOffset.x;
    out.y = fy - vOffset.z;
    out.h = fdeck + vOffset.y;
  };
  const partPoint = { x: 0, y: 0, h: 0 };

  /** Per-vehicle suspension state: the frame eases towards the road, never snaps. And the level it was drawn at. */
  const suspension = new Map<number, { deck: number; pitch: number; roll: number; seen: number; lod: number }>();
  const blobMatrix = new Matrix4();
  /** This frame's whole-level candidates' lengths on the screen, and the least one may have (last frame's cap). */
  const nearCandidates: number[] = [];
  /** The cars in bays in the cells in view, gathered each frame (`SimMirror.parkedIn`). */
  const parkedInView: SimVehicle[] = [];
  let nearFloor = 0;
  /** Whether a two-wheeler was drawn whole last frame: then they all cast into the shadow map */
  let bikesWhole = false;
  let castersChanged = false;
  let suspensionClock = typeof performance !== 'undefined' ? performance.now() : 0;
  let suspensionDt = 0;
  /** The simulation's own time between two frames drawn (tick and interpolation) */
  let gaitClock = -1;
  let gaitDt = 0;
  let suspensionFrame = 0;

  /** Writes one instance, positioned in the current agent's frame. */
  const place = (
    part: Part,
    along: number,
    side: number,
    up: number,
    sx: number,
    sy: number,
    sz: number,
    tint: number,
    rake = 0,
    yaw = 0,
  ): void => {
    // Through the vehicle's one transform (`fq`)
    toWorld(along, up, side, partPoint);
    object.position.set(partPoint.x, partPoint.h, -partPoint.y);
    eulerScratch.rotation.set(0, yaw, rake);
    qLocal.setFromEuler(eulerScratch.rotation);
    qPart.copy(fq).multiply(qLocal);
    object.quaternion.copy(qPart);
    object.scale.set(sx, sy, sz);
    object.updateMatrix();
    write(part, object.matrix, tint);
  };
  /** DO NOT write `setMatrixAt` on a part anywhere else: a parked car's copied frames show only what passed through here. */
  const write = (part: Part, matrix: Matrix4, tint: number): void => {
    if (part.n >= part.mesh.instanceMatrix.count) growPart(part, part.n + 1);
    part.mesh.setMatrixAt(part.n, matrix);
    if (tint >= 0) {
      colour.setHex(tint);
      part.mesh.setColorAt(part.n, colour);
      part.tinted = true;
    }
    if (part === lamps) lampGlow.setX(part.n, LAMP_GAIN.get(tint) ?? 0);
    if (recording) recording.push({ part, m: new Float32Array(matrix.elements), tint, linear: tint >= 0 ? colour.clone() : null });
    part.n++;
  };
  /** DO NOT go back to dropping what passes the capacity: the town's parked cars past the fleet's ceiling were not drawn. */
  const growPart = (part: Part, needed: number): void => {
    const mesh = part.mesh;
    let capacity = Math.max(1, mesh.instanceMatrix.count);
    while (capacity < needed) capacity *= 2;
    const matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    matrices.array.set(mesh.instanceMatrix.array);
    matrices.setUsage(DynamicDrawUsage);
    const colours = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    if (mesh.instanceColor) colours.array.set(mesh.instanceColor.array);
    colours.setUsage(DynamicDrawUsage);
    mesh.dispose();
    mesh.instanceMatrix = matrices;
    mesh.instanceColor = colours;
    if (part === lamps) {
      const glow = new InstancedBufferAttribute(new Float32Array(capacity), 1);
      glow.array.set(lampGlow.array);
      glow.setUsage(DynamicDrawUsage);
      unitBox.dispose();
      unitBox.setAttribute('glow', glow);
      lampGlow = glow;
    }
  };
  /** A parked car's instances as written (`place`), kept while it stands where it stood */
  /** `linear`: the tint as the working colour space holds it, worked out once */
  interface Written { readonly part: Part; readonly m: Float32Array; readonly tint: number; readonly linear: Color | null }
  let recording: Written[] | null = null;
  const parkedDraws = new Map<number, { x: number; y: number; angle: number; deck: number; band: number; paint: number; writes: Written[]; seen: number; blob: Matrix4 | null }>();
  const replay = (writes: readonly Written[]): void => {
    for (const rec of writes) {
      const part = rec.part;
      if (part.n >= part.mesh.instanceMatrix.count) growPart(part, part.n + 1);
      (part.mesh.instanceMatrix.array as Float32Array).set(rec.m, part.n * 16);
      if (rec.linear) {
        part.mesh.setColorAt(part.n, rec.linear);
        part.tinted = true;
      }
      if (part === lamps) lampGlow.setX(part.n, LAMP_GAIN.get(rec.tint) ?? 0);
      part.n++;
    }
  };

  /** Road wheels, plus their hubs at the closest band. */
  const placeWheels = (plan: BodyPlan, band: number): void => {
    const d = plan.wheelRadius * 2;
    plan.axleAlong.forEach((along, axle) => {
      // Only the front axle steers; every hub turns with the distance driven
      const steer = axle === 0 ? lamp.steer : 0;
      if (plan.shape === 'bicycle') {
        place(thinWheels, along, 0, plan.wheelRadius, d, d, plan.tread, RUBBER, 0, steer);
        place(spokes, along, 0, plan.wheelRadius, d, d, plan.tread, CHROME, lamp.spin, steer);
        return;
      }
      if (plan.axleSide === 0) {
        place(wheels, along, 0, plan.wheelRadius, d, d, plan.tread, RUBBER, 0, steer);
        if (band >= 1) {
          place(hubs, along, 0, plan.wheelRadius, d * 0.45, d * 0.45, plan.tread * 1.1, HUB, lamp.spin, steer);
        }
        return;
      }
      for (const side of SIDES) {
        place(wheels, along, side * plan.axleSide, plan.wheelRadius, d, d, plan.tread, RUBBER, 0, steer);
        if (band >= 1) {
          place(
            hubs,
            along,
            side * (plan.axleSide + plan.tread * 0.3),
            plan.wheelRadius,
            d * 0.52,
            d * 0.52,
            plan.tread * 0.5,
            HUB,
            lamp.spin,
            steer,
          );
        }
      }
    });
  };

  /** Hatchback, sedan, SUV and van, from the class's model (`vehicleModels.ts`) */
  const drawCar = (vehicle: SimVehicle, plan: BodyPlan, paintHex: number, look: VehicleLook, band: number): void => {
    const car = carParts.get(bodyKey(vehicle));
    if (!car) return;
    const model = car.model;
    if (band < 1) {
      // Far away: one opaque, low-poly body, glass and wheels painted on.
      place(car.far, 0, 0, 0, 1, 1, 1, paintHex);
      for (const l of model.taillamps) place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, lamp.tail);
      return;
    }
    const doorsMoving = vehicle.doors.length > 0;
    // Real shadows from the whole vehicle only; the middle level's is a soft disc (`sync`).
    const shell = band >= 2 ? car.shell : car.shellLite;
    if (!doorsMoving && look.windowsDown === 0) {
      place(shell, 0, 0, 0, 1, 1, 1, paintHex);
      place(car.glass, 0, 0, 0, 1, 1, 1, -1);
    } else if (!doorsMoving) {
      // A window down: the fixed glazing, then each door's window, lowered into its door
      place(shell, 0, 0, 0, 1, 1, 1, paintHex);
      place(car.openGlass, 0, 0, 0, 1, 1, 1, -1);
      model.doors.forEach((door, i) => {
        const down = (look.windowsDown & (door.side === -1 ? 1 : 2)) !== 0 && door.kind === 'hinge';
        const pane = windowPane(door, down ? look.windowDrop : 0);
        if (pane.visible) place(car.doorGlass[i]!, door.hingeX, -door.hingeZ, pane.up, 1, pane.sy, 1, -1);
      });
    } else {
      place(car.openShell, 0, 0, 0, 1, 1, 1, paintHex);
      place(car.openGlass, 0, 0, 0, 1, 1, 1, -1);
      model.doors.forEach((door, i) => {
        const open = doorOpening(vehicle, door.index);
        if (door.kind === 'slide') {
          // A plug door: out a little, then along the body.
          const out = Math.min(1, open * 4) * m(0.07);
          const along = door.hingeX + door.slide * smooth01((open - 0.15) / 0.85);
          const across = -(door.hingeZ + door.side * out);
          place(car.doors[i]!, along, across, 0, 1, 1, 1, paintHex);
          place(car.doorGlass[i]!, along, across, 0, 1, 1, 1, -1);
          return;
        }
        // Swung about the hinge, outwards on its own side.
        const swing = open * DOOR_SWING;
        place(car.doors[i]!, door.hingeX, -door.hingeZ, 0, 1, 1, 1, paintHex, 0, door.side * swing);
        place(car.doorGlass[i]!, door.hingeX, -door.hingeZ, 0, 1, 1, 1, -1, 0, door.side * swing);
      });
    }
    const roof = band >= 2 ? car.roof : car.roofLite;
    const accent = band >= 2 ? car.accent : car.accentLite;
    if (roof && car.roofGlass) {
      if (look.glassRoof) place(car.roofGlass, 0, 0, 0, 1, 1, 1, -1);
      else place(roof, 0, 0, 0, 1, 1, 1, look.blackRoof ? 0x15171a : paintHex);
    }
    if (accent) place(accent, 0, 0, 0, 1, 1, 1, look.accent);
    placeWheels(plan, band);

    place(car.trim, 0, 0, 0, 1, 1, 1, -1);
    for (const l of model.headlamps) place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, lamp.head);
    for (const l of model.taillamps) place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, lamp.tail);
    for (const l of model.indicators) {
      // `lamp.indicate` is +1 for left, and the model's left is -Z.
      if (lamp.indicate !== 0 && lamp.indicate === -l.side) {
        place(lamps, l.x, -l.z, l.y, l.sx * 1.2, l.sy, l.sz, INDICATOR);
      }
    }
    if (band < 2) return;
    if (!doorsMoving) place(car.interior, 0, 0, 0, 1, 1, 1, -1);
    else {
      place(car.openInterior, 0, 0, 0, 1, 1, 1, -1);
      model.doors.forEach((door, i) => {
        const card = car.doorCards[i];
        if (!card || door.kind !== 'hinge') return;
        place(card, door.hingeX, -door.hingeZ, 0, 1, 1, 1, -1, 0, door.side * doorOpening(vehicle, door.index) * DOOR_SWING);
      });
    }
    model.plates.forEach((l, i) => place(lamps, l.x, -l.z, l.y, l.sx, l.sy, l.sz, i < 2 ? PLATE : DESTINATION));
    placeCarOccupants(vehicle, car);
  };

  /** The company a vehicle's people are cast in (`citizenCasting.codesFor`). */
  const vehicleCompany = (vehicle: Pick<SimVehicle, 'archetype'>): Company =>
    vehicle.archetype.shape === 'bus' ? 'bus' : vehicle.archetype.shape === 'truck' ? 'truck'
      : vehicle.archetype.shape === 'motorcycle' || vehicle.archetype.shape === 'bicycle' ? 'rider' : 'car';
  /** Whether anybody aboard is a child: a car with a child in it is never on a work trip. */
  const carriesChild = (vehicle: SimVehicle): boolean => {
    const seats = Math.min(32, vehicle.archetype.seats);
    for (let i = 0; i < seats; i++) if ((vehicle.seats & (1 << i)) !== 0 && seatPerson(vehicle, i).ageClass === 'child') return true;
    return false;
  };
  /** The vehicles whose people were cast (`seatIdentity`), by id */
  const castVehicles = new Map<number, Pick<SimVehicle, 'id' | 'archetype'>>();
  /** The fleet's version `forgetCast` last looked at. */
  let castFleet = -1;
  /** The people of the vehicles gone from the world let go by the casting, when the fleet changed */
  const forgetCast = (world: SimMirror): void => {
    const fleet = world.fleetVersion;
    if (fleet === castFleet) return;
    castFleet = fleet;
    for (const [id, vehicle] of castVehicles) {
      if (world.has(vehicle)) continue;
      castVehicles.delete(id);
      pedestrians.forgetCompany(vehicleCompany(vehicle), id);
    }
  };
  /** Who sits in (or steps out of) a seat: the seat's person, cast with the vehicle's company. */
  const seatIdentity = (vehicle: Pick<SimVehicle, 'id' | 'archetype'>, person: { seed: number; gender: 'f' | 'm'; ageClass: 'child' | 'adult' | 'elder' },
    hasChild: boolean): ClipIdentity => {
    castVehicles.set(vehicle.id, vehicle);
    return { seed: person.seed, gender: person.gender, ageClass: person.ageClass,
      company: vehicleCompany(vehicle), companyId: vehicle.id, hasChild };
  };

  /** The whole person in a seat: its world point, written without allocating. */
  const seatPoint: { x: number; y: number; h?: number } = { x: 0, y: 0, h: 0 };

  /** The people in a car, each in a seat of the model */
  const placeCarOccupants = (vehicle: SimVehicle, car: CarParts): void => {
    if (occupantBand < 1) return;
    const model = car.model;
    // Who is sitting where is the simulation's (`Vehicle.seats`)
    const moving = vehicle.kerbStop?.phase === 'transfer' ? vehicle.kerbStop.seat : -1;
    let driverScale = 0;
    // Only the seats the simulation can fill: `Vehicle.seats` is a 32-bit mask, and `1 << 32` is 1 again in JavaScript.
    const seatCount = Math.min(model.seats.length, vehicle.archetype.seats);
    const hasChild = carriesChild(vehicle);
    // A person picked up from the street already has a visible identity.
    for (const pickedFirst of [true, false]) for (let index = 0; index < seatCount; index++) {
      if ((vehicle.seats & (1 << index)) === 0 || index === moving) continue;
      if ((vehicle.people[index] !== undefined) !== pickedFirst) continue;
      const seat = model.seats[index]!;
      if (seat.row > rowsDrawn) continue;
      seatWorldInto(seat, seatPoint, seat.hipY);
      const who = seatIdentity(vehicle, seatPerson(vehicle, index), hasChild);
      // The seat's pose (`riderPoses.ts`) with a glance now and then (`occupants.ts`).
      const slain = seat.driver && vehicle.slain === true;
      const plays = occupantPlays(seat, who.seed, frameClock, seatPlays, slain);
      const fixed = seat.pose === 'car' ? 0 : 1;
      const drawn = pedestrians.drawClip(who, seatPoint.x, seatPoint.y, seatPoint.h ?? fdeck + seat.hipY, fyaw, plays as readonly { key: CitizenClipKey; phase: number; weight: number }[],
        0, seatFitScale(seat), false, fixed, null, slain ? 'dead' : undefined);
      if (seat.driver) driverScale = drawn;
    }
    // The wheel where this driver's hands are: at their own size, and turned with the front wheels.
    if (car.steering && model.steering) {
      const seat = model.seats[model.steering.seat]!;
      const wheel = model.steering.wheel;
      const s = driverScale > 0 ? driverScale / m(1) : 1;
      placeSteeringWheel(car.steering, seat.x + m(wheel.forward) * s, -seat.z, seat.hipY + m(wheel.up) * s,
        wheel.tilt, Math.max(-1.6, Math.min(1.6, lamp.steer * 5)), s);
    }
    const stop = vehicle.kerbStop;
    if (stop) placeKerbPerson(vehicle, model, stop);
  };

  /** Reused by every seated person: what they play this frame. */
  const seatPlays: Play[] = [];
  /** Seconds of simulation, for the occupants' own motion; set per vehicle. */
  let frameClock = 0;
  /** Seat rows drawn this frame (`SeatModel.row`); set per sync from the zoom. */
  let rowsDrawn = Infinity;

  /** A steering wheel about its column: yaw with the vehicle, tilt, then the turn. */
  const placeSteeringWheel = (part: Part, along: number, side: number, up: number, tilt: number, turn: number, size = 1): void => {
    toWorld(along, up, side, partPoint);
    object.position.set(partPoint.x, partPoint.h, -partPoint.y);
    eulerScratch.rotation.order = 'YZX';
    eulerScratch.rotation.set(turn, 0, tilt);
    qLocal.setFromEuler(eulerScratch.rotation);
    eulerScratch.rotation.order = 'YXZ';
    object.quaternion.copy(fq).multiply(qLocal);
    // The rim at the driver's size too, so the hands on it are on it.
    object.scale.set(size, size, size);
    object.updateMatrix();
    // Through `write`, so a parked car's copied frames keep its wheel.
    write(part, object.matrix, -1);
  };

  const seatWorld = (seat: { x: number; z: number }): { x: number; y: number } =>
    ({ x: fx + fdx * seat.x + fdy * seat.z, y: fy + fdy * seat.x - fdx * seat.z });
  /** A seat (X forward, Z to the right, `up` above the road) to world, through the vehicle's transform */
  const seatWorldInto = (seat: { x: number; z: number }, out: { x: number; y: number; h?: number }, up = 0): void => {
    toWorld(seat.x, up, -seat.z, partPoint);
    out.x = partPoint.x;
    out.y = partPoint.y;
    out.h = partPoint.h;
  };

  /** Somebody at the kerb this frame (`occupants.kerbFigure`), reused. */
  const kerb = createKerbFigure();
  /** A world point in the current vehicle's frame: X forward, Z to the right. */
  const toVehicle = (x: number, y: number): { x: number; z: number } => {
    const dx = x - fx;
    const dy = y - fy;
    return { x: dx * fdx + dy * fdy, z: dx * fdy - dy * fdx };
  };

  /** Somebody getting out at the kerb, or in. */
  const placeKerbPerson = (vehicle: SimVehicle, model: VehicleModel, stop: KerbStop): void => {
    const progress = kerbTransfer(stop);
    const person = stop.person;
    const door = model.doors.find((d) => d.index === stop.door);
    if (!progress || !person || !door) return;
    const side = door.side;
    const along = door.hingeX - door.length / 2;
    const flank = Math.abs(door.hingeZ);
    const seat = stop.seatStage ? model.seats[stop.seat] : undefined;
    const identity = seatIdentity(vehicle, person, carriesChild(vehicle));
    if (seat && door.kind === 'hinge' && !(progress.walked >= 1 && (stop.phase === 'hold' || stop.phase === 'close'))) {
      const f = kerbFigure({ seat, door, foot: toVehicle(person.footX, person.footY) }, stop.kind, progress.seated, progress.walked, kerb);
      seatWorldInto(f, seatPoint, f.y);
      pedestrians.drawClip(identity, seatPoint.x, seatPoint.y, seatPoint.h ?? fdeck + f.y, fyaw + f.heading, f.plays,
        0, f.seated ? seatFitScale(seat) : Infinity, f.anchor === 'pelvis' ? false : f.anchor === 'feet' ? true : 'pelvisOver');
      return;
    }
    // Just outside the door opening on the road, and just inside it.
    const outside = seatWorld({ x: along, z: side * (flank + m(0.45)) });
    const inside = seatWorld({ x: along, z: side * (flank - m(0.4)) });
    const walkTo = (fromX: number, fromY: number, toX: number, toY: number, t: number, height: number): void => {
      const x = fromX + (toX - fromX) * t;
      const y = fromY + (toY - fromY) * t;
      const distance = hypot2(toX - fromX, toY - fromY);
      const heading = Math.atan2(toY - fromY, toX - fromX);
      pedestrians.drawClip(identity, x, y, height, heading,
        [{ key: 'walk', phase: 0, distance: distance * t, weight: 1 }], 0, Infinity, true);
    };
    if (progress.walked >= 1 && (stop.phase === 'hold' || stop.phase === 'close')) {
      // Standing on the footway: the truck's mate with the load, facing the truck.
      pedestrians.drawClip(identity, person.footX, person.footY, fdeck,
        Math.atan2(outside.y - person.footY, outside.x - person.footX),
        [{ key: 'idle', phase: (stop.t * 0.1) % 1, weight: 1 }], 0, Infinity, true);
      return;
    }
    if (progress.walked > 0 || progress.seated <= 0) {
      // Between the door and the footway.
      if (stop.kind === 'drop') walkTo(outside.x, outside.y, person.footX, person.footY, progress.walked, fdeck);
      else walkTo(person.footX, person.footY, outside.x, outside.y, 1 - progress.walked, fdeck);
      return;
    }
    // A bus: stepping up through the door, then gone inside.
    const t = stop.kind === 'drop' ? 1 - progress.seated : progress.seated;
    if (stop.kind === 'pick' && t > 0.9) return;
    walkTo(outside.x, outside.y, inside.x, inside.y, stop.kind === 'pick' ? t : 1 - t, fdeck + m(0.25) * t);
  };

  /** A motorcycle or a bicycle from its model */
  const drawTwoWheeler = (vehicle: SimVehicle, plan: BodyPlan, paintHex: number, look: VehicleLook, band: number): void => {
    const bike = twoWheelerParts.get(vehicle.archetype.id);
    if (!bike) return;
    const model = bike.model;
    place(bike.body, 0, 0, 0, 1, 1, 1, paintHex);
    place(bike.steering, model.headX, 0, model.headY, 1, 1, 1, CHROME, 0, lamp.steer);
    placeWheels(plan, band);
    if (band < 1) return;
    place(bike.trim, 0, 0, 0, 1, 1, 1, TRIM);
    if (bike.cranks) place(bike.cranks, model.bracketX, 0, model.bracketY, 1, 1, 1, CHROME, -lamp.crank);
    const h = model.headlamp;
    place(lamps, h.x, 0, h.y, h.sx, h.sy, h.sz, HEADLAMP, 0, lamp.steer);
    const t = model.taillamp;
    place(lamps, t.x, 0, t.y, t.sx, t.sy, t.sz, lamp.tail);
    placeRiderFigure(vehicle, model, plan.shape === 'bicycle', look);
  };

  /** The person astride: a baked IK pose */
  const placeRiderFigure = (vehicle: SimVehicle, model: TwoWheelerModel, cyclist: boolean, look: VehicleLook): void => {
    if (occupantBand < 1) return;
    const pelvisUp = model.seatY;
    // The seat point rolled about the road-level forward axis (`place`).
    const sideOffset = pelvisUp * fsin;
    const x = fx + fdx * model.seatX - fdy * sideOffset;
    const y = fy + fdy * model.seatX + fdx * sideOffset;
    const height = fdeck + pelvisUp * fcos;
    const moving = riderMoving(vehicle);
    const steer = Math.max(-1, Math.min(1, lamp.steer / STEER_FULL));
    const plays = riderPlays;
    plays.length = 0;
    if (cyclist) {
      const phase = (-lamp.crank - Math.PI) / (2 * Math.PI);
      plays.push({ key: 'bikePedal', phase, weight: moving * (1 - Math.abs(steer) * 0.4) });
      if (steer > 0) plays.push({ key: 'bikeLeft', phase: 0, weight: moving * steer * 0.4 });
      if (steer < 0) plays.push({ key: 'bikeRight', phase: 0, weight: moving * -steer * 0.4 });
      plays.push({ key: 'bikeStop', phase: 0, weight: 1 - moving });
    } else {
      plays.push({ key: 'motoRide', phase: 0, weight: moving * (1 - Math.abs(steer)) });
      if (steer > 0) plays.push({ key: 'motoLeft', phase: 0, weight: moving * steer });
      if (steer < 0) plays.push({ key: 'motoRight', phase: 0, weight: moving * -steer });
      plays.push({ key: 'motoStop', phase: 0, weight: 1 - moving });
    }
    // At the size the pose was solved at: the hands are on the grips and the feet on the pegs or pedals only there.
    const drawn = pedestrians.drawClip(seatIdentity(vehicle, seatPerson(vehicle, 0), false), x, y, height, fyaw, plays, froll, Infinity, false, 1,
      cyclist ? null : helmetMatrix);
    if (!cyclist && drawn > 0) {
      // A motorcyclist's helmet, fitted to this body's head (`riderPoses.helmetShape`) and put where the pose just drawn has it.
      write(helmets, helmetMatrix, look.helmet);
    }
  };

  /** The helmet of the rider just drawn (`drawClip`). */
  const helmetMatrix = new Matrix4();



  /** Refreshed for every vehicle, read by whichever body builder runs. */
  const lamp: LampState = { head: HEADLAMP, tail: TAILLAMP, indicate: 0, steer: 0, spin: 0, crank: 0 };
  // One elevation callback for every vehicle and pedestrian drawn this frame.
  let currentSegment: SegmentId | undefined;
  const elevationOnCurrent = (x: number, y: number): number => elevationAt(x, y, currentSegment);
  /** DO NOT key it by position alone: a parked car kept the height it was first asked at and floated over */
  const offRoadDecks = new WeakMap<SimVehicle, { x: number; y: number; deck: number; seen: number }>();
  /** DO NOT ask the diary per car (`touches`): every car read every entry since its serial, cars x entries a frame */
  let offRoadSweep: ChangeSweep | null = null;
  let offRoadSerial = 0;
  const offRoadDeck = (v: SimVehicle, x: number, y: number): number => {
    const known = offRoadDecks.get(v);
    if (known && known.x === x && known.y === y) {
      if (known.seen >= offRoadSerial) return known.deck;
      if (!offRoadSweep!.touches(known.seen, x, y)) {
        known.seen = offRoadSerial;
        return known.deck;
      }
    }
    const lot = v.free?.lot ?? null;
    const onLot = lot !== null && lotAt ? lotAt(lot, x, y) : NaN;
    const deck = Number.isFinite(onLot) ? onLot : elevationAt(x, y, undefined);
    offRoadDecks.set(v, { x, y, deck, seen: offRoadSerial });
    return deck;
  };
  // `vehicleLook` by id: it is a pure function of the id and the seat count
  const looks = new Map<number, { seats: number; look: VehicleLook; seen: number }>();

  return {
    meshes,
    get castersChanged() { return castersChanged; },
    census: () => pedestrians.census(),
    meshProbe() {
      const out: { id: number; stretch: number; stretchBone: string; scale: number; scaleBone: string; held: boolean; clip: string }[] = [];
      if (!procedural) return out;
      const inv = new Matrix4();
      for (const [id, entry] of procPeople) {
        const person = entry.person;
        if (!person) continue;
        const pal = procedural.ragdoll.pose(person);
        const sk = procedural.ragdoll.skeleton(person);
        if (!pal || !sk) continue;
        // At this person's own joints (`skeleton` gives the binds moved to them).
        const bind = sk.inverses.map((m4) => { const e = inv.copy(m4).invert().elements; return [e[12]!, e[13]!, e[14]!] as const; });
        // Measured against the same person standing (their own proportions, `refit`)
        const rest = procedural.ragdoll.standing(person, 0);
        if (!rest) continue;
        const atIn = (m: Float32Array, b: number): [number, number, number] => {
          const o = b * 16, [x, y, z] = bind[b]!;
          return [m[o]! * x + m[o + 4]! * y + m[o + 8]! * z + m[o + 12]!, m[o + 1]! * x + m[o + 5]! * y + m[o + 9]! * z + m[o + 13]!,
            m[o + 2]! * x + m[o + 6]! * y + m[o + 10]! * z + m[o + 14]!];
        };
        const at = (b: number): [number, number, number] => atIn(pal, b);
        const norm = (b: number): number => Math.max(Math.hypot(pal[b * 16]!, pal[b * 16 + 1]!, pal[b * 16 + 2]!),
          Math.hypot(pal[b * 16 + 4]!, pal[b * 16 + 5]!, pal[b * 16 + 6]!), Math.hypot(pal[b * 16 + 8]!, pal[b * 16 + 9]!, pal[b * 16 + 10]!));
        let stretch = 1, stretchBone = '', scale = 0, scaleBone = '';
        let longest = 0;
        for (let b = 0; b < sk.parents.length; b++) {
          const p = sk.parents[b]!;
          if (p >= 0) longest = Math.max(longest, Math.hypot(bind[b]![0] - bind[p]![0], bind[b]![1] - bind[p]![1], bind[b]![2] - bind[p]![2]));
        }
        for (let b = 0; b < sk.parents.length; b++) {
          const name = sk.names[b] ?? '';
          if (/Finger|Toe|Nub|_end|twist/i.test(name)) continue;
          const n = norm(b);
          if (n > scale) { scale = n; scaleBone = name; }
          const p = sk.parents[b]!;
          // Not against the root (it stays at the feet: a crouch lowers the pelvis to it, no skin between).
          if (p < 0 || sk.parents[p]! < 0 || n < 0.5 || norm(p) < 0.5) continue;
          const ra = atIn(rest, b), rc = atIn(rest, p);
          const l0 = Math.hypot(ra[0] - rc[0], ra[1] - rc[1], ra[2] - rc[2]);
          // Bones of real length only: a few millimetres between the spine and the pelvis made a 3x from nothing.
          if (l0 < longest * 0.12) continue;
          const a = at(b), c = at(p);
          const r = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]) / l0;
          if (Math.abs(r - 1) > Math.abs(stretch - 1)) { stretch = r; stretchBone = `${name}<${sk.names[p]} ${(l0 * 100).toFixed(1)}cm ${person.sex}-${person.band}`; }
        }
        out.push({ id, stretch, stretchBone, scale, scaleBone, held: procHeld.has(id), clip: person.clip });
      }
      return out;
    },
    animProbe(id) {
      const person = procPeople.get(id)?.person;
      if (!person || !procedural) return null;
      const duration = procedural.ragdoll.duration(person, person.clip);
      const held = procHeld.has(id);
      return {
        clip: person.clip, time: (person.phase - Math.floor(person.phase)) * duration, duration, weight: held ? 0 : 1,
        paused: procFrozen.has(id), layers: procedural.ragdoll.layers(person), source: held ? 'physics' : 'animation',
      };
    },
    forceClip(id, clip) {
      if (clip) procForced.set(id, clip); else procForced.delete(id);
    },
    driverBody(vehicle, x, y) {
      return pedestrians.indexFor(seatIdentity(vehicle, seatPerson(vehicle, 0), false), vehicle.archetype.shape === 'motorcycle', x, y);
    },
    carcass(vehicle, intact = false) {
      const a = vehicle.archetype;
      const plan = planOf(a);
      const pieces: BufferGeometry[] = [];
      const put = (g: BufferGeometry, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): void => {
        pieces.push(g.clone().scale(sx, sy, sz).translate(x, y, z));
      };
      const d = plan.wheelRadius * 2;
      if (a.shape === 'motorcycle' || a.shape === 'bicycle') {
        const t = twoWheelerParts.get(a.id);
        if (!t) return null;
        const md = t.model;
        put(md.body, 0, 0, 0); put(md.trim, 0, 0, 0); put(md.steering, md.headX, md.headY, 0);
        if (md.cranks) put(md.cranks, md.bracketX, md.bracketY, 0);
        // The tyres burnt away: the rims left, sagging to the ground (whole, on a machine merely dropped).
        for (const along of plan.axleAlong) {
          if (intact) {
            put(a.shape === 'bicycle' ? thinTyreGeometry : wheelGeometry, along, plan.wheelRadius, 0, d, d, plan.tread);
            put(a.shape === 'bicycle' ? spokedGeometry : hubGeometry, along, plan.wheelRadius, 0, d * (a.shape === 'bicycle' ? 1 : 0.45), d * (a.shape === 'bicycle' ? 1 : 0.45), plan.tread);
          } else if (a.shape === 'bicycle') put(spokedGeometry, along, plan.wheelRadius * 0.93, 0, d * 0.95, d * 0.95, plan.tread);
          else put(hubGeometry, along, plan.wheelRadius * 0.75, 0, d * 0.72, d * 0.72, plan.tread);
        }
      } else {
        const car = carParts.get(bodyKey(vehicle as SimVehicle));
        if (!car) return null;
        const md = car.model;
        put(md.shell, 0, 0, 0); put(md.trim, 0, 0, 0); put(md.interior, 0, 0, 0);
        if (md.accent) put(md.accent, 0, 0, 0);
        if (md.roof) put(md.roof, 0, 0, 0);
        for (const along of plan.axleAlong) {
          for (const side of plan.axleSide === 0 ? [0] : SIDES) {
            put(hubGeometry, along, plan.wheelRadius * 0.72, -side * plan.axleSide, d * 0.62, d * 0.62, plan.tread * 0.6);
          }
        }
      }
      const merged = merge(pieces);
      // Each wreck its own: the panels buckled and the roof sagged by the heat and the blast, by a pattern of its own (its id).
      merged.computeBoundingBox();
      const box = merged.boundingBox!;
      const centre = box.getCenter(new Vector3());
      merged.translate(-centre.x, -centre.y, -centre.z);
      if (intact) { merged.computeVertexNormals(); return merged; }
      const pos = merged.getAttribute('position');
      const seed = (vehicle.id * 2654435761) >>> 0;
      const wave = (x: number, y: number, z: number, k: number): number => Math.sin(x * k + (seed % 97)) * Math.cos(z * k * 1.3 + (seed % 61)) + Math.sin(y * k * 0.7 + (seed % 13));
      const half = (box.max.y - box.min.y) / 2;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const top = Math.max(0, y / Math.max(1e-6, half));
        const dent = wave(x, y, z, 1 / m(0.45)) * m(0.04) + wave(x, y, z, 1 / m(0.18)) * m(0.015);
        pos.setXYZ(i, x + dent * 0.5, y - top * top * m(0.12) + dent, z + dent * 0.6);
      }
      merged.computeVertexNormals();
      return merged;
    },
    setBleed: (fn) => { pedestrians.onBleed = fn; procBleed = fn; },
    setNight: (dark) => {
      lampDark.value = dark;
    },
    renderPalettes: (renderer) => procedural?.renderPalettes(renderer),
    sync(world, net, alpha, detailed, zoom = Number.POSITIVE_INFINITY, options = {}) {
      // A new document has a journal of its own: the sweep follows the one the world stands on.
      if (offRoadSweep?.journal !== net.doc.changes) offRoadSweep = new ChangeSweep(net.doc.changes, OFF_ROAD_GROUND);
      offRoadSweep.advance();
      offRoadSerial = offRoadSweep.serial;
      const now = typeof performance !== 'undefined' ? performance.now() : suspensionClock + 16;
      suspensionDt = Math.min(0.1, Math.max(0, (now - suspensionClock) / 1000));
      suspensionClock = now;
      const simNow = (world.tick + alpha) * DT;
      gaitDt = gaitClock < 0 ? 0 : Math.min(0.5, Math.max(0, simNow - gaitClock));
      gaitClock = simNow;
      suspensionFrame++;
      if (suspensionFrame % 600 === 0) {
        for (const [id, ride] of suspension) if (suspensionFrame - ride.seen > 120) suspension.delete(id);
        for (const [id, entry] of looks) if (suspensionFrame - entry.seen > 120) looks.delete(id);
      }
      forgetCast(world);
      pedestrians.begin(options.pedestrianDetail ?? 2, zoom);
      procPixels = options.personPixels ?? null;
      for (const part of allParts) part.n = 0;
      const band = !detailed ? 0 : zoom >= NEAR_DETAIL_ZOOM ? 2 : 1;
      // Vehicles have their own bands: the far proxy below FAR_BODY_ZOOM, the whole body above it
      const occupantZoom = options.occupantZoom ?? OCCUPANT_ZOOM;
      const vehicleBand = !detailed || zoom < FAR_BODY_ZOOM ? 0 : zoom >= occupantZoom ? 2 : 1;
      // Between the occupant zoom and 1.6 times it, only the front row.
      rowsDrawn = zoom >= occupantZoom * 1.6 ? Infinity : 0;

      const screenScale = options.screenScale;
      const softShadows = options.shadows !== false;
      let whole = 0;
      nearCandidates.length = 0;
      // Last frame's answer: this frame's discs and casting agree with each other.
      const bikesCast = bikesWhole;
      let bikesWholeNow = false, carsWheeled = false;
      vehicleBlobs.begin();
      if (suspensionFrame % 600 === 0) for (const [id, entry] of parkedDraws) if (suspensionFrame - entry.seen > 120) parkedDraws.delete(id);
      // The traffic, then the scenery's cars parked in their bays in the cells in view (grown by a shadow's reach), on the ground of the lot.
      parkedInView.length = 0;
      const areaPixels = options.areaPixels;
      world.parkedIn(areaPixels
        ? (x0, y0, x1, y1) => areaPixels(x0 - PARKED_REACH, y0 - PARKED_REACH, x1 + PARKED_REACH, y1 + PARKED_REACH, PARKED_LOW, PARKED_HIGH) * CAR_LENGTH >= 2
        : () => true, parkedInView);
      for (const list of [world.road, parkedInView]) for (const vehicle of list) {
        // Off the road and not moving (the town's parked cars): where it is, with none of the interpolation's sums.
        const at = vehicle.free;
        const pose = POSE;
        if (at && at.px === at.x && at.py === at.y && at.pangle === at.angle) { pose.p.x = at.x; pose.p.y = at.y; pose.angle = at.angle; }
        else shownPoseInto(vehicle, alpha, pose);
        const free = vehicle.free !== null;
        const plan = planOf(vehicle.archetype);
        const twoWheeled = plan.shape === 'motorcycle' || plan.shape === 'bicycle';
        const deck = free ? offRoadDeck(vehicle, pose.p.x, pose.p.y) : elevationAt(pose.p.x, pose.p.y, vehicle.segment);
        // Off screen, and too far from it for its shadow to fall on it: nothing of this vehicle is written this frame.
        if (options.vehicleVisible && !options.vehicleVisible(pose.p.x, pose.p.y, deck, plan.length * 0.5 + plan.height * 2)) continue;
        // Its own level, by the screen's scale where it stands (a tenth of hysteresis going up).
        let ride = suspension.get(vehicle.id);
        const pixels = screenScale ? screenScale(pose.p.x, pose.p.y, deck) : Infinity;
        const was = ride?.lod ?? -1;
        let own = -1;
        for (let level = 2; level >= 0; level--) {
          const edge = level === 2 ? occupantZoom : level === 1 ? FAR_BODY_ZOOM : 2 / CAR_LENGTH;
          if (pixels >= (level > was ? edge * (1 + VEHICLE_HYSTERESIS) : edge)) { own = level; break; }
        }
        if (own < 0) continue;
        // Whole: at most `VEHICLE_NEAR_CAP`, the biggest on the screen (last frame's floor).
        if (own === 2) {
          nearCandidates.push(pixels);
          if (pixels < nearFloor || whole >= VEHICLE_NEAR_CAP) own = 1;
          else whole++;
        }
        const level = Math.min(vehicleBand, own);
        if (twoWheeled && level === 2) bikesWholeNow = true;
        if (!twoWheeled && level >= 1) carsWheeled = true;
        const parked = free && vehicle.seats === 0 && vehicle.v === 0;
        // Standing where it stood, drawn as it was: its instances copied, none of the sums.
        const still = parked && !twoWheeled && vehicle.doors.length === 0 && !vehicle.kerbStop;
        if (still) {
          const kept = parkedDraws.get(vehicle.id);
          if (kept && kept.x === pose.p.x && kept.y === pose.p.y && kept.angle === pose.angle && kept.deck === deck
            && kept.band === level && kept.paint === hexOf(vehicle.color)) {
            replay(kept.writes);
            kept.seen = suspensionFrame;
            if (ride) { ride.seen = suspensionFrame; ride.lod = own; }
            if (level < 2 && softShadows) {
              // Its shadow where it stands, worked out once.
              kept.blob ??= new Matrix4().makeRotationY(pose.angle).setPosition(pose.p.x, deck, -pose.p.y);
              vehicleBlobs.add(kept.blob, plan.length * 0.55, plan.width * 0.62);
            }
            continue;
          }
        }
        // A parked car's engine is off; a bicycle has none. Far off (the proxy), no smoke drawn.
        if (options.exhaust && level >= 1 && plan.shape !== 'bicycle' && !parked) {
          // Off the road (a lot, a drive) the wheels raise dust.
          options.exhaust(pose.p.x, pose.p.y, deck, pose.angle, plan.length, vehicle.v, free);
        }
        // A two-wheeler leans into its bend and, stopped, tilts onto the rider's foot on the road (`TwoWheelerFit.stopTilt`).
        const fit = twoWheeled ? twoWheelerParts.get(vehicle.archetype.id)?.model.fit : undefined;
        // The road under each axle and each side
        const front = plan.axleAlong[0] ?? plan.length * 0.35;
        const rear = plan.axleAlong[plan.axleAlong.length - 1] ?? -plan.length * 0.35;
        currentSegment = vehicle.segment;
        // A car off the road stands level on its lot (lots are laid near flat).
        const slope = !free && (level >= 2 || twoWheeled || !ride || (level === 1 && ((suspensionFrame + vehicle.id) & 1) === 0));
        const want = WANT;
        if (free || (level === 0 && !twoWheeled)) { want.deck = deck; want.pitch = 0; want.roll = 0; }
        else if (slope) roadFrameInto(elevationOnCurrent, pose.p.x, pose.p.y, pose.angle, front, rear, twoWheeled ? 0 : plan.axleSide, deck, want);
        else { want.deck = deck; want.pitch = ride!.pitch; want.roll = ride!.roll; }
        const wantDeck = want.deck;
        const wantPitch = want.pitch;
        const wantRoll = want.roll;
        // Suspension: pitch and roll ease towards the road over a few hundredths of a second, so a change of grade is ridden
        if (!ride || Math.abs(ride.pitch - wantPitch) > 0.2) {
          ride = { deck: wantDeck, pitch: wantPitch, roll: wantRoll, seen: suspensionFrame, lod: own };
          suspension.set(vehicle.id, ride);
        } else {
          const k = 1 - Math.exp(-suspensionDt / SUSPENSION_TAU);
          ride.pitch += (wantPitch - ride.pitch) * k;
          ride.roll += (wantRoll - ride.roll) * k;
          ride.deck = wantDeck;
          ride.seen = suspensionFrame;
          ride.lod = own;
        }
        frameAt(pose.p.x, pose.p.y, pose.angle, ride.deck,
          twoWheeled ? leanOf(vehicle) + (fit ? fit.stopTilt * (1 - riderMoving(vehicle)) : 0) : 0,
          ride.pitch, ride.roll);
        const paintHex = hexOf(vehicle.color);
        let lookEntry = looks.get(vehicle.id);
        if (!lookEntry || lookEntry.seats !== plan.seats) {
          lookEntry = { seats: plan.seats, look: vehicleLook(vehicle.id, plan.seats), seen: suspensionFrame };
          looks.set(vehicle.id, lookEntry);
        } else lookEntry.seen = suspensionFrame;
        const look = lookEntry.look;
        occupantBand = twoWheeled ? vehicleBand : level;
        frameClock = vehicle.age;

        // Brakes and indicators, straight off the simulation.
        const decel = (vehicle.prev.v - vehicle.v) / DT;
        // A car standing in its bay with nobody in it has its lamps off.
        lamp.head = parked ? HEADLAMP_OFF : HEADLAMP;
        lamp.tail = parked ? TAILLAMP_OFF : decel >= BRAKE_DECEL ? BRAKELAMP : TAILLAMP;
        // `lateral` is the unfinished part of a lane change, signed towards the lane being left
        if (level >= 1 || twoWheeled) {
          const side = vehicle.indicator;
          lamp.indicate = side !== 0 && blinkOn(vehicle.age, vehicle.id) ? side : 0;
          const axles = plan.axleAlong;
          lamp.steer = free ? 0 : steerAngle(vehicle.curvature, (axles[0] ?? 0) - (axles[axles.length - 1] ?? 0));
          const driven = vehicle.odometer;
          lamp.spin = -driven / Math.max(plan.wheelRadius, 1e-3);
          // A bicycle's cranks turn a little over half a turn per turn of the wheel: about 80 rpm at a city cyclist's 18 km/h.
          lamp.crank = (driven / (2 * Math.PI * Math.max(plan.wheelRadius, 1e-3))) * CRANK_RATIO * 2 * Math.PI;
        } else { lamp.indicate = 0; lamp.steer = 0; }
        if (still) recording = [];
        switch (plan.shape) {
          case 'motorcycle':
          case 'bicycle':
            drawTwoWheeler(vehicle, plan, paintHex, look, Math.max(1, vehicleBand));
            break;
          case 'car':
          case 'bus':
          case 'truck':
            drawCar(vehicle, plan, paintHex, look, level);
            break;
        }
        if (still && recording) {
          parkedDraws.set(vehicle.id, { x: pose.p.x, y: pose.p.y, angle: pose.angle, deck, band: level, paint: paintHex, writes: recording, seen: suspensionFrame, blob: null });
          recording = null;
        }
        // Below the whole level, its shadow is a soft disc (the body casts none); a two-wheeler's too while none is drawn whole
        if ((twoWheeled ? !bikesCast : level < 2) && softShadows) {
          blobMatrix.makeRotationY(pose.angle).setPosition(pose.p.x, ride.deck, -pose.p.y);
          vehicleBlobs.add(blobMatrix, plan.length * 0.55, plan.width * 0.62);
        }
      }
      vehicleBlobs.finish();
      // The two-wheelers cast only while one is drawn whole; the shared tyres also while a car is drawn with its wheels.
      castersChanged = thinWheels.mesh.castShadow !== bikesCast;
      for (const t of twoWheelerParts.values()) { t.body.mesh.castShadow = bikesCast; t.trim.mesh.castShadow = bikesCast; }
      thinWheels.mesh.castShadow = bikesCast;
      wheels.mesh.castShadow = bikesCast || carsWheeled;
      bikesWhole = bikesWholeNow;
      // Next frame's floor for the whole level: the cap's smallest of this frame.
      if (nearCandidates.length > VEHICLE_NEAR_CAP) {
        nearCandidates.sort((a, b) => b - a);
        nearFloor = nearCandidates[VEHICLE_NEAR_CAP - 1]!;
      } else nearFloor = 0;

      // Pedestrians start at band 1: zoomed out past it a whole person is smaller than a car's wing mirror
      if (band >= 1) {
        let pedCount = 0;
        for (const ped of world.pedViews) {
          if (pedCount >= MAX_PEDS) break;
          if (options.hiddenPed?.(ped.id)) continue;
          pedPoseInto(ped, alpha, POSE);
          const pose = POSE;
          const open = ped.ground === 'open';
          const segment = ped.segment;
          currentSegment = segment;
          const land = open && groundAt ? groundAt : elevationOnCurrent;
          // DO NOT ask them of every walker of the simulation before the test.
          const below = open ? (roughGroundAt ?? land)(pose.p.x, pose.p.y) : elevationAt(pose.p.x, pose.p.y, segment);
          if (options.pedestrianVisible && !options.pedestrianVisible(pose.p.x, pose.p.y, below)) continue;
          const rise = open ? m(0.04) : footwayRiseAt(net, pose.p.x, pose.p.y) * walkingRise(net, pose.p.x, pose.p.y, ped.ground !== 'crossing',
            segment === undefined ? 'ground' : net.doc.segment(segment)?.structure ?? 'ground');
          const deck = (open && roughGroundAt ? land(pose.p.x, pose.p.y) : below) + rise;
          frameAt(pose.p.x, pose.p.y, pose.angle, deck);
          if (procedural && ped.id !== PLAYER_ID) {
            // What they are doing shows before the fright on their face (a photo held up, a crouch, a fall).
            const doing = ped.gesture?.kind;
            // Shot and still going: the pain on their face over the fright.
            const shown = doing === 'photo' || doing === 'crouch' || doing === 'fall' || doing === 'flinch' || doing === 'look' || doing === 'mourn' || doing === 'crawl' ? doing : ped.bleeding ? 'hurt' : ped.panic ? 'panic' : doing;
            if (ped.bleeding || ped.lost?.length) procBleed?.(ped.id, pose.p.x, pose.p.y, deck);
            // The gait at the body's real speed: a step aside is steps, not a glide.
            const gait = gaitSpeed(ped);
            procDraw(ped.id, pose.p.x, pose.p.y, pose.angle, deck, gait, ped.walking || gait > m(0.15), gaitDt, shown,
              ped.lost ?? (ped.maimed ? [ped.maimed] : undefined), ped.gesture ? { t: ped.gesture.t, hold: ped.gesture.hold ?? 0 } : undefined, ped.wound, ped.ageClass);
          }
          else {
            // The rise is the same on both sides of the difference, so the gradient is the road's own under the walker.
            const ground = groundGradient(land,
              pose.p.x, pose.p.y, deck - rise);
            pedestrians.draw(ped, pose.p.x, pose.p.y, pose.angle, deck, alpha, ground);
          }
          pedCount++;
        }
      }

      if (procedural) {
        const live = procLive;
        live.clear();
        for (const ped of world.pedViews) live.add(ped.id);
        // Those a ragdoll holds (struck, down, or dead) keep their person.
        for (const id of procHeld) live.add(id);
        procFinish(options.eye, live);
      }
      // The ragdolls draw the procedural people as themselves (`procRagdoll`), the rest as cooked bodies.
      procHeldNow.clear();
      options.ragdolls?.(procedural ? procRagdoll : riggedRagdoll);
      if (procedural) {
        // Let go of those the ragdolls no longer hold (up again).
        for (const id of procHeld) if (!procHeldNow.has(id)) { const p = procPeople.get(id)?.person; if (p) procedural.ragdoll.hold(p, null); }
        procHeld.clear();
        for (const id of procHeldNow) procHeld.add(id);
        procedural.update(options.eye, gaitClock < 0 ? undefined : gaitClock, options.shadows !== false);
      }
      pedestrians.finish();

      // Upload only what was written this frame.
      for (const part of allParts) {
        part.mesh.count = part.n;
        // An empty instanced mesh still costs a program bind, its uniforms and a state change in every pass
        part.mesh.visible = part.n > 0;
        const matrix = part.mesh.instanceMatrix;
        matrix.clearUpdateRanges();
        if (part.n > 0) matrix.addUpdateRange(0, part.n * 16);
        matrix.needsUpdate = true;

        const colour = part.mesh.instanceColor;
        if (colour && part.tinted) {
          colour.clearUpdateRanges();
          if (part.n > 0) colour.addUpdateRange(0, part.n * 3);
          colour.needsUpdate = true;
        }
        if (part === lamps) {
          lampGlow.clearUpdateRanges();
          if (part.n > 0) lampGlow.addUpdateRange(0, part.n);
          lampGlow.needsUpdate = true;
        }
        part.tinted = false;
      }
    },
    dispose() {
      pedestrians.dispose();
      vehicleBlobs.dispose();
      for (const part of allParts) part.mesh.dispose();
      for (const geometry of [
        unitBox,
        torsoGeometry,
        wheelGeometry,
        hubGeometry,
        thinTyreGeometry,
        spokedGeometry,
        headGeometry,
        helmetGeometry,
      ]) {
        geometry.dispose();
      }
      for (const geometry of modelGeometries) geometry.dispose();
      for (const material of [paint, trim, glassMaterial, rubber, lampMaterial, cloth, cabinMaterial]) {
        material.dispose();
      }
    },
  };
}

/** Narrows a unit box towards its top, in place. */
function taper(geometry: BufferGeometry, topX: number, topZ: number): void {
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) > 0) {
      position.setX(i, position.getX(i) * topX);
      position.setZ(i, position.getZ(i) * topZ);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}
