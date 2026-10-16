/** DERIVED DATA kept in the player's browser: what the game makes from its own code the same way every time */
const DB = 'roadcraft-derived';
const STORE = 'entries';

let opening: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    // DO NOT keep it: closed for another tab's upgrade, every transaction on it threw
    const forget = (): void => { opening = null; };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab of a newer build asks to upgrade: let it.
      db.onversionchange = () => { db.close(); forget(); };
      db.onclose = forget;
      resolve(db);
    };
    request.onerror = () => { forget(); resolve(null); };
    request.onblocked = () => { forget(); resolve(null); };
  });
  return opening;
}

/** The keys from `prefix` up to every key that starts with it. */
const prefixRange = (prefix: string): IDBKeyRange => IDBKeyRange.bound(prefix, `${prefix}￿`);

/** One entry, or undefined when it is not kept. */
export async function readDerived<T>(key: string): Promise<T | undefined> {
  const db = await database();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Every entry whose key starts with `prefix`, by the rest of its key. */
export async function readDerivedAll<T>(prefix: string): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const db = await database();
  if (!db) return out;
  return new Promise((resolve) => {
    try {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const keys = store.getAllKeys(prefixRange(prefix));
      const values = store.getAll(prefixRange(prefix));
      values.onsuccess = () => {
        const list = keys.result ?? [];
        list.forEach((key, i) => out.set(String(key).slice(prefix.length), values.result[i] as T));
        resolve(out);
      };
      values.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

/** The keys kept under `prefix`, without it: the store's index alone, none of the values (`getAllKeys`, MDN IDBObjectStore). */
export async function readDerivedKeys(prefix: string): Promise<Set<string>> {
  const out = new Set<string>();
  const db = await database();
  if (!db) return out;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys(prefixRange(prefix));
      request.onsuccess = () => {
        for (const key of request.result) out.add(String(key).slice(prefix.length));
        resolve(out);
      };
      request.onerror = () => resolve(out);
    } catch (error) {
      console.warn('[derived] the kept keys could not be read; what they hold is made again', error);
      resolve(out);
    }
  });
}

/** These entries (each `prefix` + key), in one read-only transaction: a key no longer kept is left out. */
export async function readDerivedMany<T>(prefix: string, keys: readonly string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const db = await database();
  if (!db || !keys.length) return out;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      for (const key of keys) {
        const request = store.get(`${prefix}${key}`);
        request.onsuccess = () => { if (request.result !== undefined) out.set(key, request.result as T); };
        request.onerror = (event) => event.preventDefault();
      }
      tx.oncomplete = () => resolve(out);
      tx.onabort = () => resolve(out);
      tx.onerror = () => resolve(out);
    } catch (error) {
      console.warn('[derived] the kept entries could not be read; they are made again', error);
      resolve(out);
    }
  });
}

/** Keeps a value under `key`. */
async function keepDerived(key: string, value: unknown): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const request = tx.objectStore(STORE).put(value, key);
    request.onerror = (event) => event.preventDefault();
  } catch {
    // Not kept (no space, private window): made again next time.
  }
}

/** As `keepDerived`, and also tells when the write has committed (the transaction's `complete`, MDN) or failed */
export async function keepDerivedDurably(key: string, value: unknown): Promise<{ committed: Promise<void> }> {
  const db = await database();
  if (!db) return { committed: Promise.resolve() };
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const committed = new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
      tx.onerror = () => resolve();
    });
    const request = tx.objectStore(STORE).put(value, key);
    request.onerror = (event) => event.preventDefault();
    return { committed };
  } catch {
    return { committed: Promise.resolve() };
  }
}

/** Keeps a value under `key`, without waiting. */
export function writeDerived(key: string, value: unknown): void {
  void keepDerived(key, value);
}

/** Keeps many values, each under `prefix` and its own key, in one transaction */
export function writeDerivedMany(prefix: string, values: ReadonlyMap<string, unknown>): void {
  void keepDerivedMany(prefix, values);
}

/** As `writeDerivedMany`, resolved once the store has taken its copy of every value */
export async function keepDerivedMany(prefix: string, values: ReadonlyMap<string, unknown>): Promise<void> {
  if (!values.size) return;
  const db = await database();
  if (!db) return;
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const [key, value] of values) {
      const request = store.put(value, `${prefix}${key}`);
      request.onerror = (event) => event.preventDefault();
    }
  } catch {
    // Not kept (no space, private window): made again next time.
  }
}

/** Forgets these entries (each `prefix` + key), without waiting: one readwrite transaction, a `delete` per key */
export function forgetDerivedKeys(prefix: string, keys: Iterable<string>): void {
  const list = [...keys];
  if (!list.length) return;
  void database().then((db) => {
    if (!db) return;
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      for (const key of list) {
        const request = store.delete(`${prefix}${key}`);
        request.onerror = (event) => event.preventDefault();
      }
    } catch {
      // Left for another time.
    }
  });
}

/** Forgets the entries of `kind` kept under any other fingerprint (an older build's). */
export function forgetOtherDerived(kind: string, fingerprint: string): void {
  void database().then((db) => {
    if (!db) return;
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const keep = `${kind}:${fingerprint}:`;
      const request = store.getAllKeys(prefixRange(`${kind}:`));
      request.onsuccess = () => {
        for (const key of request.result) if (!String(key).startsWith(keep)) store.delete(key);
      };
    } catch {
      // Left for another time.
    }
  });
}
