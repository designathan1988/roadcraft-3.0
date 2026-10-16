import { describe, expect, it } from 'vitest';
import { ForkMap, ForkSet } from '@core/forkMap';

/** A MAP LAID OVER ANOTHER READS AS A COPY OF IT GIVEN THE SAME WRITES (`core/forkMap.ts`) */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ForkMap', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`reads as a copy given the same writes, and takes back as one (seed ${seed})`, () => {
      const rand = random(seed);
      const below = new Map<number, string>();
      for (let i = 0; i < 40; i++) below.set(Math.floor(rand() * 60), `b${i}`);
      const frozen = [...below];
      const copy = new Map(below);
      const fork = new ForkMap(below);
      for (let step = 0; step < 300; step++) {
        const key = Math.floor(rand() * 80);
        const roll = rand();
        if (roll < 0.45) { copy.set(key, `s${step}`); fork.set(key, `s${step}`); }
        else if (roll < 0.8) expect(fork.delete(key)).toBe(copy.delete(key));
        else if (roll < 0.9) {
          const own = fork.writable(key, (v) => `${v}+`);
          if (copy.has(key) && !fork.owns(key)) throw new Error('writable must own the key');
          if (own !== undefined) copy.set(key, own);
          else expect(copy.has(key)).toBe(false);
        }
        expect(fork.get(key)).toBe(copy.get(key));
        expect(fork.has(key)).toBe(copy.has(key));
        expect(fork.size).toBe(copy.size);
      }
      expect([...fork]).toEqual([...copy]);
      expect([...fork.keys()]).toEqual([...copy.keys()]);
      expect([...fork.values()]).toEqual([...copy.values()]);
      expect([...below]).toEqual(frozen);
      fork.applyTo(below);
      expect([...below]).toEqual([...copy]);
    });
  }

  it('clears as a map does, and takes the clearing back', () => {
    const below = new Map([[1, 'a'], [2, 'b']]);
    const fork = new ForkMap(below);
    fork.clear();
    fork.set(2, 'c');
    fork.set(5, 'd');
    expect([...fork]).toEqual([[2, 'c'], [5, 'd']]);
    expect(fork.size).toBe(2);
    fork.applyTo(below);
    expect([...below]).toEqual([[2, 'c'], [5, 'd']]);
  });
});

describe('ForkSet', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`reads as a copy given the same writes, in the same order, and takes back as one (seed ${seed})`, () => {
      const rand = random(seed);
      const below = new Set<number>();
      for (let i = 0; i < 40; i++) below.add(Math.floor(rand() * 60));
      const frozen = [...below];
      const copy = new Set(below);
      const fork = new ForkSet(below);
      for (let step = 0; step < 300; step++) {
        const key = Math.floor(rand() * 80);
        if (rand() < 0.5) { copy.add(key); fork.add(key); } else expect(fork.delete(key)).toBe(copy.delete(key));
        expect(fork.has(key)).toBe(copy.has(key));
        expect(fork.size).toBe(copy.size);
      }
      expect([...fork]).toEqual([...copy]);
      expect([...below]).toEqual(frozen);
      fork.applyTo(below);
      expect([...below]).toEqual([...copy]);
    });
  }
});
