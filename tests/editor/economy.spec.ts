import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { ROAD_TUNING } from '@world/roads/tuning';
import { roadValue } from '@world/economy';
import { commitDraft, commitRoadPath, moveNodeChecked, splitSegment } from '@editor/commit';
import { guardRoadEdit } from '@editor/editRules';
import { restoreSnapshot, serialize } from '@editor/history';
import { isSerializedDoc } from '@editor/persistence';
import { roadsBefore, settleRoadEdit } from '@editor/roads/economy';

/** The minimal economy in the editor */
function empty(balance?: number): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  if (balance !== undefined) doc.setBalance(balance);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

const draw = (doc: RoadDoc, net: Network, x0: number, x1: number, y = 0, dryRun = false) =>
  commitRoadPath(doc, net, { kind: 'free', at: { x: x0, y } }, { kind: 'free', at: { x: x1, y } }, 1,
    [{ start: { at: { x: x0, y }, heightOffset: 0 }, end: { at: { x: x1, y }, heightOffset: 0 }, curve: null }], null, undefined, undefined, { dryRun });

describe('paying for roads', () => {
  it('prices a road in the dry run without touching the map, then debits exactly that on commit', () => {
    const { doc, net } = empty();
    const start = doc.economy.balance;
    const preview = draw(doc, net, 0, 300, 0, true);
    expect(preview.committed).toBe(true);
    expect(preview.cost).toBeGreaterThan(0);
    expect(doc.economy.balance).toBe(start);
    expect(doc.segments.size).toBe(0);
    const done = draw(doc, net, 0, 300);
    expect(done.committed).toBe(true);
    expect(done.cost).toBe(preview.cost);
    expect(doc.economy.balance).toBe(start - done.cost!);
    expect(done.cost).toBe(Math.round(roadValue(doc)));
  });

  it('refuses a road the balance cannot cover, naming why, and leaves the map alone', () => {
    const { doc, net } = empty(1000);
    const preview = draw(doc, net, 0, 300, 0, true);
    expect(preview).toMatchObject({ committed: false, reason: 'funds' });
    expect(preview.cost).toBeGreaterThan(1000);
    const done = draw(doc, net, 0, 300);
    expect(done).toMatchObject({ committed: false, reason: 'funds' });
    expect(doc.segments.size).toBe(0);
    expect(doc.economy.balance).toBe(1000);
  });

  it('gives the money back on undo, and takes it again on redo', () => {
    const { doc, net } = empty();
    const before = serialize(doc);
    const start = doc.economy.balance;
    const cost = draw(doc, net, 0, 300).cost!;
    const after = serialize(doc);
    restoreSnapshot(doc, JSON.parse(before), net);
    expect(doc.economy.balance).toBe(start);
    expect(doc.segments.size).toBe(0);
    restoreSnapshot(doc, JSON.parse(after), net);
    expect(doc.economy.balance).toBe(start - cost);
  });

  it('charges a road drawn through the older commitDraft path too', () => {
    const { doc, net } = empty();
    const start = doc.economy.balance;
    const result = commitDraft(doc, net, { kind: 'free', at: { x: 0, y: 0 } }, { kind: 'free', at: { x: 0, y: 300 } }, 1);
    expect(result.committed).toBe(true);
    expect(doc.economy.balance).toBe(start - result.cost!);
    expect(result.cost).toBeGreaterThan(0);
  });

  it('charges nothing for a split, the difference for a wider class, and refuses what it cannot pay', () => {
    const { doc, net } = empty();
    draw(doc, net, 0, 300);
    const first = [...doc.segments.keys()][0] as SegmentId;
    // A split re-cuts the road: the same road, nothing to pay.
    const before = doc.economy.balance;
    const line = net.polylines.get(doc, first);
    expect(guardRoadEdit(doc, net, (work, workNet) => splitSegment(work, workNet, first, line.length / 2, line.sampleAt(line.length / 2).p) !== null).changed).toBe(true);
    expect(doc.segments.size).toBe(2);
    expect(doc.economy.balance).toBe(before);
    const id = [...doc.segments.keys()][0] as SegmentId;
    const balance = doc.economy.balance;
    // A wider class costs the difference.
    const widened = guardRoadEdit(doc, net, (work) => { work.setSegmentType(id, 3); return true; });
    expect(widened.changed).toBe(true);
    expect(doc.economy.balance).toBeLessThan(balance);
    // With no money left, the next widening is refused and undone.
    doc.setBalance(0);
    const lanes = doc.requireSegment(id).lanes;
    const refused = guardRoadEdit(doc, net, (work) => { work.setSegmentLanes(id, 8); return true; });
    expect(refused).toEqual({ changed: false, refused: 'funds' });
    expect(doc.requireSegment(id).lanes).toBe(lanes);
    expect(doc.economy.balance).toBe(0);
  });

  it('gives back the demolition share when a road is removed', () => {
    const { doc, net } = empty();
    draw(doc, net, 0, 300);
    const value = roadValue(doc);
    const balance = doc.economy.balance;
    const money = roadsBefore(doc);
    for (const id of [...doc.segments.keys()]) doc.removeSegment(id);
    doc.pruneOrphanNodes();
    const charge = settleRoadEdit(money, doc);
    expect(charge.amount).toBe(-Math.round(value * ROAD_TUNING.economy.demolitionRefund));
    expect(doc.economy.balance).toBe(balance + Math.round(value * ROAD_TUNING.economy.demolitionRefund));
  });

  it('pays for a node dragged to make its roads longer', () => {
    const { doc, net } = empty();
    draw(doc, net, 0, 300);
    const end = [...doc.nodes.values()].find((n) => n.x > 200)!;
    const balance = doc.economy.balance;
    const moved = moveNodeChecked(doc, net, end.id, { x: end.x + 100, y: end.y });
    expect(moved.committed).toBe(true);
    expect(moved.cost).toBeGreaterThan(0);
    expect(doc.economy.balance).toBe(balance - moved.cost!);
  });
});

describe('the balance on disk', () => {
  it('validates the saved field', () => {
    const doc = new RoadDoc();
    doc.setBalance(42);
    expect(isSerializedDoc(doc.toJSON())).toBe(true);
    expect(isSerializedDoc({ ...doc.toJSON(), economy: { balance: 'x' } })).toBe(false);
    expect(isSerializedDoc({ ...doc.toJSON(), economy: 7 })).toBe(false);
  });

  it('loads the test town (saved before the economy) as it was, at the starting balance', () => {
    const text = readFileSync('tests/fixtures/parking-town.json', 'utf8');
    const saved = JSON.parse(text);
    expect(isSerializedDoc(saved)).toBe(true);
    const doc = RoadDoc.fromJSON(saved);
    expect(doc.economy.balance).toBe(ROAD_TUNING.economy.startingFunds);
    // Written back, it carries no economy key: the same map as before the economy.
    expect('economy' in doc.toJSON()).toBe(false);
    expect(JSON.parse(doc.toText())).toEqual(doc.toJSON());
  });
});
