/** A COPY-ON-WRITE MAP OVER ANOTHER: a working copy of a keyed collection that costs what it writes, not what it holds. */
export class ForkMap<K, V> implements Map<K, V> {
  /** Keys of the map below given another value; still at their place. */
  private readonly replaced = new Map<K, V>();
  /** Keys after those below: new ones, and those below deleted and set again. */
  private readonly added = new Map<K, V>();
  /** Keys below deleted (those set again are in `added` too). */
  private readonly gone = new Set<K>();

  constructor(private readonly below: ReadonlyMap<K, V>) {}

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  get size(): number {
    return this.below.size - this.gone.size + this.added.size;
  }

  get(key: K): V | undefined {
    if (this.added.has(key)) return this.added.get(key);
    if (this.gone.has(key)) return undefined;
    if (this.replaced.has(key)) return this.replaced.get(key);
    return this.below.get(key);
  }

  has(key: K): boolean {
    return this.added.has(key) || (!this.gone.has(key) && this.below.has(key));
  }

  /** Whether the fork holds this key's value itself (written here), not the one below. */
  owns(key: K): boolean {
    return this.added.has(key) || this.replaced.has(key);
  }

  /** The value of `key` to change in place: the fork's own, or the one below copied (`copy`) and set here first. */
  writable(key: K, copy: (value: V) => V): V | undefined {
    if (this.added.has(key)) return this.added.get(key);
    if (this.replaced.has(key)) return this.replaced.get(key);
    if (this.gone.has(key)) return undefined;
    const value = this.below.get(key);
    if (value === undefined) return undefined;
    const own = copy(value);
    forkWork.copied++;
    this.replaced.set(key, own);
    return own;
  }

  set(key: K, value: V): this {
    if (this.added.has(key) || this.gone.has(key) || !this.below.has(key)) this.added.set(key, value);
    else this.replaced.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    if (this.added.delete(key)) return true;
    if (this.gone.has(key) || !this.below.has(key)) return false;
    this.replaced.delete(key);
    this.gone.add(key);
    return true;
  }

  /** DO NOT call it on a working copy for an edit: it marks every key below */
  clear(): void {
    this.replaced.clear();
    this.added.clear();
    for (const key of this.below.keys()) this.gone.add(key);
  }

  *entries(): MapIterator<[K, V]> {
    for (const [key, value] of this.below) {
      if (this.gone.has(key)) continue;
      yield [key, this.replaced.has(key) ? this.replaced.get(key)! : value];
    }
    yield* this.added.entries();
  }

  *keys(): MapIterator<K> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  forEach(visit: (value: V, key: K, map: Map<K, V>) => void, self?: unknown): void {
    for (const [key, value] of this.entries()) visit.call(self, value, key, this);
  }

  /** What the fork wrote, in the order `applyTo` takes it: deleted keys, replaced values, added values. */
  changes(): { readonly gone: ReadonlySet<K>; readonly replaced: ReadonlyMap<K, V>; readonly added: ReadonlyMap<K, V> } {
    return { gone: this.gone, replaced: this.replaced, added: this.added };
  }

  /** Writes the fork's changes into `target`, a map holding what the map below held */
  applyTo(target: { set(key: K, value: V): unknown; delete(key: K): unknown },
    put: (key: K, value: V) => void = (key, value) => { target.set(key, value); },
    drop: (key: K) => void = (key) => { target.delete(key); }): void {
    for (const key of this.gone) drop(key);
    for (const [key, value] of this.replaced) put(key, value);
    for (const [key, value] of this.added) put(key, value);
  }
}

/** A COPY-ON-WRITE SET OVER ANOTHER, as `ForkMap`: the set below is never written, and reads as a copy given the same writes. */
export class ForkSet<K> implements Set<K> {
  /** Keys after those below: new ones, and those below deleted and added again. */
  private readonly added = new Set<K>();
  /** Keys below deleted (those added again are in `added` too). */
  private readonly gone = new Set<K>();

  constructor(private readonly below: ReadonlySet<K>) {}

  get [Symbol.toStringTag](): string {
    return 'Set';
  }

  get size(): number {
    return this.below.size - this.gone.size + this.added.size;
  }

  has(key: K): boolean {
    return this.added.has(key) || (!this.gone.has(key) && this.below.has(key));
  }

  add(key: K): this {
    if (!this.has(key)) this.added.add(key);
    return this;
  }

  delete(key: K): boolean {
    if (this.added.delete(key)) return true;
    if (this.gone.has(key) || !this.below.has(key)) return false;
    this.gone.add(key);
    return true;
  }

  /** DO NOT call it on a working copy for an edit: it marks every key below */
  clear(): void {
    this.added.clear();
    for (const key of this.below) this.gone.add(key);
  }

  *values(): SetIterator<K> {
    for (const key of this.below) if (!this.gone.has(key)) yield key;
    yield* this.added;
  }

  keys(): SetIterator<K> {
    return this.values();
  }

  *entries(): SetIterator<[K, K]> {
    for (const key of this.values()) yield [key, key];
  }

  [Symbol.iterator](): SetIterator<K> {
    return this.values();
  }

  forEach(visit: (value: K, key: K, set: Set<K>) => void, self?: unknown): void {
    for (const key of this.values()) visit.call(self, key, key, this);
  }

  /** Writes the fork's changes into `target`, a set holding what the set below held: deleted keys, then added ones. */
  applyTo(target: Set<K>): void {
    for (const key of this.gone) target.delete(key);
    for (const key of this.added) target.add(key);
  }
}

/** The work of the working copies, and the lists and indices a document's fork copies when it writes them: records */
export const forkWork = { copied: 0 };
