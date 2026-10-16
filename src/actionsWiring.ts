import type { BodyPart } from '@sim/people/view';
import type { Occupant } from '@render/ragdoll';
import type { BlastHit, SceneHandle } from '@render/renderer';
import { newPose } from '@sim/pose';
import type { SimControl } from '@sim/host';
import { type SimMirror, shownPoseInto } from '@sim/mirror';
import type { Viewport } from '@view/viewport';
import type { Vec2 } from '@core/vec2';
import { closestOnSegment } from '@core/intersect';
import { pointInPolygon } from '@core/polygon';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import type { PoleId } from '@world/ids';
import { type Building, type BuildingId } from '@world/buildings/types';
import { levelElevation, solidFootprints, volumeElevation, worldToLocal } from '@world/buildings/geometry';
import { resolveBlocks } from '@world/buildings/blocks';
import { signalPosts } from '@world/signalPosts';
import type { SignalGroups } from '@world/signalPosts';
import { m, stepsIn } from '@world/units';
import { editRng } from '@editor/editStream';
import { MAX_STOREYS, MAX_STOREY_HEIGHT } from '@world/buildings/types';

/** How high over the ground under the pointer a building can reach: the tallest stack of the tallest storeys, its roof and plinth. */
const RAY_ABOVE = MAX_STOREYS * MAX_STOREY_HEIGHT + m(40);
/** How far under the ground under the pointer a building can stand (one in a valley seen over a ridge). */
const RAY_BELOW = m(120);
/** How often the fires flare on, seconds of the simulation's time. */
const FIRE_STEP = 0.5;

/** THE ACTIONS (the dock's Actions: the pistol and the bomb, and the city on fire after) */
export interface ActionsDeps {
  readonly doc: RoadDoc;
  readonly net: Network;
  /** The simulation as the page sees it, and what the page does to it (`sim/host.ts`). */
  readonly sim: SimMirror;
  readonly control: SimControl;
  /** The simulation's clock, seconds (`SimClock.time`). */
  time(): number;
  readonly scene: SceneHandle;
  /** The building drawn under a screen point (`buildingsWiring.ts` tool). */
  buildingAt(screen: Vec2): number | null;
  view(): Viewport;
  /** The canvas size, CSS pixels. */
  size(): { readonly w: number; readonly h: number };
  /** The height of what is drawn at a point: ground, road or plate. */
  heightAt(p: Vec2): number;
  /** The bomb's force (`ui/toolChoices.ts` `strikeChoice.strength`). */
  strength(): number;
  /** An edit of the document, one undo step. */
  mutate(fn: () => boolean): void;
  /** Runs `fn` with the diary's cause set (`main.ts` `caused`). */
  caused<T>(cause: string, fn: () => T): T;
  hint(key: string): void;
  redraw(): void;
  /** Nothing grows on zoned lots for this many seconds of the simulation's time (rubble lying). */
  holdGrowth(seconds: number): void;
}

export interface Actions {
  /** The bomb at a screen point (`world` the ground under it). */
  strikeAt(sx: number, sy: number, world: Vec2): void;
  /** The pistol at a screen point; false when it hit nothing. */
  shootAt(sx: number, sy: number): boolean;
  /** An explosion at `world`, height `z` (on building `b` when it landed on one). */
  explodeAt(world: Vec2, z: number, b: Building | null, strength: number, quiet?: boolean): void;
  /** The fires, at the simulation's time `now` (seconds, `SimClock.time`) */
  tick(now: number): void;
}

export function createActions(deps: ActionsDeps): Actions {
  const { doc, net, sim, scene, control } = deps;
  /** The traffic's signalised junctions as the page sees them (`SimMirror`). */
  const signals: SignalGroups = { nodes: () => sim.junctionNodesInOrder(), groupsOf: (node) => sim.junctionGroups(node) ?? undefined };
  const pose = newPose();
  /** The people out walking within `radius` of (x, y), as the page sees them. */
  const walkersNear = (x: number, y: number, radius: number): { id: number; x: number; y: number; heading: number }[] =>
    sim.pedViews.filter((p) => Math.hypot(p.x - x, p.y - y) < radius).map((p) => ({ id: p.id, x: p.x, y: p.y, heading: p.heading }));
  const ground = (p: Vec2): number => deps.heightAt(p);

  /** Shots each vehicle has taken on its bodywork: enough of them and it burns and blows up. */
  const vehicleShots = new Map<number, number>();
  /** Buildings that already shorted and burst their pipes (once each). */
  const shorted = new Set<number>();
  /** Buildings a blow reached, broken one a frame. */
  const deferredHits: { id: number; x: number; y: number; z: number; force: number }[] = [];
  /** A frame asked for the buildings waiting to break; none while none wait. */
  let breaking = false;
  const burning = new Map<number, { since: number; nextFlame: number; until: number }>();

  /** The pistol: a shot at the person under the pointer, striking the part of the body clicked */
  function shootAt(sx: number, sy: number): boolean {
    const { w, h } = deps.size();
    const view = deps.view();
    const under = view.toWorldAt(sx, sy, ground(view.toWorld(sx, sy, w, h)), w, h);
    let best: { id: number; height: number; d: number; x: number; y: number; heading: number } | null = null;
    for (const p of walkersNear(under.x, under.y, m(25))) {
      // Down on the ground: their body is shot where it lies (below).
      if (scene.isDown(p.id)) continue;
      const base = ground(p);
      // Up the body's axis: where the line of sight through the pointer passes nearest it.
      for (let k = 0; k <= 37; k++) {
        const height = m(0.05) * k;
        const q = view.toWorldAt(sx, sy, base + height, w, h);
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        // The body's reach about its axis, arms out included (at 0.3 m a shot on an arm out swinging missed).
        if (d < m(0.42) && (!best || d < best.d)) best = { id: p.id, height, d, x: p.x, y: p.y, heading: p.heading };
      }
    }
    if (!best) {
      // The bodies on the ground, alive or dead, along the line of sight
      const lo = ground(under) - m(0.3), hi = lo + m(5);
      const a = view.toWorldAt(sx, sy, hi, w, h), b = view.toWorldAt(sx, sy, lo, w, h);
      const hit = scene.shootBody([a.x, a.y, hi], [b.x, b.y, lo]);
      if (hit && hit !== 'hit') {
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        void control.shoot(hit.alive, hit.part, b.x - ((b.x - a.x) / len) * m(10), b.y - ((b.y - a.y) / len) * m(10)).then((done) => {
          if (done) scene.wound(b.x, b.y, lo + m(0.4), (b.x - a.x) / len, (b.y - a.y) / len, done.severed);
          deps.redraw();
        });
      }
      if (hit) { deps.redraw(); return true; }
      if (shootVehicle(a, b, hi, lo)) { deps.redraw(); return true; }
      deps.hint('hint.shoot.miss');
      return false;
    }
    // The shot's way: from the viewer into the scene, which on the ground is the way up the screen
    const gz = ground(best);
    const farther = view.toWorldAt(sx, sy - 40, gz, w, h), nearer = view.toWorldAt(sx, sy + 40, gz, w, h);
    let dx = farther.x - nearer.x, dy = farther.y - nearer.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    // Left or right of the body's middle, as the body faces.
    const at = view.toWorldAt(sx, sy, ground(best) + best.height, w, h);
    const side = (at.x - best.x) * -Math.sin(best.heading) + (at.y - best.y) * Math.cos(best.heading);
    const part: BodyPart = best.height > m(1.5) ? 'head'
      : best.height > m(0.9) ? (Math.abs(side) > m(0.17) ? (side > 0 ? 'armL' : 'armR') : 'torso')
        : side >= 0 ? 'legL' : 'legR';
    const shot = best;
    void control.shoot(shot.id, part, shot.x - dx * m(10), shot.y - dy * m(10)).then((done) => {
      if (!done) return;
      scene.wound(shot.x, shot.y, ground(shot) + shot.height, dx, dy, done.severed);
      deps.redraw();
    });
    return true;
  }

  /** A shot along the line of sight from `a` (height `hi`) to `b` */
  function shootVehicle(a: Vec2, b: Vec2, hi: number, lo: number): boolean {
    let best: { v: (typeof sim.road)[number]; t: number; x: number; y: number; z: number; up: number; angle: number } | null = null;
    for (const v of sim.road) {
      shownPoseInto(v, 1, pose);
      const g = ground(pose.p);
      const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
      // A rider sits above a two-wheeler's frame: the box up to their head.
      const two = v.archetype.shape === 'bicycle' || v.archetype.shape === 'motorcycle';
      const L = v.archetype.length / 2, W = Math.max(v.archetype.width / 2, two ? m(0.35) : 0), H = two ? Math.max(v.archetype.height, m(1.75)) : v.archetype.height;
      // The segment in the vehicle's frame, clipped by each pair of faces (slabs).
      const ax = a.x - pose.p.x, ay = a.y - pose.p.y, bx = b.x - pose.p.x, by = b.y - pose.p.y;
      const p0 = [ax * c + ay * s, -ax * s + ay * c, hi - g], p1 = [bx * c + by * s, -bx * s + by * c, lo - g];
      const lo3 = [-L, -W, 0], hi3 = [L, W, H];
      let t0 = 0, t1 = 1;
      for (let i = 0; i < 3 && t0 <= t1; i++) {
        const d = p1[i]! - p0[i]!;
        if (Math.abs(d) < 1e-9) { if (p0[i]! < lo3[i]! || p0[i]! > hi3[i]!) t0 = 2; continue; }
        let ta = (lo3[i]! - p0[i]!) / d, tb = (hi3[i]! - p0[i]!) / d;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      }
      if (t0 > t1 || (best && t0 >= best.t)) continue;
      const z = hi + (lo - hi) * t0;
      best = { v, t: t0, x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0, z, up: (z - g) / H, angle: pose.angle };
    }
    if (!best) return false;
    const { v, x, y, z } = best;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dirX = (b.x - a.x) / len, dirY = (b.y - a.y) / len;
    const shape = v.archetype.shape;
    const css = String(v.color ?? '#777777');
    const color = parseInt(css.replace('#', '').slice(0, 6), 16) || 0x777777;
    if (shape === 'bicycle' || shape === 'motorcycle') {
      // The rider shot off: thrown down dead, the machine falling over.
      const g = ground({ x, y });
      scene.wound(x, y, g + m(1.2), dirX, dirY, null);
      scene.flingOccupants([{ id: 8_000_000 + v.id, x, y, z: g + m(0.9), heading: best.angle, blastX: x - dirX * m(4), blastY: y - dirY * m(4),
        power: 0.15, kind: 'dead', index: scene.driverBody(v, x, y) }]);
      scene.dropVehicle({ id: v.id, archetype: v.archetype, x, y, angle: best.angle, color, dirX, dirY });
      control.removeVehicle(v.id);
      vehicleShots.delete(v.id);
      return true;
    }
    // Through the glass (the upper part of the body): the driver killed, the car rolling to a stop.
    const glass = best.up > 0.55;
    scene.vehicleHit(x, y, z, dirX, dirY, glass, glass);
    if (glass) control.strand(v.id);
    const n = (vehicleShots.get(v.id) ?? 0) + 1;
    vehicleShots.set(v.id, n);
    if (vehicleShots.size > 200) vehicleShots.clear();
    if (n >= 12) {
      vehicleShots.delete(v.id);
      shownPoseInto(v, 1, pose);
      explodeAt({ x: pose.p.x, y: pose.p.y }, ground(pose.p), null, 3);
    }
    return true;
  }

  /** The bomb (the player's order of 2026-10-05): a blow of the chosen force where the pointer is. */
  function strikeAt(sx: number, sy: number, world: Vec2): void {
    const strength = deps.strength();
    // A building already broken is no longer drawn as itself, so the pick by its meshes misses it
    const id = deps.buildingAt({ x: sx, y: sy });
    const b = id !== null ? doc.buildings.get(id as BuildingId)
      : buildingsUnderRay(sx, sy, ground(world)).find((c) => rayOnBuilding(c, sx, sy, ground({ x: c.x, y: c.y })) !== null);
    // Where the blow lands: the first point of the building along the pointer's ray (its roof or the face under the pointer)
    let target = world, z = ground(world);
    if (b) {
      const hit = rayOnBuilding(b, sx, sy, z);
      if (hit) { target = hit; z = hit.z; }
    }
    explodeAt(target, z, b ?? null, strength);
  }

  /** An explosion at `world`, height `z` (on building `b` when it landed on one) */
  function explodeAt(world: Vec2, z: number, b: Building | null, strength: number, quiet = false): void {
    const radius = m(2.5 + strength * 1.1);
    const kill = radius * 0.5, scare = m(70 + strength * 10);
    const deaths = control.impact(world.x, world.y, kill, scare);
    const near = (x: number, y: number, reach: number): boolean => Math.hypot(x - world.x, y - world.y) < reach;
    const paved = Number.isFinite(scene.pavedHeightAt(world.x, world.y));
    const struck: BlastHit['ground'] = b && z > ground(world) + m(0.5) ? 'building' : paved ? 'road' : 'earth';
    const hit: { ground: BlastHit['ground']; crater: boolean; poles: BlastHit['poles'][number][]; wires: BlastHit['wires'][number][];
      posts: BlastHit['posts'][number][]; vehicles: BlastHit['vehicles'][number][]; items: BlastHit['items'][number][] } =
      { ground: struck, crater: struck !== 'building', poles: [], wires: [], posts: [], vehicles: [], items: [] };
    let downs = 0;
    deps.mutate(() => {
      let changed = false;
      // DO NOT walk `buildings.all()`: every blow outlined every building of the city.
      for (const c of doc.buildings.near(world.x - radius, world.y - radius, world.x + radius, world.y + radius)) {
        let best = Infinity, px = world.x, py = world.y;
        // Its farthest corner from its own centre: past that and the reach, nothing of it is struck.
        const own = solidFootprints(c);
        let extent = 0;
        for (const ring of own) for (const q of ring) extent = Math.max(extent, Math.hypot(q.x - c.x, q.y - c.y));
        if (Math.hypot(c.x - world.x, c.y - world.y) - extent > radius) continue;
        for (const ring of own) {
          if (pointInPolygon(world, ring)) { best = 0; break; }
          for (let i = 0; i < ring.length; i++) {
            const q = closestOnSegment(world, ring[i]!, ring[(i + 1) % ring.length]!).point;
            const d = Math.hypot(q.x - world.x, q.y - world.y);
            if (d < best) { best = d; px = q.x; py = q.y; }
          }
        }
        if (best > radius) continue;
        // Where it is struck.
        const at = c === b ? { x: world.x, y: world.y, z } : { x: px, y: py, z: Math.max(z, ground({ x: px, y: py }) + m(1.5)) };
        const force = c === b ? strength : Math.max(1, strength * (1 - best / radius) * 1.2);
        // Breaking a building into its pieces is the costly part (a Voronoi fracture of its meshes)
        if (c !== b) { if (best < radius * 0.75 || force >= 4) { deferredHits.push({ id: c.id, ...at, force }); scheduleBreak(); } continue; }
        if (scene.strikeBuilding(c, at.x, at.y, at.z, force)) {
          doc.buildings.remove(c.id);
          scene.forgetRuin(c.id);
          burning.delete(c.id);
          downs++;
          changed = true;
        } else {
          // Its wiring shorting and its pipes bursting at a few points on the side the blast struck
          const base = ground({ x: c.x, y: c.y });
          const floors = Math.max(1, Math.max(...c.volumes.map((v) => v.base + v.storeys.length)));
          const spots = shorted.has(c.id) ? 0 : Math.min(2, 1 + Math.round(force / 8));
          shorted.add(c.id);
          for (let k = 0; k < spots; k++) {
            const h = base + levelElevation(c, Math.floor(Math.random() * floors)) + m(1 + Math.random() * 1.5);
            const jx = px + (Math.random() - 0.5) * m(6), jy = py + (Math.random() - 0.5) * m(6);
            if (Math.random() < 0.75) scene.sparkAt(jx, jy, h, 0.6 + Math.random() * 0.8);
            else scene.leak(jx, jy, h, 1 + Math.random() * 1.5);
          }
        }
      }
      // Everything round it left filthy: the buildings within twice the reach blackened with soot and dust
      const soot = radius * 2.2;
      for (const c of doc.buildings.near(world.x - soot, world.y - soot, world.x + soot, world.y + soot)) {
        const d = Math.hypot(c.x - world.x, c.y - world.y);
        if (d > soot) continue;
        const add = 0.35 * (1 - d / soot) * Math.min(1, strength / 8);
        if (add > 0.02) { deps.caused('explosion soot', () => doc.buildings.wear(c.id, Math.min(1, (c.decay ?? 0) + add))); changed = true; }
      }
      // Poles: broken whole, snapped or to splinters; the wires torn off them pull the next poles over, or hang from them.
      const broken = new Set<PoleId>();
      for (const pole of doc.polesIn([world.x - radius, world.y - radius, world.x + radius, world.y + radius])) {
        if (near(pole.x, pole.y, radius)) broken.add(pole.id);
      }
      // Which neighbour a torn wire pulls over is drawn from a stream seeded by the document and the place
      const pull = editRng(doc, world.x, world.y);
      // Each broken pole's wires, the ones it pulls over in their turn
      const queue = [...broken].sort((p, q) => p - q);
      for (let k = 0; k < queue.length; k++) {
        for (const span of doc.spansAt(queue[k]!).sort((p, q) => p.id - q.id)) {
          const from = span.a === queue[k] ? span.b : span.a;
          if (broken.has(from)) continue;
          const p = doc.poles.get(from);
          if (p && near(p.x, p.y, radius * 2.2) && pull.float() < 0.5) { broken.add(from); queue.push(from); }
        }
      }
      const wires = new Map<number, { a: PoleId; b: PoleId }>();
      for (const id of broken) for (const span of doc.spansAt(id)) wires.set(span.id, span);
      const spans = [...wires.entries()].sort((p, q) => p[0] - q[0]).map(([, span]) => span);
      for (const span of spans) {
        const pa = doc.poles.get(span.a), pb = doc.poles.get(span.b);
        if (!pa || !pb) continue;
        if (broken.has(span.a) && !broken.has(span.b)) hit.wires.push({ fromX: pb.x, fromY: pb.y, toX: pa.x, toY: pa.y });
        if (broken.has(span.b) && !broken.has(span.a)) hit.wires.push({ fromX: pa.x, fromY: pa.y, toX: pb.x, toY: pb.y });
      }
      for (const id of broken) {
        const pole = doc.poles.get(id)!;
        const d = Math.hypot(pole.x - world.x, pole.y - world.y) || 1;
        const close = d < radius * 0.4;
        const mode = d > radius ? 'whole' : close && Math.random() < 0.6 ? 'splinter' : Math.random() < 0.5 ? 'snap' : 'whole';
        hit.poles.push({ x: pole.x, y: pole.y, lamp: pole.lamp, mode, dirX: (pole.x - world.x) / d, dirY: (pole.y - world.y) / d });
        doc.removePole(id);
        changed = true;
      }
      // The posts of the junctions on the roads within reach only (`near`)
      for (const post of signalPosts(net, signals, { x: world.x, y: world.y, radius })) {
        if (!near(post.x, post.y, radius)) continue;
        hit.posts.push({ x: post.x, y: post.y, yaw: post.yaw });
        if (doc.node(post.node)?.control !== 'none') { doc.setNodeControl(post.node, 'none'); changed = true; }
      }
      // Trees, benches, bins, lamps, signs: thrown and gone.
      for (const item of doc.landscapeIn([world.x - radius, world.y - radius, world.x + radius, world.y + radius])) {
        if (!near(item.x, item.y, radius)) continue;
        hit.items.push({ kind: item.kind, x: item.x, y: item.y });
        if (item.kind === 'hydrant') scene.geyser(item.x, item.y, ground(item));
        doc.removeLandscape(item.id);
        changed = true;
      }
      // Bare earth: a crater dug into the terrain.
      if (struck === 'earth') {
        doc.addTerrainStamp({ x: world.x, y: world.y, radius: radius * 0.5, strength: m(0.6 + strength * 0.12), mode: 'lower' });
        changed = true;
      }
      return changed;
    });
    // Cars: thrown, burning shells - the traffic.
    const aboard: Occupant[] = [];
    const throwAboard = (id: number, x: number, y: number, angle: number, rider: boolean, index: number | null = null): void => {
      const d = Math.hypot(x - world.x, y - world.y);
      const close = d < radius * 0.6;
      aboard.push({ id: 8_000_000 + id, x, y, z: ground({ x, y }) + m(rider ? 1.0 : 0.6), heading: angle,
        blastX: world.x, blastY: world.y, power: Math.max(0.3, 1 - d / (radius * 1.1)),
        kind: close && Math.random() < 0.5 ? 'torn' : 'dead', charred: !rider || close, index });
    };
    for (const v of [...sim.road]) {
      shownPoseInto(v, 1, pose);
      if (!near(pose.p.x, pose.p.y, radius * 1.1)) continue;
      const css = String(v.color ?? '#777777');
      const p = pose.p;
      hit.vehicles.push({ x: p.x, y: p.y, angle: pose.angle, length: v.archetype.length, width: v.archetype.width,
        height: v.archetype.height, color: parseInt(css.replace('#', '').slice(0, 6), 16) || 0x777777, id: v.id, archetype: v.archetype });
      throwAboard(v.id, p.x, p.y, pose.angle, v.archetype.shape === 'bicycle' || v.archetype.shape === 'motorcycle', scene.driverBody(v, pose.p.x, pose.p.y));
      control.removeVehicle(v.id);
    }
    (globalThis as Record<string, unknown>)['__lastBlast'] = { ...hit, radius, at: world };
    scene.explode(world.x, world.y, z, radius, hit);
    if (aboard.length) scene.flingOccupants(aboard);
    // Soot and ash over the ground round it, kept: streets and lots left dirty.
    const blots = Math.min(40, Math.round(6 + stepsIn(radius, 3)));
    for (let k = 0; k < blots; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * radius * 1.6;
      const x = world.x + Math.cos(a) * r, y = world.y + Math.sin(a) * r;
      scene.soot(x, y, ground({ x, y }), m(2 + Math.random() * 4) + radius * 0.08);
    }
    if (struck === 'road') scene.strikeGround(world.x, world.y, strength);
    if (downs > 0 || hit.poles.length || hit.vehicles.length) deps.holdGrowth(90);
    if (!quiet) void deaths.then((dead) => deps.hint(downs > 0 ? 'hint.strike.down' : dead > 0 ? 'hint.strike.deaths' : b ? 'hint.strike.hit' : 'hint.strike.ground'));
    if (b && doc.buildings.has(b.id)) ignite(b.id);
    deps.redraw();
  }

  // A building struck comes down when its pieces are ready (made off the main thread).
  scene.onBuildingDown((id) => {
    if (!doc.buildings.has(id as BuildingId)) return;
    deps.mutate(() => { doc.buildings.remove(id as BuildingId); scene.forgetRuin(id); burning.delete(id); return true; });
    deps.redraw();
  });

  /** The buildings a blow reached, four a frame (MDN: one `requestAnimationFrame` per frame, asked again while some wait). */
  function breakDeferred(): void {
    breaking = false;
    for (let k = 0; k < 4 && deferredHits.length; k++) breakOne(deferredHits.shift()!);
    if (deferredHits.length) scheduleBreak();
  }
  function scheduleBreak(): void {
    if (breaking) return;
    breaking = true;
    requestAnimationFrame(breakDeferred);
  }
  function breakOne(next: { id: number; x: number; y: number; z: number; force: number }): void {
    const c = doc.buildings.get(next.id as BuildingId);
    if (c && scene.strikeBuilding(c, next.x, next.y, next.z, next.force)) {
      deps.mutate(() => { doc.buildings.remove(c.id); scene.forgetRuin(c.id); burning.delete(c.id); return true; });
    }
    deps.redraw();
  }

  /** Buildings on fire the player's order of 2026-10-05: the fire spreading over the neighbouring buildings, as it happens */
  function ignite(id: number): void {
    if (burning.has(id) || burning.size >= 3) return;
    const now = deps.time();
    burning.set(id, { since: now, nextFlame: now, until: now + 50 + Math.random() * 40 });
  }
  /** DO NOT go back to a `setInterval` on the wall clock */
  let fireLast: number | null = null;
  function tick(now: number): void {
    if (fireLast === null || now < fireLast) fireLast = now;
    if (now - fireLast < FIRE_STEP) return;
    fireLast = now;
    for (const [id, f] of [...burning]) {
      const b = doc.buildings.get(id as BuildingId);
      if (!b || now > f.until) { burning.delete(id); continue; }
      const pts = solidFootprints(b).flat();
      if (!pts.length) { burning.delete(id); continue; }
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      const size = Math.min(m(30), Math.max(m(6), Math.hypot(pts[0]!.x - cx, pts[0]!.y - cy)));
      const base = ground({ x: cx, y: cy });
      if (now >= f.nextFlame) {
        // Fires at a few points of the building, from the ground up its height.
        for (let k = 0; k < 2; k++) {
          const p = pts[Math.floor(Math.random() * pts.length)]!;
          const x = cx + (p.x - cx) * Math.random(), y = cy + (p.y - cy) * Math.random();
          scene.burn(x, y, base + m(2 + Math.random() * 10), Math.min(size * 0.3, m(3)), 7);
        }
        f.nextFlame = now + 6;
      }
    }
    if (burning.size) deps.redraw();
  }

  /** DO NOT walk `buildings.all()`: a blow on open ground ray-marched every building of the city. */
  function buildingsUnderRay(sx: number, sy: number, groundZ: number): Building[] {
    const { w, h } = deps.size();
    const view = deps.view();
    const high = view.toWorldAt(sx, sy, groundZ + RAY_ABOVE, w, h), low = view.toWorldAt(sx, sy, groundZ - RAY_BELOW, w, h);
    return doc.buildings.near(Math.min(high.x, low.x), Math.min(high.y, low.y), Math.max(high.x, low.x), Math.max(high.y, low.y));
  }

  /** The first point of building `b` along the screen ray through (sx, sy): marched down from its top. */
  function rayOnBuilding(b: Building, sx: number, sy: number, base: number): (Vec2 & { z: number }) | null {
    const { w, h: height } = deps.size();
    const view = deps.view();
    const volumes = resolveBlocks(b).volumes.filter((v) => !v.open);
    // Each block at its own heights (a split level, `Volume.lift`).
    let top = 0, low = 0;
    for (const v of volumes) { top = Math.max(top, volumeElevation(b, v, v.base + v.storeys.length)); low = Math.min(low, volumeElevation(b, v, v.base)); }
    for (let h = top + m(1); h >= low; h -= m(0.5)) {
      const p = view.toWorldAt(sx, sy, base + h, w, height);
      const l = worldToLocal(b, p);
      for (const v of volumes) {
        if (l.x < v.x || l.x > v.x + v.w || l.y < v.y || l.y > v.y + v.d) continue;
        if (h <= volumeElevation(b, v, v.base + v.storeys.length) && h >= volumeElevation(b, v, v.base)) return { x: p.x, y: p.y, z: base + h };
      }
    }
    return null;
  }

  return { strikeAt, shootAt, explodeAt, tick };
}
