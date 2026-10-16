import { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import { type FinishedPair, type SampledSweep, type SweepSamples, TABLE_SIZE, finishPair, pairTable, sampleSweep } from '@world/conflictTable';
import type { ChosenTurn } from '@world/junctionTurns';
import type { JunctionSurface } from '@world/turnPaths';
import { chooseTurnOf } from '@world/turnChoice';
import { type CornerAsk, roundCorners } from '@world/walkingLines';
import { type JunctionAnswer, type JunctionAsk, buildJunctionOf } from '@world/junctionBuild';
import { keepDerivedMany } from './render/derivedCache';

/** The traffic's pure work off the page's thread (`conflictPool.ts`), answered with the job's id: - conflict pairs */
interface PairsAsk {
  readonly kind: 'pairs';
  readonly id: number;
  readonly sweeps: readonly { readonly c0: number; readonly count: number; readonly length: number; readonly frame: Float64Array; readonly frameLengthSq: Float64Array }[];
  /** Two indices into `sweeps` a pair. */
  readonly pairs: Int32Array;
  /** The pairs' keys, and the prefix their tables are kept under for the next session (`derivedCache.ts`); none: not kept here. */
  readonly keep: { readonly prefix: string; readonly keys: readonly string[] } | null;
}
interface TurnsAsk {
  readonly kind: 'turns';
  readonly id: number;
  readonly surfaces: readonly { readonly key: string; readonly centre: { readonly x: number; readonly y: number }; readonly rings: readonly Float64Array[] }[];
  readonly turns: readonly {
    readonly surface: number; readonly inXY: Float64Array; readonly outXY: Float64Array; readonly waiting: readonly Float64Array[];
    readonly fromRoadEnd: boolean; readonly toRoadEnd: boolean;
  }[];
}

interface SweepsAsk {
  readonly kind: 'sweeps';
  readonly id: number;
  /** Every lane the share's sweeps read, once (`Polyline.xy`). */
  readonly lines: readonly Float64Array[];
  /** Three indices into `lines` a sweep: approach, movement, exit. */
  readonly refs: Int32Array;
  readonly c0: Float64Array;
  readonly count: Int32Array;
}

interface FinishAsk {
  readonly kind: 'finish';
  readonly id: number;
  /** Every centreline the share's pairs read, once (`Polyline.xy`). */
  readonly lines: readonly Float64Array[];
  /** Two indices into `lines` a pair. */
  readonly refs: Int32Array;
  /** The pairs' tables one after another, `TABLE_SIZE` numbers each. */
  readonly tables: Float64Array;
}

interface JunctionsAsk {
  readonly kind: 'junctions';
  readonly id: number;
  readonly asks: readonly JunctionAsk[];
}

interface CornersAsk {
  readonly kind: 'corners';
  readonly id: number;
  readonly asks: readonly CornerAsk[];
}

/** Most time between two words to the page while working: the pool's watchdog hears the worker is alive (`SILENCE_MS`). */
const BEAT_MS = 500;

self.onmessage = async (event: MessageEvent<PairsAsk | TurnsAsk | SweepsAsk | FinishAsk | CornersAsk | JunctionsAsk>) => {
  const ask = event.data;
  let spoke = performance.now();
  const beat = (): void => {
    const now = performance.now();
    if (now - spoke >= BEAT_MS) { spoke = now; self.postMessage({ id: ask.id, beat: true }); }
  };
  try {
    if (ask.kind === 'turns') {
      const made = new Map<string, JunctionSurface>();
      const turns: ChosenTurn[] = [];
      for (const t of ask.turns) {
        const s = ask.surfaces[t.surface]!;
        turns.push(chooseTurnOf({ ...t, surfaceKey: s.key }, s, made));
        beat();
      }
      self.postMessage({ id: ask.id, turns });
      return;
    }
    if (ask.kind === 'junctions') {
      const lines = new Map<Float64Array, Polyline>(), rings = new Map<Float64Array, Vec2[]>();
      const junctions: JunctionAnswer[] = [];
      const transfer = new Set<ArrayBuffer>();
      for (const junction of ask.asks) {
        const built = buildJunctionOf(junction, lines, rings);
        for (const c of built.connectors) transfer.add(c.path.buffer as ArrayBuffer);
        junctions.push(built);
        beat();
      }
      (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id: ask.id, junctions }, [...transfer]);
      return;
    }
    if (ask.kind === 'corners') {
      const corners: (Float64Array | null)[][] = [];
      const transfer: ArrayBuffer[] = [];
      for (const node of ask.asks) {
        const lines = roundCorners(node);
        for (const line of lines) if (line) transfer.push(line.buffer as ArrayBuffer);
        corners.push(lines);
        beat();
      }
      (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id: ask.id, corners }, transfer);
      return;
    }
    if (ask.kind === 'finish') {
      // The points as the page reads them (`Polyline.toPoints`), each centreline's once.
      const points = ask.lines.map((xy) => Polyline.fromFlat(xy).toPoints() as readonly Vec2[]);
      const finished: FinishedPair[] = [];
      for (let k = 0; k < ask.refs.length; k += 2) {
        const q = k / 2;
        finished.push(finishPair(points[ask.refs[k]!]!, points[ask.refs[k + 1]!]!, ask.tables.subarray(q * TABLE_SIZE, (q + 1) * TABLE_SIZE)));
        beat();
      }
      self.postMessage({ id: ask.id, finished });
      return;
    }
    if (ask.kind === 'sweeps') {
      const made = new Map<Float64Array, { line: Polyline; digest: number }>();
      const sweeps: SampledSweep[] = [];
      const transfer: ArrayBuffer[] = [];
      for (let q = 0; q < ask.c0.length; q++) {
        const sweep = sampleSweep({
          inXY: ask.lines[ask.refs[q * 3]!]!, crossXY: ask.lines[ask.refs[q * 3 + 1]!]!, outXY: ask.lines[ask.refs[q * 3 + 2]!]!,
          c0: ask.c0[q]!, count: ask.count[q]!,
        }, made);
        sweeps.push(sweep);
        transfer.push(sweep.frame.buffer as ArrayBuffer, sweep.frameLengthSq.buffer as ArrayBuffer);
        beat();
      }
      (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id: ask.id, sweeps }, transfer);
      return;
    }
    // The caches `pairTable` keeps on a sweep start empty here, as on the page.
    const samples: SweepSamples[] = ask.sweeps.map((s) => ({ ...s, bounds: null, boxes: null, range: null }));
    const tables: (Float64Array | null)[] = [];
    const transfer: ArrayBuffer[] = [];
    for (let k = 0; k < ask.pairs.length; k += 2) {
      const table = pairTable(samples[ask.pairs[k]!]!, samples[ask.pairs[k + 1]!]!);
      tables.push(table);
      if (table) transfer.push(table.buffer as ArrayBuffer);
      beat();
    }
    // Kept for the next session here, off the page: the store copies them before they are handed over.
    if (ask.keep) await keepDerivedMany(ask.keep.prefix, new Map(tables.map((table, k) => [ask.keep!.keys[k]!, table])));
    (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id: ask.id, tables }, transfer);
  } catch (error) {
    // Reported here and answered: the page does this work itself (`ConflictIndex.prepare`, `LaneletGraph.redoProvisional`).
    console.error(`[traffic] ${ask.kind} failed in their worker`, error);
    self.postMessage({ id: ask.id, error: String(error) });
  }
};
