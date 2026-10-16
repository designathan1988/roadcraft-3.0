import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILDINGS_PER_PART, RECORDS_PER_PART, type PartStore, PartedSaves } from '@editor/chunkedSave';
import { type LargeStore, Persistence, normalizeSettings } from '@editor/persistence';
import { RoadDoc } from '@world/doc';
import { growCity } from '../world/cityAudit';

/** THE MAP IS SAVED IN PARTS (`chunkedSave.ts`): never one text of the whole map. */

/** An IndexedDB stand-in that counts what each write touched; `refuse` makes the next write fail. */
function memoryStore(): PartStore & { readonly blobs: Map<string, Blob>; writes: string[][]; refuse: boolean } {
  const blobs = new Map<string, Blob>();
  const store = {
    blobs,
    writes: [] as string[][],
    refuse: false,
    async get(keys: readonly string[]) { return keys.map((k) => blobs.get(k) ?? null); },
    async write(put: readonly (readonly [string, Blob])[], remove: readonly string[]) {
      if (store.refuse) { store.refuse = false; return false; }
      for (const [k, b] of put) blobs.set(k, b);
      for (const k of remove) blobs.delete(k);
      store.writes.push(put.map(([k]) => k));
      return true;
    },
  };
  return store;
}

/** A document as the whole-text save reads it back. */
const asWhole = (doc: RoadDoc): unknown => RoadDoc.fromJSON(JSON.parse(doc.toText())).toJSON();

const town = (): RoadDoc => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')));

describe('a map saved in parts', () => {
  it('reads back the map it saved', async () => {
    const doc = town();
    expect(doc.buildings.size).toBeGreaterThan(BUILDINGS_PER_PART);
    const saves = new PartedSaves(memoryStore(), 'map');
    expect(await saves.save(doc, { camera: 1 }, 1234)).toBe(true);
    const read = await saves.read();
    expect(read?.savedAt).toBe(1234);
    expect(read?.settings).toEqual({ camera: 1 });
    // The same document as the whole-text save gives.
    expect(RoadDoc.fromJSON(read!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('writes again only what the diary says changed', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    const parts = (keys: readonly string[]): string[] => keys.filter((k) => k.includes(':part:'));
    expect(parts(store.writes[0]!).length).toBeGreaterThan(1);
    expect(store.writes[0]).toContain('map:head:nodes:0');
    expect(store.writes[0]).toContain('map:head:terrain');
    // Nothing changed: the manifest alone, no part and no head.
    await saves.save(doc, {});
    expect(store.writes[1]).toEqual(['map:manifest']);
    // One building changed: its part alone, not the head.
    const one = [...doc.buildings.all()][3]!;
    doc.buildings.put({ ...one, decay: 0.5 });
    await saves.save(doc, {});
    expect(store.writes[2]).toEqual([`map:part:${Math.floor(one.id / BUILDINGS_PER_PART)}`, `map:wear:${Math.floor(one.id / BUILDINGS_PER_PART)}`, 'map:manifest']);
    // A road changed: the parts of the head its ids fall in, of the roads alone; no building part.
    const node = [...doc.nodes.values()][0]!;
    doc.setNodeHeightOffset(node.id, node.heightOffset + 1);
    await saves.save(doc, {});
    const part = Math.floor(node.id / RECORDS_PER_PART);
    expect(store.writes[3]!.filter((k) => k !== `map:head:segments:${part}`)).toEqual([`map:head:nodes:${part}`, 'map:manifest']);
    const read = await saves.read();
    expect(RoadDoc.fromJSON(read!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('writes a building aged as the wears of its part, never the records of its part again', async () => {
    // DO NOT write a part's records for wear
    const doc = town();
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    const aged = [...doc.buildings.all()].filter((_, i) => i % 97 === 0);
    for (const b of aged) doc.buildings.wear(b.id, 0.6);
    await saves.save(doc, {});
    const written = store.writes.at(-1)!;
    expect(written.filter((k) => k.includes(':part:'))).toEqual([]);
    expect(written.filter((k) => k.includes(':wear:')).length).toBe(new Set(aged.map((b) => Math.floor(b.id / BUILDINGS_PER_PART))).size);
    // Read back, worn: the wears laid over the records stored before.
    const read = await saves.read();
    expect(RoadDoc.fromJSON(read!.document).toJSON()).toEqual(doc.toJSON());
    // A map saved before the wears were kept apart (no `:wear:` key) reads its records as they are.
    for (const key of [...store.blobs.keys()]) if (key.includes(':wear:')) store.blobs.delete(key);
    const old = await saves.read();
    expect(old!.document.buildings!.length).toBe(doc.buildings.size);
  });

  it('keeps what a failed write did not write for the next save', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    const one = [...doc.buildings.all()][5]!;
    doc.buildings.put({ ...one, decay: 0.25 });
    store.refuse = true;
    expect(await saves.save(doc, {})).toBe(false);
    await saves.save(doc, {});
    expect(store.writes.at(-1)).toEqual([`map:part:${Math.floor(one.id / BUILDINGS_PER_PART)}`, `map:wear:${Math.floor(one.id / BUILDINGS_PER_PART)}`, 'map:manifest']);
    const read = await saves.read();
    expect(RoadDoc.fromJSON(read!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('a map opened from its parts is not written again whole', async () => {
    const store = memoryStore();
    await new PartedSaves(store, 'map').save(town(), {});
    const reader = new PartedSaves(store, 'map');
    const read = await reader.read();
    const doc = RoadDoc.fromJSON(read!.document);
    reader.adopt(doc, read!);
    const one = [...doc.buildings.all()][2]!;
    doc.buildings.put({ ...one, decay: 0.75 });
    await reader.save(doc, {});
    expect(store.writes.at(-1)).toEqual([`map:part:${Math.floor(one.id / BUILDINGS_PER_PART)}`, `map:wear:${Math.floor(one.id / BUILDINGS_PER_PART)}`, 'map:manifest']);
    expect(RoadDoc.fromJSON((await reader.read())!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('a building taken away empties its part, and the part goes', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    const last = Math.max(...[...doc.buildings.all()].map((b) => b.id));
    const part = Math.floor(last / BUILDINGS_PER_PART);
    for (const b of [...doc.buildings.all()]) if (Math.floor(b.id / BUILDINGS_PER_PART) === part) doc.buildings.remove(b.id);
    await saves.save(doc, {});
    expect(store.blobs.has(`map:part:${part}`)).toBe(false);
    expect(RoadDoc.fromJSON((await saves.read())!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('writes a road edit as the parts of the head its records fall in, never the whole head', async () => {
    // DO NOT write the head as one text: every road, pole, bench and lot of the map gzipped again for one node
    const { doc } = growCity({ seed: 2, size: 'small', style: 'blocks' });
    for (let k = 0; k < 3000; k++) doc.addLandscape('bench', { x: (k % 60) * 20, y: Math.floor(k / 60) * 20 });
    expect(doc.lotStore.size).toBeGreaterThan(50);
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    const first = store.writes[0]!.filter((k) => k.startsWith('map:head:'));
    expect(first.filter((k) => k.startsWith('map:head:landscape:')).length).toBe(Math.ceil(3000 / RECORDS_PER_PART) + 0);
    const node = [...doc.nodes.values()].find((n) => n.incident.length === 2)!;
    doc.moveNode(node.id, { x: node.x + 3, y: node.y });
    const bench = doc.addLandscape('bin', { x: 5, y: 5 });
    await saves.save(doc, {});
    const written = store.writes.at(-1)!;
    expect(written.every((k) => k === 'map:manifest' || /^map:head:(nodes|segments|landscape):\d+$/.test(k))).toBe(true);
    expect(written).toContain(`map:head:landscape:${Math.floor(bench.id / RECORDS_PER_PART)}`);
    expect(written.length).toBeLessThan(first.length / 2);
    expect(RoadDoc.fromJSON((await saves.read())!.document).toJSON()).toEqual(asWhole(doc));
  });

  it('reads the lots back in their order, and a part emptied goes', async () => {
    const { doc } = growCity({ seed: 4, size: 'small', style: 'blocks' });
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    await saves.save(doc, {});
    // A lot taken away and put back stands last in the lots' order, whatever its id (`LotStore.restore`).
    const lot = doc.lotStore.get([...doc.lotStore.all()][1]!.id)!;
    doc.lotStore.restore([{ id: lot.id, value: undefined }], 'test');
    doc.lotStore.restore([{ id: lot.id, value: lot }], 'test');
    expect(doc.toJSON().lots!.at(-1)!.id).toBe(lot.id);
    const wall = doc.addBarrier('wall', [{ x: 0, y: 0 }, { x: 20, y: 0 }])!;
    await saves.save(doc, {});
    expect(store.blobs.has(`map:head:barriers:${Math.floor(wall.id / RECORDS_PER_PART)}`)).toBe(true);
    doc.removeBarrier(wall.id);
    await saves.save(doc, {});
    expect(store.blobs.has(`map:head:barriers:${Math.floor(wall.id / RECORDS_PER_PART)}`)).toBe(false);
    const read = (await saves.read())!;
    expect(read.document.lots!.at(-1)!.id).toBe(lot.id);
    expect(RoadDoc.fromJSON(read.document).toJSON()).toEqual(asWhole(doc));
  });

  it('opens a map saved with the head as one text, and writes it in parts at the next save', async () => {
    // A map saved before the head was in parts (manifest 3, `:head`) keeps loading
    const doc = town();
    const store = memoryStore();
    await new PartedSaves(store, 'map').save(doc, {}, 500);
    for (const key of [...store.blobs.keys()]) if (key.startsWith('map:head:')) store.blobs.delete(key);
    const gzip = (text: string): Promise<Blob> => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    const { buildings: _buildings, ...head } = doc.toJSON();
    store.blobs.set('map:head', await gzip(JSON.stringify(head)));
    const manifest = JSON.parse(await store.blobs.get('map:manifest')!.text()) as Record<string, unknown>;
    store.blobs.set('map:manifest', new Blob([JSON.stringify({ version: 3, savedAt: 500, parts: manifest['parts'], settings: {} })]));
    const reader = new PartedSaves(store, 'map');
    const read = (await reader.read())!;
    expect(read.head).toBeNull();
    const opened = RoadDoc.fromJSON(read.document);
    expect(opened.toJSON()).toEqual(doc.toJSON());
    reader.adopt(opened, read);
    await reader.save(opened, {});
    expect(store.blobs.has('map:head')).toBe(false);
    expect(store.writes.at(-1)!.filter((k) => k.includes(':part:'))).toEqual([]);
    expect(store.writes.at(-1)).toContain('map:head:nodes:0');
    expect(RoadDoc.fromJSON((await reader.read())!.document).toJSON()).toEqual(doc.toJSON());
  });

  it('writes the head as it stood when the save began, whatever is edited while it compresses', async () => {
    const doc = town();
    const store = memoryStore();
    const saves = new PartedSaves(store, 'map');
    const want = asWhole(doc);
    const saving = saves.save(doc, {});
    // Edited while the parts are gzipped: a road whose nodes the head read before it would not hold.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const a = doc.addNode({ x: 300, y: 300 }), b = doc.addNode({ x: 360, y: 300 });
    doc.addSegment(a.id, b.id, 1);
    await saving;
    expect(RoadDoc.fromJSON((await saves.read())!.document).toJSON()).toEqual(want);
    await saves.save(doc, {});
    expect(RoadDoc.fromJSON((await saves.read())!.document).toJSON()).toEqual(asWhole(doc));
  });

  it('reads nothing where nothing was saved', async () => {
    expect(await new PartedSaves(memoryStore(), 'map').read()).toBeNull();
  });
});

describe('a map in parts among the other copies', () => {
  const KEY = 'roadcraft.world.v7';
  const real = (globalThis as { localStorage?: Storage | undefined }).localStorage;
  afterEach(() => { (globalThis as { localStorage?: Storage | undefined }).localStorage = real; });
  const useStorage = (): void => {
    const items = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      get length() { return items.size; },
      key: (n: number) => [...items.keys()][n] ?? null,
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => { items.set(k, String(v)); },
      removeItem: (k: string) => { items.delete(k); },
      clear: () => items.clear(),
    };
  };
  const largeStore = (): LargeStore & { items: Map<string, string> } => {
    const items = new Map<string, string>();
    return { items, get: async (k) => items.get(k) ?? null, put: async (k, v) => { items.set(k, v); return true; }, delete: async (k) => items.delete(k) };
  };
  const settings = normalizeSettings({ camera: { x: 0, y: 0, zoom: 1 }, paused: true, speed: 1, trafficIntensity: 1, pedestrianIntensity: 1, congestionOverlay: false });
  const small = (): RoadDoc => RoadDoc.fromJSON({ version: 1, nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 0 }], segments: [{ id: 1, a: 1, b: 2, type: 1, curve: null }] } as never);

  it('the newest copy opens, whichever store holds it', async () => {
    useStorage();
    const parts = memoryStore();
    const large = largeStore();
    const whole = (savedAt: number): string => JSON.stringify({ version: 2, savedAt, document: small().toJSON(), settings });
    await new PartedSaves(parts, KEY).save(town(), settings, 1000);
    large.items.set(KEY, whole(2000));
    // The whole copy is newer: a large map gave way to a smaller one saved after it.
    expect((await new Persistence(undefined, large, parts).loadSessionAsync())?.document.buildings ?? []).toHaveLength(0);
    await new PartedSaves(parts, KEY).save(town(), settings, 3000);
    expect((await new Persistence(undefined, large, parts).loadSessionAsync())?.document.buildings?.length).toBe(town().buildings.size);
  });

  it('a small map is saved in parts too, never as one text', async () => {
    // Chosen by the count of buildings, a map of few buildings was written whole on every edit, whatever its roads
    useStorage();
    const parts = memoryStore();
    const large = largeStore();
    new Persistence(undefined, large, parts).saveSession(small(), settings);
    await vi.waitFor(() => expect(parts.blobs.has(`${KEY}:manifest`)).toBe(true));
    expect(large.items.size).toBe(0);
    expect(localStorage.getItem(KEY)).toContain('"stored":"parts"');
    expect((await new Persistence(undefined, large, parts).loadSessionAsync())?.document.nodes?.length).toBe(2);
  });

  it('a map in parts that failed to load is set aside, never deleted', async () => {
    useStorage();
    const parts = memoryStore();
    await new PartedSaves(parts, KEY).save(town(), settings, 1000);
    const held = parts.blobs.size;
    new Persistence(undefined, largeStore(), parts).quarantineStored();
    await vi.waitFor(() => expect([...parts.blobs.keys()].every((k) => k.startsWith(`${KEY}.unreadable.`))).toBe(true));
    expect(parts.blobs.size).toBe(held);
    // Not read again on the next opening.
    expect(await new Persistence(undefined, largeStore(), parts).loadSessionAsync()).toBeNull();
  });
});
