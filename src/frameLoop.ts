
/** THE FRAME LOOP'S BOOKKEEPING, out of `main.ts`: what the loop keeps between frames that is not the game's state. */

/** One frame asked for at a time, and the wall time between frames. */
export class FrameClock {
  private pending = false;
  private last = performance.now();
  private driftQueued = false;

  /** `loading`: a town is being put together unseen (`SceneHandle.opening`). */
  constructor(private readonly frame: (now: number) => void, private readonly loading: () => boolean = () => false) {}

  private channel: MessageChannel | null = null;

  /** A frame is wanted: one is asked of the browser unless one already is. */
  request(): void {
    if (this.pending) return;
    this.pending = true;
    if (this.loading() && typeof MessageChannel !== 'undefined') {
      if (!this.channel) {
        this.channel = new MessageChannel();
        this.channel.port1.onmessage = () => {
          this.pending = false;
          this.frame(performance.now());
        };
      }
      this.channel.port2.postMessage(null);
      return;
    }
    requestAnimationFrame((now) => {
      this.pending = false;
      this.frame(now);
    });
  }

  /** Seconds since the last frame, read once at the start of each frame. */
  tick(now: number): number {
    const wall = (now - this.last) / 1000;
    this.last = now;
    return wall;
  }

  /** The time stood still (unpaused, the tab shown again) */
  restart(): void {
    this.last = performance.now();
  }

  /** Only the clouds are moving: a frame in `DRIFT_MS`, unless one is already on its way. */
  drift(): void {
    if (this.driftQueued) return;
    this.driftQueued = true;
    setTimeout(() => {
      this.driftQueued = false;
      this.request();
    }, DRIFT_MS);
  }
}

/** Twenty frames a second for the clouds drifting alone. */
const DRIFT_MS = 50;

/** Work done every `seconds` of wall time, not every frame (the minimap ten times a second, the panels two and a half). */
export class Periodic {
  private clock: number;

  constructor(private readonly seconds: number) {
    this.clock = seconds;
  }

  /** `wall` seconds went by: true when the work is due (and the clock starts over). */
  due(wall: number): boolean {
    this.clock += wall;
    if (this.clock < this.seconds) return false;
    this.clock = 0;
    return true;
  }
}

/** DO NOT drive the game's own periodic work with `setInterval`. */
export class SimPeriodic {
  private last: number | null = null;

  constructor(private readonly seconds: number) {}

  /** The simulation stands at `time` seconds: true when the work is due (and its clock starts over). */
  due(time: number): boolean {
    if (this.last === null || time < this.last) {
      this.last = time;
      return false;
    }
    if (time - this.last < this.seconds) return false;
    this.last = time;
    return true;
  }
}

/** `fn` run once, in a task of its own, after however many calls came since it last ran */
export function coalescedTask(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; fn(); }, 0);
  };
}
