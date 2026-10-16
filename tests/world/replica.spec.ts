import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { ReplicaFeed, applyReplica } from '@world/replica';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import type { BuildingId } from '@world/buildings/types';
import { layCity, widenCityFootways, zoneCity } from '@editor/cityGenerator';
import { growOnLot } from '@editor/zoning';
import { m } from '@world/units';

/** THE SIMULATION'S COPY OF THE DOCUMENT, kept by the diary (`world/replica.ts`) */

/** The parts the simulation reads, as plain data, in id order. */
function parts(doc: RoadDoc): unknown {
  const sorted = <T extends { id: number }>(list: Iterable<T>): T[] => [...list].sort((a, b) => a.id - b.id);
  return JSON.parse(JSON.stringify({
    nodes: sorted(doc.nodes.values()), segments: sorted(doc.segments.values()),
    buildings: sorted(doc.buildings.all()), lots: sorted(doc.lotStore.all()), transit: doc.transit,
    // The lots' order too: the growth takes the open lots in it (`world/openLots.ts`).
    order: [...doc.lotStore.all()].map((l) => [l.id, doc.lotStore.orderOf(l.id)]),
  }));
}

/** The network as the simulation builds it from its copy: every ribbon's length and every junction. */
function network(doc: RoadDoc): unknown {
  const net = new Network(doc);
  net.rebuild();
  return { ribbons: [...net.ribbons.values()].map((r) => [r.id, r.full.length.toFixed(6)]).sort(), junctions: [...net.junctions.keys()].sort((a, b) => a - b) };
}

describe('the copy of the document the simulation reads', () => {
  it('stands as the document does after the first patch and after every edit', () => {
    const plan = planCity({ ...DEFAULT_CITY, size: 'small' });
    const doc = layCity(plan);
    widenCityFootways(doc);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    zoneCity(doc, net, plan);
    const refused = new Set<number>();
    for (let k = 0; k < 40; k++) growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed);
    expect(doc.buildings.size).toBeGreaterThan(20);

    const feed = new ReplicaFeed();
    const copy = new RoadDoc();
    const sync = (): void => {
      const patch = feed.take(doc);
      if (patch) applyReplica(copy, structuredClone(patch));
      expect(parts(copy)).toEqual(parts(doc));
    };
    sync();
    expect(network(copy)).toEqual(network(doc));

    // A road added, a node moved, a road taken away.
    const a = doc.addNode({ x: m(900), y: m(900) }), b = doc.addNode({ x: m(960), y: m(900) });
    doc.addSegment(a.id, b.id, 1);
    sync();
    const node = [...doc.nodes.values()].find((n) => n.incident.length === 2)!;
    doc.moveNode(node.id, { x: node.x + m(3), y: node.y - m(2) });
    sync();
    doc.removeSegment([...doc.segments.keys()][5]!);
    sync();
    // Buildings taken down and grown; a lot dropped.
    const ids = [...doc.buildings.all()].map((x) => x.id);
    doc.buildings.remove(ids[0]! as BuildingId);
    doc.buildings.remove(ids[3]! as BuildingId);
    growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed);
    sync();
    // A lot taken away and put back (an undo): last in the order now, there in the copy too.
    const lot = [...doc.lotStore.all()][2]!;
    doc.lotStore.apply({ remove: [lot.id] }, 'taken');
    doc.lotStore.restore([{ id: lot.id, value: lot }], 'put back');
    expect([...doc.lotStore.all()].at(-1)).toBe(lot);
    sync();
    // Nothing changed: no patch.
    expect(feed.take(doc)).toBeNull();
    // A whole map put in (the diary names nothing): the copy follows it whole.
    doc.replaceFromJSON(new RoadDoc().toJSON());
    sync();
    expect(copy.nodes.size).toBe(0);
    expect(network(copy)).toEqual(network(doc));
  });
});
