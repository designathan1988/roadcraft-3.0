import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { pedPose } from '@sim/pose';
import { personHash, type PedView } from '@sim/people/view';
import type { SimWorld } from '@sim/world';
import { m } from '@world/units';
import { SIGNAL_POST_RADIUS, signalGroupsOf, signalPosts } from '@world/signalPosts';
import { streetFurniture } from '@world/streetFurniture';
import { WALK_STYLES, type GaitClipName, type GaitClips, type GaitPlay } from '@render/citizenGait';
import { fixtureDoc, simOf } from '../../sim/support/bodies';
import { gaitClipsOf } from './gaitClips';
import { rocketboxLibrary } from './rocketboxLibrary';

/** Measures what the player sees a pedestrian's legs do against how the drawn body actually moves, on the real simulation */

const LIBRARY = await rocketboxLibrary();
const GAIT_CLIPS: Readonly<Record<'male' | 'female', GaitClips>> = {
  male: gaitClipsOf(LIBRARY.male, 'male'),
  female: gaitClipsOf(LIBRARY.female, 'female'),
};

/** A gait controller as the renderer drives one: created once, stepped every frame. */
export interface GaitController<S> {
  create(ped: PedView, time: number, heading: number, hash: number): S;
  step(state: S, ped: PedView, clips: GaitClips, time: number, heading: number, size: number, hash: number): void;
  plays(state: S, clips: GaitClips, out: GaitPlay[]): void;
  heading(state: S): number;
}

export interface GaitAudit {
  pedSeconds: number;
  /** Seconds the drawn body moved at 0.15 m/s or more, and of those, with legs not stepping. */
  movingSeconds: number;
  glideSeconds: number;
  /** Seconds a walk cycle carried most of the weight, and of those, played under 0.75 of its rate. */
  walkSeconds: number;
  slowMotionSeconds: number;
  /** Mean ratio of played to captured cadence over `walkSeconds`. */
  cadenceMean: number;
  /** Body rotation, radians, while under 0.3 m/s, and of it, with no stepping clip advancing. */
  slowRotation: number;
  unsteppedRotation: number;
  /** Mean length of drawn velocity minus signed stepping velocity while moving, m/s. */
  skateMean: number;
  /** Mean drawn speed while moving, m/s. */
  movingSpeedMean: number;
  /** Cadence against speed, for the report: [speed band m/s, mean cadence ratio, seconds]. */
  cadenceBySpeed: [number, number, number][];
}

// The new cycles contain measured backward/lateral ankle travel. walkRest carries zero ground and must never be counted as
const WALKS = new Set<GaitClipName>(['walk', 'walkElder', 'walkSlow', 'walkShuffle', 'walkBack', 'walkLeft', 'walkRight',
  'walkDrunk', 'walkHandL', 'walkHandR', ...WALK_STYLES]);
const STEPPING = new Set<GaitClipName>([...WALKS, 'run', 'start', 'stop', 'turnLeft', 'turnRight']);
const MOVING = 0.15;
const SLOW = 0.75;

/** Body size the renderer gives an age class, near enough: a child is drawn about two thirds tall. */
const sizeOf = (p: PedView): number => (p.ageClass === 'child' ? 0.7 : 1);

export function auditGait<S>(controller: GaitController<S>, seconds: number, seed = 3,
  onTick?: (sim: SimWorld) => void, breakdown?: Map<string, number>): GaitAudit {
  const sim = simOf(fixtureDoc(), seed, 2);
  const states = new Map<number, S>();
  const last = new Map<number, { x: number; y: number; heading: number; frames: Map<GaitClipName, number> }>();
  const bands = new Map<number, [number, number]>();
  const out: GaitPlay[] = [];
  const audit: GaitAudit = {
    pedSeconds: 0, movingSeconds: 0, glideSeconds: 0, walkSeconds: 0, slowMotionSeconds: 0, cadenceMean: 0,
    slowRotation: 0, unsteppedRotation: 0, skateMean: 0, movingSpeedMean: 0, cadenceBySpeed: [],
  };
  let cadenceSum = 0;
  let skateSum = 0;
  let movedSum = 0;
  sim.clock.run(Math.round(seconds / DT), () => {
    step(sim, { traffic: true, pedestrians: true });
    onTick?.(sim);
    for (const ped of sim.pedViews) {
      const pose = pedPose(ped, 1);
      const clips = GAIT_CLIPS[ped.gender === 'f' ? 'female' : 'male'];
      const hash = personHash(ped.id);
      const size = sizeOf(ped);
      let state = states.get(ped.id);
      if (!state) {
        state = controller.create(ped, ped.age, pose.angle, hash);
        states.set(ped.id, state);
      }
      controller.step(state, ped, clips, ped.age, pose.angle, size, hash);
      out.length = 0;
      controller.plays(state, clips, out);
      const heading = controller.heading(state);
      const before = last.get(ped.id);
      const frames = new Map<GaitClipName, number>();
      for (const p of out) frames.set(p.name, p.frame);
      last.set(ped.id, { x: pose.p.x, y: pose.p.y, heading, frames });
      if (!before) continue;

      audit.pedSeconds += DT;
      const speed = Math.hypot(pose.p.x - before.x, pose.p.y - before.y) / m(1) / DT;
      if (speed > 4) continue; // a re-seat, not motion
      let stepping = 0;
      let carriedForward = 0, carriedLeft = 0;
      let walkWeight = 0;
      let cadence = 0;
      for (const p of out) {
        if (!STEPPING.has(p.name)) continue;
        const clip = clips[p.name];
        const was = before.frames.get(p.name);
        if (was === undefined) continue;
        let delta = p.frame - was;
        if (clip.loop) delta = ((delta % clip.frames) + clip.frames) % clip.frames;
        if (delta <= 1e-6 || delta > clip.frames / 2) continue;
        stepping += p.weight;
        if (WALKS.has(p.name) || p.name === 'run') {
          const rate = delta / clip.frames / DT;
          const travel = p.weight * rate * clip.stride * size;
          if (p.name === 'walkLeft') carriedLeft += travel;
          else if (p.name === 'walkRight') carriedLeft -= travel;
          else carriedForward += p.name === 'walkBack' ? -travel : travel;
          if (p.name !== 'run') { walkWeight += p.weight; cadence += p.weight * rate * clip.duration; }
        } else if (clip.travel) {
          const at = (f: number): number => {
            const k = Math.min(clip.frames - 1, Math.max(0, Math.floor(f)));
            return clip.travel![k]! + (clip.travel![k + 1]! - clip.travel![k]!) * (f - k);
          };
          carriedForward += p.weight * (at(p.frame) - at(was)) * size / DT;
        }
      }
      const turned = Math.abs(Math.atan2(Math.sin(heading - before.heading), Math.cos(heading - before.heading)));
      if (speed < 0.3) {
        audit.slowRotation += turned;
        if (stepping < 0.5) {
          audit.unsteppedRotation += turned;
          if (breakdown && turned > 0) {
            const top = out.reduce((a, b) => (b.weight > a.weight ? b : a), out[0]!);
            const key = `${top.name}|${ped.walking ? 'walking' : 'standing'}|${ped.gesture ? ped.gesture.kind + ':' + ped.gesture.phase : '-'}|${Math.abs(ped.turnV) > 0.35 ? 'spin' : 'slowturn'}|${speed < 0.06 ? 'still' : 'creep'}`;
            breakdown.set(key, (breakdown.get(key) ?? 0) + turned);
          }
        }
      }
      if (speed >= MOVING) {
        audit.movingSeconds += DT;
        if (stepping < 0.5) {
          audit.glideSeconds += DT;
          if (breakdown) {
            const top = out.reduce((a, b) => (b.weight > a.weight ? b : a), out[0]!);
            const key = `G:${top.name}|${ped.walking ? 'walking' : 'standing'}|${ped.gesture ? ped.gesture.kind : '-'}|${speed < 0.5 ? 'slow' : speed < 1 ? 'mid' : 'fast'}`;
            breakdown.set(key, (breakdown.get(key) ?? 0) + DT);
          }
        }
        // Check direction as well as speed
        const vx = (pose.p.x - before.x) / m(1) / DT, vy = (pose.p.y - before.y) / m(1) / DT;
        const forward = Math.cos(heading) * vx + Math.sin(heading) * vy;
        const left = -Math.sin(heading) * vx + Math.cos(heading) * vy;
        const skate = Math.hypot(forward - carriedForward, left - carriedLeft);
        skateSum += skate * DT;
        if (breakdown) {
          const top = out.reduce((a, b) => (b.weight > a.weight ? b : a), out[0]!);
          const key = `S:${top.name}|${speed < 0.5 ? 'slow' : speed < 1 ? 'mid' : 'fast'}`;
          breakdown.set(key, (breakdown.get(key) ?? 0) + skate * DT);
        }
        movedSum += speed * DT;
      }
      if (walkWeight > 0.5) {
        const ratio = cadence / walkWeight;
        audit.walkSeconds += DT;
        cadenceSum += ratio * DT;
        if (ratio < SLOW) audit.slowMotionSeconds += DT;
        const band = Math.min(18, Math.floor(speed * 10));
        const entry = bands.get(band) ?? [0, 0];
        entry[0] += ratio * DT; entry[1] += DT;
        bands.set(band, entry);
      }
    }
  });
  audit.cadenceMean = cadenceSum / Math.max(1e-9, audit.walkSeconds);
  audit.skateMean = skateSum / Math.max(1e-9, audit.movingSeconds);
  audit.movingSpeedMean = movedSum / Math.max(1e-9, audit.movingSeconds);
  audit.cadenceBySpeed = [...bands.entries()].sort((a, b) => a[0] - b[0])
    .map(([band, [sum, time]]) => [band / 10, sum / time, time]);
  return audit;
}

export interface FlowAudit {
  pedSeconds: number;
  /** Seconds a walker's body centre was closer to street furniture than a person's radius. */
  insideFurniture: number;
  /** Seconds two people's centres were closer than 0.3 m (shoulders overlapping). */
  overlapping: number;
  /** Seconds walkers on a footway, wanting to move and not queueing at a kerb, stood still. */
  heldUp: number;
  walkingSeconds: number;
  /** Seconds walkers slowed below half their own pace within two metres of furniture ahead. */
  slowedByFurniture: number;
  /** Closest approach of any walker's centre to the edge of a piece of furniture, metres. */
  nearestFurniture: number;
}

/** How people get along the pavement: through furniture, into each other, held up. */
export function auditFlow(seconds: number, seed = 3, breakdown?: Map<string, number>): FlowAudit {
  const sim = simOf(fixtureDoc(), seed, 2);
  interface Obstacle { x: number; y: number; radius: number; along?: { x: number; y: number }; halfLength?: number; halfWidth?: number; kind?: string }
  const items: Obstacle[] = streetFurniture(sim.net).filter((item) => item.on === 'footway');
  for (const pole of sim.doc.poles.values()) items.push({ x: pole.x, y: pole.y, radius: m(0.18), kind: 'utilityPole' });
  // Signal posts are furniture too, and the one people meet most: at the kerb.
  for (const post of signalPosts(sim.net, signalGroupsOf(sim.graph))) items.push({ x: post.x, y: post.y, radius: SIGNAL_POST_RADIUS, kind: 'signalPost' });
  const CELL = m(4);
  const grid = new Map<string, typeof items>();
  for (const item of items) {
    const key = `${Math.floor(item.x / CELL)}:${Math.floor(item.y / CELL)}`;
    const list = grid.get(key) ?? [];
    list.push(item);
    grid.set(key, list);
  }
  const edgeDistance = (item: Obstacle, x: number, y: number): number => {
    const dx = x - item.x, dy = y - item.y;
    if (item.halfLength === undefined || item.halfWidth === undefined || !item.along) return Math.hypot(dx, dy) - item.radius;
    const along = Math.abs(dx * item.along.x + dy * item.along.y) - item.halfLength;
    const across = Math.abs(-dx * item.along.y + dy * item.along.x) - item.halfWidth;
    return Math.hypot(Math.max(0, along), Math.max(0, across)) + Math.min(0, Math.max(along, across));
  };
  const near = (x: number, y: number, call: (item: Obstacle) => void): void => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cy - 1; j <= cy + 1; j++) for (const item of grid.get(`${i}:${j}`) ?? []) call(item);
  };
  const flow: FlowAudit = { pedSeconds: 0, insideFurniture: 0, overlapping: 0, heldUp: 0, walkingSeconds: 0,
    slowedByFurniture: 0, nearestFurniture: Infinity };
  const PERSON = m(0.3);
  sim.clock.run(Math.round(seconds / DT), () => {
    step(sim, { traffic: true, pedestrians: true });
    // What every pedestrian engine publishes (`SimWorld.pedViews`), not the inner state of one
    const peds = sim.pedViews;
    const cells = new Map<string, PedView[]>();
    for (const p of peds) {
      const key = `${Math.floor(p.x / CELL)}:${Math.floor(p.y / CELL)}`;
      const list = cells.get(key) ?? [];
      list.push(p);
      cells.set(key, list);
    }
    for (const p of peds) {
      flow.pedSeconds += DT;
      const seated = p.gesture?.kind === 'bench' && p.gesture.phase !== 'approach';
      if (!seated && p.ground !== 'crossing') {
        let nearest = Infinity;
        let nearestKind = '';
        let aheadClose = false;
        near(p.x, p.y, (item) => {
          const d = edgeDistance(item, p.x, p.y);
          if (d < nearest) nearestKind = (item as { kind?: string }).kind ?? '?';
          nearest = Math.min(nearest, d);
          const dx = item.x - p.x, dy = item.y - p.y;
          if (d < m(2) && dx * Math.cos(p.heading) + dy * Math.sin(p.heading) > 0) aheadClose = true;
        });
        if (nearest < PERSON) {
          flow.insideFurniture += DT;
          if (breakdown) {
            const key = `${p.walking ? 'walking' : 'standing'}|${p.gesture ? p.gesture.kind + ':' + p.gesture.phase : '-'}|${p.ground}|${p.v < 0.1 ? 'still' : 'moving'}|${nearestKind}`;
            breakdown.set(key, (breakdown.get(key) ?? 0) + DT);
          }
        }
        flow.nearestFurniture = Math.min(flow.nearestFurniture, nearest / m(1));
        if (p.walking && !p.gesture) {
          flow.walkingSeconds += DT;
          // Below half a walking pace (1.3 m/s) beside something in the way.
          if (aheadClose && p.v < m(0.65)) flow.slowedByFurniture += DT;
          if (p.v < 0.05) flow.heldUp += DT;
        }
      }
      const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
      for (let i = cx - 1; i <= cx + 1; i++) for (let j = cy - 1; j <= cy + 1; j++) for (const q of cells.get(`${i}:${j}`) ?? []) {
        if (q.id > p.id && Math.hypot(q.x - p.x, q.y - p.y) < m(0.3)) flow.overlapping += DT;
      }
    }
  });
  return flow;
}
