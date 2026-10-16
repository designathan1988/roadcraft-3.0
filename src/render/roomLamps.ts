import type { RoadDoc } from '@world/doc';
import { floorHeight, type GroundAt, type PavedAt } from '@world/buildings/foundation';
import { levelElevation, levelHeight, liftAt, localToWorld } from '@world/buildings/geometry';
import { LAMP_KINDS, interiorAt } from '@world/buildings/interior';
import { m } from '@world/units';
import type { CutawaySpec } from './buildings/layer';
import type { Building } from '@world/buildings/types';

/** The room lights of the floors cut open (the building tool's cutaway) */
export class RoomLamps {
  /** DO NOT clear them all on `buildings.revision`: any building of the town grown or aged threw every height away. */
  private readonly floors = new WeakMap<Building, Map<number, number>>();

  lamps(doc: RoadDoc, spec: CutawaySpec | null, groundAt: GroundAt, pavedAt: PavedAt, max: number): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    if (!spec) return out;
    // DO NOT walk `buildings.all()`: this runs every frame the cutaway is open, the whole town each time.
    const buildings = doc.buildings;
    const only = spec.only !== undefined ? buildings.get(spec.only) : undefined;
    const candidates = spec.only !== undefined ? (only ? [only] : [])
      : buildings.near(spec.x - spec.radius, spec.y - spec.radius, spec.x + spec.radius, spec.y + spec.radius);
    const near = candidates
      .map((b) => ({ b, d: Math.hypot(b.x - spec.x, b.y - spec.y) }))
      .filter((e) => spec.only !== undefined || e.d <= spec.radius)
      .sort((a, c) => a.d - c.d);
    for (const { b } of near) {
      let levels = this.floors.get(b);
      if (!levels) this.floors.set(b, levels = new Map());
      let floor = levels.get(spec.level);
      if (floor === undefined) {
        floor = floorHeight(b, groundAt, pavedAt) + levelElevation(b, spec.level) + m(0.05);
        levels.set(spec.level, floor);
      }
      for (const f of interiorAt(b, spec.level).furniture) {
        if (!LAMP_KINDS.has(f.kind)) continue;
        if (out.length >= max) return out;
        const p = localToWorld(b, f.x, f.y);
        const up = f.kind === 'ceilingLamp' ? levelHeight(b, spec.level) - m(0.6) : f.h * 0.9;
        // On its own block's floor (a split level stands at its own, `Volume.lift`).
        out.push({ x: p.x, y: p.y, z: floor + liftAt(b, spec.level, f.x, f.y) + up });
      }
    }
    return out;
  }
}
