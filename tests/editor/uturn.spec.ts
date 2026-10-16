import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import type { SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { m } from '@world/units';
import { roadProfile, sectionFromProfile } from '@world/roadTypes';
import { LaneletGraph } from '@world/lanelets';
import { MEDIAN_UTURN_OPENING, medianNose } from '@world/landscape';
import { commitUturn } from '@editor/streetObjects';
import { guardRoadEdit } from '@editor/editRules';

/** A U-TURN THROUGH THE MEDIAN (retorno: a piece the player puts, 2026-10-10). */
const AVENUE = 2, BOULEVARD = 3;

function road(type: number, median?: number): { doc: RoadDoc; net: Network; id: SegmentId; start: number } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-200), y: 0 }).id, b = doc.addNode({ x: m(200), y: 0 }).id;
  const seg = doc.addSegment(a, b, type)!;
  if (median !== undefined) doc.setSegmentSection(seg.id, { ...sectionFromProfile(roadProfile(type)), median: m(median) });
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, id: seg.id, start: a };
}

describe('a U-turn through the median', () => {
  it('is refused on a road with no median', () => {
    const { doc, net, id } = road(AVENUE);
    expect(commitUturn(doc, net, id, 'b')).toEqual({ committed: false, reason: 'noMedian' });
  });

  it('is refused where a car cannot turn round, and the road is left as it was', () => {
    const { doc, net, id } = road(BOULEVARD);
    const before = JSON.stringify(doc.toJSON());
    expect(commitUturn(doc, net, id, 'b')).toEqual({ committed: false, reason: 'narrow' });
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });

  it('is opened where it is wide enough: cars turn round, buses do not, the median is cut', () => {
    const { doc, net, id, start } = road(BOULEVARD, 5);
    const result = commitUturn(doc, net, id, 'b');
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    const node = doc.node(result.node)!;
    // It serves the traffic heading for `b`: arriving from the piece that holds the road's start.
    const from = doc.segment(node.uturn!)!;
    expect([from.a, from.b]).toContain(start);
    const graph = new LaneletGraph();
    graph.build(doc, net);
    const turns = [...graph.connectors.values()].filter((c) => c.node === result.node && c.turn === 'uturn');
    expect(Math.max(...turns.map((c) => c.maxBodyClass))).toBe(1);
    // The median opens on the road beyond, where the half circle crosses it.
    const beyond = node.incident.find((sg) => sg !== node.uturn)!;
    expect(medianNose(net, beyond, result.node)).toBe(MEDIAN_UTURN_OPENING);
    expect(medianNose(net, node.uturn!, result.node)).toBeLessThan(m(3));
  });

  it('opened as the inspector opens it, a working copy of the working copy (`guardRoadEdit`): the same road as opened directly', () => {
    const direct = road(BOULEVARD, 5);
    expect(commitUturn(direct.doc, direct.net, direct.id, 'b').committed).toBe(true);
    const guarded = road(BOULEVARD, 5);
    expect(guardRoadEdit(guarded.doc, guarded.net, (work, workNet) => commitUturn(work, workNet, guarded.id, 'b').committed))
      .toEqual({ changed: true, refused: null });
    expect(guarded.doc.toJSON()).toEqual(direct.doc.toJSON());
    expect([...guarded.net.ribbons.keys()]).toEqual([...direct.net.ribbons.keys()]);
    expect([...guarded.net.trims]).toEqual([...direct.net.trims]);
    expect(guarded.net.revision).toBe(guarded.doc.revision);
  });
});
