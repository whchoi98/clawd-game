/**
 * `?shot=` — deterministic capture mode for automated visual checks.
 *
 * Headless browsers throttle requestAnimationFrame, so a screenshot of the
 * normal loop comes back blank. This mode advances the simulation in fixed
 * steps synchronously with a scripted mask stream, draws once, and stamps a
 * JSON diagnostics blob on `<html data-shot>` for the Playwright smoke to read.
 * It never engages without the query flag.
 *
 *   ?shot=<levelId|title|daily|endless>   what to capture
 *   &frames=N                             fixed 1/120 s steps (1..3000, default 120)
 *   &hold=right,left,up,down,jump,dash    actions held for the whole run
 *   &pulse=jump:26,dash:60                tap an action every N steps (jump/dash need a press edge)
 *   &alt=N                                flip the horizontal axis every N steps
 *   &bot=wall                             hold toward a wall, jump and reverse the moment you stick
 *   &at=x,y                               drop the player at world feet position (x, y)
 *   &seed=N                               daily / endless seed (no server in capture mode)
 *   &ui=select|settings|result|...        with shot=title: show a UI surface over the backdrop
 *   &audio                                also init the audio engine (diagnostics only)
 */
import { IN } from '../sim/types.js';
import type { InputMask, LevelDef, PlayerState, RunSummary, SimEvent } from '../sim/types.js';
import { BIOMES } from '../shared/biomes.js';
import type { AudioPort, RendererPort, ResultView, Screen } from './contracts.js';
import type { Scenes, ShellUI } from './scenes.js';

export const SHOT_MAX_FRAMES = 3000;
export const SHOT_DEFAULT_FRAMES = 120;
/** A pulsed action is held for this many ticks so the sim sees a press and a release. */
export const PULSE_HOLD_TICKS = 3;

export type ShotAction = 'left' | 'right' | 'up' | 'down' | 'jump' | 'dash';

export interface ShotSpec {
  target: string;
  frames: number;
  hold: Set<ShotAction>;
  pulse: { a: ShotAction; n: number }[];
  alt: number;
  bot: 'wall' | null;
  at: [number, number] | null;
  seed: number | null;
  ui: string | null;
  audio: boolean;
}

const ACTION_BIT: Record<ShotAction, InputMask> = {
  left: IN.LEFT, right: IN.RIGHT, up: IN.UP, down: IN.DOWN, jump: IN.JUMP, dash: IN.DASH,
};
const isAction = (s: string): s is ShotAction => s in ACTION_BIT;

/** Null when the page was not opened with `?shot`. */
export function parseShotQuery(q: URLSearchParams): ShotSpec | null {
  if (!q.has('shot')) return null;
  const frames = Math.min(SHOT_MAX_FRAMES, Math.max(1, Math.floor(Number(q.get('frames')) || SHOT_DEFAULT_FRAMES)));
  const hold = new Set<ShotAction>((q.get('hold') ?? '').split(',').map((s) => s.trim()).filter(isAction));
  const pulse: ShotSpec['pulse'] = [];
  for (const p of (q.get('pulse') ?? '').split(',').filter(Boolean)) {
    const [a, n] = p.split(':');
    if (isAction(a)) pulse.push({ a, n: Math.max(PULSE_HOLD_TICKS + 1, Math.floor(Number(n)) || 20) });
  }
  const atRaw = (q.get('at') ?? '').split(',').map(Number);
  const at: [number, number] | null = atRaw.length === 2 && atRaw.every(Number.isFinite) ? [atRaw[0], atRaw[1]] : null;
  const seedRaw = q.get('seed');
  const seed = seedRaw !== null && Number.isFinite(Number(seedRaw)) ? Number(seedRaw) >>> 0 : null;
  return {
    target: q.get('shot') || 'title',
    frames,
    hold,
    pulse,
    alt: Math.max(0, Math.floor(Number(q.get('alt')) || 0)),
    bot: q.get('bot') === 'wall' ? 'wall' : null,
    at,
    seed,
    ui: q.get('ui'),
    audio: q.has('audio'),
  };
}

/**
 * Turns a spec into a per-tick mask. `step` is 1-based. The wall bot reads the
 * player's state: hold toward a wall, and the moment you stick to it, jump and
 * reverse — fixed-direction or fixed-period input can never validate a
 * wall-jump chain.
 */
export class ShotScript {
  private botDir: 1 | -1 = 1;
  /** Ticks JUMP stays held after a bot press (a one-tick tap would be cut short). */
  private botHold = 0;
  private botHeld = false;
  constructor(readonly spec: ShotSpec) {}

  mask(step: number, p: PlayerState): InputMask {
    const s = this.spec;
    let m = 0;
    for (const a of s.hold) m |= ACTION_BIT[a];
    if (s.alt > 0) {
      const dir = Math.floor(step / s.alt) % 2 ? -1 : 1;
      m &= ~(IN.LEFT | IN.RIGHT);
      m |= dir > 0 ? IN.RIGHT : IN.LEFT;
    }
    if (s.bot === 'wall') m = this.wallBot(m, p);
    for (const pl of s.pulse) {
      if (step >= pl.n && step % pl.n < PULSE_HOLD_TICKS) m |= ACTION_BIT[pl.a];
    }
    return m & 0x3f;
  }

  /**
   * Hold toward a wall; jump when grounded or the moment we stick to the wall
   * we were aiming at, then hold JUMP for 30 ticks and aim at the other wall.
   * Since the sim needs a press EDGE, a held JUMP is released for one tick
   * before a new press.
   */
  private wallBot(m: InputMask, p: PlayerState): InputMask {
    const onTarget = p.onWall === this.botDir && !p.grounded;
    const want = p.grounded || onTarget;
    m &= ~(IN.LEFT | IN.RIGHT | IN.JUMP);
    if (want && this.botHeld) {
      this.botHeld = false;
      this.botHold = 0;
    } else if (want) {
      m |= IN.JUMP;
      this.botHeld = true;
      this.botHold = 30;
      if (onTarget) this.botDir = this.botDir > 0 ? -1 : 1;
    } else if (this.botHold > 0) {
      m |= IN.JUMP;
      this.botHold--;
      if (this.botHold === 0) this.botHeld = false;
    } else {
      this.botHeld = false;
    }
    m |= this.botDir > 0 ? IN.RIGHT : IN.LEFT;
    return m;
  }
}

// ---------------------------------------------------------------- runner
export interface ShotContext {
  scenes: Scenes;
  renderer: RendererPort;
  ui: ShellUI;
  doc: Document;
  audio?: (AudioPort & { track?: string | null; voices?: number }) | null;
  levels: LevelDef[];
  build: string;
}

interface Track { maxX: number; minY: number; jumps: number; dashes: number; wallJumps: number; hurts: number; deaths: number }

function sampleResult(def: LevelDef): ResultView {
  const summary: RunSummary = {
    levelId: def.id, cleared: true, ticks: 4166, time: 34.72, shards: 23, totalShards: 25, relics: 1, totalRelics: 1,
    deaths: 1, par: def.par, rank: 'A', height: 0,
  };
  return {
    summary, levelName: def.name, personalBest: true, stars: 2,
    submit: { state: 'accepted', rank: 12, total: 340 },
    leaderboard: {
      mode: 'story', board: def.id, total: 340,
      entries: [1, 2, 3].map((r) => ({
        rank: r, runId: `sample-${r}`, playerTag: String(r).padStart(12, '0'), you: r === 1, name: ['클로드', '라이벌', '메아리'][r - 1],
        score: 3000 + r * 240, ticks: 3000 + r * 240, shards: 25, deaths: 0, cleared: true, height: 0,
        createdAt: '2026-09-06T00:00:00.000Z',
      })),
    },
    nextLevelId: def.id,
  };
}

/** Run the capture synchronously and stamp the result. Returns the stamped object. */
export function runShot(spec: ShotSpec, ctx: ShotContext): Record<string, unknown> {
  const { scenes, renderer, ui, doc } = ctx;
  const stamp = (obj: Record<string, unknown>): Record<string, unknown> => {
    doc.documentElement.dataset.shot = JSON.stringify(obj);
    return obj;
  };
  try {
    if (spec.audio && ctx.audio) { ctx.audio.init(); }
    const canvas = doc.querySelector<HTMLCanvasElement>('canvas#world');
    const common = () => ({
      cv: canvas ? [canvas.width, canvas.height] : null,
      view: [Math.round(renderer.viewW), Math.round(renderer.viewH)],
      q: renderer.qualityTier,
      screen: [...doc.querySelectorAll('.screen.is-active')].map((e) => e.id).join(','),
      build: ctx.build,
      audio: ctx.audio?.ready
        ? { track: ctx.audio.track ?? null, voices: ctx.audio.voices ?? 0 }
        : { state: 'uninit' },
    });

    if (spec.target === 'title') {
      for (let i = 0; i < spec.frames; i++) scenes.titleFrame(1 / 60);
      if (spec.ui) {
        if (spec.ui === 'result') {
          const def = ctx.levels[0];
          if (def) ui.showResult(sampleResult(def));
        } else {
          ui.show(spec.ui as Screen);
        }
      }
      for (const el of doc.querySelectorAll('.screen.is-leaving')) el.classList.remove('is-leaving');
      const resultUp = !!doc.querySelector('#scr-result.is-active');
      return stamp({ ...common(), phase: 'title', rank: resultUp ? doc.getElementById('res-rank')?.textContent ?? null : null });
    }

    let started: boolean;
    if (spec.target === 'endless') { scenes.startEndless(spec.seed ?? 20260906); started = true; }
    else if (spec.target === 'daily') {
      const seed = spec.seed ?? 20260906;
      scenes.startDaily({ date: '2026-09-06', seed, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' }, { offline: true });
      started = true;
    } else started = scenes.startLevel(spec.target);
    const run = scenes.run;
    if (!started || !run) return stamp({ error: `unknown level '${spec.target}'` });

    if (spec.at) scenes.teleport(spec.at[0], spec.at[1]);

    const script = new ShotScript(spec);
    const track: Track = { maxX: 0, minY: Infinity, jumps: 0, dashes: 0, wallJumps: 0, hurts: 0, deaths: 0 };
    for (let i = 1; i <= spec.frames; i++) {
      const events: SimEvent[] = scenes.tick(script.mask(i, run.sim.state.player));
      for (const ev of events) {
        if (ev.type === 'jump') track.jumps++;
        else if (ev.type === 'dash') track.dashes++;
        else if (ev.type === 'wallJump') track.wallJumps++;
        else if (ev.type === 'hurt') track.hurts++;
        else if (ev.type === 'death') track.deaths++;
      }
      const p = run.sim.state.player;
      if (p.x > track.maxX) track.maxX = p.x;
      if (p.y < track.minY) track.minY = p.y;
    }
    // A run starts faded from black and the capture never runs the frame loop,
    // so settle the fx bus (fade, shake, slow-mo) before the single draw.
    scenes.fx.reset(0);
    scenes.settleCamera();
    scenes.drawFrame(1 / 60);
    // Screen changes fade out over a timer that never fires inside this
    // synchronous capture, so finish them by hand: a lingering boot overlay
    // would otherwise sit on top of every screenshot.
    for (const el of doc.querySelectorAll('.screen.is-leaving')) el.classList.remove('is-leaving');

    const st = run.sim.state;
    const resultUp = !!doc.querySelector('#scr-result.is-active');
    return stamp({
      ...common(),
      cam: [Math.round(scenes.camera.x), Math.round(scenes.camera.y)],
      level: [run.sim.level.pxW, run.sim.level.pxH],
      biome: BIOMES[run.def.biome].id,
      player: [Math.round(st.player.x), Math.round(st.player.y)],
      deaths: st.stats.deaths,
      shards: st.stats.shards,
      phase: st.phase,
      cleared: st.phase === 'clear',
      tick: st.tick,
      rank: resultUp ? doc.getElementById('res-rank')?.textContent ?? null : null,
      stars: resultUp ? doc.querySelectorAll('#res-stars .star.on').length : 0,
      tide: st.tide ? { y: Math.round(st.tide.y), speed: +st.tide.speed.toFixed(1), height: Math.round(st.tide.maxHeight) } : null,
      track: {
        maxX: Math.round(track.maxX), minY: Number.isFinite(track.minY) ? Math.round(track.minY) : null,
        jumps: track.jumps, dashes: track.dashes, wallJumps: track.wallJumps, hurts: track.hurts, deaths: track.deaths,
      },
    });
  } catch (err) {
    return stamp({ error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}`.slice(0, 600) : String(err) });
  }
}
