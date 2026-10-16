import type { BodyPart, Severable } from './view';
import type { SimWorld } from '../world';
import type { PartyView, PersonAgeClass, PersonGender } from './view';

/** The people blows have struck, for the renderer (`render/ragdoll.ts`) */

/** Somebody a blow killed or knocked down: who they were (for their body) and the blast that threw them. */
export interface Casualty {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  /** Killed, killed and torn apart, or knocked down (gets up again). */
  readonly kind: 'dead' | 'torn' | 'knocked';
  /** Seconds since. */
  t: number;
  readonly id: number;
  readonly gender: PersonGender;
  readonly ageClass: PersonAgeClass;
  readonly party: PartyView;
  readonly blastX: number;
  readonly blastY: number;
  /** 0 at the edge of the reach, 1 at the blow's centre. */
  readonly power: number;
  /** Limbs (or the head) already lost when they fell: the body on the ground lacks them too. */
  readonly lost?: readonly Severable[];
  /** Knocked down for this long before getting up (seconds); a leg lost keeps them down for good. */
  readonly lieFor?: number;
  /** Down for good but alive: writhing where they lie, bleeding (`render/ragdoll.ts` writhe). */
  readonly crawl?: boolean;
  /** Bled to death where they lay: the body already down goes still, not thrown again. */
  readonly faded?: boolean;
  /** Limbs (or the head) that came off at this blow: thrown off the body, each a piece of its own. */
  readonly severed?: readonly Severable[];
  /** Burnt black (right under a bomb). */
  readonly charred?: boolean;
  /** Shot, and where: a bullet's small push there, the body falling with its muscles still working (`ragdoll.ts` tone). */
  readonly struck?: BodyPart;
  /** Shot open at the belly (a grave trunk wound, two or three rounds in it): the guts out (`ragdoll.ts` openBelly). */
  readonly opened?: boolean;
}

const RECORDS = new WeakMap<SimWorld, Casualty[]>();
const WOUNDS = new WeakMap<SimWorld, { id: number; part: BodyPart; fromX: number; fromY: number }[]>();

/** A bullet wound on somebody (alive or not): their clothes holed and bloodied by the renderer. */
export function recordWound(w: SimWorld, id: number, part: BodyPart, fromX: number, fromY: number): void {
  let list = WOUNDS.get(w);
  if (!list) WOUNDS.set(w, (list = []));
  if (list.length < 256) list.push({ id, part, fromX, fromY });
}

/** The wounds recorded since the last call (`recordWound`), taken. */
export function takeWounds(w: SimWorld): { id: number; part: BodyPart; fromX: number; fromY: number }[] {
  const list = WOUNDS.get(w);
  if (!list?.length) return [];
  const out = list.slice();
  list.length = 0;
  return out;
}

/** Records somebody struck by a blow. */
export function recordCasualty(w: SimWorld, c: Casualty): void {
  let list = RECORDS.get(w);
  if (!list) RECORDS.set(w, (list = []));
  list.push(c);
}

/** The casualties recorded since the last call (`recordCasualty`), taken: the page keeps them (`CasualtyBook`). */
export function takeCasualties(w: SimWorld): Casualty[] {
  const list = RECORDS.get(w);
  if (!list?.length) return [];
  const out = list.slice();
  list.length = 0;
  return out;
}

/** The casualties of blows on the map as the page draws them: each one's clock run on, a minute's worth kept. */
export class CasualtyBook {
  private list: Casualty[] = [];

  add(taken: readonly Casualty[]): void {
    for (const c of taken) this.list.push(c);
  }

  /** The book, each clock advanced by `dt`. */
  advance(dt = 0): readonly Casualty[] {
    for (const c of this.list) c.t += dt;
    if (this.list.length && this.list[0]!.t > 60) this.list = this.list.filter((c) => c.t <= 60);
    return this.list;
  }

  clear(): void {
    this.list = [];
  }
}
