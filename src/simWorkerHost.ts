import type { AuditIssue } from '@sim/audit';
import type { SimAdvance, SimControl, SimHost, SimInspect, SimSettings } from '@sim/host';
import type { JunctionTraffic, SegmentTraffic } from '@sim/inspect';
import { SimMirror } from '@sim/mirror';
import { DT } from '@sim/params';
import type { FromSim, SimAct, SimAnswers, SimAsk, ToSim } from '@sim/protocol';
import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { ReplicaFeed } from '@world/replica';

/** THE SIMULATION IN A WORKER (`sim.worker.ts`), as the page holds it: what it draws of it, the document's changes sent, the answers awaited */

/** The last answer for one road or junction the inspector reads, and whether it is asked again already. */
interface Slot<Id, Value> {
  id: Id | null;
  value: Value | null | undefined;
  asking: boolean;
}

/** What starts the worker's simulation (`ToSim` 'init'). */
export interface WorkerSimStart {
  readonly seed: number;
  readonly settings: SimSettings;
  readonly ambientSource: 'view' | 'edges';
  readonly zonesPrefix: string | null;
}

export class WorkerSimHost implements SimHost {
  readonly shown = new SimMirror();
  readonly inspect: SimInspect;
  readonly control: SimControl;
  readonly world = null;
  time = 0;
  minutes = 0;
  private readonly worker: Worker;
  private readonly feed = new ReplicaFeed();
  private current: SimSettings;
  private changed: Partial<SimSettings> | null = null;
  private acts: SimAct[] = [];
  /** Something done in the worker since the last frame whose sight comes with the next one (a shot's wound). */
  private due = false;
  private resetNext = false;
  /** Wall seconds run on the page and not sent yet: one frame is out at a time, the time between them added up. */
  private wall = 0;
  private out = false;
  /** The frame out carries something to take in (an edit, a setting, an act): its answer is drawn even paused. */
  private outWork = false;
  private seq = 0;
  /** The last frame's share of its tick, when it came (`performance.now()`), and whether the worker held. */
  private frameAlpha = 1;
  private cameAt = 0;
  private held = false;
  private readonly issueList: AuditIssue[] = [];
  private lastHealth: { readonly stepMs: number; readonly share: number } = { stepMs: 0, share: 1 };
  private readonly measured = new Map<string, Float64Array | null>();
  private readonly waiting = new Map<number, (value: unknown) => void>();
  private nextAsk = 1;
  private readonly segmentSlot: Slot<SegmentId, SegmentTraffic> = { id: null, value: undefined, asking: false };
  private readonly junctionSlot: Slot<NodeId, JunctionTraffic> = { id: null, value: undefined, asking: false };

  /** `arrived`: a frame came back that the page should draw. */
  constructor(private readonly doc: RoadDoc, start: WorkerSimStart, private readonly arrived: () => void) {
    this.current = start.settings;
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<FromSim>) => this.hear(event.data);
    this.worker.onerror = (event) => console.error(`[sim] the simulation's worker failed: ${event.message}`);
    this.worker.onmessageerror = () => console.error("[sim] the simulation's worker sent a message that cannot be read");
    this.send({ kind: 'init', seed: start.seed, settings: start.settings, ambientSource: start.ambientSource, zonesPrefix: start.zonesPrefix });
    this.inspect = {
      segment: (id) => this.read(this.segmentSlot, id, { kind: 'segment', id }),
      junction: (id) => this.read(this.junctionSlot, id, { kind: 'junction', id }),
      greenWave: (node) => this.ask<'greenWave'>({ kind: 'greenWave', node }),
    };
    this.control = {
      shoot: (id, part, fromX, fromY) => this.poke(this.ask<'shoot'>({ kind: 'shoot', id, part, fromX, fromY })),
      impact: (x, y, kill, scare) => this.poke(this.ask<'impact'>({ kind: 'impact', x, y, kill, scare })),
      removeVehicle: (id) => this.act({ kind: 'removeVehicle', id }),
      strand: (id) => this.act({ kind: 'strand', id }),
      getUp: (id, x, y, heading, seconds, crawl = false) => this.act({ kind: 'getUp', id, x, y, heading, seconds, crawl }),
    };
  }

  get settings(): SimSettings { return this.current; }

  set(patch: Partial<SimSettings>): void {
    this.current = { ...this.current, ...patch };
    this.changed = { ...this.changed, ...patch };
  }

  /** The share of the tick drawn: the last frame's, carried on by the wall time since it came (never past its tick). */
  get alpha(): number {
    if (this.held || this.current.paused) return this.frameAlpha;
    return Math.min(1, this.frameAlpha + ((performance.now() - this.cameAt) / 1000) * this.current.speed / DT);
  }

  advance(frame: SimAdvance): boolean {
    if (!frame.hold) this.wall += frame.wall;
    if (this.out) return this.held;
    const patch = this.feed.take(this.doc);
    const work = patch !== null || this.changed !== null || this.acts.length > 0 || this.resetNext || this.due;
    // Paused, caught up and nothing to take in: the worker is left alone (the page draws on demand).
    if (!work && !this.held && this.current.paused) return false;
    this.out = true;
    this.outWork = work;
    this.send({ kind: 'frame', seq: ++this.seq, advance: { ...frame, wall: this.wall }, patch, settings: this.changed, reset: this.resetNext, acts: this.acts });
    this.wall = 0;
    this.changed = null;
    this.acts = [];
    this.due = false;
    this.resetNext = false;
    return this.held;
  }

  /** The topology catches up in the worker: an edit is always drawn before it. */
  behind(): boolean { return false; }
  settle(): void {}

  reset(): void {
    this.resetNext = true;
    this.issueList.length = 0;
  }

  issues(): readonly AuditIssue[] { return this.issueList; }
  health(): { readonly stepMs: number; readonly share: number } { return this.lastHealth; }

  seedZones(kept: ReadonlyMap<string, Float64Array | null>): void {
    this.send({ kind: 'zones', zones: kept });
  }

  takeMeasured(): ReadonlyMap<string, Float64Array | null> {
    const taken = new Map(this.measured);
    this.measured.clear();
    return taken;
  }

  /** Probes: done in the worker with the next frame, seen when it comes back. */
  run(seconds: number): void { this.act({ kind: 'run', seconds }); }
  step(traffic: boolean, pedestrians: boolean): void { this.act({ kind: 'step', traffic, pedestrians }); }

  private act(act: SimAct): void {
    this.acts.push(act);
    this.arrived();
  }

  /** An ask that changes the world: the next frame is sent even paused, to bring its sight back. */
  private poke<T>(answer: Promise<T>): Promise<T> {
    this.due = true;
    this.arrived();
    return answer;
  }

  private ask<K extends SimAsk['kind']>(ask: Extract<SimAsk, { kind: K }>): Promise<SimAnswers[K]> {
    const id = this.nextAsk++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve as (value: unknown) => void);
      this.send({ kind: 'ask', id, ask });
    });
  }

  /** The last answer for this id (undefined until the first comes), asked again for the next read. */
  private read<Id, Value>(slot: Slot<Id, Value>, id: Id, ask: SimAsk): Value | null | undefined {
    if (slot.id !== id) {
      slot.id = id;
      slot.value = undefined;
      slot.asking = false;
    }
    if (!slot.asking) {
      slot.asking = true;
      void this.ask(ask as Extract<SimAsk, { kind: 'segment' }>).then((value) => {
        if (slot.id !== id) return;
        slot.value = value as Value | null;
        slot.asking = false;
      });
    }
    return slot.value;
  }

  private hear(m: FromSim): void {
    if (m.kind === 'answer') {
      const resolve = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      resolve?.(m.value);
      return;
    }
    this.out = false;
    this.shown.take(m.frame);
    this.frameAlpha = m.alpha;
    this.cameAt = performance.now();
    this.held = m.hold;
    this.time = m.time;
    this.minutes = m.minutes;
    this.lastHealth = m.health;
    if (m.issuesWhole) this.issueList.length = 0;
    for (const issue of m.issues) this.issueList.push(issue);
    if (m.measured) for (const [key, table] of m.measured) this.measured.set(key, table);
    if (m.hold || !this.current.paused || this.outWork) this.arrived();
  }

  private send(message: ToSim): void {
    this.worker.postMessage(message);
  }
}
