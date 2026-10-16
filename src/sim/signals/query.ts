import type { CrossingId, GroupId } from './plan';
import type { SignalController } from './fsm';
import { PED } from '../params';

export type SignalState = 'green' | 'amber' | 'red';
export type WalkState = 'walk' | 'flash' | 'dont';

/** What `signalStateFor` reads of a signal: the simulation's controller, or the page's (`sim/mirror.ts` `ShownController`). */
export interface SignalStage {
  readonly plan: { readonly stages: readonly { readonly greenGroups: readonly GroupId[] }[] };
  readonly stageIndex: number;
  readonly sub: string;
}

/** Signal state for one approach group. */
export function signalStateFor(c: SignalStage, group: GroupId): SignalState {
  const st = c.plan.stages[c.stageIndex];
  if (!st) return 'red';
  if (!st.greenGroups.includes(group)) return 'red';
  if (c.sub === 'GREEN') return 'green';
  if (c.sub === 'AMBER') return 'amber';
  return 'red';
}

/** True when at least one group at this junction currently has green. */
export function anyGreen(c: SignalController): boolean {
  return c.sub === 'GREEN' && (c.plan.stages[c.stageIndex]?.greenGroups.length ?? 0) > 0;
}

/** Seconds for which the crossing stays protected from the traffic that would otherwise use its leg. */
function remainingProtectedTime(c: SignalController, crossing: CrossingId): number {
  const st = c.plan.stages[c.stageIndex];
  if (!st || !st.pedWalk.includes(crossing)) return 0;
  const clearance = st.amber + st.allRed;
  switch (c.sub) {
    case 'GREEN':
      // A green is never cut while somebody it released is still crossing
      return Math.max(0, Math.max(st.targetGreen, st.maxGreen) - c.elapsed) + clearance;
    case 'AMBER':
      return Math.max(0, st.amber - c.elapsed) + st.allRed;
    case 'ALL_RED':
      return Math.max(0, st.allRed - c.elapsed);
  }
}

/** Walk indicator for one crossing. */
export function pedestrianSignalState(
  c: SignalController,
  crossing: CrossingId,
  crossingLength: number,
): WalkState {
  const st = c.plan.stages[c.stageIndex];
  if (!st || !st.pedWalk.includes(crossing)) return 'dont';
  const need = crossingLength / PED.designSpeed + PED.startLag;
  if (remainingProtectedTime(c, crossing) < need) return 'flash';
  return c.sub === 'GREEN' ? 'walk' : 'flash';
}
