import type { GrowthStamp } from '@editor/zoning';
import type { HeightTile } from '@render/heightTile';
import type { Building } from '@world/buildings/types';
import type { Lot } from '@world/lots';
import type { ReplicaPatch } from '@world/replica';

/** WHAT THE PAGE AND THE GROWTH'S WORKER SAY TO EACH OTHER (`growthHost.ts`, `growth.worker.ts`) */

/** A batch of growth asked: the document's changes taken in first, then buildings grown until `most`, `budgetMs` or no open lot. */
export interface GrowAsk {
  readonly kind: 'grow';
  readonly seq: number;
  readonly patch: ReplicaPatch | null;
  /** The id the page's store hands out next: the copy's own is set to it (a batch not taken left it further on). */
  readonly nextId: number;
  /** The lots set aside, whole, when the page's set is not the copy's; null: the copy's, with what it set aside itself. */
  readonly refused: readonly number[] | null;
  readonly seed: number;
  readonly stamp: GrowthStamp;
  readonly most: number;
  readonly budgetMs: number;
}

/** The heights a batch asked for: the squares (`heightTileKey`) and the points, each reading in the order asked. */
export interface HeightsAnswer {
  readonly kind: 'heights';
  readonly seq: number;
  readonly tiles: readonly (readonly [number, HeightTile])[];
  readonly points: Float64Array;
}

export type ToGrowth = GrowAsk | HeightsAnswer;

/** Readings a point is asked for: the ground as drawn (`terrainHeightAt`), the paving (`pavedHeightAt`). */
export const GROUND_READ = 0;
export const PAVED_READ = 1;

/** What a batch needs before it goes on: the squares not handed over yet, and points none of them can say (kind, x, y threes). */
export interface HeightsNeed {
  readonly kind: 'need';
  readonly seq: number;
  readonly tiles: readonly number[];
  readonly points: Float64Array;
}

/** A batch grown, in the order grown: each building as stored, its lot naming it, the lots set aside; `done`: no open lot is left. */
export interface GrownBatch {
  readonly kind: 'grown';
  readonly seq: number;
  readonly buildings: readonly Building[];
  readonly lots: readonly Lot[];
  readonly refused: readonly number[];
  readonly done: boolean;
  /** Milliseconds the worker spent on it, waiting for heights included. */
  readonly ms: number;
}

export type FromGrowth = HeightsNeed | GrownBatch | { readonly kind: 'failed'; readonly seq: number; readonly error: string };
