import type { NodeId, SegmentId } from '@world/ids';
import type { ReplicaPatch } from '@world/replica';
import type { SignalSettings } from '@world/roads/rules';
import type { AuditIssue } from './audit';
import type { SimFrame } from './frame';
import type { SimAdvance, SimSettings } from './host';
import type { JunctionTraffic, SegmentTraffic } from './inspect';
import type { BodyPart, Severable } from './people/view';
import type { VehicleId } from './vehicles/state';

/** WHAT THE PAGE AND THE SIMULATION'S WORKER SAY TO EACH OTHER (`sim.worker.ts`, `simWorkerHost.ts`) */

/** What the page does to the simulation without waiting for an answer. */
export type SimAct =
  | { readonly kind: 'removeVehicle'; readonly id: VehicleId }
  | { readonly kind: 'strand'; readonly id: VehicleId }
  | { readonly kind: 'getUp'; readonly id: number; readonly x: number; readonly y: number; readonly heading: number; readonly seconds: number; readonly crawl: boolean }
  | { readonly kind: 'run'; readonly seconds: number }
  | { readonly kind: 'step'; readonly traffic: boolean; readonly pedestrians: boolean };

/** What the page asks the simulation, and the answer each brings back. */
export type SimAsk =
  | { readonly kind: 'segment'; readonly id: SegmentId }
  | { readonly kind: 'junction'; readonly id: NodeId }
  | { readonly kind: 'greenWave'; readonly node: NodeId }
  | { readonly kind: 'shoot'; readonly id: number; readonly part: BodyPart; readonly fromX: number; readonly fromY: number }
  | { readonly kind: 'impact'; readonly x: number; readonly y: number; readonly kill: number; readonly scare: number };
export interface SimAnswers {
  readonly segment: SegmentTraffic | null;
  readonly junction: JunctionTraffic | null;
  readonly greenWave: ReadonlyMap<NodeId, SignalSettings>;
  readonly shoot: { readonly killed: boolean; readonly severed: Severable | null } | null;
  readonly impact: number;
}

export type ToSim =
  | {
    readonly kind: 'init';
    readonly seed: number;
    readonly settings: SimSettings;
    readonly ambientSource: 'view' | 'edges';
    /** The prefix the conflict zones are kept under between sessions (`ConflictPool`). */
    readonly zonesPrefix: string | null;
  }
  /** The conflict zones kept from earlier sessions (`ConflictIndex.seed`). */
  | { readonly kind: 'zones'; readonly zones: ReadonlyMap<string, Float64Array | null> }
  | {
    readonly kind: 'frame';
    readonly seq: number;
    readonly advance: SimAdvance;
    /** The document's changes since the last frame (`ReplicaFeed`). */
    readonly patch: ReplicaPatch | null;
    readonly settings: Partial<SimSettings> | null;
    /** A different map: the old simulation let go before the patch is taken in. */
    readonly reset: boolean;
    readonly acts: readonly SimAct[];
  }
  | { readonly kind: 'ask'; readonly id: number; readonly ask: SimAsk };

export type FromSim =
  | {
    readonly kind: 'frame';
    readonly seq: number;
    readonly frame: SimFrame;
    readonly alpha: number;
    readonly time: number;
    readonly minutes: number;
    readonly hold: boolean;
    readonly health: { readonly stepMs: number; readonly share: number };
    /** The simulation's checks since the last frame; `issuesWhole`: the list started over. */
    readonly issues: readonly AuditIssue[];
    readonly issuesWhole: boolean;
    /** The conflict zones measured since the last frame, to keep for the next session; null with none. */
    readonly measured: ReadonlyMap<string, Float64Array | null> | null;
  }
  | { readonly kind: 'answer'; readonly id: number; readonly value: unknown };
