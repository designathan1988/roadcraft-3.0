import { Rng } from '@core/rng';
import type { Vec2 } from '@core/vec2';
import { type Signature, bodySignature, madeToMeasure, signatureDistance } from '@world/buildings/procedural';
import type { Era } from '@world/buildings/architecture';
import { METERS_PER_UNIT } from '@world/units';
import { driveSide as driveSideOf, furnishLot, garageRamp, lotKind, planLot, yardRamp } from './lotPlan';
import { MAX_ELEMENTS, type Building, type BuildingElement, type Volume } from '@world/buildings/types';
import { type SiteContext, validateBuilding } from '@world/buildings/validate';
import type { RoadDoc } from '@world/doc';
import { m, stepsIn } from '@world/units';
import type { ZoneDensity } from '@world/zones';
import { lotBuildFrame, lotCentre, type Lot } from '@world/lots';
import { MIN_SIZE, buildingBounds, footprintRects, storedBounds } from '@world/buildings/geometry';
import { intersection } from '@core/clipper';
import { pointInPolygon } from '@core/polygon';
import { Level, halfWidth } from '@world/roadTypes';
import { rectAround } from '@world/changes';
import { groundElements } from '@world/buildings/elements';
import { AREA_EPS, overlapArea, validOutline } from '@world/buildings/footprints';
import { THRESHOLD } from '@world/buildings/foundation';
import { garageUnder, stepToSlope } from '@world/buildings/splitLevel';

const BOUNDARY_PARTS = new Set(['wall', 'fence', 'hedge', 'railing']);

/** A grown building as it may stand (its id the next the store hands out), its boundary meeting the neighbours'; null when it may not */
function fitPlaced(ctx: SiteContext, record: Omit<Building, 'id'>): Building | null {
  const first = { ...record, id: ctx.doc.buildings.nextId } as Building;
  const problem = validateBuilding(ctx, first);
  if (!problem) return first;
  if (problem !== 'building') return null;
  const probe = { ...record, id: -1 } as unknown as Building;
  const box = buildingBounds(probe, m(2));
  const theirs: Vec2[][] = [];
  // The buildings by place (`BuildingStore.near`), not the town; the same box test.
  for (const o of ctx.doc.buildings.near(box.minX, box.minY, box.maxX, box.maxY)) {
    const ob = storedBounds(o);
    if (ob.minX > box.maxX || ob.maxX < box.minX || ob.minY > box.maxY || ob.maxY < box.minY) continue;
    theirs.push(...footprintRects(o), ...groundElements(o));
  }
  const elements = (record.elements ?? []).filter((e) => {
    if (!BOUNDARY_PARTS.has(e.kind)) return true;
    const ring = groundElements({ ...probe, elements: [e] }, -m(0.05))[0];
    return !ring || !theirs.some((c) => overlapArea(ring, c) > AREA_EPS);
  });
  if (elements.length === (record.elements ?? []).length) return null;
  const second = { ...record, elements, id: ctx.doc.buildings.nextId } as Building;
  return validateBuilding(ctx, second) ? null : second;
}

/** The joint left between two neighbouring lots: a hair, so their party walls meet without overlapping. */
const JOINT = 0;
/** A lot's side in metres, to the millimetre, for the plans made in metres (`planLot`, `madeToMeasure`, `furnishLot`) */
const metresOf = (units: number): number => Math.round(units * METERS_PER_UNIT * 1000) / 1000;

/** The version of the lot generator */
export const LOT_PLAN_VERSION = 13;

/** The ground floor a grown building on a lot will have */
function streetFloor(ctx: SiteContext, local: (lx: number, ly: number) => Vec2, width: number, ground: (x: number, y: number) => number, front = 0): number {
  let best = -Infinity;
  if (ctx.pavedAt) {
    for (const k of [-0.3, 0, 0.3]) {
      const p = local(width * k, -front - m(0.6));
      const h = ctx.pavedAt(p.x, p.y);
      if (Number.isFinite(h)) best = Math.max(best, h);
    }
  }
  if (Number.isFinite(best)) return best + THRESHOLD;
  const p = local(0, m(0.5));
  return ground(p.x, p.y) + m(0.6);
}

/** Grows one building on a zoned lot without one (`world/lots.ts`): the lot is planned first - front, sides, back */
/** Candidates made for a lot, the least like its neighbours kept (Mitchell's best candidate). */
const CANDIDATES = 4;
/** How far round a lot the buildings it should not look like are read: the 100 m of the rule it answers (`tests/world/variety.spec.ts`; at 90 m a twin 95 m off went unseen). */
const LIKE_REACH = m(100);
/** How far beyond a footway's edge a point still counts as on the street, for a corner lot (`cornerOf`). */
const STREET_MARGIN = m(0.6);
/** How near the last building grown an open lot must be to grow next (the street filling along). */
const GROW_ON_REACH = m(70);

/** Each record's signature, worked out once (a record is replaced when its building changes). */
const SIGNATURES = new WeakMap<Building, Signature>();
const signatureOfRecord = (b: Building): Signature => {
  let s = SIGNATURES.get(b);
  if (!s) SIGNATURES.set(b, s = bodySignature(b));
  return s;
};

/** How far `a` is from `b`. */
function apart(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The buildings round a point: each one's signature and how far it stands. */
function nearSignatures(doc: RoadDoc, at: Vec2): { signature: Signature; distance: number }[] {
  const out: { signature: Signature; distance: number }[] = [];
  for (const b of doc.buildings.near(at.x - LIKE_REACH, at.y - LIKE_REACH, at.x + LIKE_REACH, at.y + LIKE_REACH)) {
    const d = apart(b, at);
    if (d < LIKE_REACH) out.push({ signature: signatureOfRecord(b), distance: d });
  }
  return out;
}

/** How unlike its surroundings a building would be */
function unlikeness(body: Building | Omit<Building, 'id' | 'x' | 'y' | 'rotation'>, near: readonly { signature: Signature; distance: number }[]): number {
  const mine = bodySignature(body);
  let least = Infinity;
  for (const n of near) least = Math.min(least, signatureDistance(mine, n.signature) + 2.5 * (n.distance / LIKE_REACH));
  return least;
}

/** Storeys of the buildings beside a lot's front (within its width and a little), tallest block each. */
function neighbourStoreys(doc: RoadDoc, anchor: Vec2, width: number): number[] {
  const out: number[] = [];
  const reach = width + m(12);
  for (const b of doc.buildings.near(anchor.x - reach, anchor.y - reach, anchor.x + reach, anchor.y + reach)) {
    if (apart(b, anchor) > reach) continue;
    const top = Math.max(0, ...b.volumes.filter((v) => !v.open).map((v) => v.base + v.storeys.length));
    if (top > 0) out.push(top);
  }
  return out;
}

/** The side of a lot (`left`: along -u from the front's middle) with a street just beyond it over most of its depth */
function cornerOf(ctx: SiteContext, anchor: Vec2, u: Vec2, n: Vec2, width: number, depth: number): 'left' | 'right' | undefined {
  const net = ctx.net;
  if (!net) return undefined;
  // The ribbons filed round the point (`Network.ribbonsMeeting`)
  const onStreet = (p: Vec2): boolean => net.ribbonsMeeting([p.x - STREET_MARGIN, p.y - STREET_MARGIN, p.x + STREET_MARGIN, p.y + STREET_MARGIN]).some((r) => {
    if (ctx.doc.segment(r.id)?.structure !== 'ground') return false;
    const bb = r.full.bbox, reach = halfWidth(r.road, Level.Sidewalk) + STREET_MARGIN;
    if (p.x < bb.minX - reach || p.x > bb.maxX + reach || p.y < bb.minY - reach || p.y > bb.maxY + reach) return false;
    return r.full.distanceTo(p) < reach;
  });
  for (const [side, sign] of [['left', -1], ['right', 1]] as const) {
    const along = sign * (width / 2 + m(2));
    const hits = [0.35, 0.65].filter((k) => onStreet({ x: anchor.x + u.x * along + n.x * depth * k, y: anchor.y + u.y * along + n.y * depth * k })).length;
    if (hits === 2) return side;
  }
  return undefined;
}

/** The street side and the quarter a lot belongs to, for its building's style (`world/buildings/architecture.ts`) */
function quarterOf(anchor: Vec2, n: Vec2): { character: number; era: Era } {
  const hash = (a: number, b: number, c: number): number => {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x3c6ef372);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return (h ^ (h >>> 13)) >>> 0;
  };
  const facing = Math.round(Math.atan2(n.y, n.x) / (Math.PI / 2));
  const cx = anchor.x, cy = anchor.y;
  const central = Math.hypot(anchor.x, anchor.y) < m(450);
  const character = hash(Math.floor(stepsIn(cx, 60)), Math.floor(stepsIn(cy, 60)), facing + 11);
  const q = hash(Math.floor(stepsIn(cx, 220)), Math.floor(stepsIn(cy, 220)), 5) / 4_294_967_296;
  const era: Era = central ? (q < 0.5 ? 0 : q < 0.8 ? 1 : 2) : (q < 0.15 ? 0 : q < 0.5 ? 1 : 2);
  return { character, era };
}

/** What a lot grows (`planOnLot`): the building that fits it, its id the next the store hands out; null, nothing fits (the lot set aside). */
export interface LotGrowth {
  readonly lot: Lot;
  readonly building: Building | null;
}

/** What the growth stamps on a building it stores: when it was built, its wear, the lot generator's version. */
export interface GrowthStamp {
  readonly builtAt: number;
  readonly decay: number;
  readonly lotPlan: number;
}

/** @perItem Grows one building on a zoned lot without one (`growOnLot`): the plan and its store at once; the building's id, or null. */
export function growOnLot(ctx: SiteContext, refused: Set<number>, seed: number): number | null {
  const growth = planOnLot(ctx, refused, seed);
  return growth ? commitGrowth(ctx, growth, refused)?.id ?? null : null;
}

/** A lot's growth carried out (`planOnLot`): its building stored (the stamp laid over it), its lot naming it; or the lot set aside. */
export function commitGrowth(ctx: SiteContext, growth: LotGrowth, refused: Set<number>, stamp?: GrowthStamp): Building | null {
  const open = ctx.doc.openLots;
  if (!growth.building) {
    open.refuse(growth.lot, refused);
    return null;
  }
  if (growth.building.id !== ctx.doc.buildings.nextId) throw new Error(`a growth planned for building ${growth.building.id} stored as ${ctx.doc.buildings.nextId}`);
  const stored = ctx.doc.buildings.add(stamp ? { ...growth.building, ...stamp } : growth.building);
  const where = rectAround(growth.lot.corners);
  open.grew(growth.lot, stored.id as number, where ? [where] : null, 'building grew on the lot');
  return stored;
}

/** @perItem The growth of the next open lot worked out, nothing written (`commitGrowth` writes it): nothing it reaches may walk the map. */
export function planOnLot(ctx: SiteContext, refused: Set<number>, seed: number): LotGrowth | null {
  const { doc } = ctx;
  // The open lots kept by the document (`world/openLots.ts`)
  const open = doc.openLots;
  const count = open.count(refused);
  if (!count) return null;
  const rng = new Rng((seed ^ Math.imul(doc.buildings.nextId, 0x9e3779b1)) >>> 0);
  // The street fills along: the open lot nearest the last building grown, when one is near
  let lot = open.at(rng.int(0, count - 1));
  const last = open.lastGrown();
  if (last) {
    let best = GROW_ON_REACH;
    // Nearer by a millimetre at least: two lots as near
    for (const l of open.near(last, GROW_ON_REACH)) {
      const d = apart(lotCentre(l), last);
      if (d < best - m(0.001)) { best = d; lot = l; }
    }
  }
  const use = lot.use!;
  const frame = lotBuildFrame(lot);
  // Every zoned lot gets a building, whatever its size or shape (the player, 2026-10-05: "it always has to appear").
  const u = { x: Math.cos(frame.rotation), y: Math.sin(frame.rotation) }, n = { x: -u.y, y: u.x };
  // A corner lot: a street along one of its sides too (the building then looks onto it, `planLot`).
  const corner = cornerOf(ctx, frame.anchor, u, n, frame.width, frame.depth);
  const densities: ZoneDensity[] = lot.density === 'high' ? ['high', 'medium', 'low'] : lot.density === 'medium' ? ['medium', 'low'] : ['low'];
  // A handful of tries, each a building made: a few milliseconds apiece.
  const tries = [
    { front: 0, side: 0, shrink: 1 }, { front: m(1.5), side: 0, shrink: 1 }, { front: m(3), side: m(1), shrink: 0.9 },
    { front: m(3), side: m(1), shrink: 0.75 }, { front: m(4), side: m(1.5), shrink: 0.6 }, { front: m(4), side: m(1.5), shrink: 0.45 },
  ];
  // Read once, not a try: a try writes to the document only when it succeeds, and then returns
  const neighbours = neighbourStoreys(doc, frame.anchor, frame.width);
  const near = nearSignatures(doc, frame.anchor);
  for (const density of densities) for (const t of tries) {
    const lotW = (frame.width - JOINT - 2 * t.side) * t.shrink;
    const lotD = (frame.depth - m(0.3) - t.front) * t.shrink;
    const W = metresOf(lotW), D = metresOf(lotD);
    if (W < 4 || D < 4) continue;
    const plan = planLot(lotKind(use, density), W, D, rng, corner);
    const env = plan.building;
    const driveSide = plan.left.use === 'drive' || plan.left.use === 'drivePath' ? 'left' as const
      : plan.right.use === 'drive' || plan.right.use === 'drivePath' ? 'right' as const : undefined;
    const envelope = {
      W: env.x1 - env.x0, D: env.y1 - env.y0,
      backDoor: plan.back.use !== 'none' && plan.back.use !== 'loading',
      ...quarterOf(frame.anchor, n),
      ...(driveSide ? { driveSide } : {}),
      neighbours: [...neighbours],
    };
    // Of a few candidates, the one least like the buildings round it
    let made = madeToMeasure(use, density, envelope, rng);
    if (near.length) {
      let score = unlikeness(made.body, near);
      for (let k = 1; k < CANDIDATES; k++) {
        const other = madeToMeasure(use, density, envelope, rng);
        const s = unlikeness(other.body, near);
        if (s > score) { score = s; made = other; }
      }
    }
    const body = made.body;
    const dx = m(env.x0 - W / 2), dy = m(env.y0);
    for (const v of body.volumes) { v.x += dx; v.y += dy; }
    for (const e of body.elements ?? []) { e.x += dx; e.y += dy; }
    for (const c of body.cores ?? []) { c.x += dx; c.y += dy; }
    for (const v of body.volumes) {
      if (v.outline) continue;
      const x0 = Math.max(v.x, -lotW / 2), x1 = Math.min(v.x + v.w, lotW / 2);
      if (x1 - x0 > m(1)) { v.x = x0; v.w = x1 - x0; }
    }
    // The lot's front middle, set back by the try's front margin.
    const anchor = { x: frame.anchor.x + n.x * t.front, y: frame.anchor.y + n.y * t.front };
    // How the land falls or rises from the street to the middle of the back yard, metres: a yard on a hillside is terraced
    const ground = ctx.groundAt;
    const yardY = m(D - plan.back.depth / 2);
    const local = (lx: number, ly: number): Vec2 => ({ x: anchor.x + u.x * lx + n.x * ly, y: anchor.y + u.y * lx + n.y * ly });
    // The building follows its hillside (`splitLevel.ts`)
    let split: { y: number; lift: number } | undefined;
    let garage: { x: number; y: number; w: number } | undefined;
    let landAt: ((x: number, y: number) => number) | undefined;
    const yardBack = plan.back.use === 'parking' || plan.back.use === 'loading';
    const ramp = yardBack ? yardRamp(plan) : null;
    if (ground && (!yardBack || ramp)) {
      const floor = streetFloor(ctx, local, lotW, ground, t.front);
      // The natural ground about the street floor at a point of the lot (metres, the lot's frame).
      landAt = (x, y) => { const p = local(m(x - W / 2), m(y)); return (ground(p.x, p.y) - floor) * METERS_PER_UNIT; };
      const step = stepToSlope(body, {
        groundAt: (lx, ly) => { const p = local(lx, ly); return ground(p.x, p.y); },
        floor, x0: m(env.x0 - W / 2), x1: m(env.x1 - W / 2),
        ...(ramp ? { yard: { x0: m(-W / 2), y0: m(ramp.end), x1: m(W / 2), y1: m(D) }, maxLift: m(ramp.grade * (ramp.end - ramp.start)) } : {}),
      });
      if (step) split = { y: step.y / m(1), lift: step.lift / m(1) };
      // A house a whole storey down its hillside, with a drive: its garage in the lower ground floor, on the drive's side
      const way = step && step.steps === -2 ? garageRamp(plan) : null;
      const side = driveSideOf(plan);
      const hasGarage = body.volumes.some((v) => v.storeys.some((s) => Object.values(s.facade.bays ?? {}).includes('garageDoor') || s.facade.fill === 'garageDoor'));
      if (step && way && side && !hasGarage && plan.back.depth >= 7 && -step.lift <= m(way.grade * (way.end - way.start))) {
        const door = garageUnder(body, side);
        if (door) garage = { x: door.x / m(1) + W / 2, y: door.y / m(1), w: door.w / m(1) };
      }
    }
    // How the land falls across the back zone, from its front to the lot's back (a car park keeps a little of it).
    const backFall = ground && plan.back.depth > 0
      ? (ground(local(0, m(D - 0.5)).x, local(0, m(D - 0.5)).y) - ground(local(0, m(D - plan.back.depth)).x, local(0, m(D - plan.back.depth)).y)) * METERS_PER_UNIT
      : undefined;
    const hill = ground && plan.back.depth > 0
      ? { yard: (ground(anchor.x + n.x * yardY, anchor.y + n.y * yardY) - ground(anchor.x + n.x * m(0.5), anchor.y + n.y * m(0.5))) * METERS_PER_UNIT, ...(split ? { split } : {}), ...(backFall !== undefined ? { backFall } : {}), ...(garage ? { garage } : {}), ...(landAt ? { landAt } : {}) }
      : split ? { yard: split.lift, split } : undefined;
    if (!furnishLot(body, plan, made, rng, hill)) continue;
    // The lot in the building's frame: x along the front, y back into it.
    const ring = lot.corners.map((c) => ({ x: (c.x - anchor.x) * u.x + (c.y - anchor.y) * u.y, y: (c.x - anchor.x) * n.x + (c.y - anchor.y) * n.y }));
    // Set back from the street (a try's margin), its front still reaches the street (`reachStreet`)
    const bare = t.front > 0 ? structuredClone({ volumes: body.volumes, elements: body.elements }) : null;
    if (bare) reachStreet(body, t.front, lotW);
    fitToLot(body, ring);
    const placed = (): Omit<Building, 'id'> => ({ ...body, x: anchor.x, y: anchor.y, rotation: frame.rotation }) as Omit<Building, 'id'>;
    let building = fitPlaced(ctx, placed());
    if (!building && bare) {
      // Refused with it (over a curved footway, a neighbour's yard): the plan alone, as before.
      body.volumes = bare.volumes;
      if (bare.elements) body.elements = bare.elements;
      else delete body.elements;
      fitToLot(body, ring);
      building = fitPlaced(ctx, placed());
    }
    if (building) return { lot, building };
  }
  return { lot, building: null };
}


const BOUNDARY_KINDS = new Set(['wall', 'fence', 'hedge', 'railing', 'gate']);

/** A plan set back `front` from its lot's front (a try's margin, `growOnLot`) carried out to the street */
function reachStreet(body: { volumes: Volume[]; elements?: BuildingElement[] }, front: number, width: number): void {
  // The surfaces along the plan's front, at the street's floor
  const along = body.volumes.filter((v) => v.open && !v.outline && Math.abs(v.y) < m(0.05)
    && v.ramp === undefined && !v.terrace);
  const covered: [number, number][] = [];
  for (const v of along) {
    v.y -= front;
    v.d += front;
    covered.push([v.x, v.x + v.w]);
  }
  // And the paths from the gate, out to the footway.
  for (const el of body.elements ?? []) {
    if (el.kind !== 'pavement' || el.facing % 2 !== 0 || Math.abs(el.y - el.d / 2) > m(0.05)) continue;
    el.y -= front / 2;
    el.d += front;
  }
  covered.sort((a, b) => a[0] - b[0]);
  // Paving across the rest of the front, as deep as a surface may be
  let next = Math.max(0, ...body.volumes.map((v) => v.id)) + 1;
  const lay = (x0: number, x1: number): void => {
    if (x1 - x0 < MIN_SIZE) return;
    body.volumes.push({ id: next++, x: x0, y: -front, w: x1 - x0, d: Math.max(front, MIN_SIZE), base: 0,
      roof: 'flat', storeys: [{ facade: { fill: 'wall' } }], open: 'paving' } as Volume);
  };
  let x = -width / 2;
  for (const [a, b] of covered) {
    lay(x, Math.min(a, width / 2));
    x = Math.max(x, b);
  }
  lay(x, width / 2);
}

/** A grown building made to its lot's own shape */
function fitToLot(body: { volumes: Volume[]; elements?: BuildingElement[] }, ring: readonly Vec2[]): void {
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let area = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i]!, q = ring[(i + 1) % ring.length]!; area += p.x * q.y - q.x * p.y; }
  if (ring.length === 4 && Math.abs(area / 2) > (x1 - x0) * (y1 - y0) * 0.97) return;
  const inside = (p: Vec2): boolean => pointInPolygon(p, ring as Vec2[]);
  const elements = (body.elements ??= []);
  // The boundary's kind and height, from the plan's own.
  const old = elements.filter((e) => BOUNDARY_KINDS.has(e.kind) && e.kind !== 'gate');
  const front = elements.filter((e) => BOUNDARY_KINDS.has(e.kind) && Math.abs(e.y) < m(1.2));
  const kind = (old.find((e) => Math.abs(e.y) >= m(1.2))?.kind ?? old[0]?.kind ?? 'fence') as BuildingElement['kind'];
  const height = old.find((e) => e.kind === kind)?.h ?? m(1.4);
  const thick = kind === 'fence' ? m(0.12) : kind === 'hedge' ? m(0.7) : m(0.2);
  // Everything off the lot, and the side and back boundary, out.
  const kept = elements.filter((e) => (front.includes(e)) || (!BOUNDARY_KINDS.has(e.kind) && inside({ x: e.x, y: e.y })));
  let nextId = Math.max(0, ...elements.map((e) => e.id)) + 1;
  // The new boundary along every side but the front (side 0), in pieces of 20 m at most.
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const full = Math.hypot(b.x - a.x, b.y - a.y);
    if (full < m(0.5) + thick) continue;
    // Short of each corner by half its thickness: a square-ended piece met a corner not quite square
    const ux = (b.x - a.x) / full, uy = (b.y - a.y) / full;
    const len = full - thick;
    const sx = a.x + ux * thick / 2, sy = a.y + uy * thick / 2;
    const pieces = Math.ceil(stepsIn(len, 20));
    const angle = Math.atan2(uy, ux);
    // Set in by half its thickness, so it stands on the lot's side of the line.
    const nx = -uy * thick / 2, ny = ux * thick / 2;
    for (let k = 0; k < pieces; k++) {
      const t = ((k + 0.5) / pieces) * len;
      kept.push({ id: nextId++, kind, x: sx + ux * t + nx, y: sy + uy * t + ny, facing: 0, w: len / pieces, d: thick, z: 0, h: height, angle });
    }
  }
  elements.splice(0, elements.length, ...kept.slice(0, MAX_ELEMENTS));
  // Surfaces clipped to the lot; volumes of the building itself kept where they stand on it.
  const clip = (poly: Vec2[]): Vec2[] => {
    // The lot may be any simple polygon (cut back to a bent street, round a corner)
    let best: Vec2[] = [], bestArea = 0;
    for (const piece of intersection([[poly.map((p) => [p.x, p.y])]], [[ring.map((p) => [p.x, p.y])]])) {
      const r = (piece[0] ?? []).map(([x, y]) => ({ x: x!, y: y! }));
      let a = 0;
      for (let i = 0; i < r.length; i++) { const p = r[i]!, q = r[(i + 1) % r.length]!; a += p.x * q.y - q.x * p.y; }
      if (Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = a < 0 ? r.reverse() : r; }
    }
    return best;
  };
  const asOutline = (v: Volume, poly: readonly Vec2[]): void => {
    const px = poly.map((p) => p.x), py = poly.map((p) => p.y);
    v.x = Math.min(...px); v.y = Math.min(...py); v.w = Math.max(...px) - v.x; v.d = Math.max(...py) - v.y;
    v.outline = poly.map((p) => ({ x: (p.x - v.x) / (v.w || 1), y: (p.y - v.y) / (v.d || 1) }));
  };
  const volumes: Volume[] = [];
  const nextVolume = Math.max(0, ...body.volumes.map((v) => v.id)) + 1;
  // The lawn under everything, the lot's own shape - laid first, drawn under the rest.
  const lawnTemplate = body.volumes.find((v) => v.open);
  // A surface cut to a sliver (under 2 m across, or an outline the model cannot hold) is left out
  const sound = (v: Volume): boolean => v.w >= MIN_SIZE && v.d >= MIN_SIZE && (!v.outline || validOutline(v.outline));
  if (lawnTemplate) {
    const lawn: Volume = { ...JSON.parse(JSON.stringify(lawnTemplate)) as Volume, id: nextVolume, open: 'grass' };
    asOutline(lawn, [...ring]);
    if (sound(lawn)) volumes.push(lawn);
  }
  for (const v of body.volumes) {
    const ringOf = v.outline ? v.outline.map((p) => ({ x: v.x + p.x * v.w, y: v.y + p.y * v.d }))
      : [{ x: v.x, y: v.y }, { x: v.x + v.w, y: v.y }, { x: v.x + v.w, y: v.y + v.d }, { x: v.x, y: v.y + v.d }];
    if (v.open) {
      const cut = clip(ringOf);
      if (cut.length < 3) continue;
      if (cut.length !== 4 || !ringOf.every((p) => inside({ x: p.x * 0.999 + (v.x + v.w / 2) * 0.001, y: p.y * 0.999 + (v.y + v.d / 2) * 0.001 }))) asOutline(v, cut);
      if (sound(v)) volumes.push(v);
    } else if (ringOf.some((p) => inside(p)) || inside({ x: v.x + v.w / 2, y: v.y + v.d / 2 })) volumes.push(v);
  }
  body.volumes.splice(0, body.volumes.length, ...volumes);
}
