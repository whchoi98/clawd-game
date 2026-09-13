import { Sim } from '../../sim/sim.js';
import { IN_ALL, MAX_TICKS, TICK_HZ } from '../../sim/types.js';
import type { LevelDef } from '../../sim/types.js';

/**
 * Standalone, silent replay transport. Cursor/duration count input ticks,
 * including the intro; mask is the last input applied to Sim (0 at the start).
 * Consumers must read `sim` again after seeking: backwards seeks replace it.
 */
export class ReplayPlayback {
  private current: Sim;
  private readonly masks: Uint8Array;
  private readonly options: { seed: number; assist: boolean };
  /** Fractional simulation ticks, never elapsed wall time waiting to catch up. */
  private pendingTicks = 0;

  cursor = 0;
  readonly duration: number;
  playing = true;
  speed: 0.5 | 1 | 2 = 1;
  mask = 0;
  readonly checkpoints: readonly { tick: number; label: string }[];

  /**
   * Requires a nonempty Uint8Array of supported 7-bit inputs, at most MAX_TICKS.
   * Wrong buffer types throw TypeError; invalid lengths/bits throw RangeError.
   * The private copy also isolates future seeks from edits to the caller's log.
   */
  constructor(private readonly def: LevelDef, masks: Uint8Array, options: { seed?: number; assist?: boolean } = {}) {
    if (!(masks instanceof Uint8Array)) throw new TypeError('Replay masks must be a Uint8Array');
    if (masks.length === 0 || masks.length > MAX_TICKS) {
      throw new RangeError(`Replay length must be between 1 and ${MAX_TICKS} ticks`);
    }
    // Unlike Buffer.slice(), this always copies the bytes, even for subclasses.
    this.masks = new Uint8Array(masks);
    if (this.masks.some((mask) => (mask & ~IN_ALL) !== 0)) {
      throw new RangeError('Replay masks contain unsupported input bits');
    }
    this.duration = this.masks.length;
    this.options = { seed: (options.seed ?? def.seed) >>> 0, assist: !!options.assist };
    this.checkpoints = this.indexCheckpoints();
    this.current = new Sim(this.def, this.options);
  }

  get sim(): Sim { return this.current; }

  /** Wall-clock seconds; at 2× even a tab resume advances at most 24 ticks. */
  update(dt: number): void {
    if (!this.playing || !Number.isFinite(dt) || dt <= 0) return;
    this.pendingTicks += Math.min(dt, 0.1) * TICK_HZ * this.speed;
    // Absorb roundoff at whole-tick boundaries without varying Sim's fixed DT.
    const ticks = Math.floor(this.pendingTicks + 1e-9);
    this.pendingTicks = Math.max(0, this.pendingTicks - ticks);
    this.advanceTo(Math.min(this.duration, this.cursor + ticks));
  }

  /** Floor/clamp finite tick positions; ignore non-finite requests. Preserve pause. */
  seek(tick: number): void {
    if (!Number.isFinite(tick)) return;
    const target = Math.max(0, Math.min(this.duration, Math.floor(tick)));
    this.pendingTicks = 0;
    if (target < this.cursor) {
      this.current = new Sim(this.def, this.options);
      this.cursor = 0;
      this.mask = 0;
    }
    this.advanceTo(target);
  }

  /** Restart also resumes playback, retaining the selected speed. */
  restart(): void {
    this.seek(0);
    this.playing = true;
  }

  toggle(): void {
    if (this.cursor === this.duration) this.restart();
    else this.playing = !this.playing;
  }

  setSpeed(speed: 0.5 | 1 | 2): void {
    this.speed = speed;
  }

  private advanceTo(target: number): void {
    while (this.cursor < target) {
      // Match Echo / replay verification: clear-state animation is not part of
      // the authoritative finish, even if a log contains trailing input ticks.
      if (!this.current.finished) {
        this.mask = this.masks[this.cursor];
        this.current.step(this.mask);
        this.current.drainEvents();
      }
      this.cursor++;
    }
    if (this.cursor === this.duration) {
      this.playing = false;
      this.pendingTicks = 0;
    }
  }

  /** One bounded pass makes checkpoint navigation available before playback. */
  private indexCheckpoints(): readonly { tick: number; label: string }[] {
    const scan = new Sim(this.def, this.options);
    const checkpoints: { tick: number; label: string }[] = [Object.freeze({ tick: 0, label: '시작' })];
    const visited = new Set<string>();
    for (let i = 0; i < this.duration && !scan.finished; i++) {
      scan.step(this.masks[i]);
      for (const event of scan.drainEvents()) {
        if (event.type !== 'checkpoint') continue;
        const key = `${event.x},${event.y}`;
        if (visited.has(key)) continue;
        visited.add(key);
        checkpoints.push(Object.freeze({ tick: i + 1, label: `체크포인트 ${checkpoints.length}` }));
      }
    }
    return Object.freeze(checkpoints);
  }
}
