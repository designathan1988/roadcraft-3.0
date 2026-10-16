import { describe, expect, it } from 'vitest';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { BLINK_HZ, MAX_STEER, blinkOn, steerAngle } from '@render/vehicleSignals';
import { WheelOdometer, indicatorSide, pathCurvature } from '@sim/vehicles/shown';
import { LAYOUTS, layoutDoc, simOf } from '../sim/support/bodies';

/** What a driver shows the road: which way they are about to go, and wheels that steer and roll. */
describe('vehicle signals', () => {
  it('signals a turn before the junction and through it, on the side it turns to', () => {
    const sim = simOf(layoutDoc(LAYOUTS[0]!).doc, 7, 2);
    const seen = { left: 0, right: 0, through: 0 };
    let wrong = 0;
    sim.clock.run(Math.round(45 / DT), () => {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehicles.values()) {
        const lane = sim.lanelet(v.lanelet);
        // On the first half of a turn, nothing else can be what the lamp says.
        if (lane?.kind !== 'connector' || v.lateral !== 0 || v.s > lane.length * 0.5) continue;
        const side = indicatorSide(sim, v);
        if (lane.turn === 'left') { seen.left++; if (side !== 1) wrong++; }
        if (lane.turn === 'right') { seen.right++; if (side !== -1) wrong++; }
        if (lane.turn === 'through') { seen.through++; if (side !== 0) wrong++; }
      }
    });
    expect(seen.left).toBeGreaterThan(0);
    expect(seen.right).toBeGreaterThan(0);
    expect(seen.through).toBeGreaterThan(0);
    expect(wrong).toBe(0);
  });

  it('signals BEFORE the stop line, not only once the turn has begun', () => {
    const sim = simOf(layoutDoc(LAYOUTS[0]!).doc, 7, 2);
    let early = 0;
    sim.clock.run(Math.round(45 / DT), () => {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehicles.values()) {
        const lane = sim.lanelet(v.lanelet);
        if (lane?.kind !== 'link' || v.lateral !== 0 || v.desiredLane) continue;
        const next = v.route.map((id) => sim.lanelet(id)).find((l) => l?.kind === 'connector');
        if (next?.turn !== 'left' && next?.turn !== 'right') continue;
        if (lane.length - v.s < 10 && indicatorSide(sim, v) === (next.turn === 'left' ? 1 : -1)) early++;
      }
    });
    expect(early).toBeGreaterThan(0);
  });

  it('points the lamp into a lane change, towards the lane being entered', () => {
    const sim = simOf(layoutDoc(LAYOUTS[0]!).doc, 0x51de, 2);
    let changing = 0;
    sim.clock.run(Math.round(45 / DT), () => {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehicles.values()) {
        if (Math.abs(v.lateral) < 1) continue;
        changing++;
        // `lateral` is the offset still to cover, signed towards the old lane.
        expect(indicatorSide(sim, v)).toBe(v.lateral > 0 ? -1 : 1);
      }
    });
    expect(changing).toBeGreaterThan(0);
  });

  it('flashes at a real rate, and not in lockstep down a queue', () => {
    let lit = 0;
    let edges = 0;
    let previous = blinkOn(0, 3);
    const samples = 6000;
    for (let i = 1; i <= samples; i++) {
      const on = blinkOn(i * 0.001, 3);
      if (on) lit++;
      if (on && !previous) edges++;
      previous = on;
    }
    // Six seconds at 1.5 Hz: nine flashes, lit a little over half the time.
    expect(edges).toBeGreaterThanOrEqual(Math.floor(6 * BLINK_HZ) - 1);
    expect(edges).toBeLessThanOrEqual(Math.ceil(6 * BLINK_HZ) + 1);
    expect(lit / samples).toBeGreaterThan(0.45);
    expect(lit / samples).toBeLessThan(0.65);
    const phases = new Set<boolean>();
    for (let id = 0; id < 8; id++) phases.add(blinkOn(0.2, id));
    expect(phases.size).toBe(2);
  });

  it('steers the front wheels into a turn and keeps them straight on a straight road', () => {
    const sim = simOf(layoutDoc(LAYOUTS[0]!).doc, 7, 2);
    let lefts = 0;
    let rights = 0;
    let worstStraight = 0;
    sim.clock.run(Math.round(45 / DT), () => {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehicles.values()) {
        const lane = sim.lanelet(v.lanelet);
        if (!lane) continue;
        const wheelbase = v.archetype.length * 0.62;
        const steer = steerAngle(pathCurvature(sim, v), wheelbase);
        expect(Math.abs(steer)).toBeLessThanOrEqual(MAX_STEER);
        const middle = v.s > lane.length * 0.3 && v.s < lane.length * 0.7;
        if (lane.kind === 'connector' && middle && lane.turn === 'left') { lefts++; expect(steer).toBeGreaterThan(0); }
        if (lane.kind === 'connector' && middle && lane.turn === 'right') { rights++; expect(steer).toBeLessThan(0); }
        if (lane.kind === 'link' && v.lateral === 0 && v.s > 30 && lane.length - v.s > 30) {
          worstStraight = Math.max(worstStraight, Math.abs(steer));
        }
      }
    });
    expect(lefts).toBeGreaterThan(0);
    expect(rights).toBeGreaterThan(0);
    expect(worstStraight).toBeLessThan(0.01);
  });

  it('rolls the wheels continuously, across every lanelet boundary', () => {
    const sim = simOf(layoutDoc(LAYOUTS[0]!).doc, 7, 2);
    const odometer = new WheelOdometer();
    const last = new Map<number, number>();
    let boundaries = 0;
    let worst = 0;
    sim.clock.run(Math.round(45 / DT), () => {
      const before = new Map([...sim.vehicles.values()].map((v) => [v.id, v.lanelet]));
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehicles.values()) {
        const total = odometer.advance(v);
        const previous = last.get(v.id);
        last.set(v.id, total);
        if (previous === undefined) continue;
        const moved = total - previous;
        expect(moved).toBeGreaterThanOrEqual(0);
        if (before.get(v.id) !== v.lanelet) boundaries++;
        worst = Math.max(worst, moved - v.v * DT * 1.5);
      }
    });
    expect(boundaries).toBeGreaterThan(0);
    // Never more than one step of travel in one step: no jump at a boundary.
    expect(worst).toBeLessThan(0.05);
  });
});
