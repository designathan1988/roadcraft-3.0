import type { Budget } from '@core/perfBudget';

/** The specs' counts: exact, the same on every run (`tests/perf`). */
export const COUNT_BUDGETS = {
  /** Rings measured per corner of the ground graded to the default town's 761 buildings (7.59): the nearest-ring pruning (`pads.ts`). */
  padRingsPerCorner: { max: 9.5, level: 'error', why: 'the platforms pruning (7.59; without it ~tens)' },
  /** Kerb edges walked per `kerbward` ask over the default town (208.6): its pruning (`poleLines.ts`). */
  kerbEdgesPerAsk: { max: 260, level: 'error', why: 'the kerb pruning (208.6; without it the whole city)' },
  /** Cells of the default town's crossing surface (21 297). */
  townWalkableCells: { max: 30_000, level: 'error', why: 'crossing grids of the default town (21 297)' },
  /** Triangles of the road surfaces of `tests/fixtures/grid-and-bends.json` (133 500 since the Delaunay flips, `tileShapeFlip.spec.ts`: same border and vertices, fewer needles to split): neither bloated nor stripped of detail. */
  fixtureRoadTriangles: { min: 110_000, max: 160_000, level: 'error', why: 'road surfaces of the fixed scene (133 500)' },
  /** Meshes (draw calls) of the same surfaces (134). */
  fixtureRoadMeshes: { max: 160, level: 'error', why: 'surface meshes of the fixed scene (134)' },
} as const satisfies Readonly<Record<string, Budget>>;

/** Whether a value keeps its budget. */
export function withinBudget(value: number, budget: Budget): boolean {
  return value <= budget.max && (budget.min === undefined || value >= budget.min);
}
