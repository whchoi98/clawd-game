/**
 * Novice-bot death heat map — the synthetic stand-in for the two weeks of
 * player telemetry the roadmap wanted before tuning the zones (P2-8).
 *
 *   npx tsx tools/novice.ts [zoneId...] [--episodes=300] [--seed=1] [--out=levels/heatmap]
 *                           [--levels=<path/to/levels.generated.ts>] [--no-write] [--quiet]
 *   npx tsx tools/novice.ts --guide=t1 [--guide-checkpoint=2]
 *
 * For every zone the tool plays N noisy episodes of a simple reactive policy
 * on the real Sim and records where the bot died, what killed it, which
 * checkpoints it reached and whether it cleared. The policy is deliberately
 * naive — it is a first-session player, not a solver:
 *
 *   • holds RIGHT the whole time;
 *   • when a gap, a spike run, a wall or a foe on its row shows up 1–3 tiles
 *     ahead it jumps, after a reaction delay drawn from 0–12 ticks;
 *   • presses the air jump when a gap is still under it past the apex (or,
 *     one time in seven, too early — the mistimed double jump);
 *   • dashes across wide gaps (≥ 5 tiles) and through switch toggles on its
 *     row (it read the hint), but forgets the dash 30 % of the time; swims
 *     with jump taps; wall-jumps whenever it slides down a wall;
 *   • walks back when a jump carried it past the goal; after 3 s without
 *     getting further it reconsiders a skipped toggle; gives up after 90 s of
 *     play or 25 deaths.
 *
 * Each zone's result goes to levels/heatmap/<zone>.json (deaths per tile with
 * causes, checkpoint reach rates, clear rate, the top death clusters) and an
 * ASCII overlay of the zone with the death intensity drawn over the geometry
 * is printed. The top clusters are the "hot spots" a checkpoint should stand
 * right before. Everything is seeded, so the same command reproduces the same
 * numbers on any machine; `--levels` points the bot at another geometry (the
 * main checkout's generated levels, say) for a before / after comparison.
 *
 * `--guide=<zone>` runs the noise-free policy once and prints the RLE-base64
 * masks up to (and a moment past) the Nth checkpoint — the recording the
 * client's '길잡이' guide echo (src/client/echo/guide.ts) is made from.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Sim } from '../src/sim/sim.js';
import type { Level } from '../src/sim/level.js';
import { makeRng } from '../src/sim/rng.js';
import type { Rng } from '../src/sim/rng.js';
import { encodeMasks } from '../src/sim/replay.js';
import { IN, SIM_VERSION, TICK_HZ, TILE } from '../src/sim/types.js';
import type { InputMask, LevelDef } from '../src/sim/types.js';
import { SPIKES } from '../src/sim/legend.js';
import { ZONES } from '../levels/build.js';
import { RAMP } from './stats.mjs';

// ---------------------------------------------------------------- policy
export interface NoviceParams {
  /** Longest reaction delay (ticks) between noticing a danger and pressing jump. */
  maxDelay: number;
  /** Chance of forgetting the dash on a wide gap. */
  dashForget: number;
  /** Chance of pressing the air jump far too early. */
  mistime: number;
  /** Gap width (tiles) from which the bot plans a dash. */
  dashGap: number;
  /** Give up after this many seconds of play. */
  giveUpSec: number;
  /** Give up after this many deaths. */
  giveUpDeaths: number;
}

export const NOVICE: NoviceParams = { maxDelay: 12, dashForget: 0.3, mistime: 1 / 7, dashGap: 5, giveUpSec: 90, giveUpDeaths: 25 };
/** The same policy without noise: reacts at once, never forgets, never mistimes. */
export const FLAWLESS: NoviceParams = { ...NOVICE, maxDelay: 0, dashForget: 0, mistime: 0 };

/** How far ahead (tiles) the bot looks for trouble. */
const LOOK_AHEAD = 3;
/** Columns without support beyond which a hole counts as a gap rather than a step down. */
const DROP_OK = 2;
/** Ticks without a new furthest x after which the bot retries the toggles it skipped (a novice tries again). */
const STUCK_TICKS = 3 * 120;

/** The bot's read of the tiles ahead. */
interface Danger { kind: 'gap' | 'spikes' | 'wall' | 'foe'; width: number; at: number }

export class NoviceBot {
  private readonly L: Level;
  /** World x of the goal: a bot that sailed past it turns back instead of pressing on into the map edge. */
  private readonly goalX: number;
  private pendingJump = -1;
  private hold = 0;
  private release = 0;
  private plan: Danger | null = null;
  private airJumpAt = -1;
  private dashAt = -1;
  private dashForgotten = false;
  private lastTrigger = -1;
  private swimT = 0;
  /** Toggle ids the bot has decided about (dash through, or forgot) and the pending ground dash. */
  private readonly toggleSeen = new Set<number>();
  private groundDashAt = -1;
  /** Furthest x reached and the tick it was reached: standing still for STUCK_TICKS makes the bot reconsider the toggles. */
  private bestX = -Infinity;
  private bestXTick = 0;

  constructor(private readonly sim: Sim, private readonly rng: Rng, private readonly P: NoviceParams) {
    this.L = sim.level;
    const g = sim.level.spawns.find((sp) => sp.ch === 'G');
    this.goalX = g ? g.x : Number.POSITIVE_INFINITY;
  }

  private supported(tx: number, fy: number): boolean {
    for (let r = fy; r <= fy + DROP_OK; r++) {
      if (this.L.solid(tx, r) || this.L.oneWay(tx, r)) return true;
      const ch = this.L.at(tx, r);
      if (ch === '~' || ch === 'W') return true;
    }
    return false;
  }

  private spiky(tx: number, ty: number): boolean {
    const ch = this.L.at(tx, ty);
    return ch.length === 1 && SPIKES.includes(ch);
  }

  /** A live foe walking the bot's own row within LOOK_AHEAD tiles ahead (a novice hops over what comes at them). */
  private foeAhead(): Danger | null {
    const p = this.sim.state.player;
    const cy = p.y + p.h / 2;
    const front = p.x + p.w;
    for (const f of this.sim.state.foes) {
      if (f.dead || f.dying > 0) continue;
      const dx = f.x - f.w / 2 - front;
      if (dx >= 0 && dx <= LOOK_AHEAD * TILE && Math.abs(f.y - cy) < TILE * 1.5) return { kind: 'foe', width: 1, at: Math.floor(f.x / TILE) };
    }
    return null;
  }

  /** The nearest danger within LOOK_AHEAD tiles of the front edge, or null. */
  private scan(): Danger | null {
    const p = this.sim.state.player;
    const front = Math.floor((p.x + p.w) / TILE);
    const fy = Math.floor((p.y + p.h + 0.6) / TILE);       // the row the feet stand on
    const foe = this.foeAhead();
    if (foe) return foe;
    for (let d = 1; d <= LOOK_AHEAD; d++) {
      const c = front + d;
      if (c >= this.L.w) break;                              // the map edge is not an obstacle to clear (the goal is before it)
      if (this.L.solid(c, fy - 1)) {
        let h = 0;
        while (this.L.solid(c, fy - 1 - h) && h < 12) h++;
        return { kind: 'wall', width: h, at: c };
      }
      if (this.spiky(c, fy - 1) || this.spiky(c, fy)) {
        let w = 0;
        while ((this.spiky(c + w, fy - 1) || this.spiky(c + w, fy)) && w < 16) w++;
        return { kind: 'spikes', width: w, at: c };
      }
      if (!this.supported(c, fy)) {
        let w = 0;
        while (!this.supported(c + w, fy) && w < 16) w++;
        return { kind: 'gap', width: w, at: c };
      }
    }
    return null;
  }

  private delay(): number { return this.P.maxDelay > 0 ? this.rng.int(0, this.P.maxDelay) : 0; }

  /** A switch toggle within LOOK_AHEAD tiles ahead on the bot's row that it has not yet decided about. */
  private toggleAhead(): { id: number } | null {
    const p = this.sim.state.player;
    const cy = p.y + p.h / 2;
    const front = p.x + p.w;
    for (const e of this.sim.state.entities) {
      if (e.kind !== 'toggle' || this.toggleSeen.has(e.id)) continue;
      const dx = e.x - e.w / 2 - front;
      if (dx >= 0 && dx <= LOOK_AHEAD * TILE && Math.abs(e.y - cy) < TILE * 1.5) return { id: e.id };
    }
    return null;
  }

  /** Input for this tick. */
  mask(): InputMask {
    const st = this.sim.state;
    const p = st.player;
    if (st.phase !== 'play' || p.dead) { this.reset(); return IN.RIGHT; }
    // overshot the goal (a jump carried the bot over it): walk back to it, nothing else
    if (p.x + p.w / 2 > this.goalX + TILE) { this.reset(); return IN.LEFT; }
    let m: InputMask = IN.RIGHT;
    // no progress for a while: whatever toggle was skipped gets a fresh decision
    if (p.x > this.bestX) { this.bestX = p.x; this.bestXTick = st.tick; }
    else if (st.tick - this.bestXTick > STUCK_TICKS) { this.toggleSeen.clear(); this.bestXTick = st.tick; }

    // swimming: jump taps toward the bank
    if (p.inWater) {
      this.swimT++;
      if (this.swimT % 26 < 20) m |= IN.JUMP;
      this.plan = null; this.pendingJump = -1; this.hold = 0;
      return m;
    }
    this.swimT = 0;

    if (this.release > 0) this.release--;

    if (p.grounded) {
      this.airJumpAt = -1; this.dashAt = -1;
      // a toggle ahead: dash through it (a novice who read the hint), unless the dash is forgotten
      const toggle = this.toggleAhead();
      if (toggle) {
        this.toggleSeen.add(toggle.id);
        if (!this.rng.chance(this.P.dashForget)) this.groundDashAt = this.delay();
      }
      if (this.groundDashAt >= 0) {
        if (this.groundDashAt === 0) {
          if (p.dashReady && p.dashT <= 0) { m |= IN.DASH; this.groundDashAt = -1; }
        } else this.groundDashAt--;
      }
      const danger = this.scan();
      if (danger && this.pendingJump < 0 && this.hold <= 0 && this.release <= 0 && this.lastTrigger !== danger.at) {
        this.lastTrigger = danger.at;
        this.plan = danger;
        this.pendingJump = this.delay();
        this.dashForgotten = this.rng.chance(this.P.dashForget);
      }
      if (!danger && this.pendingJump < 0) this.plan = null;
    } else {
      // airborne: a wall we are sliding down is kicked off; a gap still under us gets the air jump and, wide, the dash
      if (p.onWall === 1 && p.vy > 0 && this.hold <= 0 && this.release <= 0 && this.pendingJump < 0) this.pendingJump = this.delay();
      const fy = Math.floor((p.y + p.h) / TILE);
      const under = this.supported(Math.floor((p.x + p.w / 2) / TILE), fy);
      if (!under && p.jumps < 2 && p.jumps > 0 && this.airJumpAt < 0 && this.hold <= 0) {
        const early = this.rng.chance(this.P.mistime);
        this.airJumpAt = early ? 0 : (p.vy > -40 ? this.delay() : -2);
      }
      if (this.airJumpAt === -2 && p.vy > -40) this.airJumpAt = this.delay();
      if (this.airJumpAt >= 0) {
        if (this.airJumpAt === 0 && this.hold <= 0 && this.release <= 0) { this.hold = 12; this.release = 0; this.airJumpAt = -3; }
        else if (this.airJumpAt > 0) this.airJumpAt--;
      }
      const wide = this.plan !== null && this.plan.kind !== 'wall' && this.plan.width >= this.P.dashGap;
      const panic = !under && p.jumps >= 2 && p.vy > 0;
      if ((wide || panic) && !this.dashForgotten && p.dashReady && p.dashT <= 0 && this.dashAt < 0 && p.jumps >= 1 && p.vy > -60) {
        this.dashAt = this.delay();
      }
      if (this.dashAt >= 0) {
        if (this.dashAt === 0) { m |= IN.DASH; this.dashAt = -3; }
        else this.dashAt--;
      }
    }

    if (this.pendingJump > 0) this.pendingJump--;
    else if (this.pendingJump === 0) {
      this.pendingJump = -1;
      if (this.hold <= 0 && this.release <= 0) {
        this.hold = this.plan && this.plan.kind === 'wall' && this.plan.width <= 2 ? 10 : this.rng.int(16, 30);
      }
    }
    if (this.hold > 0) {
      m |= IN.JUMP;
      this.hold--;
      if (this.hold === 0) this.release = 3;
    }
    return m;
  }

  private reset(): void {
    this.pendingJump = -1; this.hold = 0; this.release = 0; this.plan = null;
    this.airJumpAt = -1; this.dashAt = -1; this.lastTrigger = -1; this.swimT = 0;
    this.groundDashAt = -1;
    this.toggleSeen.clear();     // after a respawn every toggle is a fresh decision
    this.bestX = -Infinity;
  }
}

// ---------------------------------------------------------------- episodes
export interface DeathRecord { tx: number; ty: number; cause: string; tick: number }

export interface Episode {
  cleared: boolean;
  gaveUp: boolean;
  deaths: DeathRecord[];
  /** Checkpoint indices (in Level.spawns order of 'C') the run activated. */
  checkpoints: number[];
  /** Play ticks at the end. */
  ticks: number;
  shards: number;
}

/** The zone's checkpoints in play order (left to right, then top to bottom). */
function checkpointsOf(level: Level): { tx: number; ty: number; x: number }[] {
  return level.spawns.filter((s) => s.ch === 'C').map((s) => ({ tx: s.tx, ty: s.ty, x: s.x })).sort((a, b) => a.tx - b.tx || a.ty - b.ty);
}

/** Tile of a death: the player centre, clamped into the map (a pit death is below it). */
function deathTile(level: Level, x: number, y: number): [number, number] {
  const tx = Math.max(0, Math.min(level.w - 1, Math.floor(x / TILE)));
  const ty = Math.max(0, Math.min(level.h - 1, Math.floor(y / TILE)));
  return [tx, ty];
}

/** One episode of the policy on `def`. The Sim keeps the zone's own seed (what every player gets); `rng` drives the noise. */
export function runEpisode(def: LevelDef, rng: Rng, P: NoviceParams = NOVICE, record?: InputMask[]): Episode {
  const sim = new Sim(def, { seed: def.seed });
  const bot = new NoviceBot(sim, rng, P);
  const cps = checkpointsOf(sim.level);
  const deaths: DeathRecord[] = [];
  const reached = new Set<number>();
  const maxTicks = P.giveUpSec * TICK_HZ;
  let gaveUp = false;
  while (!sim.finished) {
    const m = bot.mask();
    if (record) record.push(m);
    sim.step(m);
    for (const ev of sim.drainEvents()) {
      if (ev.type === 'death') {
        const [tx, ty] = deathTile(sim.level, ev.x, ev.y);
        deaths.push({ tx, ty, cause: ev.cause, tick: sim.state.tick });
      } else if (ev.type === 'checkpoint') {
        const i = cps.findIndex((c) => Math.abs(c.x - ev.x) < TILE);
        if (i >= 0) reached.add(i);
      }
    }
    if (sim.summary().ticks >= maxTicks || sim.state.stats.deaths >= P.giveUpDeaths) { gaveUp = true; break; }
  }
  const s = sim.summary();
  return { cleared: s.cleared, gaveUp, deaths, checkpoints: [...reached].sort((a, b) => a - b), ticks: s.ticks, shards: s.shards };
}

// ---------------------------------------------------------------- aggregation
export interface CellStat { tx: number; ty: number; deaths: number; causes: Record<string, number> }
export interface CheckpointStat { index: number; tx: number; ty: number; reached: number; rate: number }
export interface HotSpot {
  /** Inclusive column span of the cluster. */
  x0: number; x1: number;
  /** Row of the cluster's heaviest cell. */
  ty: number;
  deaths: number;
  /** Share of all deaths in the zone. */
  share: number;
  /** The dominant cause. */
  cause: string;
}

export interface ZoneHeat {
  levelId: string;
  name: string;
  sim: number;
  rev: number;
  seed: number;
  par: number;
  episodes: number;
  policy: NoviceParams;
  clears: number;
  clearRate: number;
  gaveUp: number;
  deaths: number;
  deathsPerEpisode: number;
  /** Median play seconds of the cleared episodes, null without a clear. */
  medianClearSec: number | null;
  causes: Record<string, number>;
  checkpoints: CheckpointStat[];
  /** Every tile with at least one death, heaviest first. */
  cells: CellStat[];
  hotspots: HotSpot[];
}

/** Contiguous column runs of deaths, heaviest first; a run breaks at a column with none. */
export function clusters(cells: readonly CellStat[], total: number, top = 6): HotSpot[] {
  const byCol = new Map<number, CellStat[]>();
  for (const c of cells) {
    const list = byCol.get(c.tx);
    if (list) list.push(c); else byCol.set(c.tx, [c]);
  }
  const cols = [...byCol.keys()].sort((a, b) => a - b);
  const out: HotSpot[] = [];
  let i = 0;
  while (i < cols.length) {
    let j = i;
    while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
    const members = cols.slice(i, j + 1).flatMap((x) => byCol.get(x)!);
    const deaths = members.reduce((n, c) => n + c.deaths, 0);
    const heaviest = members.reduce((a, b) => (b.deaths > a.deaths ? b : a));
    const causes: Record<string, number> = {};
    for (const c of members) for (const [k, n] of Object.entries(c.causes)) causes[k] = (causes[k] ?? 0) + n;
    const cause = Object.entries(causes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '?';
    out.push({ x0: cols[i], x1: cols[j], ty: heaviest.ty, deaths, share: total ? deaths / total : 0, cause });
    i = j + 1;
  }
  return out.sort((a, b) => b.deaths - a.deaths || a.x0 - b.x0).slice(0, top);
}

export interface ZoneOptions { episodes: number; seed: number; policy?: NoviceParams }

/** Play `episodes` noisy runs of the policy on `def` and aggregate them. */
export function runZone(def: LevelDef, opts: ZoneOptions): ZoneHeat {
  const P = opts.policy ?? NOVICE;
  const level = new Sim(def, { seed: def.seed }).level;
  const cps = checkpointsOf(level);
  const cellMap = new Map<string, CellStat>();
  const causes: Record<string, number> = {};
  const reached = new Array<number>(cps.length).fill(0);
  const clearTicks: number[] = [];
  let clears = 0, gaveUp = 0, deaths = 0;
  for (let i = 0; i < opts.episodes; i++) {
    const ep = runEpisode(def, makeRng((opts.seed * 1_000_003 + i) >>> 0), P);
    if (ep.cleared) { clears++; clearTicks.push(ep.ticks); }
    if (ep.gaveUp) gaveUp++;
    for (const c of ep.checkpoints) reached[c]++;
    for (const d of ep.deaths) {
      deaths++;
      causes[d.cause] = (causes[d.cause] ?? 0) + 1;
      const key = `${d.tx},${d.ty}`;
      let cell = cellMap.get(key);
      if (!cell) { cell = { tx: d.tx, ty: d.ty, deaths: 0, causes: {} }; cellMap.set(key, cell); }
      cell.deaths++;
      cell.causes[d.cause] = (cell.causes[d.cause] ?? 0) + 1;
    }
  }
  const cells = [...cellMap.values()].sort((a, b) => b.deaths - a.deaths || a.tx - b.tx || a.ty - b.ty);
  clearTicks.sort((a, b) => a - b);
  const median = clearTicks.length ? clearTicks[clearTicks.length >> 1] / TICK_HZ : null;
  return {
    levelId: def.id, name: def.name, sim: SIM_VERSION, rev: def.rev ?? 0, seed: def.seed, par: def.par,
    episodes: opts.episodes, policy: P,
    clears, clearRate: opts.episodes ? clears / opts.episodes : 0,
    gaveUp, deaths, deathsPerEpisode: opts.episodes ? deaths / opts.episodes : 0,
    medianClearSec: median === null ? null : Math.round(median * 100) / 100,
    causes,
    checkpoints: cps.map((c, i) => ({ index: i, tx: c.tx, ty: c.ty, reached: reached[i], rate: opts.episodes ? reached[i] / opts.episodes : 0 })),
    cells,
    hotspots: clusters(cells, deaths),
  };
}

// ---------------------------------------------------------------- rendering
/**
 * The zone's rows with the death intensity drawn over them: a cell with deaths
 * shows a RAMP glyph (light → heavy), every other cell its own character, and a
 * two-line column ruler (tens over units) sits on top.
 */
export function renderOverlay(def: LevelDef, cells: readonly CellStat[]): string {
  const rows = def.rows.map((r) => r.split(''));
  const max = cells.reduce((m, c) => Math.max(m, c.deaths), 0);
  for (const c of cells) {
    if (!rows[c.ty] || c.tx >= rows[c.ty].length) continue;
    const k = Math.max(1, Math.min(RAMP.length - 1, Math.round((c.deaths / max) * (RAMP.length - 1))));
    rows[c.ty][c.tx] = RAMP[k];
  }
  const w = def.rows[0]?.length ?? 0;
  const gutter = String(rows.length - 1).length + 3;
  let tens = '', units = '';
  for (let x = 0; x < w; x++) {
    tens += x % 10 === 0 ? String(Math.floor(x / 10) % 10) : ' ';
    units += String(x % 10);
  }
  const pad = ' '.repeat(gutter);
  const out = [`${pad}${tens}`, `${pad}${units}`];
  rows.forEach((r, y) => out.push(`${`y=${y}`.padEnd(gutter)}${r.join('')}`));
  out.push(`legend: '${RAMP.slice(1)}' deaths low → high (max ${max} in one cell), other cells are the zone itself`);
  return out.join('\n');
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** The console summary of one zone. */
export function summarize(h: ZoneHeat): string {
  const out = [
    `${h.levelId} ${h.name} — par ${h.par}s, rev ${h.rev}, ${h.episodes} episodes: clear ${h.clears} (${pct(h.clearRate)}), gave up ${h.gaveUp}, ` +
      `${h.deaths} deaths (${h.deathsPerEpisode.toFixed(1)} per episode)${h.medianClearSec !== null ? `, median clear ${h.medianClearSec.toFixed(1)}s` : ''}`,
    `  causes: ${Object.entries(h.causes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none'}`,
    `  checkpoints: ${h.checkpoints.map((c) => `C${c.index + 1}(${c.tx},${c.ty}) ${pct(c.rate)}`).join(' · ') || 'none'}`,
    '  hot spots:',
  ];
  for (const s of h.hotspots) {
    out.push(`    x ${s.x0}${s.x1 !== s.x0 ? `..${s.x1}` : ''} (row ${s.ty}) — ${s.deaths} deaths (${pct(s.share)}), mostly ${s.cause}`);
  }
  if (!h.hotspots.length) out.push('    none');
  return out.join('\n');
}

// ---------------------------------------------------------------- files
export const HEATMAP_DIR = fileURLToPath(new URL('../levels/heatmap/', import.meta.url));

export function heatmapPath(zoneId: string, dir = HEATMAP_DIR): string { return resolve(dir, `${zoneId}.json`); }

/** The exact bytes written for a zone: 2-space JSON, trailing newline, no timestamps (reproducible). */
export function renderHeat(h: ZoneHeat): string { return `${JSON.stringify(h, null, 2)}\n`; }

// ---------------------------------------------------------------- guide recording
export interface GuideRecording { masks: string; ticks: number; checkpoints: number; deaths: number; x: number }

/**
 * The noise-free policy on `def`, stopped `settle` ticks after its `nth`
 * checkpoint (standing still): what the bundled guide echo replays.
 */
export function recordGuide(def: LevelDef, nth = 1, settle = 90): GuideRecording | null {
  const sim = new Sim(def, { seed: def.seed });
  const bot = new NoviceBot(sim, makeRng(1), FLAWLESS);
  const masks: InputMask[] = [];
  let checkpoints = 0;
  let deaths = 0;
  let stop = -1;
  while (!sim.finished && masks.length < TICK_HZ * 60) {
    const m = stop >= 0 ? 0 : bot.mask();
    masks.push(m);
    sim.step(m);
    for (const ev of sim.drainEvents()) {
      if (ev.type === 'checkpoint') { checkpoints++; if (checkpoints === nth) stop = settle; }
      if (ev.type === 'death') deaths++;
    }
    if (deaths) return null;
    if (stop > 0) stop--;
    else if (stop === 0) break;
  }
  if (checkpoints < nth) return null;
  const arr = Uint8Array.from(masks);
  return { masks: encodeMasks(arr), ticks: arr.length, checkpoints, deaths, x: sim.state.player.x + sim.state.player.w / 2 };
}

// ---------------------------------------------------------------- cli
const VALUE_FLAGS = new Set(['episodes', 'seed', 'out', 'levels', 'guide', 'guide-checkpoint']);
const BOOL_FLAGS = new Set(['no-write', 'quiet']);

export function parseArgs(argv: string[]): { flags: Map<string, string>; ids: string[] } {
  const flags = new Map<string, string>();
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { ids.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (!VALUE_FLAGS.has(name) && !BOOL_FLAGS.has(name)) throw new Error(`unknown option '${a}'`);
    if (eq >= 0) { flags.set(name, a.slice(eq + 1)); continue; }
    if (BOOL_FLAGS.has(name)) { flags.set(name, 'true'); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(name, next); i++; }
    else throw new Error(`--${name} needs a value`);
  }
  return { flags, ids };
}

async function loadLevels(path: string | undefined): Promise<readonly LevelDef[]> {
  if (!path) return ZONES;
  const mod = (await import(pathToFileURL(resolve(process.cwd(), path)).href)) as { LEVELS?: LevelDef[]; ZONES?: LevelDef[] };
  const levels = mod.LEVELS ?? mod.ZONES;
  if (!levels) throw new Error(`${path} exports neither LEVELS nor ZONES`);
  return levels;
}

async function main(argv: string[]): Promise<number> {
  const { flags, ids } = parseArgs(argv);
  const num = (name: string, dflt: number): number => {
    const v = flags.get(name);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} needs a number, got '${v}'`);
    return n;
  };
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const levels = await loadLevels(flags.get('levels'));
  const pick = (id: string): LevelDef => {
    const z = levels.find((d) => d.id === id);
    if (!z) throw new Error(`unknown zone '${id}'`);
    return z;
  };

  const guide = flags.get('guide');
  if (guide) {
    const def = pick(guide);
    const rec = recordGuide(def, num('guide-checkpoint', 1));
    if (!rec) { log(`${def.id}: the flawless policy did not reach checkpoint ${num('guide-checkpoint', 1)} without dying`); return 1; }
    log(JSON.stringify({ v: SIM_VERSION, levelId: def.id, rev: def.rev ?? 0, seed: def.seed, masks: rec.masks, ticks: rec.ticks }, null, 2));
    log(`// ${rec.checkpoints} checkpoint(s), ${rec.deaths} deaths, ends at tile x=${Math.floor(rec.x / TILE)} after ${(rec.ticks / TICK_HZ).toFixed(1)}s`);
    return 0;
  }

  const zones = ids.length ? ids.map(pick) : levels;
  const episodes = num('episodes', 300);
  const seed = num('seed', 1);
  const dir = flags.get('out') ? resolve(process.cwd(), flags.get('out')!) : HEATMAP_DIR;
  const write = !flags.has('no-write');
  const quiet = flags.has('quiet');
  for (const def of zones) {
    const t0 = performance.now();
    const heat = runZone(def, { episodes, seed });
    log(summarize(heat));
    if (!quiet) log(renderOverlay(def, heat.cells));
    if (write) {
      mkdirSync(dirname(heatmapPath(def.id, dir)), { recursive: true });
      writeFileSync(heatmapPath(def.id, dir), renderHeat(heat));
      log(`  wrote ${heatmapPath(def.id, dir)} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
    }
    log('');
  }
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
