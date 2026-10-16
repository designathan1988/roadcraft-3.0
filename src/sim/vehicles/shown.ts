import { newFrame } from '@core/polyline';
import { m } from '@world/units';
import { DT } from '../params';
import type { SimWorld } from '../world';
import type { Vehicle, VehicleId } from './state';

/** WHAT A VEHICLE SHOWS, read off the simulation: the side it signals, the bend under it, how far its wheels rolled */

/** +1 indicating left, -1 right, 0 none — in the vehicle's own frame. */
export type IndicatorSide = -1 | 0 | 1;

/** Offset of a lane change under which the manoeuvre is treated as finished. */
const LANE_CHANGE_DONE = 0.15;
/** A driver signals a turn this long, or this far, before the stop line. */
const TURN_SIGNAL_TIME = 4;
const TURN_SIGNAL_MIN = m(25);
/** And keeps signalling until this share of the turn is driven. */
const TURN_SIGNAL_UNTIL = 0.6;

/** What `indicatorSide` reads of the two lanes, made once. */
const HERE = newFrame();
const THERE = newFrame();
const HIT = { s: 0, distance: 0 };

/** Which way a vehicle is signalling. */
export function indicatorSide(w: SimWorld, v: Vehicle): IndicatorSide {
  if (Math.abs(v.lateral) > LANE_CHANGE_DONE) return v.lateral > 0 ? -1 : 1;

  const here = w.lanelet(v.lanelet);
  if (!here) return 0;

  const wanted = v.laneIntent ?? (v.desiredLane !== v.lanelet ? v.desiredLane : null);
  if (wanted) {
    const target = w.lanelet(wanted);
    if (target && here.kind === 'link') {
      // Into frames made once: every vehicle signalling a lane change, every tick.
      const frame = here.centre.sampleAtInto(Math.min(Math.max(0, v.s), here.length), HERE);
      target.centre.closestInto(frame.p.x, frame.p.y, HIT);
      const at = target.centre.sampleAtInto(HIT.s, THERE).p;
      const leftward = (at.x - frame.p.x) * -frame.t.y + (at.y - frame.p.y) * frame.t.x;
      if (Math.abs(leftward) > 1e-6) return leftward > 0 ? 1 : -1;
    }
  }

  if (here.kind === 'connector') {
    if (v.s / Math.max(here.length, 1e-6) < TURN_SIGNAL_UNTIL) return turnSide(here.turn);
    return 0;
  }

  const toLine = here.length - v.s;
  if (toLine > Math.max(TURN_SIGNAL_MIN, v.v * TURN_SIGNAL_TIME)) return 0;
  for (const id of v.route) {
    if (id === v.lanelet) continue;
    const next = w.lanelet(id);
    if (!next) break;
    if (next.kind === 'connector') return turnSide(next.turn);
    break;
  }
  return 0;
}

function turnSide(turn: string | undefined): IndicatorSide {
  if (turn === 'left' || turn === 'uturn') return 1;
  if (turn === 'right') return -1;
  return 0;
}

/** The two tangents `pathCurvature` reads: made once (every vehicle, every tick). */
const BEFORE = newFrame();
const AFTER = newFrame();

/** Curvature of the path the vehicle is driving under its front axle, per world unit, positive turning left */
export function pathCurvature(w: SimWorld, v: Vehicle): number {
  const lane = w.lanelet(v.lanelet);
  if (!lane) return 0;
  const span = Math.min(m(2), lane.length / 2);
  const s = Math.min(Math.max(v.s, span), lane.length - span);
  let curvature = 0;
  if (span > 1e-3) {
    const a = lane.centre.sampleAtInto(s - span, BEFORE).t;
    const b = lane.centre.sampleAtInto(s + span, AFTER).t;
    const turn = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
    curvature = turn / (2 * span);
  }
  const travelled = v.s - (v.prev.lanelet === v.lanelet ? v.prev.s : v.s);
  if (travelled > 1e-4) {
    curvature += (Math.atan(v.lateralSlope) - Math.atan(v.prev.lateralSlope)) / travelled;
  }
  return curvature;
}

/** Distance each vehicle has driven, for the rolling angle of its wheels. */
export class WheelOdometer {
  private readonly seen = new Map<VehicleId, { lanelet: string; s: number; total: number }>();

  /** Total distance driven so far, in world units. */
  advance(v: Vehicle): number {
    const last = this.seen.get(v.id);
    if (!last) {
      this.seen.set(v.id, { lanelet: v.lanelet, s: v.s, total: 0 });
      return 0;
    }
    const ds = last.lanelet === v.lanelet ? v.s - last.s : Math.max(0, v.v) * DT;
    last.total += Math.max(0, ds);
    last.lanelet = v.lanelet;
    last.s = v.s;
    return last.total;
  }

  /** A vehicle gone from the world: its count let go. */
  forget(id: VehicleId): void {
    this.seen.delete(id);
  }
}
