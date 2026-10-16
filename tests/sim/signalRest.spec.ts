import { describe, expect, it } from 'vitest';

import { asNodeId } from '@world/ids';
import { DT } from '@sim/params';
import { addRepeated, stepController, type SignalController, type SignalDeps } from '@sim/signals/fsm';
import { Rng } from '@core/rng';

describe('actuated signal rest', () => {
  it('keeps the empty junction green and transfers right of way when another approach calls', () => {
    const stage = (group: number) => ({
      greenGroups: [group], pedWalk: [], minGreen: 2, targetGreen: 5, maxGreen: 8,
      amber: 1, allRed: 1, exclusivePed: false, protectedMovements: [],
    });
    const calls = new Set<number>();
    let tick = 0;
    const deps: SignalDeps = {
      tick: () => tick,
      connectorsOf: () => undefined,
      pedestriansCrossing: () => false,
      demandOn: (_node, groups) => groups.some((group) => calls.has(group)),
      pedestrianDemandOn: () => false,
      reservationDemandOn: () => false,
    };
    const controller: SignalController = {
      node: asNodeId(1), plan: { stages: [stage(1), stage(2)], groups: [1, 2], crossings: [], cycle: 20 },
      stageIndex: 0, sub: 'GREEN', elapsed: 0,
      lastServed: new Map([[1, 0], [2, 0]]), stageServed: new Map([[0, 0], [1, 0]]),
      offsetApplied: 0, degraded: false,
    };
    for (let i = 0; i < Math.round(30 / DT); i++) { tick++; stepController(controller, deps); }
    expect([controller.stageIndex, controller.sub]).toEqual([0, 'GREEN']);

    calls.add(2);
    for (let i = 0; i < Math.round(4 / DT); i++) { tick++; stepController(controller, deps); }
    expect([controller.stageIndex, controller.sub]).toEqual([1, 'GREEN']);
  });

  it('counts a resting signal\'s seconds on as a tick-by-tick sum would, bit for bit', () => {
    const rng = new Rng(7);
    const sum = (x: number, n: number): number => { for (let i = 0; i < n; i++) x += DT; return x; };
    for (let k = 0; k < 300; k++) {
      const x = k % 3 === 0 ? 0 : k % 3 === 1 ? rng.float() * 2 : rng.float() * 5000;
      const n = Math.floor(rng.float() * (k % 10 === 0 ? 400_000 : 4_000));
      expect(addRepeated(x, DT, n)).toBe(sum(x, n));
    }
    // Across many binades, from nothing: a signal asleep for days.
    expect(addRepeated(0, DT, 20_000_000)).toBe(sum(0, 20_000_000));
  });
});
