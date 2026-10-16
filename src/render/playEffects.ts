import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  LineBasicMaterial,
  LineSegments,
  PointLight,
  Quaternion,
  Vector3,
  type Camera,
  type Scene,
} from 'three';
import type { BodyPart, Severable } from '@sim/people/view';
import type { Archetype } from '@sim/vehicles/archetypes';
import { type ShownVehicle as SimVehicleShown, type SimMirror, shownPoseInto } from '@sim/mirror';
import type { RoadDoc } from '@world/doc';
import { newPose } from '@sim/pose';
import { solidsOf } from '@world/solids';
import { floorHeight } from '@world/buildings/foundation';
import { roofHeightAt, roofRise, volumeCorners, volumeElevation, worldToLocal } from '@world/buildings/geometry';
import { elementRing } from '@world/buildings/elements';
import type { Building, BuildingId } from '@world/buildings/types';
import { POLE_ARM_DROP, POLE_ARM_HALF, POLE_HEIGHT, POLE_LAMP_REACH } from '@world/utilities';
import { TUNED_UNIT, m } from '@world/units';
import type { AgentMeshes } from './agents';
import type { Exhaust } from './exhaust';
import type { BlastHit } from './renderer';
import { createGore } from './gore';
import { createCasualties } from './casualties';
import {
  createRagdolls, type Occupant, type RagdollCitizens, type RagdollProbe, type RagdollWall, type RagdollWorld,
} from './ragdoll';
import { createBlast } from './blast';
import { createDestruction } from './destruction';
import { compileAhead } from './uploads';

/** What shots and blows leave behind: the bodies they throw */
export interface PlayEffectsContext {
  readonly scene: Scene;
  readonly exhaust: Exhaust;
  readonly agents: AgentMeshes;
  readonly buildings: {
    chunkOf: Parameters<typeof createDestruction>[1];
    setRuined(ruined: ReadonlySet<number>): void;
    lotHeightAt(id: BuildingId, x: number, y: number): number;
  };
  readonly renderedHeightAt: (x: number, y: number) => number;
  readonly naturalRenderedHeightAt: (x: number, y: number) => number;
  readonly pavedHeightAt: (x: number, y: number) => number;
  readonly camera: () => Camera;
  readonly onAssetsReady: () => void;
  /** The muzzle's flash and the blast's: made by the renderer with the scene, in it from the start at no intensity. */
  readonly lights: { readonly muzzle: PointLight; readonly blast: PointLight };
}

/** Somebody a ragdoll held stands up again at (x, y) facing `heading` in `seconds`, or crawls off (`PedestrianEngine.getUp`). */
export type GetUp = (id: number, x: number, y: number, heading: number, seconds: number, crawl?: boolean) => void;

export interface PlayEffects {
  /** The effects' own seconds for a frame of `wallDt` (the weapons lab slows, stops and steps them). */
  clock(wallDt: number): number;
  setEffectsSpeed(speed: number): void;
  stepEffects(seconds: number): void;
  /** The bodies posed and drawn with the crowd's meshes (`AgentRenderOptions.ragdolls`). */
  /** `getUp`: somebody a ragdoll held up again where the body came to rest (`PedestrianEngine.getUp`), or crawling. */
  frame(citizens: RagdollCitizens, sim: SimMirror, doc: RoadDoc, getUp: GetUp, wallDt: number, fxDt: number): void;
  /** Somebody whose own body lies on the ground: not drawn standing as well. */
  hides(id: number): boolean;
  /** Debris, ruins, blood stains, tracers: after the agents. */
  update(wallDt: number, fxDt: number): void;
  /** How far an explosion shakes the camera now. */
  shake(): number;
  busy(): boolean;
  shootBody(a: readonly [number, number, number], b: readonly [number, number, number]): { alive: number; part: BodyPart } | 'hit' | null;
  ragdollProbe(): RagdollProbe[];
  clearCasualties(): void;
  vehicleHit(x: number, y: number, z: number, dirX: number, dirY: number, glass: boolean, blood: boolean): void;
  dropVehicle(v: { id: number; archetype: Archetype; x: number; y: number; angle: number; color: number; dirX: number; dirY: number }): void;
  wound(x: number, y: number, z: number, dirX: number, dirY: number, severed: Severable | null): void;
  shot(from: readonly [number, number, number], to: readonly [number, number, number]): void;
  strikeBuilding(b: Building, x: number, y: number, z: number, strength: number): boolean;
  explode(x: number, y: number, z: number, radius: number, hit: BlastHit): void;
  burn(x: number, y: number, z: number, size: number, seconds: number): void;
  soot(x: number, y: number, z: number, radius: number): void;
  geyser(x: number, y: number, z: number, seconds?: number): void;
  sparkAt(x: number, y: number, z: number, seconds: number): void;
  leak(x: number, y: number, z: number, seconds: number): void;
  onBuildingDown(listener: (id: number) => void): void;
  flingOccupants(list: readonly Occupant[]): void;
  forgetRuin(id: number): void;
  dispose(): void;
}

/** A tracer's life, s, and how many can be in the air at once (the oldest is taken again past it). */
const TRACER_LIFE = 0.12;
export const TRACER_SLOTS = 32;

export interface Tracers {
  /** A shot's line, world coordinates (x, y, height). */
  shot(from: readonly [number, number, number], to: readonly [number, number, number]): void;
  /** Fades them by `wallDt` s; how many still show. */
  update(wallDt: number): number;
  dispose(): void;
}

/** THE TRACERS: one set of line segments made once, a slot a shot */
export function createTracers(scene: Scene): Tracers {
  const positions = new BufferAttribute(new Float32Array(TRACER_SLOTS * 2 * 3), 3).setUsage(DynamicDrawUsage);
  const colours = new BufferAttribute(new Float32Array(TRACER_SLOTS * 2 * 4), 4).setUsage(DynamicDrawUsage);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', positions);
  geometry.setAttribute('color', colours);
  const material = new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  const lines = new LineSegments(geometry, material);
  lines.name = 'tracers';
  lines.frustumCulled = false;
  lines.visible = false;
  scene.add(lines);
  const tint = new Color(0xfff1b0);
  /** Each slot's life left, s (0: free), and the next slot to take. */
  const life = new Float32Array(TRACER_SLOTS);
  let next = 0;
  return {
    shot(from, to) {
      const slot = next;
      next = (next + 1) % TRACER_SLOTS;
      positions.setXYZ(slot * 2, from[0], from[2], -from[1]);
      positions.setXYZ(slot * 2 + 1, to[0], to[2], -to[1]);
      colours.setXYZW(slot * 2, tint.r, tint.g, tint.b, 1);
      colours.setXYZW(slot * 2 + 1, tint.r, tint.g, tint.b, 1);
      positions.needsUpdate = true;
      colours.needsUpdate = true;
      life[slot] = TRACER_LIFE;
      lines.visible = true;
    },
    update(wallDt) {
      let lit = 0;
      let faded = false;
      for (let i = 0; i < TRACER_SLOTS; i++) {
        if (life[i]! <= 0) continue;
        life[i] = Math.max(0, life[i]! - wallDt);
        const alpha = life[i]! / TRACER_LIFE;
        colours.setW(i * 2, alpha);
        colours.setW(i * 2 + 1, alpha);
        faded = true;
        if (alpha > 0) lit++;
      }
      if (faded) colours.needsUpdate = true;
      lines.visible = lit > 0;
      return lit;
    },
    dispose() {
      scene.remove(lines);
      geometry.dispose();
      material.dispose();
    },
  };
}

export function createPlayEffects(ctx: PlayEffectsContext): PlayEffects {
  const { scene, exhaust, agents, buildings, onAssetsReady } = ctx;
  /** Buildings knocked down block by block (`destruction.ts`). */
  const destruction = createDestruction(exhaust, buildings.chunkOf);
  scene.add(destruction.group);
  destruction.onRuined = () => { buildings.setRuined(destruction.ruined); };
  /** Blood where blows killed people (`casualties.ts`). */
  const casualties = createCasualties();
  scene.add(casualties.group);
  /** Explosions and what they throw (`blast.ts`). */
  const blast = createBlast(exhaust, ctx.lights.blast);
  scene.add(blast.group);
  void compileAhead(blast.group);
  /** The effects' clock against real time, and a step owed (`setEffectsSpeed`, `stepEffects`). */
  let fxSpeed = 1, fxStep = 0;
  // Guts, organs and bones out of bodies opened up (`gore.ts`).
  const gore = createGore();
  scene.add(gore.group);
  /** The world drawn this frame, for the walls a body strikes. */
  let ragdollSim: SimMirror | null = null;
  let ragdollDoc: RoadDoc | null = null;
  let ragdollGetUp: GetUp | null = null;
  const ragdolls = createRagdolls(exhaust, (id, x, y, heading, seconds, crawl) => {
    // Up again where the body came to rest (`PeopleEngine.getUp`), or onto hands and knees to crawl.
    ragdollGetUp?.(id, x, y, heading, seconds, crawl);
  }, gore);
  (globalThis as Record<string, unknown>)['__ragdolls'] = ragdolls;
  /** Who is down (a `fall` pause) this frame. */
  const ragdollDown = new Set<number>();
  /** The ground found under the bodies (the lots' raised yards are ground too), by small cells. */
  const ragdollGround = new Map<number, number>();
  /** The document's serial of what the ground found is read from (`wallsNear`). */
  let ragdollGroundSerial = '';
  /** DO NOT file the town's buildings again here */
  const LOT_GROW = m(2);
  const lotsAt = (x: number, y: number): readonly Building[] =>
    ragdollDoc?.buildings.near(x - LOT_GROW, y - LOT_GROW, x + LOT_GROW, y + LOT_GROW) ?? [];
  /** The ground at a corner of the bodies' ground grid (0.2 units a cell): a lot's yard as drawn, else the paving (a footway stands over the terrain), else the terrain. */
  const ragdollCorner = (ix: number, iy: number): number => {
    const key = ix * 100003 + iy;
    const known = ragdollGround.get(key);
    if (known !== undefined) return known;
    const cx = ix / 5, cy = iy / 5;
    // Only the lots whose box covers this cell of the grid (`lotsAt`)
    let h = NaN;
    for (const b of lotsAt(cx, cy)) {
      h = buildings.lotHeightAt(b.id, cx, cy);
      if (Number.isFinite(h)) break;
    }
    if (!Number.isFinite(h)) h = ctx.pavedHeightAt(cx, cy);
    if (!Number.isFinite(h)) h = ctx.renderedHeightAt(cx, cy);
    if (ragdollGround.size > 60000) ragdollGround.clear();
    ragdollGround.set(key, h);
    return h;
  };
  const poseScratch = newPose();
  /** A vehicle near a body, as the body sees it: its box, from the mirror's cells (DO NOT walk and pose the whole fleet for every body). */
  const vehicleWall = (v: SimVehicleShown, x: number, y: number, reach: number, out: RagdollWall[]): void => {
    let vx: number, vy: number, angle: number;
    if (v.free) { vx = v.free.x; vy = v.free.y; angle = v.free.angle; }
    else { shownPoseInto(v, 1, poseScratch); vx = poseScratch.p.x; vy = poseScratch.p.y; angle = poseScratch.angle; }
    if (Math.hypot(vx - x, vy - y) > reach) return;
    const hl = v.archetype.length / 2, hw = v.archetype.width / 2;
    const c = Math.cos(angle), sn = Math.sin(angle);
    const ring = [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([u, w]) => ({ x: vx + c * u! - sn * w!, y: vy + sn * u! + c * w! }));
    out.push({ ring, top: ragdollWorld.groundAt(vx, vy) + v.archetype.height * 0.85 });
  };
  const ragdollWorld: RagdollWorld = {
    groundAt(x, y) {
      // Between the heights at the corners of its cell, as a physics engine's heightfield is a surface between its samples
      const gx = x * 5, gy = y * 5, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const a = ragdollCorner(ix, iy), b = ragdollCorner(ix + 1, iy), c = ragdollCorner(ix, iy + 1), d = ragdollCorner(ix + 1, iy + 1);
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    },
    wallsNear(x, y, reach) {
      // The buildings standing (not a ruin) and the walls, fences and hedges of their lots.
      const out: RagdollWall[] = [];
      // The heights found stand until the ground under them changes
      const land = ragdollDoc;
      const serial = land ? `${land.changes.serialOf('roads', 'terrain', 'lots')}:${land.buildings.size}:${destruction.ruined.size}` : '';
      if (serial !== ragdollGroundSerial) {
        ragdollGround.clear();
        ragdollGroundSerial = serial;
      }
      // Those near, from the store's index: DO NOT walk every building of the town per body.
      const near = reach + m(40);
      for (const b of land?.buildings.near(x - near, y - near, x + near, y + near) ?? []) {
        if (destruction.ruined.has(b.id) || Math.hypot(b.x - x, b.y - y) > near) continue;
        const floor = floorHeight(b, ctx.naturalRenderedHeightAt, ctx.pavedHeightAt);
        for (const v of b.volumes) {
          if (v.base !== 0 || v.mode === 'void' || v.mode === 'intersect' || v.open) continue;
          // The walls up to the eaves, the roof over them: a body lands on it and slides down a pitch.
          const eaves = floor + volumeElevation(b, v, v.base + v.storeys.length);
          out.push({ ring: volumeCorners(b, v), top: eaves + roofRise(b, v), roof: (wx, wy) => eaves + Math.max(0, roofHeightAt(b, v, worldToLocal(b, { x: wx, y: wy }))) });
        }
        for (const e of b.elements ?? []) {
          if ((e.kind === 'wall' || e.kind === 'fence' || e.kind === 'hedge') && e.z <= 0.01) out.push({ ring: elementRing(b, e), top: floor + e.h });
        }
      }
      // Everything else standing there (the player, 2026-10-06: a body goes through nothing)
      const doc = ragdollDoc;
      if (doc) {
        for (const s of solidsOf(doc).near(x, y, reach)) {
          const ground = ctx.renderedHeightAt(s.kind === 'disc' ? s.c.x : s.a.x, s.kind === 'disc' ? s.c.y : s.a.y);
          if (s.kind === 'disc') {
            const ring = Array.from({ length: 8 }, (_, i) => ({ x: s.c.x + Math.cos(i * Math.PI / 4) * s.r, y: s.c.y + Math.sin(i * Math.PI / 4) * s.r }));
            // A pole or a trunk stands tall; street furniture is low.
            out.push({ ring, top: ground + (s.r < m(0.2) ? m(6) : s.r < m(0.35) ? m(4) : m(0.9)) });
          } else {
            const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, l = Math.hypot(dx, dy) || 1;
            const nx = (-dy / l) * s.r, ny = (dx / l) * s.r, tx = (dx / l) * s.r, ty = (dy / l) * s.r;
            out.push({ ring: [{ x: s.a.x - tx + nx, y: s.a.y - ty + ny }, { x: s.b.x + tx + nx, y: s.b.y + ty + ny },
              { x: s.b.x + tx - nx, y: s.b.y + ty - ny }, { x: s.a.x - tx - nx, y: s.a.y - ty - ny }], top: ground + m(1.6) });
          }
        }
      }
      // The traffic, and the cars parked off the road.
      if (ragdollSim) {
        for (const v of ragdollSim.roadNear(x - reach, y - reach, x + reach, y + reach)) vehicleWall(v, x, y, reach, out);
        for (const v of ragdollSim.parkedNear(x - reach, y - reach, x + reach, y + reach)) if (v.free) vehicleWall(v, x, y, reach, out);
      }
      return out.filter((w) => w.ring.length >= 3);
    },
  };
  // A body torn apart: a limb or two and what was inside thrown over the street, where they stay
  ragdolls.onGore = (x, y, z, dx, dy, speed, kind) => {
    // The limbs themselves are the person's own, thrown by the ragdolls (`detach`).
    const organs = kind === 'torn' ? 4 + Math.floor(Math.random() * 4) : 1;
    for (let k = 0; k < organs; k++) {
      const s0 = m(0.04 + Math.random() * 0.07);
      blast.debris({ shape: Math.random() < 0.7 ? 'cylinder' : 'box', kind: 'flesh', color: [0x3a0507, 0x4a0b0e, 0x561418, 0x2e0405][k % 4]!,
        at: new Vector3(x, z, -y), size: new Vector3(s0, s0 * (0.6 + Math.random()), s0 * (0.7 + Math.random() * 0.6)),
        velocity: new Vector3(dx * speed * 0.5 + (Math.random() - 0.5) * m(6), m(2 + Math.random() * 4), -dy * speed * 0.5 + (Math.random() - 0.5) * m(6)) });
    }
  };
  // A trail of blood behind those who lost a limb: a drop every metre or so.
  const lastDrip = new Map<number, { x: number; y: number }>();
  agents.setBleed((id, x, y, z) => {
    const last = lastDrip.get(id);
    if (last && Math.hypot(last.x - x, last.y - y) < m(0.9)) return;
    lastDrip.set(id, { x, y });
    if (lastDrip.size > 500) lastDrip.clear();
    ragdolls.drip(x + (Math.random() - 0.5) * m(0.3), y + (Math.random() - 0.5) * m(0.3), z + m(0.02), m(0.06 + Math.random() * 0.08));
  });
  /** People thrown out of a building or a vehicle, waiting for the next frame's ragdolls. */
  const occupantQueue: Occupant[] = [];
  const tracers = createTracers(scene);
  // In the scene since it opened (`PlayEffectsContext.lights`).
  const muzzle = ctx.lights.muzzle;

  return {
    clock(wallDt) {
      const fxDt = Math.min(0.1, wallDt * fxSpeed + fxStep);
      fxStep = 0;
      return fxDt;
    },
    setEffectsSpeed(speed) { fxSpeed = Math.max(0, speed); onAssetsReady(); },
    stepEffects(seconds) { fxStep += Math.max(0, seconds); onAssetsReady(); },
    frame(citizens, sim, doc, getUp, wallDt, fxDt) {
      ragdollSim = sim;
      ragdollDoc = doc;
      ragdollGetUp = getUp;
      // Bullet holes on the people shot, alive or not (`recordWound`).
      for (const wd of sim.takeWounds()) citizens.wound?.(-1 - wd.id, wd.part, wd.fromX, wd.fromY);
      ragdolls.absorb(sim.casualties.advance(wallDt), citizens, ragdollWorld);
      if (occupantQueue.length) { ragdolls.fling(occupantQueue, citizens, ragdollWorld); occupantQueue.length = 0; }
      // Somebody tripping on the pavement falls as a ragdoll too.
      ragdollDown.clear();
      for (const ped of sim.pedViews) {
        const g = ped.gesture;
        if (g?.kind !== 'fall') continue;
        ragdollDown.add(ped.id);
        if (g.t < 0.5 && !ragdolls.hides(ped.id)) {
          // Knocked from a point (a punch, a shove): down away from it; else a trip, forwards.
          const away = g.fromX !== undefined && g.fromY !== undefined && Math.hypot(ped.x - g.fromX, ped.y - g.fromY) > 1e-3
            ? Math.atan2(ped.y - g.fromY, ped.x - g.fromX) : null;
          ragdolls.trip(ped.id, ped.heading, citizens, ragdollWorld, away);
        }
      }
      ragdolls.release((id) => ragdollDown.has(id));
      ragdolls.update(fxDt, ragdollWorld);
      gore.update(fxDt, ragdollWorld.groundAt);
      ragdolls.draw(citizens, ragdollWorld);
    },
    hides: (id) => ragdolls.hides(id),
    update(wallDt, fxDt) {
      destruction.update(wallDt);
      casualties.sync(ragdolls.decals);
      blast.update(fxDt, ragdollWorld);
      // Tracers fade in a tenth of a second, the muzzle flash with them.
      const lit = tracers.update(wallDt);
      muzzle.intensity = lit ? muzzle.intensity * Math.pow(0.02, wallDt * 8) : 0;
    },
    shake: () => blast.shake(),
    busy: () => blast.active() || ragdolls.stats().living > 0 || ragdolls.stats().moving > 0,
    shootBody(a, b) {
      const hit = ragdolls.shootBody(new Vector3(a[0], a[2], -a[1]), new Vector3(b[0], b[2], -b[1]));
      if (hit) onAssetsReady();
      return hit;
    },
    ragdollProbe: () => ragdolls.probe(),
    clearCasualties() { ragdolls.clear(); gore.clear(); blast.clear(); onAssetsReady(); },
    vehicleHit(x, y, z, dirX, dirY, glass, blood) {
      if (glass) {
        for (let k = 0; k < 14; k++) {
          blast.debris({ shape: 'box', kind: 'glass', at: new Vector3(x, z, -y),
            size: new Vector3(m(0.03 + Math.random() * 0.05), m(0.006), m(0.03 + Math.random() * 0.05)),
            velocity: new Vector3(dirX * m(2) + (Math.random() - 0.5) * m(2.5), m(0.5 + Math.random() * 1.5), -dirY * m(2) + (Math.random() - 0.5) * m(2.5)) });
        }
        if (blood) exhaust.burst(x + dirX * m(0.4), y + dirY * m(0.4), z, 40, 4, m(0.2), m(0.04), 0.8);
      } else {
        exhaust.burst(x, y, z, 18, 6, m(0.12), m(0.2), 0.35);
      }
      onAssetsReady();
    },
    dropVehicle(v) {
      const own = agents.carcass({ id: v.id, archetype: v.archetype }, true);
      if (!own) return;
      own.computeBoundingBox();
      const size = own.boundingBox!.getSize(new Vector3());
      const g = ragdollWorld.groundAt(v.x, v.y);
      const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), v.angle);
      // Tipping over sideways as it goes, carried on a little by its speed.
      const forward = new Vector3(Math.cos(v.angle), 0, -Math.sin(v.angle));
      blast.debris({ shape: 'mesh', geometry: own, kind: 'metal', color: v.color, at: new Vector3(v.x, g + size.y / 2 + m(0.05), -v.y),
        size, turn, velocity: forward.clone().multiplyScalar(m(2.5)).add(new Vector3(v.dirX * m(0.8), 0, -v.dirY * m(0.8))),
        spin: forward.multiplyScalar(Math.random() < 0.5 ? 2.2 : -2.2) });
      onAssetsReady();
    },
    wound(x, y, z, dirX, dirY, severed) {
      // The spray, out of the far side, then the drops on the ground behind.
      exhaust.burst(x + dirX * m(0.15), y + dirY * m(0.15), z, severed ? 36 : 18, 4, m(severed ? 0.22 : 0.14), m(0.035), 0.7);
      // On what is there (the footway stands over the terrain).
      for (let k = 0; k < (severed ? 9 : 4); k++) {
        const d = m(0.3 + Math.random() * 1.6), side = (Math.random() - 0.5) * m(0.6);
        const dx = x + dirX * d - dirY * side, dy = y + dirY * d + dirX * side;
        ragdolls.drip(dx, dy, ragdollWorld.groundAt(dx, dy) + m(0.02), m(0.06 + Math.random() * 0.12));
      }
      // The limb shot off is the person's own, thrown by the ragdolls (`detach`).
      onAssetsReady();
    },
    shot(from, to) {
      tracers.shot(from, to);
      muzzle.position.set(from[0], from[2], -from[1]);
      // Falls off with the distance in world units: the same flash in metres at any unit.
      muzzle.intensity = 60 * TUNED_UNIT ** muzzle.decay;
      onAssetsReady();
    },
    strikeBuilding(b, x, y, z, strength) {
      // The building's own floor, as it is drawn on its pad.
      const floor = floorHeight(b, ctx.naturalRenderedHeightAt, ctx.pavedHeightAt);
      const down = destruction.hit(b, floor, x, y, z, strength, ctx.camera().getWorldDirection(new Vector3()));
      buildings.setRuined(destruction.ruined);
      return down;
    },
    explode(x, y, z, radius, hit) {
      const ground = (px: number, py: number): number => ragdollWorld.groundAt(px, py);
      blast.explode(x, y, z, radius, hit.ground);
      if (hit.crater && hit.ground !== 'building') blast.crater(x, y, ground(x, y), radius * 0.75, hit.ground);
      const away = (px: number, py: number, k: number): Vector3 => {
        const dx = px - x, dy = py - y, d = Math.hypot(dx, dy) || 1;
        const f = k * Math.max(0.25, 1 - d / (radius * 1.6));
        return new Vector3((dx / d) * f, f * 0.6, -(dy / d) * f);
      };
      const wood = 0x5e4630;
      for (const pole of hit.poles) {
        const g = ground(pole.x, pole.y);
        const r = m(0.15);
        const top = new Vector3(pole.x, g + POLE_HEIGHT - POLE_ARM_DROP, -pole.y);
        // Falls the way it is thrown: a turn about the horizontal axis across that way.
        const axis = new Vector3(-pole.dirY, 0, -pole.dirX).normalize();
        const push = away(pole.x, pole.y, m(5));
        if (pole.mode === 'whole') {
          blast.debris({ shape: 'cylinder', kind: 'wood', color: wood, at: new Vector3(pole.x, g + POLE_HEIGHT / 2 + m(0.05), -pole.y),
            size: new Vector3(r, POLE_HEIGHT, r), velocity: push.clone().multiplyScalar(0.4), spin: axis.clone().multiplyScalar(0.9 + Math.random() * 0.6) });
        } else if (pole.mode === 'snap') {
          // Snapped: the stump left standing, the top thrown over.
          const cut = POLE_HEIGHT * (0.25 + Math.random() * 0.3);
          blast.debris({ shape: 'cylinder', kind: 'wood', color: wood, at: new Vector3(pole.x, g + cut / 2, -pole.y),
            size: new Vector3(r * 1.1, cut, r * 1.1), velocity: new Vector3(), spin: new Vector3() });
          blast.debris({ shape: 'cylinder', kind: 'wood', color: wood, at: new Vector3(pole.x, g + cut + (POLE_HEIGHT - cut) / 2 + m(0.1), -pole.y),
            size: new Vector3(r, POLE_HEIGHT - cut, r), velocity: push.clone().multiplyScalar(0.7), spin: axis.clone().multiplyScalar(1.5 + Math.random()) });
        } else {
          // To splinters: pieces of it flung out.
          let h = 0;
          while (h < POLE_HEIGHT - m(0.5)) {
            const l = Math.min(POLE_HEIGHT - h, m(1 + Math.random() * 2.5));
            blast.debris({ shape: 'cylinder', kind: 'wood', color: wood, at: new Vector3(pole.x, g + h + l / 2, -pole.y),
              size: new Vector3(r * (0.6 + Math.random() * 0.4), l, r * (0.6 + Math.random() * 0.4)),
              velocity: push.clone().multiplyScalar(0.8 + Math.random()).add(new Vector3((Math.random() - 0.5) * m(4), m(2 + Math.random() * 4), (Math.random() - 0.5) * m(4))) });
            h += l;
          }
        }
        // The cross-arm and the lamp, knocked off.
        blast.debris({ shape: 'box', kind: 'wood', color: wood, at: top.clone(), size: new Vector3(POLE_ARM_HALF * 2, m(0.1), m(0.1)),
          velocity: push.clone().add(new Vector3(0, m(2), 0)) });
        if (pole.lamp) blast.debris({ shape: 'box', kind: 'metal', at: top.clone().add(new Vector3(POLE_LAMP_REACH * 0.5, 0, 0)), size: new Vector3(m(0.5), m(0.14), m(0.26)), velocity: push.clone().multiplyScalar(1.2) });
        // A flash and sparks off the line as it goes.
        blast.arc(top, 1.5 + Math.random() * 2);
      }
      for (const w of hit.wires) {
        const g = ground(w.fromX, w.fromY);
        const gt = ground(w.toX, w.toY);
        const dx = w.toX - w.fromX, dy = w.toY - w.fromY, d = Math.hypot(dx, dy) || 1;
        for (const offset of [-0.8, 0, 0.8]) {
          const side = new Vector3(-dy / d, 0, -dx / d).multiplyScalar(offset * POLE_ARM_HALF);
          const from = new Vector3(w.fromX, g + POLE_HEIGHT - POLE_ARM_DROP, -w.fromY).add(side);
          const to = new Vector3(w.toX, gt + POLE_HEIGHT * 0.6, -w.toY).add(side);
          blast.wire(from, to, away(w.toX, w.toY, m(3)));
        }
      }
      for (const post of hit.posts) {
        const g = ground(post.x, post.y);
        const push = away(post.x, post.y, m(5));
        const axis = new Vector3(push.z, 0, -push.x).normalize();
        blast.debris({ shape: 'cylinder', kind: 'metal', color: 0x2a2d31, at: new Vector3(post.x, g + m(3.1) + m(0.05), -post.y),
          size: new Vector3(m(0.165), m(6.2), m(0.165)), velocity: push.clone().multiplyScalar(0.3), spin: axis.multiplyScalar(1.2) });
        const head = new Vector3(post.x + Math.cos(post.yaw) * m(3), g + m(5.5), -(post.y + Math.sin(post.yaw) * m(3)));
        blast.debris({ shape: 'box', kind: 'metal', color: 0x1b1d20, at: head, size: new Vector3(m(0.35), m(1.0), m(0.35)), velocity: push.clone().add(new Vector3(0, m(3), 0)) });
        blast.debris({ shape: 'cylinder', kind: 'metal', color: 0x2a2d31, at: head.clone().lerp(new Vector3(post.x, g + m(5.9), -post.y), 0.5),
          size: new Vector3(m(0.06), m(3.5), m(0.06)), turn: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2), velocity: push.clone() });
        blast.arc(head, 1 + Math.random() * 2);
      }
      for (const v of hit.vehicles) {
        const g = ground(v.x, v.y);
        const push = away(v.x, v.y, m(9)).add(new Vector3(0, m(3), 0));
        const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), v.angle);
        const spin = new Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3);
        // The burnt shell of its own body (each model its own wreck, buckled its own way), burning
        const own = v.archetype && v.id !== undefined ? agents.carcass({ id: v.id, archetype: v.archetype }) : null;
        if (own) {
          own.computeBoundingBox();
          const size = own.boundingBox!.getSize(new Vector3());
          const light = v.archetype!.shape === 'bicycle' || v.archetype!.shape === 'motorcycle';
          blast.debris({ shape: 'mesh', geometry: own, kind: 'char', color: v.color, at: new Vector3(v.x, g + size.y / 2 + m(0.05), -v.y),
            size, turn, velocity: light ? push.clone().multiplyScalar(1.6) : push, spin: light ? spin.multiplyScalar(2) : spin,
            burn: light ? 8 + Math.random() * 6 : 30 + Math.random() * 20 });
          exhaust.burst(v.x, v.y, g + m(1), light ? 15 : 40, 5, m(light ? 0.6 : 1.2), m(1.4), 1.0);
          if (light) continue;
        } else {
          const charred = new Color(v.color).lerp(new Color(0x1f1b18), 0.95).getHex();
          blast.debris({ shape: 'car', kind: 'char', color: charred, at: new Vector3(v.x, g + v.height * 0.45, -v.y),
            size: new Vector3(v.length, v.height * 0.85, v.width), turn, velocity: push, spin, burn: 30 + Math.random() * 20 });
        }
        for (let k = 0; k < 2; k++) {
          blast.debris({ shape: 'cylinder', kind: 'char', color: 0x141414, at: new Vector3(v.x, g + m(0.35), -v.y),
            size: new Vector3(m(0.32), m(0.22), m(0.32)), turn: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2),
            velocity: push.clone().multiplyScalar(0.6 + Math.random()).add(new Vector3((Math.random() - 0.5) * m(8), m(2 + Math.random() * 4), (Math.random() - 0.5) * m(8))) });
        }
        exhaust.burst(v.x, v.y, g + m(1), 40, 5, m(1.2), m(1.4), 1.0);
      }
      for (const item of hit.items) {
        const g = ground(item.x, item.y);
        const push = away(item.x, item.y, m(6));
        if (item.kind === 'tree') {
          // Split: a broken stump left standing, charred; the top - trunk and crown
          const tall = m(6 + Math.random() * 3), cut = tall * (0.25 + Math.random() * 0.25);
          const axis = new Vector3(push.z, 0, -push.x).normalize();
          blast.debris({ shape: 'cylinder', kind: 'char', color: 0x2b211a, at: new Vector3(item.x, g + cut / 2, -item.y), size: new Vector3(m(0.22), cut, m(0.22)),
            velocity: new Vector3(), spin: new Vector3() });
          blast.debris({ shape: 'cylinder', kind: 'wood', at: new Vector3(item.x, g + cut + (tall - cut) / 2, -item.y), size: new Vector3(m(0.18), tall - cut, m(0.18)),
            velocity: push.clone().multiplyScalar(0.6), spin: axis.clone().multiplyScalar(1.4 + Math.random()), burn: 12 + Math.random() * 10 });
          // The splinters at the break.
          for (let k = 0; k < 6; k++) {
            blast.debris({ shape: 'box', kind: 'wood', at: new Vector3(item.x, g + cut, -item.y), size: new Vector3(m(0.05), m(0.3 + Math.random() * 0.5), m(0.05)),
              velocity: push.clone().add(new Vector3((Math.random() - 0.5) * m(5), m(2 + Math.random() * 4), (Math.random() - 0.5) * m(5))) });
          }
          // The crown, in clumps of leaves and branches.
          for (let k = 0; k < 24; k++) {
            blast.debris({ shape: 'box', kind: 'leaf', at: new Vector3(item.x, g + tall * 0.85, -item.y), size: new Vector3(m(0.4 + Math.random() * 0.6), m(0.1), m(0.4 + Math.random() * 0.6)),
              velocity: push.clone().add(new Vector3((Math.random() - 0.5) * m(7), m(1 + Math.random() * 5), (Math.random() - 0.5) * m(7))) });
          }
          exhaust.burst(item.x, item.y, g + tall * 0.7, 10, 5, m(1.5), m(1.2), 1);
        } else if (item.kind === 'shrub') {
          const tall = m(1.2);
          blast.debris({ shape: 'cylinder', kind: 'wood', at: new Vector3(item.x, g + tall / 2, -item.y), size: new Vector3(m(0.14), tall, m(0.14)),
            velocity: push.clone().multiplyScalar(0.4), spin: new Vector3(push.z, 0, -push.x).normalize().multiplyScalar(1.2) });
          for (let k = 0; k < 14; k++) {
            blast.debris({ shape: 'box', kind: 'leaf', at: new Vector3(item.x, g + tall * 0.8, -item.y), size: new Vector3(m(0.3), m(0.05), m(0.3)),
              velocity: push.clone().add(new Vector3((Math.random() - 0.5) * m(6), m(2 + Math.random() * 5), (Math.random() - 0.5) * m(6))) });
          }
        } else if (item.kind === 'lamp') {
          // A street light: its column bent over and thrown, the head and its glass flung off, sparks.
          const axis = new Vector3(push.z, 0, -push.x).normalize();
          blast.debris({ shape: 'cylinder', kind: 'metal', color: 0x3a3e43, at: new Vector3(item.x, g + m(3), -item.y), size: new Vector3(m(0.1), m(6), m(0.1)),
            velocity: push.clone().multiplyScalar(0.5), spin: axis.multiplyScalar(1.6) });
          blast.debris({ shape: 'box', kind: 'metal', color: 0x2a2d31, at: new Vector3(item.x, g + m(6), -item.y), size: new Vector3(m(0.6), m(0.15), m(0.3)),
            velocity: push.clone().add(new Vector3(0, m(4), 0)) });
          exhaust.burst(item.x, item.y, g + m(6), 30, 6, m(0.3), m(0.12), 0.8);
        } else {
          for (let k = 0; k < 4; k++) {
            blast.debris({ shape: 'box', kind: item.kind === 'bench' ? 'wood' : 'metal', at: new Vector3(item.x, g + m(0.5), -item.y),
              size: new Vector3(m(0.2 + Math.random() * 0.5), m(0.06 + Math.random() * 0.2), m(0.1 + Math.random() * 0.3)),
              velocity: push.clone().add(new Vector3((Math.random() - 0.5) * m(4), m(2 + Math.random() * 5), (Math.random() - 0.5) * m(4))) });
          }
        }
      }
    },
    burn: (x, y, z, size, seconds) => blast.burn(x, y, z, size, seconds),
    soot: (x, y, z, r) => blast.soot(x, y, z, r),
    geyser: (x, y, z, seconds) => blast.geyser(x, y, z, seconds),
    sparkAt: (x, y, z, seconds) => blast.arc(new Vector3(x, z, -y), seconds),
    leak: (x, y, z, seconds) => blast.leak(x, y, z, seconds),
    onBuildingDown: (listener) => { destruction.onDown = listener; },
    flingOccupants: (list) => { occupantQueue.push(...list); },
    forgetRuin(id) {
      void id;
      buildings.setRuined(destruction.ruined);
    },
    dispose() {
      ragdolls.clear(); gore.clear(); blast.clear();
      tracers.dispose();
      scene.remove(destruction.group, casualties.group, blast.group, gore.group, muzzle);
      // What each holds on the GPU (and the fracture's workers): only taken out of the scene, it stayed.
      destruction.dispose(); casualties.dispose(); blast.dispose(); gore.dispose();
      agents.setBleed(() => {});
    },
  };
}
