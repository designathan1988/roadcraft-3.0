/** THE SURGICAL PROFILER: what each frame disposed of, built and uploaded, who called it, and how the heap moved */

/** What is counted. */
export type ProfiledEvent =
  | 'dispose.geometry' | 'dispose.material' | 'dispose.texture' | 'dispose.target'
  | 'build.geometry' | 'upload.buffer' | 'upload.texture';

/** One counter over a frame, a window of a second, and the whole run. */
interface Tally {
  frame: number;
  /** Bytes (uploads), else 0. */
  frameBytes: number;
  window: number;
  windowBytes: number;
  peak: number;
  total: number;
  totalBytes: number;
  /** Count per call site in the current window (scaled when sampled). */
  sites: Map<string, number>;
  /** The last window's sites, largest first. */
  lastSites: [string, number][];
  /** The latest call: its site and a short stack. */
  last: { site: string; stack: string; at: number } | null;
}

/** First calls of a frame whose site is read every time; past them, one in `SITE_STRIDE`. */
const SITES_EXACT = 48;
const SITE_STRIDE = 16;
/** Frames of the HUD's window. */
const WINDOW_MS = 1000;
/** Stack lines kept for the latest call. */
const STACK_LINES = 6;

/** Frames of three, Vite, the profiler itself: not the caller. */
const NOT_CALLER = /profiler|node_modules|\/three\/|three\.module|\.vite\/deps|<anonymous>|^\s*at new Promise/;

function stackHere(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 14;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  return stack;
}

/** `fn @ file:line` of a stack line ("    at fn (http://host/src/a/b.ts?t=1:12:3)"). */
function shortLine(line: string): string {
  const m = /at (?:(.+?) \()?(?:https?:\/\/[^/]+\/)?([^?:)]+)(?:\?[^:]*)?:(\d+):\d+\)?/.exec(line);
  if (!m) return line.trim();
  return `${m[1] ?? '(anon)'} @ ${m[2]!.replace(/^src\//, '')}:${m[3]}`;
}

/** The caller's lines of a stack, three and the profiler left out. */
function callerLines(stack: string): string[] {
  return stack.split('\n').slice(1).filter((l) => l.includes(' at ') && !NOT_CALLER.test(l)).map(shortLine);
}

/** One product's refresh as the engine timed it (`core/engine.ts`). */
export interface ProductTiming {
  readonly name: string;
  readonly phase: string;
  readonly ms: number;
  readonly keys: number;
  /** It computed in a refresh where no input it is told of had moved: work for nothing. */
  readonly idle: boolean;
}

/** A change of the document's diary seen in a frame: what set the rebuilds off. */
export interface ChangeSeen {
  readonly kind: string;
  readonly cause: string;
  readonly ids: number;
}

export class Profiler {
  /** Counting at all: only while its HUD is shown (`profilerHud.ts`). */
  enabled = false;
  private readonly tallies = new Map<ProfiledEvent, Tally>();
  private frameCalls = 0;
  private windowStart = 0;
  private frames = 0;
  private framesInWindow = 0;
  private frameStart = 0;
  /** Frame times of the window, ms. */
  private frameMs: number[] = [];
  /** Last window's frame time: median and worst. */
  frameP50 = 0;
  frameMax = 0;
  fps = 0;
  /** Engine products of the last refresh of each phase. */
  readonly products = new Map<string, ProductTiming>();
  /** Products that computed for nothing, ever (name → times). */
  readonly idleProducts = new Map<string, number>();
  /** Diary entries of the last window, by kind and cause. */
  private changesWindow = new Map<string, number>();
  lastChanges: [string, number][] = [];
  /** Latest heap readings: MB, and MB per second over the last window. */
  heapMB: number | null = null;
  heapRate = 0;
  private heapAt = { mb: 0, t: 0 };
  /** Biggest drop of the heap in the window: a collection, MB. */
  gcDropMB = 0;
  /** Long tasks (> 50 ms) lately, newest first: ms and when. */
  readonly longTasks: { ms: number; at: number }[] = [];
  /** Milliseconds per frame system and per measured step (`hitch:`) in the window, and the last window's, largest first. */
  private stepsWindow = new Map<string, number>();
  lastSteps: [string, number][] = [];

  /** Time a system of the frame or a measured step took (ms). */
  step(name: string, ms: number): void {
    if (!this.enabled || ms <= 0) return;
    this.stepsWindow.set(name, (this.stepsWindow.get(name) ?? 0) + ms);
  }

  /** Extra gauges set by the renderer (draw calls, geometries on the GPU...). */
  readonly gauges = new Map<string, number>();

  private tally(event: ProfiledEvent): Tally {
    let t = this.tallies.get(event);
    if (!t) {
      t = { frame: 0, frameBytes: 0, window: 0, windowBytes: 0, peak: 0, total: 0, totalBytes: 0, sites: new Map(), lastSites: [], last: null };
      this.tallies.set(event, t);
    }
    return t;
  }

  /** Counts one event (and its bytes), with its call site when sampled. */
  count(event: ProfiledEvent, bytes = 0): void {
    if (!this.enabled) return;
    const t = this.tally(event);
    t.frame++;
    t.frameBytes += bytes;
    t.total++;
    t.totalBytes += bytes;
    const n = ++this.frameCalls;
    const weight = n <= SITES_EXACT ? 1 : n % SITE_STRIDE === 0 ? SITE_STRIDE : 0;
    if (weight === 0) return;
    const lines = callerLines(stackHere());
    const site = lines[0] ?? '(three)';
    t.sites.set(site, (t.sites.get(site) ?? 0) + weight);
    t.last = { site, stack: lines.slice(0, STACK_LINES).join('\n'), at: performance.now() };
  }

  /** A diary entry the frame saw. */
  change(seen: ChangeSeen): void {
    const key = `${seen.kind} ← ${seen.cause}`;
    this.changesWindow.set(key, (this.changesWindow.get(key) ?? 0) + Math.max(1, seen.ids));
  }

  /** An engine product's refresh. */
  product(timing: ProductTiming): void {
    this.products.set(timing.name, timing);
    if (timing.idle) this.idleProducts.set(timing.name, (this.idleProducts.get(timing.name) ?? 0) + 1);
  }

  longTask(ms: number): void {
    this.longTasks.unshift({ ms, at: performance.now() });
    if (this.longTasks.length > 8) this.longTasks.pop();
  }

  heap(bytes: number | undefined, now = performance.now()): void {
    if (bytes === undefined) return;
    const mb = bytes / 1e6;
    if (this.heapMB !== null && mb < this.heapMB) this.gcDropMB = Math.max(this.gcDropMB, this.heapMB - mb);
    this.heapMB = mb;
    if (!this.heapAt.t) this.heapAt = { mb, t: now };
  }

  beginFrame(now = performance.now()): void {
    this.frameStart = now;
  }

  /** Closes the frame: the frame's counts into the window; every `WINDOW_MS`, the window into the HUD's numbers. */
  endFrame(now = performance.now()): void {
    this.frames++;
    this.framesInWindow++;
    if (this.frameStart) this.frameMs.push(now - this.frameStart);
    for (const t of this.tallies.values()) {
      t.window += t.frame;
      t.windowBytes += t.frameBytes;
      t.peak = Math.max(t.peak, t.frame);
      t.frame = 0;
      t.frameBytes = 0;
    }
    this.frameCalls = 0;
    if (!this.windowStart) this.windowStart = now;
    if (now - this.windowStart < WINDOW_MS) return;
    const seconds = (now - this.windowStart) / 1000;
    this.fps = this.framesInWindow / seconds;
    const sorted = [...this.frameMs].sort((a, b) => a - b);
    this.frameP50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
    this.frameMax = sorted[sorted.length - 1] ?? 0;
    this.frameMs = [];
    for (const t of this.tallies.values()) {
      t.lastSites = [...t.sites].sort((a, b) => b[1] - a[1]).slice(0, 6);
      t.sites.clear();
    }
    this.lastChanges = [...this.changesWindow].sort((a, b) => b[1] - a[1]).slice(0, 6);
    this.changesWindow.clear();
    this.lastSteps = [...this.stepsWindow].map(([k, ms]): [string, number] => [k, round(ms / seconds)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    this.stepsWindow.clear();
    if (this.heapMB !== null && this.heapAt.t) {
      this.heapRate = (this.heapMB - this.heapAt.mb) / ((now - this.heapAt.t) / 1000);
      this.heapAt = { mb: this.heapMB, t: now };
    }
    this.closed = this.view();
    for (const t of this.tallies.values()) { t.window = 0; t.windowBytes = 0; t.peak = 0; }
    this.gcDropMB = 0;
    this.framesInWindow = 0;
    this.windowStart = now;
  }

  /** The last closed window, as the HUD shows it. */
  closed: ProfilerView | null = null;

  /** Everything counted, plain data (the HUD, `__roadcraft.profiler()`, a snapshot copied out). */
  view(): ProfilerView {
    const events: ProfilerView['events'] = {};
    for (const [name, t] of this.tallies) {
      events[name] = {
        perSecond: t.window, peakPerFrame: t.peak, total: t.total,
        mbPerSecond: round(t.windowBytes / 1e6), totalMB: round(t.totalBytes / 1e6),
        sites: t.lastSites.length ? t.lastSites : [...t.sites].sort((a, b) => b[1] - a[1]).slice(0, 6),
        last: t.last,
      };
    }
    return {
      frames: this.frames, fps: round(this.fps), frameP50: round(this.frameP50), frameMax: round(this.frameMax),
      events,
      products: [...this.products.values()].sort((a, b) => b.ms - a.ms),
      idleProducts: [...this.idleProducts],
      changes: this.lastChanges,
      steps: this.lastSteps,
      heapMB: this.heapMB === null ? null : round(this.heapMB), heapRate: round(this.heapRate), gcDropMB: round(this.gcDropMB),
      longTasks: this.longTasks.map((l) => ({ ms: Math.round(l.ms), agoS: round((performance.now() - l.at) / 1000) })),
      gauges: Object.fromEntries(this.gauges),
    };
  }
}

export interface ProfilerView {
  readonly frames: number;
  readonly fps: number;
  readonly frameP50: number;
  readonly frameMax: number;
  readonly events: Record<string, {
    readonly perSecond: number; readonly peakPerFrame: number; readonly total: number;
    readonly mbPerSecond: number; readonly totalMB: number;
    readonly sites: readonly [string, number][];
    readonly last: { readonly site: string; readonly stack: string; readonly at: number } | null;
  }>;
  readonly products: readonly ProductTiming[];
  readonly idleProducts: readonly [string, number][];
  readonly changes: readonly [string, number][];
  /** Ms per second of each frame system (`frame:`) and measured step (`hitch:`). */
  readonly steps: readonly [string, number][];
  readonly heapMB: number | null;
  readonly heapRate: number;
  readonly gcDropMB: number;
  readonly longTasks: readonly { readonly ms: number; readonly agoS: number }[];
  readonly gauges: Readonly<Record<string, number>>;
}

const round = (x: number): number => Math.round(x * 10) / 10;

/** The game's one profiler. */
export const profiler = new Profiler();
