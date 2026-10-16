import { createAgentWalkEngine } from '@sim/agents/walk';
import { useBayWorkers } from '@sim/agents/parking';
import { SimRunner, type RunnerBudget } from '@sim/host';
import { junctionTraffic, segmentTraffic } from '@sim/inspect';
import type { FromSim, SimAct, SimAsk, ToSim } from '@sim/protocol';
import { greenWave } from '@sim/roads/greenWave';
import { strandVehicle } from '@sim/vehicles/state';
import { SimWorld } from '@sim/world';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { applyReplica } from '@world/replica';
import { BayPool } from './bayPool';
import { ConflictPool } from './conflictPool';

/** THE SIMULATION OFF THE PAGE: its own copy of the document (`world/replica.ts`), its network, its world, stepped as the page asks */

/** A frame here has the thread to itself: the ticks take most of it, and a tick may cost twice what it may on the page. */
const WORKER_BUDGET: RunnerBudget = { frameMs: 14, highMs: 13, lowMs: 7 };

interface Running {
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly world: SimWorld;
  readonly runner: SimRunner;
  issuesSent: number;
}
const state: { running: Running | null } = { running: null };

const post = (message: FromSim): void => self.postMessage(message);

self.onmessage = (event: MessageEvent<ToSim>) => {
  const m = event.data;
  if (m.kind === 'init') {
    const doc = new RoadDoc();
    const net = new Network(doc);
    const world = new SimWorld(doc, net, m.seed);
    // The lots' bays worked out on the other cores (`bayPool.ts`)
    useBayWorkers(world, new BayPool());
    world.auditEnabled = true;
    world.auditLevel = 'cheap';
    world.auditEvery = 60;
    world.usePedestrianEngine(createAgentWalkEngine());
    world.ambient.enabled = true;
    world.ambient.source = m.ambientSource;
    const runner = new SimRunner(world, net, new ConflictPool(m.zonesPrefix), WORKER_BUDGET);
    runner.set(m.settings);
    state.running = { doc, net, world, runner, issuesSent: 0 };
    return;
  }
  const running = state.running;
  if (!running) return;
  if (m.kind === 'zones') {
    running.world.conflicts.seed(m.zones);
    return;
  }
  if (m.kind === 'ask') {
    post({ kind: 'answer', id: m.id, value: answer(running, m.ask) });
    return;
  }
  const { doc, net, world, runner } = running;
  if (m.reset) runner.reset();
  if (m.patch) applyReplica(doc, m.patch);
  if (m.patch?.roads) net.rebuild();
  if (m.settings) runner.set(m.settings);
  for (const act of m.acts) perform(running, act);
  const hold = runner.advance(m.advance);
  const issues = world.issues;
  const issuesWhole = issues.length < running.issuesSent;
  const fresh = issuesWhole ? issues.slice() : issues.slice(running.issuesSent);
  running.issuesSent = issues.length;
  const measured = world.conflicts.takeMeasured();
  post({
    kind: 'frame', seq: m.seq, frame: runner.frame(), alpha: runner.alpha, time: world.clock.time, minutes: world.city.minutes(world),
    hold, health: runner.health(), issues: fresh, issuesWhole, measured: measured.size ? measured : null,
  });
};

function perform(running: Running, act: SimAct): void {
  const { world, runner } = running;
  switch (act.kind) {
    case 'removeVehicle': { const v = world.vehicles.get(act.id); if (v) world.removeVehicle(v); return; }
    case 'strand': { const v = world.vehicles.get(act.id); if (v) strandVehicle(v); return; }
    case 'getUp': world.pedEngine.getUp?.(world, act.id, act.x, act.y, act.heading, act.seconds, act.crawl); return;
    case 'run': runner.run(act.seconds); return;
    case 'step': runner.step(act.traffic, act.pedestrians);
  }
}

function answer(running: Running, ask: SimAsk): unknown {
  const { world } = running;
  switch (ask.kind) {
    case 'segment': return segmentTraffic(world, ask.id);
    case 'junction': return junctionTraffic(world, ask.id);
    case 'greenWave': return greenWave(world, ask.node);
    case 'shoot': return world.pedEngine.shot?.(world, ask.id, ask.part, ask.fromX, ask.fromY) ?? null;
    case 'impact': return world.pedEngine.impact?.(world, ask.x, ask.y, ask.kill, ask.scare) ?? 0;
  }
}
