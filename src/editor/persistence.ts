import { RoadDoc, type JunctionControl, type SegmentDirection, type SerializedDoc } from '@world/doc';
import { ROAD_TYPES } from '@world/roadTypes';
import { normalizeRoadSection } from '@world/roadSection';
import { migrateStructure } from '@world/structures';
import { isTerrainMode, isTerrainProfile, readRelief } from '@world/terrain';
import { isNatureSettings } from '@world/ecology';
import { readEconomy } from '@world/economy';
import { isSerializedBuildings } from '@world/buildings/serialize';
import { unitFactor } from '@world/rescale';
import { METERS_PER_UNIT, m, perM } from '@world/units';
import { type PartStore, PartedSaves, type StoredLayout, indexedDbParts } from './chunkedSave';

/** Where the map is kept. */
const KEY = 'roadcraft.world.v7';
/** Where storage the loader could not read is kept, rather than deleted. */
export const QUARANTINE_KEY = `${KEY}.unreadable`;
const DEBOUNCE_MS = 700;
/** The longest an edit waits to be saved, however many follow it (lodash `debounce`'s `maxWait`) */
const MAX_WAIT_MS = 3000;
/** The camera and simulation settings, on their own. */
const SETTINGS_KEY = 'roadcraft.settings.v1';
/** The largest session text written to `localStorage`, characters. */
const LOCAL_LIMIT_CHARS = 2_400_000;
/** The IndexedDB database and store of the large autosaves. */
const SAVES_DB = 'roadcraft-saves';
const SAVES_STORE = 'sessions';

export interface SavedSettings {
  readonly camera: {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
    /** The free camera's bearing and tilt, rad. Absent in saves older than the orbit. */
    readonly azimuth?: number;
    readonly elevation?: number;
  };
  readonly paused: boolean;
  readonly speed: number;
  readonly trafficIntensity: number;
  readonly pedestrianIntensity: number;
  /** Counts of cars and people on foot saved by the builds of 2026-10-06 to 10-11 (10 at first, 400 at most). */
  readonly cars?: number;
  readonly people?: number;
  readonly demandMultiplier?: number;
  readonly congestionOverlay: boolean;
  /** Metres per world unit the camera was saved in; absent: 0.4, before 2026-10-10. */
  readonly unit?: number;
}

/** Settings as stored, with their camera's unit (autosave and file). Here: in `mapExport.ts` it made an import cycle. */
export const withUnit = (settings: SavedSettings): SavedSettings => ({ ...settings, unit: METERS_PER_UNIT });

export interface SavedSession {
  readonly document: SerializedDoc;
  readonly settings: SavedSettings;
}

/** Autosave and file export. */
export class Persistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => void) | null = null;
  /** When the oldest unsaved edit asked to be saved (`MAX_WAIT_MS`). */
  private firstPending: number | null = null;

  /** Called when a write fails (storage full or refused). */
  onSaveFailed: (() => void) | null = null;

  /** The map's parts (`chunkedSave.ts`): what the diary says changed, never one text of the map; null without IndexedDB (the whole text). */
  private readonly parted: PartedSaves | null;
  /** What the opening read the map from (`loadSessionAsync`), for `adoptLoaded`. */
  private loadedParts: StoredLayout | null = null;

  constructor(private readonly storageKey = KEY, private readonly store: LargeStore = indexedDbStore, parts: PartStore | null = defaultParts()) {
    this.parted = parts ? new PartedSaves(parts, storageKey) : null;
  }

  /** The document just restored from `loadSessionAsync`: read from the parts, they are it, and the next save writes only what changes. */
  adoptLoaded(doc: RoadDoc): void {
    if (this.parted && this.loadedParts) this.parted.adopt(doc, this.loadedParts);
    this.loadedParts = null;
  }

  /** Set once this instance has rejected the stored entry. */
  private rejected = false;

  /** Stores the document, keeping whatever settings are already saved. */
  save(doc: RoadDoc): boolean {
    return this.saveSession(doc, this.loadSession()?.settings ?? defaultSettings());
  }

  /** Coalesces rapid edits into one write. */
  saveSoon(doc: RoadDoc): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save(doc);
    }, DEBOUNCE_MS);
  }

  /** The document as text, when the editor already has it */
  documentText: ((doc: RoadDoc) => string | null) | null = null;

  /** DO NOT write the pointer unasked */
  private generation = 0;
  /** The last write started (`written`, settled either way): what a closing desktop window waits for. */
  private lastWrite: Promise<unknown> = Promise.resolve();
  written(): Promise<void> { return this.lastWrite.then(() => undefined, () => undefined); }
  saveSession(doc: RoadDoc, settings: SavedSettings): boolean {
    const generation = ++this.generation;
    // DO NOT choose by the count of buildings: below it a map of any size of roads, lots and trees was one text an edit.
    if (this.parted) {
      this.writeSettings(settings);
      const key = this.storageKey, savedAt = Date.now();
      this.partsKept = true;
      this.lastWrite = this.parted.save(doc, withUnit(settings), savedAt).then((ok) => {
        if (!ok) { this.onSaveFailed?.(); return; }
        if (generation !== this.generation) return;
        try { localStorage.setItem(key, `{"version":2,"stored":"parts","savedAt":${savedAt}}`); } catch (error) { console.error('[save] the pointer to the parts was not written; the parts stand', error); }
      }, (error: unknown) => { console.error('[save] the parts could not be written', error); this.onSaveFailed?.(); });
      return true;
    }
    let session: string;
    try {
      const text = this.documentText?.(doc) ?? JSON.stringify(doc.toJSON());
      session = `{"version":2,"savedAt":${Date.now()},"document":${text},"settings":${JSON.stringify(withUnit(settings))}}`;
    } catch {
      this.onSaveFailed?.();
      return false;
    }
    if (session.length <= LOCAL_LIMIT_CHARS) {
      try {
        localStorage.setItem(this.storageKey, session);
        this.writeSettings(settings);
        this.dropParts();
        return true;
      } catch {
        // Full: the large store below.
      }
    }
    // Too large for Web Storage: IndexedDB, and once it is written the small key points there
    this.writeSettings(settings);
    const key = this.storageKey;
    const savedAt = Date.now();
    this.lastWrite = this.store.put(key, session).then((ok) => {
      if (!ok) { this.onSaveFailed?.(); return; }
      if (generation !== this.generation) return;
      this.dropParts();
      try { localStorage.setItem(key, `{"version":2,"stored":"indexeddb","savedAt":${savedAt}}`); } catch { /* the stored copy stands */ }
    }, (error: unknown) => { console.error('[save] the map could not be written to IndexedDB', error); this.onSaveFailed?.(); });
    return true;
  }

  /** Whether parts of a large map may still be stored (`dropParts`). */
  private partsKept = true;

  /** The parts of a large map removed once the map is saved whole again (it shrank, or another map was opened) */
  private dropParts(): void {
    if (!this.partsKept || !this.parted) return;
    this.partsKept = false;
    void this.parted.clear();
  }

  /** Reads the autosave from wherever it is: the small key, or IndexedDB for a session too large for it */
  async loadSessionAsync(): Promise<SavedSession | null> {
    const local = this.loadSession();
    let localAt = local ? -1 : -Infinity;
    try {
      const raw = localStorage.getItem(this.storageKey);
      const at = raw ? /"savedAt":(\d+)/.exec(raw.slice(0, 64)) : null;
      if (at && local) localAt = Number(at[1]);
    } catch { /* storage blocked */ }
    // The newest of the three copies: the small key, a large map in parts, the large store.
    let best = local, bestAt = localAt;
    this.loadedParts = null;
    const parted = this.parted ? await this.parted.read().catch((error: unknown) => { console.warn('[save] the parts of the map could not be read', error); return null; }) : null;
    let bestParts: StoredLayout | null = null;
    if (parted && parted.savedAt > bestAt) {
      const session = { version: 2, document: parted.document, settings: parted.settings };
      if (isSavedSession(session)) {
        best = { document: session.document, settings: this.readSettings() ?? normalizeSettings(session.settings) };
        bestAt = parted.savedAt;
        bestParts = { parts: parted.parts, head: parted.head };
      }
    }
    this.loadedParts = bestParts;
    const stored = await this.store.get(this.storageKey);
    if (!stored) return best;
    try {
      const parsed: unknown = JSON.parse(stored);
      if (isRecord(parsed) && isSavedSession(parsed)) {
        const storedAt = isFiniteNumber(parsed.savedAt) ? parsed.savedAt : 0;
        if (storedAt > bestAt) { this.loadedParts = null; return { document: parsed.document, settings: this.readSettings() ?? normalizeSettings(parsed.settings) }; }
      }
    } catch { /* unreadable: the newest other copy */ }
    return best;
  }

  saveSessionSoon(doc: RoadDoc, settings: () => SavedSettings): void {
    if (this.timer) clearTimeout(this.timer);
    this.pending = () => this.saveSession(doc, settings());
    const now = performance.now();
    this.firstPending ??= now;
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - this.firstPending)));
    this.timer = setTimeout(() => this.flushWhenIdle(), wait);
  }

  /** The idle callback a debounced save waits in (`flushWhenIdle`). */
  private idle: number | null = null;

  /** The debounced save, in the browser's idle time - within two seconds - rather than at a fixed moment */
  private flushWhenIdle(): void {
    this.timer = null;
    const host = globalThis as { requestIdleCallback?: (run: () => void, options?: { timeout: number }) => number };
    if (!host.requestIdleCallback) { this.flush(); return; }
    if (this.idle !== null) return;
    this.idle = host.requestIdleCallback(() => { this.idle = null; this.flush(); }, { timeout: 2000 });
  }

  private settingsTimer: ReturnType<typeof setTimeout> | null = null;

  /** Stores the camera and simulation settings alone, coalescing rapid changes. */
  saveSettingsSoon(settings: () => SavedSettings): void {
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.pendingSettings = settings;
    this.settingsTimer = setTimeout(() => this.flushSettings(), DEBOUNCE_MS);
  }

  private pendingSettings: (() => SavedSettings) | null = null;

  private flushSettings(): void {
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
    const pending = this.pendingSettings;
    this.pendingSettings = null;
    if (pending) this.writeSettings(pending());
  }

  private writeSettings(settings: SavedSettings): void {
    if (this.storageKey !== KEY) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(withUnit(settings)));
    } catch {
      /* Settings are a convenience; the map's own entry still carries them. */
    }
  }

  /** The separately stored settings, when present and readable. */
  private readSettings(): SavedSettings | null {
    if (this.storageKey !== KEY) return null;
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isSavedSettings(parsed) ? normalizeSettings(parsed) : null;
    } catch {
      return null;
    }
  }

  /** Writes a debounced save now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.idle !== null) {
      (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(this.idle);
      this.idle = null;
    }
    const pending = this.pending;
    this.pending = null;
    this.firstPending = null;
    pending?.();
    this.flushSettings();
  }

  load(): SerializedDoc | null {
    return this.loadSession()?.document ?? null;
  }

  /** Reads the autosave. */
  loadSession(): SavedSession | null {
    // Already rejected once in this page's lifetime.
    if (this.rejected) return null;

    let raw: string | null;
    try {
      raw = localStorage.getItem(this.storageKey);
    } catch {
      return null;
    }
    if (!raw) return null;

    try {
      const parsed: unknown = JSON.parse(raw);
      // A pointer to the large store (`saveSession`): read by `loadSessionAsync`.
      if (isRecord(parsed) && (parsed.stored === 'indexeddb' || parsed.stored === 'parts')) return null;
      if (isSerializedDoc(parsed)) return { document: parsed, settings: defaultSettings() };
      if (isSavedSession(parsed)) {
        return { document: parsed.document, settings: this.readSettings() ?? normalizeSettings(parsed.settings) };
      }
    } catch {
      // Unparseable. Fall through and set it aside rather than reread it.
    }

    this.rejected = true;
    quarantine(
      raw,
      this.storageKey,
      this.storageKey === KEY ? QUARANTINE_KEY : `${this.storageKey}.unreadable`,
    );
    return null;
  }

  /** Sets the stored map aside after it passed validation but failed to load (the loader threw). */
  quarantineStored(): void {
    this.rejected = true;
    // A large session that crashed the loader is moved aside in its store too (never deleted).
    const key = this.storageKey;
    void this.store.get(key).then(async (text) => {
      if (text !== null && await this.store.put(`${key}.unreadable.${Date.now()}`, text)) await this.store.delete(key);
    });
    // And a large map in parts, copied aside and then removed in one transaction.
    this.loadedParts = null;
    if (this.parted) void this.parted.setAside(Date.now());
    let raw: string | null;
    try {
      raw = localStorage.getItem(this.storageKey);
    } catch {
      return;
    }
    quarantine(raw, this.storageKey, this.storageKey === KEY ? QUARANTINE_KEY : `${this.storageKey}.unreadable`);
  }

  clear(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* ignore */
    }
  }
}

/** Sets unreadable storage aside — and never destroys it to do so. */
function quarantine(raw: string | null, sourceKey = KEY, quarantineKey = QUARANTINE_KEY): void {
  if (!raw) return;

  // `setItem` replaces what a key holds (MDN): a second map set aside over the first lost the first
  let target = quarantineKey;
  try {
    const held = localStorage.getItem(quarantineKey);
    if (held !== null && held !== raw) target = `${quarantineKey}.${Date.now()}`;
  } catch {
    // Storage unreadable: the write below fails the same way and keeps the original.
  }

  try {
    localStorage.setItem(target, raw);
  } catch {
    // No room for a copy.
    return;
  }

  try {
    localStorage.removeItem(sourceKey);
  } catch {
    /* The copy is safe; the original merely lingers. */
  }
}

/** The speeds the Simulation menu offers; anything else was never chosen there. */
const SPEEDS = [1, 2, 4];
/** The demand levels the menu offers. */
const DEMANDS = [0.55, 1, 1.55];

/** Settings as the controls can show them. */
export function normalizeSettings(settings: SavedSettings): SavedSettings {
  const intensity = (value: number): number => Math.min(MAX_INTENSITY, Math.max(0, value));
  const demand = settings.demandMultiplier;
  return {
    ...settings,
    camera: cameraInUnit(settings),
    unit: METERS_PER_UNIT,
    speed: SPEEDS.includes(settings.speed) ? settings.speed : 1,
    trafficIntensity: intensity(settings.trafficIntensity),
    pedestrianIntensity: intensity(settings.pedestrianIntensity),
    ...(demand === undefined ? {} : { demandMultiplier: DEMANDS.reduce((best, d) => Math.abs(d - demand) < Math.abs(best - demand) ? d : best, 1) }),
  };
}

/** The panel's Traffic and People: shares of the city's own density (`SimWorld.followCity`), 1 = 100 %, at most this. */
export const MAX_INTENSITY = 3;

/** The saved camera in this build's world unit (`world/rescale.ts`): its zoom is pixels a unit. */
function cameraInUnit(settings: SavedSettings): SavedSettings['camera'] {
  const factor = unitFactor(settings.unit);
  const c = settings.camera;
  return factor === 1 ? c : { ...c, zoom: c.zoom / factor, x: c.x * factor, y: c.y * factor };
}

function defaultSettings(): SavedSettings {
  return { camera: { x: 0, y: 0, zoom: perM(2.5) }, paused: false, speed: 1, trafficIntensity: 1, pedestrianIntensity: 1, congestionOverlay: false, unit: METERS_PER_UNIT };
}

function isSavedSession(value: unknown): value is SavedSession {
  if (!isRecord(value) || value.version !== 2 || !isSerializedDoc(value.document)) return false;
  return isSavedSettings(value.settings);
}

function isSavedSettings(settings: unknown): settings is SavedSettings {
  if (!isRecord(settings)) return false;
  const camera = settings.camera;
  return isRecord(camera) && isFiniteNumber(camera.x) && isFiniteNumber(camera.y) && isFiniteNumber(camera.zoom) &&
    (camera.azimuth === undefined || isFiniteNumber(camera.azimuth)) &&
    (camera.elevation === undefined || isFiniteNumber(camera.elevation)) &&
    typeof settings.paused === 'boolean' && isFiniteNumber(settings.speed) && isFiniteNumber(settings.trafficIntensity) &&
    isFiniteNumber(settings.pedestrianIntensity) &&
    (settings.cars === undefined || isFiniteNumber(settings.cars)) &&
    (settings.people === undefined || isFiniteNumber(settings.people)) &&
    (settings.demandMultiplier === undefined || isFiniteNumber(settings.demandMultiplier)) &&
    typeof settings.congestionOverlay === 'boolean';
}


/** What a file pick came to: a map, nothing chosen, or a file that is not one. */
export type ImportResult =
  | { readonly status: 'ok'; readonly session: SavedSession }
  | { readonly status: 'cancelled' }
  | { readonly status: 'invalid' };

/** Reads a map file chosen by the user. */
export async function importFromFile(): Promise<ImportResult> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    let settled = false;
    const finish = (value: ImportResult): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        finish({ status: 'cancelled' });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const session = readImportedSession(parsed);
        finish(session ? { status: 'ok', session } : { status: 'invalid' });
      } catch {
        finish({ status: 'invalid' });
      }
    };
    input.oncancel = () => finish({ status: 'cancelled' });
    // Browsers without a `cancel` event: the window regains focus when the dialog closes
    window.addEventListener('focus', () => {
      setTimeout(() => { if (!input.files?.length) finish({ status: 'cancelled' }); }, 1000);
    }, { once: true });
    input.click();
  });
}

/** Accepts legacy geometry-only files while preserving complete session files. */
function readImportedSession(value: unknown): SavedSession | null {
  if (isSerializedDoc(value)) return { document: value, settings: defaultSettings() };
  return isSavedSession(value) ? { document: value.document, settings: normalizeSettings(value.settings) } : null;
}

/** Strict boundary validation for local storage and imported files. */
export function isSerializedDoc(value: unknown): value is SerializedDoc {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.segments)) return false;

  const nodeIds = new Set<number>();
  for (const node of value.nodes) {
    if (!isRecord(node)) return false;
    if (!isId(node.id) || nodeIds.has(node.id)) return false;
    if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y)) return false;
    if (node.heightOffset !== undefined && !isFiniteNumber(node.heightOffset)) return false;
    if (node.smooth !== undefined && typeof node.smooth !== 'boolean') return false;
    if (node.control !== undefined && !isJunctionControl(node.control)) return false;
    if (node.blockedMovements !== undefined && (!Array.isArray(node.blockedMovements) ||
      node.blockedMovements.some((movement) => typeof movement !== 'string'))) return false;
    nodeIds.add(node.id);
  }

  const segmentIds = new Set<number>();
  for (const segment of value.segments) {
    if (!isRecord(segment)) return false;
    if (!isId(segment.id) || segmentIds.has(segment.id)) return false;
    if (!isId(segment.a) || !isId(segment.b) || segment.a === segment.b) return false;
    if (!nodeIds.has(segment.a) || !nodeIds.has(segment.b)) return false;
    if (
      typeof segment.type !== 'number' ||
      !Number.isInteger(segment.type) ||
      segment.type < 0 ||
      segment.type >= ROAD_TYPES.length
    ) {
      return false;
    }
    if (segment.dashOrigin !== undefined && !isFiniteNumber(segment.dashOrigin)) return false;
    if (segment.direction !== undefined && !isSegmentDirection(segment.direction)) return false;
    if (segment.section !== undefined && !normalizeRoadSection(segment.section)) return false;
    if (segment.structure !== undefined && migrateStructure(segment.structure) === null) return false;
    if (segment.lanes !== undefined && segment.lanes !== null &&
      (!isFiniteNumber(segment.lanes) || !Number.isInteger(segment.lanes) || segment.lanes < 1 || segment.lanes > 8)) return false;
    if (segment.curve !== null) {
      if (!isRecord(segment.curve)) return false;
      if (!isFiniteNumber(segment.curve.t) || !isFiniteNumber(segment.curve.h)) return false;
    }
    segmentIds.add(segment.id);
  }

  // The relief versions the document reads (`terrain.ts` readRelief): a list of its own here missed one
  if (value.relief !== undefined && readRelief(value.relief) === null) return false;
  if (value.nature !== undefined && !isNatureSettings(value.nature)) return false;
  if (value.terrain !== undefined) {
    if (!Array.isArray(value.terrain)) return false;
    const terrainIds = new Set<number>();
    for (const stamp of value.terrain) {
      if (!isRecord(stamp) || !isId(stamp.id) || terrainIds.has(stamp.id)) return false;
      if (!isFiniteNumber(stamp.x) || !isFiniteNumber(stamp.y) ||
        !isFiniteNumber(stamp.radius) || stamp.radius <= 0 || stamp.radius > MAX_STAMP_RADIUS ||
        (stamp.level !== undefined && !isFiniteNumber(stamp.level)) ||
        (stamp.stroke !== undefined && !isId(stamp.stroke)) ||
        (stamp.ox !== undefined && !isFiniteNumber(stamp.ox)) ||
        (stamp.oy !== undefined && !isFiniteNumber(stamp.oy)) ||
        (stamp.rough !== undefined && typeof stamp.rough !== 'boolean') ||
        (stamp.hardness !== undefined && (!isFiniteNumber(stamp.hardness) || stamp.hardness < 0 || stamp.hardness > 1)) ||
        (stamp.profile !== undefined && !isTerrainProfile(stamp.profile)) ||
        !isFiniteNumber(stamp.strength) || stamp.strength < 0 ||
        !isTerrainMode(stamp.mode)) return false;
      terrainIds.add(stamp.id);
    }
  }

  // Poles and spans.
  const poleIds = new Set<number>();
  if (value.poles !== undefined) {
    if (!Array.isArray(value.poles)) return false;
    for (const pole of value.poles) {
      if (!isRecord(pole) || !isId(pole.id) || poleIds.has(pole.id)) return false;
      if (!isFiniteNumber(pole.x) || !isFiniteNumber(pole.y)) return false;
      if (pole.lamp !== undefined && typeof pole.lamp !== 'boolean') return false;
      poleIds.add(pole.id);
    }
  }
  if (value.poleSpans !== undefined) {
    if (!Array.isArray(value.poleSpans)) return false;
    const spanIds = new Set<number>();
    for (const span of value.poleSpans) {
      if (!isRecord(span) || !isId(span.id) || spanIds.has(span.id)) return false;
      if (!isId(span.a) || !isId(span.b) || span.a === span.b) return false;
      if (!poleIds.has(span.a) || !poleIds.has(span.b)) return false;
      spanIds.add(span.id);
    }
  }

  // Buildings: the list itself must be a list.
  if (!isSerializedBuildings(value.buildings)) return false;
  // People are normalised one by one on load; the key only has to be a list.
  if (value.people !== undefined && !Array.isArray(value.people)) return false;
  // The balance (`world/economy.ts`), when the map carries one: a finite number.
  if (value.economy !== undefined && readEconomy(value.economy) === null) return false;

  return true;
}

function isJunctionControl(value: unknown): value is JunctionControl {
  return value === 'auto' || value === 'signal' || value === 'stop' || value === 'yield' || value === 'priority' || value === 'none' || value === 'mini';
}

function isSegmentDirection(value: unknown): value is SegmentDirection {
  return value === 'both' || value === 'aToB' || value === 'bToA';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Ids stay far below 2^53: an allocator reserved past it stops counting */
const MAX_ID = 2 ** 31;
/** The widest stamp a map may hold: the map itself (4 800 units across). */
const MAX_STAMP_RADIUS = m(1_920);

function isId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_ID;
}

export { RoadDoc };

/** Where a session too large for Web Storage is kept (`LOCAL_LIMIT_CHARS`). */
export interface LargeStore {
  get(key: string): Promise<string | null>;
  put(key: string, text: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
}
const indexedDbStore: LargeStore = { get: (key) => storeGet(key), put: (key, text) => storePut(key, text), delete: (key) => storeDelete(key) };
/** The map's parts in IndexedDB where the browser has it and gzip streams (MDN, `CompressionStream`); none elsewhere. */
function defaultParts(): PartStore | null {
  return typeof indexedDB !== 'undefined' && typeof CompressionStream !== 'undefined' ? indexedDbParts(openSaves, SAVES_STORE) : null;
}
/** The large autosaves' database (`LOCAL_LIMIT_CHARS`); null where IndexedDB is missing or refused. */
let savesDb: Promise<IDBDatabase | null> | null = null;
function openSaves(): Promise<IDBDatabase | null> {
  savesDb ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const request = indexedDB.open(SAVES_DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(SAVES_STORE); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return savesDb;
}
async function storeRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  const db = await openSaves();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(SAVES_STORE, mode);
      const request = run(tx.objectStore(SAVES_STORE));
      tx.oncomplete = () => resolve((request.result as T) ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
function storeGet(key: string): Promise<string | null> {
  return storeRequest<unknown>('readonly', (store) => store.get(key)).then((v) => (typeof v === 'string' ? v : null));
}
function storePut(key: string, text: string): Promise<boolean> {
  return storeRequest<unknown>('readwrite', (store) => store.put(text, key)).then((v) => v !== null);
}
function storeDelete(key: string): Promise<boolean> {
  return storeRequest<unknown>('readwrite', (store) => store.delete(key)).then(() => true);
}
