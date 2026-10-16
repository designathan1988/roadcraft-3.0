import { describe, expect, it } from 'vitest';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import type { SegmentId } from '@world/ids';
import type { Connector } from '@world/lanelets';
import { comesFrom, rightOfWay, yieldSide } from '@sim/intersections/admission';
import { ControlAdvisor, warrantedControl } from '@sim/roads/controlAdvisor';
import { fixedCycle, stepController, type SignalDeps } from '@sim/signals/fsm';
import { greenWave } from '@sim/roads/greenWave';
import { ROAD_TUNING } from '@world/roads/tuning';
import { legRule, mainRoadLegs } from '@world/roads/rules';
import { RoadDoc } from '@world/doc';
import { layoutDoc, simOf } from './support/bodies';

/** JUNCTION RULES, run as the traffic drives them */
const STREETS = { name: 'streets', bearings: [0, 90, 180, 270], types: [1, 1, 1, 1] } as const;

function connectorFrom(sim: ReturnType<typeof simOf>, node: number, inSeg: SegmentId, turn = 'through'): Connector {
  return [...sim.graph.connectors.values()].find((c) => c.node === node && c.inSegment === inSeg && c.turn === turn)!;
}

describe('who gives way to whom', () => {
  it('signs on each leg: the main road goes first, a leg given a stop stops', () => {
    const { doc, centre } = layoutDoc({ name: 'mixed', bearings: [0, 90, 180, 270], types: [3, 1, 3, 1] });
    doc.setNodeControl(centre, 'priority');
    const legs = [...doc.segments.keys()].sort((a, b) => a - b) as SegmentId[];
    const main = mainRoadLegs(doc, centre)!;
    expect([...main].sort()).toEqual([legs[0], legs[2]].sort());
    const minor = legs[1]!;
    expect(legRule(doc, doc.node(centre)!, minor)).toBe('yield');
    doc.setNodeApproachRules(centre, [{ segment: minor, rule: 'stop' }]);
    const sim = simOf(doc, 3, 0);
    const v = { v: 0, archetype: { length: 4.5 } } as never;
    expect(rightOfWay(sim, centre, v, connectorFrom(sim, centre, minor), 5)).toBe('stop');
    expect(rightOfWay(sim, centre, v, connectorFrom(sim, centre, legs[0]!), 5)).toBe('priority');
  });

  it('nothing signed (CTB art. 29, III, c): everyone gives way only to the one coming from the right', () => {
    const { doc, centre } = layoutDoc(STREETS);
    doc.setNodeControl(centre, 'none');
    const sim = simOf(doc, 4, 0);
    const legs = [...doc.segments.keys()].sort((a, b) => a - b) as SegmentId[];
    // Legs point east (0°), north (90°), west (180°), south (270°) from the junction.
    const fromSouth = connectorFrom(sim, centre, legs[3]!);
    const fromEast = connectorFrom(sim, centre, legs[0]!);
    const fromWest = connectorFrom(sim, centre, legs[2]!);
    expect(yieldSide(sim, fromSouth)).toBe('right');
    // Driving north, the east road is on the right, the west road on the left.
    expect(comesFrom(sim, fromSouth, fromEast, 'right')).toBe(true);
    expect(comesFrom(sim, fromSouth, fromWest, 'right')).toBe(false);
  });

  it('nothing signed with a "rodovia": the highway goes first', () => {
    const { doc, centre } = layoutDoc({ name: 'hw', bearings: [0, 90, 180, 270], types: [4, 1, 4, 1] });
    doc.setNodeControl(centre, 'none');
    const sim = simOf(doc, 5, 0);
    const legs = [...doc.segments.keys()].sort((a, b) => a - b) as SegmentId[];
    const v = { v: 0, archetype: { length: 4.5 } } as never;
    expect(rightOfWay(sim, centre, v, connectorFrom(sim, centre, legs[0]!), 5)).toBe('priority');
    expect(rightOfWay(sim, centre, v, connectorFrom(sim, centre, legs[1]!), 5)).toBe('yield');
    expect(yieldSide(sim, connectorFrom(sim, centre, legs[1]!))).toBeNull();
  });

  it('a mini-roundabout: every entry gives way to the left', () => {
    const { doc, centre } = layoutDoc(STREETS);
    doc.setNodeControl(centre, 'mini');
    const sim = simOf(doc, 6, 0);
    const c = connectorFrom(sim, centre, [...doc.segments.keys()][0] as SegmentId);
    expect(rightOfWay(sim, centre, { v: 0, archetype: { length: 4.5 } } as never, c, 5)).toBe('yield');
    expect(yieldSide(sim, c)).toBe('left');
  });

  for (const control of ['none', 'mini', 'priority'] as const) {
    it(`a ${control} crossroads keeps moving under heavy traffic (no deadlock)`, () => {
      const { doc, centre } = layoutDoc(STREETS);
      doc.setNodeControl(centre, control);
      const sim = simOf(doc, 0x77, 4);
      let lastMinute = 0;
      const ticks = Math.round(60 / DT);
      for (let i = 0; i < ticks; i++) {
        step(sim, { traffic: true, pedestrians: false });
        if (i > ticks - Math.round(30 / DT)) {
          for (const v of sim.vehicles.values()) if (sim.lanelet(v.lanelet)?.kind === 'connector' && v.s < 1) lastMinute++;
        }
      }
      expect(lastMinute).toBeGreaterThan(0);
      void centre;
    });
  }
});

describe('the control "automatic" chooses from the flows', () => {
  const F = ROAD_TUNING.flow;
  it('steps up by the MUTCD volumes, and down only under 80 % of them', () => {
    expect(warrantedControl(100, 50, 50, 'priority')).toBe('priority');
    expect(warrantedControl(F.stopMajor, 50, F.stopMinor, 'priority')).toBe('stop');
    expect(warrantedControl(F.signalMajor, F.signalMinor, 300, 'stop')).toBe('signal');
    expect(warrantedControl(F.signalMajorB, F.signalMinorB, 100, 'priority')).toBe('signal');
    // Just under the threshold, a signal stays a signal; well under, it steps down.
    expect(warrantedControl(F.signalMajor * 0.9, F.signalMinor * 0.9, 300, 'signal')).toBe('signal');
    expect(warrantedControl(F.signalMajor * 0.5, F.signalMinor * 0.5, 100, 'signal')).toBe('priority');
  });

  it('nothing changes before a whole window of trend, and at most once a window', () => {
    const a = new ControlAdvisor();
    expect(a.evaluate(1 as never, 900, 300, 300, 'priority', F.trendWindow - 1)).toBe(false);
    expect(a.evaluate(1 as never, 900, 300, 300, 'priority', F.trendWindow)).toBe(true);
    expect(a.choice(1 as never)).toBe('signal');
    expect(a.evaluate(1 as never, 0, 0, 0, 'priority', F.trendWindow + 10)).toBe(false);
  });

  it('a junction on "automatic" its flows warrant becomes signalised, with a controller running it', () => {
    // A T of streets: unsignalised by the game's geometric default.
    const { doc, centre } = layoutDoc({ name: 't', bearings: [0, 90, 180], types: [1, 1, 1] });
    doc.setNodeControl(centre, 'auto');
    const sim = simOf(doc, 8, 0);
    expect(sim.graph.junctions.get(centre)?.signalised).toBe(false);
    const legs = [...doc.segments.keys()] as SegmentId[];
    const main = mainRoadLegs(doc, centre)!;
    const minor = legs.find((l) => !main.includes(l))!;
    // An hour and more of heavy flow, fed in second by second.
    for (let t = 0; t < F.trendWindow + 20; t++) {
      for (let k = 0; k < 4; k++) if ((t * 4 + k) % 5 === 0) sim.flow.record(centre, main[0]);
      if (t % 3 === 0) sim.flow.record(centre, main[1]);
      if (t % 12 === 0) sim.flow.record(centre, minor);
      sim.stepControlAdvisor(1);
    }
    expect(sim.advisor.choice(centre)).toBe('signal');
    expect(sim.graph.junctions.get(centre)?.signalised).toBe(true);
    expect(sim.controllers.get(centre)).toBeDefined();
  });

  it('evaluates again only the junctions counted at, built again or not settled: none it leaves out could change', () => {
    const doc = new RoadDoc();
    const ids: number[][] = [];
    for (let i = 0; i <= 4; i++) { ids.push([]); for (let j = 0; j <= 4; j++) ids[i]!.push(doc.addNode({ x: 120 * i, y: 120 * j }).id); }
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
      if (i < 4) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, j % 2 ? 1 : 3);
      if (j < 4) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
    doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -150, y: 0 }).id as never, 1);
    doc.addSegment(ids[4]![4]! as never, doc.addNode({ x: 630, y: 480 }).id as never, 1);
    const sim = simOf(doc, 11, 3);
    sim.trafficCount = 40;
    // Past the trend window from the start: every evaluation may change a choice.
    sim.flow.measured = F.trendWindow * 2;
    const watched = (): ReadonlySet<number> | null => (sim.advisor as unknown as { watched: ReadonlySet<number> | null }).watched;
    let left = 0, evaluations = 0;
    for (let round = 0; round < 40; round++) {
      for (let t = 0; t < 30; t++) step(sim, { traffic: true, pedestrians: false });
      sim.stepControlAdvisor(ControlAdvisor.EVERY);
      evaluations++;
      for (const [node, junction] of sim.graph.junctions) {
        const n = doc.node(node)!;
        if (watched()?.has(node) || n.control !== 'auto' || n.incident.length < 3) continue;
        left++;
        // Out of the evaluations: what one would say now is what it has.
        const main = mainRoadLegs(doc, node);
        let major = 0, minorMax = 0, minorTotal = 0;
        for (const seg of n.incident) {
          const rate = sim.flow.rate(node, seg);
          if (main?.includes(seg)) major += rate; else { minorMax = Math.max(minorMax, rate); minorTotal += rate; }
        }
        const choice = sim.advisor.choice(node)!;
        expect(choice).toBe('priority');
        expect(warrantedControl(major, minorMax, minorTotal, choice)).toBe(choice);
        expect(junction.signalised).toBe(false);
      }
    }
    expect(evaluations).toBe(40);
    expect(left).toBeGreaterThan(40);
  });
});

describe('signals', () => {
  it('a fixed-time signal runs each stage for its own green, in order', () => {
    const { doc, centre } = layoutDoc({ name: 'av', bearings: [0, 90, 180, 270], types: [3, 3, 3, 3] });
    const sim0 = simOf(doc, 9, 0);
    const stages = sim0.controllers.get(centre)!.plan.stages.length;
    const greens = Array.from({ length: stages }, (_, i) => 10 + i * 4);
    doc.setNodeSignal(centre, { mode: 'fixed', greens });
    const sim = simOf(doc, 9, 0);
    const c = sim.controllers.get(centre)!;
    const seen = new Map<number, number>();
    let last = `${c.stageIndex}${c.sub}`, since = 0;
    for (let i = 0; i < Math.round(120 / DT); i++) {
      step(sim, { traffic: false, pedestrians: false });
      since += DT;
      const now = `${c.stageIndex}${c.sub}`;
      if (now !== last) {
        if (last.endsWith('GREEN') && since > 1) seen.set(Number(last[0]), Math.round(since));
        last = now; since = 0;
      }
    }
    for (const [stage, green] of seen) expect(Math.abs(green - greens[stage]!)).toBeLessThanOrEqual(1);
    expect(seen.size).toBe(stages);
  });

  it('bus priority: a green is cut short after its minimum for a bus waiting on another stage', () => {
    const { doc, centre } = layoutDoc({ name: 'av', bearings: [0, 90, 180, 270], types: [3, 3, 3, 3] });
    doc.setNodeSignal(centre, { busPriority: true });
    const sim = simOf(doc, 10, 0);
    const c = sim.controllers.get(centre)!;
    c.stageIndex = 0; c.sub = 'GREEN'; c.elapsed = 0;
    const other = c.plan.stages[1]!.greenGroups;
    const deps: SignalDeps = { ...sim.signalDeps(), busNear: (_n, groups) => groups === other };
    let t = 0;
    while (c.sub === 'GREEN' && t < 60) { stepController(c, deps); t += DT; }
    expect(t).toBeLessThanOrEqual(c.plan.stages[0]!.minGreen + 0.5);
  });

  it('the green wave: the main road\'s signals share one cycle, offsets by the time to drive between them', () => {
    const doc = new RoadDoc();
    const nodes = [0, 1, 2, 3, 4].map((i) => doc.addNode({ x: i * 400, y: 0 }));
    for (let i = 0; i < 4; i++) doc.addSegment(nodes[i]!.id, nodes[i + 1]!.id, 3);
    for (const i of [1, 2, 3]) {
      const up = doc.addNode({ x: i * 400, y: 300 }), down = doc.addNode({ x: i * 400, y: -300 });
      doc.addSegment(nodes[i]!.id, up.id, 1);
      doc.addSegment(nodes[i]!.id, down.id, 1);
      doc.setNodeControl(nodes[i]!.id, 'signal');
    }
    const sim = simOf(doc, 11, 0);
    const plan = greenWave(sim, nodes[2]!.id);
    expect(plan.size).toBe(3);
    const cycles = [...plan.entries()].map(([node, s]) => fixedCycle(sim.controllers.get(node)!.plan, s));
    expect(Math.max(...cycles) - Math.min(...cycles)).toBeLessThan(1.5);
    const offsets = [nodes[1], nodes[2], nodes[3]].map((n) => plan.get(n!.id)?.offset ?? 0);
    expect(new Set(offsets).size).toBeGreaterThan(1);
  });
});
