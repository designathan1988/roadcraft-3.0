import { clamp, lerp } from '@core/scalar';
import { type Vec2, dist, lerpVec } from '@core/vec2';
import { type FrameOut, newFrame } from '@core/polyline';
import type { SimWorld } from '@sim/world';
import type { Kinematics, Vehicle } from '@sim/vehicles/state';
import type { PedView } from '@sim/people/view';
import { HEADING_CHORD } from '@world/heading';
import { cycleShift } from '@sim/vehicles/cycleLane';
import { m } from '@world/units';

export interface Pose {
  readonly p: Vec2;
  readonly angle: number;
}

/** A pose written in place (`vehiclePoseInto`): one per caller, made once. */
export interface PoseOut {
  p: { x: number; y: number };
  angle: number;
}

/** A pose to write into. */
export function newPose(): PoseOut {
  return { p: { x: 0, y: 0 }, angle: 0 };
}

/** Largest gap, in world units, that two consecutive poses may be apart before the interpolation is abandoned. */
const POSE_JUMP_LIMIT = m(24);

/** Angle a vehicle points into its own lane change. */
function laneChangeYaw(slope: number): number {
  return slope === 0 ? 0 : Math.atan(slope);
}

/** Distance from the rear axle to the middle of the body, as a share of its length */
const REAR_AXLE_TO_CENTRE = 0.3;

/** Sideways offset of the body CENTRE during a lane change. */
function bodyOffset(k: Kinematics, length: number): number {
  if (k.lateralSlope === 0) return k.lateral;
  const sine = k.lateralSlope / Math.sqrt(1 + k.lateralSlope * k.lateralSlope);
  return k.lateral + REAR_AXLE_TO_CENTRE * length * sine;
}

/** Pose of a vehicle, interpolated between the last two simulation steps. */
export function vehiclePose(w: SimWorld, v: Vehicle, alpha: number): Pose | null {
  const out = newPose();
  return vehiclePoseInto(w, v, alpha, out) ? out : null;
}

/** `vehiclePose` into `out`; false where there is none. */
export function vehiclePoseInto(w: SimWorld, v: Vehicle, alpha: number, out: PoseOut): boolean {
  // Off the road (parked, or manoeuvring to or from a bay): its own pose.
  const free = v.free;
  const t = clamp(alpha, 0, 1);
  if (free) {
    out.p.x = lerp(free.px, free.x, t); out.p.y = lerp(free.py, free.y, t);
    out.angle = lerpAngle(free.pangle, free.angle, t);
    return true;
  }
  if (!vehiclePoseEnds(w, v, ENDS)) return false;
  blendPoseEnds(ENDS, t, out);
  return true;
}

/** A vehicle's body at the last two ticks: centre, heading and lane-change yaw at each; `before` false when there is no last to blend from. */
export interface PoseEnds {
  x0: number; y0: number; h0: number; yaw0: number;
  x1: number; y1: number; h1: number; yaw1: number;
  before: boolean;
}
const ENDS: PoseEnds = { x0: 0, y0: 0, h0: 0, yaw0: 0, x1: 0, y1: 0, h1: 0, yaw1: 0, before: false };

/** A vehicle on the road's two ends of the tick into `out` (`blendPoseEnds` makes its pose); false where it has none. */
export function vehiclePoseEnds(w: SimWorld, v: Vehicle, out: PoseEnds): boolean {
  const frame = axleFrame(w, v, v, v.archetype.length, AXLE_NOW);
  if (!frame) return false;

  // Simulation arc position is the FRONT of the vehicle.
  const side = bodyOffset(v, v.archetype.length) + cycleShift(v, w.lanelet(v.lanelet), v.s);
  // Along the frame's left normal (`perp` of its tangent).
  const atX = frame.p.x - frame.t.y * side, atY = frame.p.y + frame.t.x * side;
  out.x1 = atX; out.y1 = atY; out.h1 = Math.atan2(frame.t.y, frame.t.x); out.yaw1 = laneChangeYaw(v.lateralSlope);
  out.before = false;

  const before = axleFrame(w, v, v.prev, v.archetype.length, AXLE_BEFORE);
  if (!before) return true;
  const sideBefore = bodyOffset(v.prev, v.archetype.length) + cycleShift(v, w.lanelet(v.prev.lanelet), v.prev.s);
  const bx = before.p.x - before.t.y * sideBefore, by = before.p.y + before.t.x * sideBefore;
  if (Math.hypot(bx - atX, by - atY) > POSE_JUMP_LIMIT) return true;
  out.x0 = bx; out.y0 = by; out.h0 = Math.atan2(before.t.y, before.t.x); out.yaw0 = laneChangeYaw(v.prev.lateralSlope);
  out.before = true;
  return true;
}

/** The pose `t` of the way through a tick, from its two ends: the last tick's alone when there is none to blend from */
export function blendPoseEnds(e: Readonly<PoseEnds>, t: number, out: PoseOut): void {
  if (!e.before) { out.p.x = e.x1; out.p.y = e.y1; out.angle = e.h1; return; }
  // Point into the change, blended across the tick like everything else.
  const yaw = lerp(e.yaw0, e.yaw1, t);
  out.p.x = lerp(e.x0, e.x1, t); out.p.y = lerp(e.y0, e.y1, t);
  out.angle = lerpAngle(e.h0, e.h1, t) + yaw;
}

/** `vehiclePoseNow` into `out`; false where there is none (the walkers read every vehicle's every tick). */
export function vehiclePoseNowInto(w: SimWorld, v: Vehicle, out: PoseOut): boolean {
  const free = v.free;
  if (free) { out.p.x = free.x; out.p.y = free.y; out.angle = free.angle; return true; }
  const frame = axleFrame(w, v, v, v.archetype.length, AXLE_NOW);
  if (!frame) return false;
  const side = bodyOffset(v, v.archetype.length) + cycleShift(v, w.lanelet(v.lanelet), v.s);
  out.p.x = frame.p.x - frame.t.y * side; out.p.y = frame.p.y + frame.t.x * side;
  out.angle = Math.atan2(frame.t.y, frame.t.x) + laneChangeYaw(v.lateralSlope);
  return true;
}

/** The body centre on the path, pointing along a short chord centred on it. */
/** The frames `axleFrame` writes and reads (`out` of the two in a pose, and the chord's ends): made once. */
const AXLE_NOW = newFrame();
const AXLE_BEFORE = newFrame();
const AHEAD = newFrame();
const BEHIND = newFrame();

function axleFrame(w: SimWorld, vehicle: Vehicle, kinematics: Kinematics, length: number, out: FrameOut): FrameOut | null {
  if (!bodyFrame(w, vehicle, kinematics, length / 2, out)) return null;
  if (!bodyFrame(w, vehicle, kinematics, length / 2 - HEADING_CHORD, AHEAD) || !bodyFrame(w, vehicle, kinematics, length / 2 + HEADING_CHORD, BEHIND)) return out;
  // (`chordHeading`, without its new vector: kept where the ends meet.)
  const behind = BEHIND.p, ahead = AHEAD.p;
  const dx = ahead.x - behind.x, dy = ahead.y - behind.y, d = Math.hypot(dx, dy);
  if (d < 1e-6) return out;
  const tx = dx / d, ty = dy / d;
  out.t.x = tx; out.t.y = ty;
  out.n.x = -ty; out.n.y = tx;
  return out;
}

/** The body's frame `behindFront` behind the front, into `out`; false off the road behind it. */
function bodyFrame(w: SimWorld, vehicle: Vehicle, kinematics: Kinematics, behindFront: number, out: FrameOut): boolean {
  let lane = w.lanelet(kinematics.lanelet);
  if (!lane) return false;
  let s = kinematics.s - behindFront;
  // The heading chord can reach past the front's lanelet even while the front is still on it.
  if (s > lane.length) {
    const nextId = lane.kind === 'connector' ? lane.toLane
      : kinematics.lanelet !== vehicle.lanelet && w.connector(vehicle.lanelet)?.fromLane === lane.id
        ? vehicle.lanelet
        : vehicle.admittedConnector && w.connector(vehicle.admittedConnector)?.fromLane === lane.id
          ? vehicle.admittedConnector : undefined;
    const next = nextId ? w.lanelet(nextId) : undefined;
    if (next) { next.centre.sampleAtInto(s - lane.length, out); return true; }
  }
  if (s >= 0) { lane.centre.sampleAtInto(s, out); return true; }
  for (const id of kinematics.rearPath) {
    lane = w.lanelet(id);
    if (!lane) return false;
    s += lane.length;
    if (s >= 0) { lane.centre.sampleAtInto(s, out); return true; }
  }
  return false;
}

/** Interpolates two headings the short way round. */
function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return from + delta * t;
}

/** Pose of a pedestrian, interpolated between the last two steps in WORLD space. */
/** `pedPose` written into `out`: the same numbers (`lerpVec`'s sums), no object made. */
export function pedPoseInto(p: PedView, alpha: number, out: PoseOut): void {
  const t = clamp(alpha, 0, 1);
  const bx = p.prev.x, by = p.prev.y;
  if (Math.hypot(p.x - bx, p.y - by) > POSE_JUMP_LIMIT) { out.p.x = p.x; out.p.y = p.y; out.angle = p.heading; return; }
  out.p.x = bx + (p.x - bx) * t;
  out.p.y = by + (p.y - by) * t;
  out.angle = lerpAngle(p.prev.heading, p.heading, t);
}

export function pedPose(p: PedView, alpha: number): Pose {
  const t = clamp(alpha, 0, 1);
  const now = { x: p.x, y: p.y };
  const before = { x: p.prev.x, y: p.prev.y };
  if (dist(before, now) > POSE_JUMP_LIMIT) return { p: now, angle: p.heading };
  return { p: lerpVec(before, now, t), angle: lerpAngle(p.prev.heading, p.heading, t) };
}
