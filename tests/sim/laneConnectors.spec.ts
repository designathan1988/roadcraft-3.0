import { describe, expect, it } from 'vitest';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import type { SegmentId } from '@world/ids';
import { roadProfile, sectionFromProfile } from '@world/roadTypes';
import { normalizeRoadSection, flipSection, sameRoadSection } from '@world/roadSection';
import { toggleLaneLink } from '@world/roads/connectors';
import { nodeLanes } from '@ui/roads/connectorPanel';
import { junctionTraffic } from '@sim/inspect';
import { layoutDoc, simOf } from './support/bodies';

/** LANE CONNECTORS, LANE USES AND LINES, run as the traffic drives them */
const AVENUES = { name: 'avenues', bearings: [0, 90, 180, 270], types: [3, 3, 3, 3] } as const;
const SECONDS = 40;

function legs(doc: ReturnType<typeof layoutDoc>['doc']): SegmentId[] {
  return [...doc.segments.keys()].sort((a, b) => a - b);
}

describe('lane connections by hand', () => {
  it('a lane with its own connections leaves the junction only by them; the vehicles follow', () => {
    const { doc, centre } = layoutDoc(AVENUES);
    const [north, east] = legs(doc) as [SegmentId, SegmentId];
    doc.setNodeLaneLinks(centre, [{ from: north, fromLane: 0, to: east, toLane: 0 }]);
    const sim = simOf(doc, 0x51ce, 3);
    const inLane = (sim.graph.inbound.get(centre) ?? []).find((id) => sim.lanelet(id)?.segment === north && sim.lanelet(id)?.laneIndex === 0)!;
    expect(inLane).toBeDefined();
    const exits = sim.graph.exitsOf(inLane).map((id) => sim.connector(id)!);
    expect(exits.map((c) => [c.outSegment, sim.lanelet(c.toLane)?.laneIndex])).toEqual([[east, 0]]);
    // The other lane of that road keeps the game's own connections (more than one way on).
    const other = (sim.graph.inbound.get(centre) ?? []).find((id) => sim.lanelet(id)?.segment === north && sim.lanelet(id)?.laneIndex === 1)!;
    expect(sim.graph.exitsOf(other).length).toBeGreaterThan(0);

    // Until the lane has carried a vehicle through the junction (50 vehicle-ticks on its connectors), at most 80 s
    const used = new Map<string, number>();
    let through = 0;
    for (let i = 0; i < Math.round(80 / DT) && through < 50; i++) {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehicles.values()) {
        const c = sim.connector(v.lanelet);
        if (!c || c.fromLane !== inLane) continue;
        through++;
        const key = `${c.outSegment}:${sim.lanelet(c.toLane)?.laneIndex}`;
        used.set(key, (used.get(key) ?? 0) + 1);
      }
    }
    expect(through).toBeGreaterThanOrEqual(50);
    expect([...used.keys()]).toEqual([`${east}:0`]);
  });

  it('a link to a lane that is gone is left out; a lane whose links are all gone keeps the derived ones', () => {
    const { doc, centre } = layoutDoc(AVENUES);
    const [north] = legs(doc) as [SegmentId];
    doc.setNodeLaneLinks(centre, [{ from: north, fromLane: 0, to: 999 as SegmentId, toLane: 0 }]);
    const sim = simOf(doc, 1, 0);
    const inLane = (sim.graph.inbound.get(centre) ?? []).find((id) => sim.lanelet(id)?.segment === north && sim.lanelet(id)?.laneIndex === 0)!;
    expect(sim.graph.exitsOf(inLane).length).toBeGreaterThan(0);
    // Saved and loaded with the map.
    expect(JSON.parse(JSON.stringify(doc.toJSON())).nodes.find((n: { id: number }) => n.id === centre).laneLinks).toHaveLength(1);
  });

  it('a toggle starts from what the game built, and never leaves a lane without a way on', () => {
    const { doc, centre } = layoutDoc(AVENUES);
    const [north] = legs(doc) as [SegmentId];
    const sim = simOf(doc, 1, 0);
    const lanes = nodeLanes(junctionTraffic(sim, centre), centre)!;
    const built = lanes.built.filter((l) => l.from === north && l.fromLane === 0);
    expect(built.length).toBeGreaterThan(1);
    // Taking one away keeps the others.
    const fewer = toggleLaneLink(undefined, lanes, built[0]!)!;
    expect(fewer.filter((l) => l.from === north && l.fromLane === 0)).toHaveLength(built.length - 1);
    // Taking away the last one is refused.
    let links = fewer;
    for (const l of built.slice(1, -1)) links = toggleLaneLink(links, lanes, l)!;
    expect(toggleLaneLink(links, lanes, built[built.length - 1]!)).toBeNull();
  });
});

describe('lane uses and lines', () => {
  it('are saved in the section, and swap with the road reversed', () => {
    const base = sectionFromProfile(roadProfile(3, null));
    const section = normalizeRoadSection({ ...base, useForward: ['all', 'bus'], linesBackward: ['solid'], linesForward: ['dashed'] })!;
    expect(section.useForward).toEqual(['all', 'bus']);
    expect(section.linesForward).toBeUndefined();
    const flipped = flipSection(section)!;
    expect(flipped.useBackward).toEqual(['all', 'bus']);
    expect(flipped.linesForward).toEqual(['solid']);
    expect(sameRoadSection(flipSection(flipped), section)).toBe(true);
  });

  it('a bus lane carries buses only, and nobody changes lane across a solid line', () => {
    const { doc } = layoutDoc(AVENUES);
    const ids = legs(doc);
    const base = sectionFromProfile(roadProfile(3, null));
    // The outer lane of every arriving and leaving direction a bus lane; the solid line on the north road.
    for (const id of ids) doc.setSegmentSection(id, { ...base, useForward: ['all', 'bus'], useBackward: ['all', 'bus'] });
    const sim = simOf(doc, 0xb05, 3);
    let carsOnBusLane = 0, busesSeen = 0, crossings = 0;
    const where = new Map<number, string>();
    for (let i = 0; i < Math.round(SECONDS / DT); i++) {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehicles.values()) {
        const lane = sim.lanelet(v.lanelet);
        if (v.archetype.shape === 'bus') busesSeen++;
        if (lane?.use === 'bus' && v.archetype.shape !== 'bus') carsOnBusLane++;
        const before = where.get(v.id);
        const prev = before ? sim.lanelet(before) : undefined;
        if (prev && lane && prev.kind === 'link' && lane.kind === 'link' && prev.segment === lane.segment && prev.to === lane.to && prev.id !== lane.id) {
          // A change between the open lane and the bus lane crosses the bus lane's line.
          if (v.archetype.shape !== 'bus') crossings++;
        }
        where.set(v.id, v.lanelet);
      }
    }
    expect(carsOnBusLane).toBe(0);
    expect(crossings).toBe(0);
    expect(sim.vehicles.size + busesSeen).toBeGreaterThan(0);
  });

  it('the change targets: a dashed line lets a car across, a solid one does not, a bus lane is buses only', () => {
    const { doc } = layoutDoc(AVENUES);
    const [north, east] = legs(doc) as [SegmentId, SegmentId];
    const base = sectionFromProfile(roadProfile(3, null));
    doc.setSegmentSection(north, { ...base, linesForward: ['solid'], linesBackward: ['solid'] });
    doc.setSegmentSection(east, { ...base, useForward: ['all', 'bus'], useBackward: ['all', 'bus'] });
    const sim = simOf(doc, 1, 0);
    const lanesOf = (seg: SegmentId) => [...sim.graph.lanelets.values()].filter((l) => l.kind === 'link' && l.segment === seg);
    for (const l of lanesOf(north)) expect(sim.graph.changeTargets(l.id, 'car')).toEqual([]);
    const inner = lanesOf(east).find((l) => l.laneIndex === 0)!;
    expect(sim.graph.changeTargets(inner.id, 'car')).toEqual([]);
    expect(sim.graph.changeTargets(inner.id, 'bus')).toEqual([]);
    expect(sim.graph.laneUsable(lanesOf(east).find((l) => l.laneIndex === 1)!.id, 'car')).toBe(false);
    const plain = layoutDoc(AVENUES);
    const sim2 = simOf(plain.doc, 1, 0);
    const lane0 = [...sim2.graph.lanelets.values()].find((l) => l.kind === 'link' && l.laneIndex === 0)!;
    expect(sim2.graph.changeTargets(lane0.id, 'car').length).toBe(1);
  });
});
