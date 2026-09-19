/**
 * The starter characters: rig expressions, idle behaviours, secondary
 * motion (ear springs, scarf chain), costume accessories, the ten appearances,
 * the pickup cue and the foe anticipation helpers — against a recording canvas
 * context. The base palettes' idle frames and portraits match the reviewed cat
 * rig in test/fixtures/clawd-baseline.json. Refresh that visual fixture only
 * after checking an intentional character change in the browser.
 */
import { describe, expect, it } from 'vitest';
import baseline from '../fixtures/clawd-baseline.json';
import { hashLog, makeRecordingCtx } from './helpers/recording-ctx.js';
import type { EntityState, PlayerState, SimState } from '../../src/sim/types.js';
import { PLAYER_H, PLAYER_W } from '../../src/sim/config.js';
import { BIOMES } from '../../src/shared/biomes.js';
import {
  CHAIN_ANCHOR, CHAIN_N, CHAIN_SEG, IDLE_AFTER, RIG_POSES, SKINS, SKIN_ACCESSORIES, SMILE_T, STRETCH_DELAY, STRETCH_T, drawClawd,
  drawClawdPortrait, drawClawdSilhouette, expressionFor, skinById, tintedSkin,
} from '../../src/client/render/clawd.js';
import type { Expression, RigPose, RigState, Skin } from '../../src/client/render/clawd.js';
import {
  Actors, CHASER_WINDUP_T, HOPPER_CROUCH_T, PlayerVisual, TURRET_AIM_T, chaserShake, flyerFlap, hopperCrouch, pickupCue, sceneWind,
  turretCharge, walkerBlink,
} from '../../src/client/render/actors.js';
import type { Stage } from '../../src/client/render/stage.js';

type Ctx2D = CanvasRenderingContext2D;
const BASE_SKINS = ['clawd', 'azure', 'ember', 'void'] as const;
const ALL_SKINS = ['clawd', 'rabbit', 'robot', 'azure', 'ember', 'void', 'coral', 'frost', 'gold', 'nova'] as const;

function rig(skin: Skin, over: Partial<RigState> = {}): RigState {
  return {
    x: 40, y: 64, vx: 0, vy: 0, grounded: true, facing: 1, state: 'idle', t: 0, anim: 0, squash: 0, invuln: 0, blink: 0,
    skin, dashReady: true, dashFlash: 0, alpha: 1, ...over,
  };
}

/** Hash of one draw's main + glow call log. */
function frameHash(r: RigState, glow = true): string {
  const ctx = makeRecordingCtx(), gctx = makeRecordingCtx();
  drawClawd(ctx as unknown as Ctx2D, glow ? (gctx as unknown as Ctx2D) : null, r);
  return hashLog(glow ? [...ctx.log, '--glow--', ...gctx.log] : ctx.log);
}
function frameCalls(r: RigState): number {
  const ctx = makeRecordingCtx();
  drawClawd(ctx as unknown as Ctx2D, null, r);
  return ctx.log.length;
}

function player(over: Partial<PlayerState> = {}): PlayerState {
  return {
    x: 100, y: 200, w: PLAYER_W, h: PLAYER_H, vx: 0, vy: 0, facing: 1, grounded: true, onWall: 0, jumps: 0,
    dashT: 0, dashDirX: 1, dashDirY: 0, dashReady: true, dashCd: 0, stomping: false, hp: 3, invuln: 0, dead: false, deadT: 0,
    inWater: false, pose: 'idle', t: 0, ...over,
  };
}

// ================================================================ regression: the shipped skins
describe('clawd rig · cat appearance across the four base palettes', () => {
  it('idle frames (t = 0 and 1.234, with the glow pass) and the portrait match the cat call log fixture', () => {
    const fixture = baseline as Record<string, string>;
    for (const id of BASE_SKINS) {
      const skin = skinById(id);
      for (const t of [0, 1.234]) {
        const ctx = makeRecordingCtx(), gctx = makeRecordingCtx();
        drawClawd(ctx as unknown as Ctx2D, gctx as unknown as Ctx2D, {
          x: 40, y: 64, vx: 0, vy: 0, grounded: true, facing: 1, state: 'idle', t, anim: 0, squash: 0, invuln: 0, blink: 0,
          skin, dashReady: true, dashFlash: 0, alpha: 1,
        });
        expect(hashLog([...ctx.log, '--glow--', ...gctx.log]), `${id} idle t=${t}`).toBe(fixture[`${id}:idle:t=${t}`]);
      }
      const pctx = makeRecordingCtx();
      drawClawdPortrait(pctx as unknown as Ctx2D, 44, skin, 0.5);
      expect(hashLog(pctx.log), `${id} portrait`).toBe(fixture[`${id}:portrait`]);
    }
    expect(Object.keys(fixture).length).toBe(BASE_SKINS.length * 3);
  });

  it('a rig that carries the Phase 5 fields at rest (idle below IDLE_AFTER, no smile, zero springs) still draws the same frame', () => {
    for (const id of BASE_SKINS) {
      const skin = skinById(id);
      const plain = frameHash(rig(skin, { t: 1.234 }));
      expect(frameHash(rig(skin, { t: 1.234, idle: IDLE_AFTER - 0.1, smile: 0 }))).toBe(plain);
      expect(frameHash(rig(skin, { t: 1.234, idle: 0, smile: 0, chain: undefined }))).toBe(plain);
    }
  });
});

// ================================================================ skins & accessories
describe('character rig · three starters, cat costumes and every accessory', () => {
  it('SKINS starts with cat, rabbit and robot and keeps every existing costume id and Korean name', () => {
    expect(Object.keys(SKINS)).toEqual([...ALL_SKINS]);
    expect(SKINS.rabbit.kr).toBe('토끼');
    expect(SKINS.robot.kr).toBe('로봇');
    expect(SKINS.clawd.accessory).toBe('scarf');
    expect(SKINS.clawd.trim).toBe('#65E4D4');
    expect(SKINS.coral.accessory).toBe('fins');
    expect(SKINS.frost.accessory).toBe('hood');
    expect(SKINS.gold.accessory).toBe('crown');
    expect(SKINS.nova.accessory).toBe('halo');
    for (const id of ['coral', 'frost', 'gold', 'nova']) {
      expect(SKINS[id].trim).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(SKINS[id].kr.length).toBeGreaterThan(0);
      expect(SKINS[id].name).toBe(id.toUpperCase());
    }
    expect(skinById('nope')).toBe(SKINS.clawd);
    expect(skinById(undefined)).toBe(SKINS.clawd);
  });

  it('drawClawd never throws: 10 appearances × 11 poses, glow pass on, with springs, a chain, a smile, idle behaviours, blink, flicker and the death tumble', () => {
    const chain = new Float32Array(CHAIN_N * 2);
    for (let i = 0; i < CHAIN_N; i++) { chain[i * 2] = -3 - i * 2; chain[i * 2 + 1] = -6 + i; }
    const stalk = new Float32Array([1.5, 0.4, -2.2, 1]);
    let frames = 0;
    for (const id of ALL_SKINS) {
      const skin = skinById(id);
      for (const state of RIG_POSES) {
        for (const facing of [1, -1] as const) {
          const ctx = makeRecordingCtx(), gctx = makeRecordingCtx();
          expect(() => drawClawd(ctx as unknown as Ctx2D, gctx as unknown as Ctx2D, rig(skin, {
            state, facing, t: 2.3, vx: facing * 150, vy: state === 'fall' ? 200 : -100, grounded: state === 'idle' || state === 'run' || state === 'crouch',
            stalk, chain, smile: 0.7, idle: IDLE_AFTER + 0.5, blink: 0.4, invuln: 0.3, squash: 0.2, dashFlash: 0.5,
            deadSpin: state === 'dead' ? 1.2 : 0, alpha: 0.9,
          }))).not.toThrow();
          expect(ctx.log.length).toBeGreaterThan(50);
          frames++;
        }
      }
    }
    expect(frames).toBe(ALL_SKINS.length * RIG_POSES.length * 2);
  });

  it('drawClawdPortrait draws all ten appearances without throwing, at several sizes and clocks', () => {
    for (const id of ALL_SKINS) {
      for (const [size, t] of [[44, 0], [64, 0.5], [160, 3.3]] as const) {
        const ctx = makeRecordingCtx();
        expect(() => drawClawdPortrait(ctx as unknown as Ctx2D, size, skinById(id), t)).not.toThrow();
        expect(ctx.log.length).toBeGreaterThan(50);
      }
    }
  });

  it('the three character shapes stay distinct in same-colour echoes and dash afterimages', () => {
    const frames = new Set<string>(), silhouettes = new Set<string>();
    const tints = new Set<Skin>();
    for (const character of ['cat', 'rabbit', 'robot'] as const) {
      const skin = tintedSkin('#65E4D4', character);
      expect(skin.character ?? 'cat').toBe(character);
      expect(tintedSkin('#65E4D4', character)).toBe(skin);
      tints.add(skin);
      frames.add(frameHash(rig(skin), false));
      const ctx = makeRecordingCtx();
      drawClawdSilhouette(ctx as unknown as Ctx2D, 1, character);
      silhouettes.add(hashLog(ctx.log));
    }
    expect(tints.size).toBe(3);
    expect(frames.size).toBe(3);
    expect(silhouettes.size).toBe(3);
  });

  it('every SkinAccessory value is drawn by the rig and the portrait: it adds calls over the uncostumed cat, and "none" adds nothing', () => {
    const bare: Skin = { ...SKINS.clawd, id: 'bare', accessory: 'none' };
    const bareRig = frameCalls(rig(bare, { t: 0.7 }));
    const bareHash = frameHash(rig(bare, { t: 0.7 }));
    const pctx = makeRecordingCtx();
    drawClawdPortrait(pctx as unknown as Ctx2D, 44, bare, 0.2);
    const barePortrait = pctx.log.length;
    expect(SKIN_ACCESSORIES.length).toBe(8);
    for (const accessory of SKIN_ACCESSORIES) {
      const skin: Skin = { ...bare, id: `acc-${accessory}`, accessory, trim: '#ABCDEF' };
      const calls = frameCalls(rig(skin, { t: 0.7 }));
      const ctx = makeRecordingCtx();
      drawClawdPortrait(ctx as unknown as Ctx2D, 44, skin, 0.2);
      if (accessory === 'none') {
        expect(frameHash(rig(skin, { t: 0.7 }))).toBe(bareHash);
        expect(ctx.log.length).toBe(barePortrait);
      } else {
        expect(calls, accessory).toBeGreaterThan(bareRig);
        expect(ctx.log.length, `${accessory} portrait`).toBeGreaterThan(barePortrait);
      }
      // with a simulated chain the scarf accessories draw it instead of the static drape — still without throwing
      const chain = new Float32Array(CHAIN_N * 2).map((_, i) => (i % 2 ? -6 + i : -3 - i));
      expect(() => frameCalls(rig(skin, { t: 0.7, chain, stalk: new Float32Array([2, 1, -1, 0.5]) }))).not.toThrow();
    }
    // a trim-less accessory skin falls back to the glow colour and still draws
    expect(() => frameCalls(rig({ ...bare, id: 'acc-notrim', accessory: 'scarf' }))).not.toThrow();
  });

  it('accessory skins with a glow pass stamp the halo / antenna bulb into the glow buffer', () => {
    for (const accessory of ['halo', 'antenna'] as const) {
      const skin: Skin = { ...SKINS.clawd, id: `glow-${accessory}`, accessory };
      const ctx = makeRecordingCtx(), gctx = makeRecordingCtx();
      drawClawd(ctx as unknown as Ctx2D, gctx as unknown as Ctx2D, rig(skin));
      const bareG = makeRecordingCtx();
      drawClawd(makeRecordingCtx() as unknown as Ctx2D, bareG as unknown as Ctx2D, rig(SKINS.clawd));
      expect(gctx.log.length).toBeGreaterThan(bareG.log.length);
    }
  });
});

// ================================================================ expressions & idle behaviours
describe('clawd rig · expressions, smile, idle behaviours, springs (P5-2)', () => {
  it('expression table: run focuses, a fall gasps, a dash grits, hurt and dead cross the eyes; idle is neutral', () => {
    const table: Record<RigPose, Expression> = {
      idle: { brow: 'none', mouth: 'none', xEyes: false },
      run: { brow: 'focus', mouth: 'none', xEyes: false },
      jump: { brow: 'raise', mouth: 'none', xEyes: false },
      fall: { brow: 'raise', mouth: 'o', xEyes: false },
      dash: { brow: 'focus', mouth: 'grit', xEyes: false },
      wall: { brow: 'focus', mouth: 'none', xEyes: false },
      stomp: { brow: 'focus', mouth: 'grit', xEyes: false },
      hurt: { brow: 'sad', mouth: 'open', xEyes: true },
      swim: { brow: 'none', mouth: 'o', xEyes: false },
      dead: { brow: 'none', mouth: 'flat', xEyes: true },
      crouch: { brow: 'focus', mouth: 'none', xEyes: false },
    };
    for (const pose of RIG_POSES) expect(expressionFor(pose), pose).toEqual(table[pose]);
    expect(expressionFor('bogus' as RigPose)).toEqual(table.idle);
  });

  it('the pickup smile replaces the mouth of the relaxed poses only, keeping their brows', () => {
    for (const pose of ['idle', 'run', 'jump', 'wall', 'crouch'] as RigPose[]) {
      const e = expressionFor(pose, 0.5);
      expect(e.mouth, pose).toBe('smile');
      expect(e.brow).toBe(expressionFor(pose).brow);
      expect(e.xEyes).toBe(false);
    }
    for (const pose of ['fall', 'dash', 'stomp', 'hurt', 'swim', 'dead'] as RigPose[]) {
      expect(expressionFor(pose, 1), pose).toEqual(expressionFor(pose));
    }
    expect(expressionFor('idle', 0)).toEqual({ brow: 'none', mouth: 'none', xEyes: false });
  });

  it('smile, idle behaviours (from IDLE_AFTER on, not before) and stalk springs each change the frame; every pose differs from idle', () => {
    const skin = SKINS.clawd;
    const plain = frameHash(rig(skin, { t: 1 }));
    expect(frameHash(rig(skin, { t: 1, smile: 1 }))).not.toBe(plain);
    expect(frameHash(rig(skin, { t: 1, idle: IDLE_AFTER - 0.01 }))).toBe(plain);
    expect(frameHash(rig(skin, { t: 1, idle: IDLE_AFTER + 0.5 }))).not.toBe(plain);
    // the stretch (after the ramp) is a different frame from the plain look-around; both are fully ramped, same clock
    const stretchPeak = IDLE_AFTER + STRETCH_DELAY + STRETCH_T / 2;    // mid-stretch
    const between = IDLE_AFTER + STRETCH_DELAY + STRETCH_T + 2;         // between two stretches
    expect(frameHash(rig(skin, { t: 1, idle: stretchPeak }))).not.toBe(frameHash(rig(skin, { t: 1, idle: between })));
    // between two stretches only the clock moves the look-around: two idle ages give the same frame
    expect(frameHash(rig(skin, { t: 1, idle: between }))).toBe(frameHash(rig(skin, { t: 1, idle: between + 0.5 })));
    expect(frameHash(rig(skin, { t: 1, stalk: new Float32Array([3, 0, -3, 0]) }))).not.toBe(plain);
    expect(frameHash(rig(skin, { t: 1, stalk: new Float32Array([0, 0, 0, 0]) }))).toBe(plain);
    const hashes = new Set(RIG_POSES.map((state) => frameHash(rig(skin, { t: 1, state, grounded: state === 'idle' || state === 'run' || state === 'crouch' }))));
    expect(hashes.size).toBe(RIG_POSES.length);
  });

  it('hurt draws X eyes like dead; a blink closes the eyes to a line', () => {
    const skin = SKINS.clawd;
    const xCount = (r: RigState) => {
      const ctx = makeRecordingCtx();
      drawClawd(ctx as unknown as Ctx2D, null, r);
      return ctx.log.filter((l) => l.startsWith('ellipse(')).length;
    };
    const idleEllipses = xCount(rig(skin));
    // hurt and dead lose the four eye ellipses (two eyes, two pupils) — the X is strokes; hurt adds the open mouth, dead a flat line
    expect(xCount(rig(skin, { state: 'hurt' }))).toBe(idleEllipses - 4 + 1);
    expect(xCount(rig(skin, { state: 'dead' }))).toBe(idleEllipses - 4);
    expect(xCount(rig(skin, { blink: 1 }))).toBe(idleEllipses - 4);
  });
});

// ================================================================ PlayerVisual secondary motion
describe('PlayerVisual · secondary motion, idle clock, smile (P5-2)', () => {
  const step = (vis: PlayerVisual, p: PlayerState, seconds: number, dt = 1 / 60) => {
    for (let t = 0; t < seconds - 1e-9; t += dt) vis.update(dt, p);
  };

  it('ear tips lag a burst of acceleration and settle once the speed is steady', () => {
    const vis = new PlayerVisual();
    const p = player();
    vis.reset(p);
    step(vis, p, 0.5);
    expect(Math.abs(vis.stalk[0])).toBeLessThan(0.05);
    p.vx = 300; p.pose = 'run';
    vis.update(1 / 60, p);
    expect(vis.stalk[0]).toBeLessThan(-0.5);       // accelerating right: the tip lags left
    expect(vis.stalk[2]).toBeLessThan(-0.5);
    step(vis, p, 2.5);
    expect(Math.abs(vis.stalk[0])).toBeLessThan(0.3);
    expect(Math.abs(vis.stalk[2])).toBeLessThan(0.3);
    // a landing (downward speed cut to zero) throws the tips down (+y)
    const air = player({ grounded: false, vy: 300, pose: 'fall' });
    const v2 = new PlayerVisual();
    v2.reset(air);
    step(v2, air, 0.3);
    air.vy = 0; air.grounded = true; air.pose = 'idle';
    v2.update(1 / 60, air);
    expect(v2.stalk[1]).toBeGreaterThan(0.3);
    // never beyond the clamp
    for (const v of vis.stalk) expect(Math.abs(v)).toBeLessThanOrEqual(6);
  });

  it('the scarf chain hangs CHAIN_N points, CHAIN_SEG apart, from the anchor behind the neck; the rig gets it as feet offsets', () => {
    const vis = new PlayerVisual();
    const p = player({ facing: 1 });
    vis.reset(p);
    step(vis, p, 1);
    const ax = p.x + p.w / 2 - CHAIN_ANCHOR.dx, ay = p.y + p.h + CHAIN_ANCHOR.dy;
    expect(vis.chain[0]).toBeCloseTo(ax, 4);
    expect(vis.chain[1]).toBeCloseTo(ay, 4);
    for (let i = 1; i < CHAIN_N; i++) {
      const d = Math.hypot(vis.chain[i * 2] - vis.chain[i * 2 - 2], vis.chain[i * 2 + 1] - vis.chain[i * 2 - 1]);
      expect(d).toBeCloseTo(CHAIN_SEG, 3);
    }
    // gravity: the tail hangs below the anchor at rest
    expect(vis.chain[(CHAIN_N - 1) * 2 + 1]).toBeGreaterThan(ay);
    const r = vis.rig(p, SKINS.frost);
    expect(r.chain).toBeDefined();
    expect(r.chain![0]).toBeCloseTo(-CHAIN_ANCHOR.dx, 4);
    expect(r.chain![1]).toBeCloseTo(CHAIN_ANCHOR.dy, 4);
    expect(r.stalk).toBe(vis.stalk);
    // facing left: the anchor sits on the other side
    p.facing = -1;
    vis.update(1 / 60, p);
    expect(vis.chain[0]).toBeCloseTo(p.x + p.w / 2 + CHAIN_ANCHOR.dx, 4);
  });

  it('a run drags the chain behind; a teleport or reset snaps it to the new anchor instead of whipping', () => {
    const vis = new PlayerVisual();
    const p = player({ vx: 200, pose: 'run' });
    vis.reset(p);
    for (let i = 0; i < 60; i++) { p.x += p.vx / 60; vis.update(1 / 60, p); }
    const tailX = vis.chain[(CHAIN_N - 1) * 2];
    expect(tailX).toBeLessThan(vis.chain[0]);             // trails behind a right-moving player
    p.x += 500;
    vis.update(1 / 60, p);
    for (let i = 0; i < CHAIN_N; i++) expect(Math.abs(vis.chain[i * 2] - vis.chain[0])).toBeLessThanOrEqual(CHAIN_N * CHAIN_SEG + 1e-6);
    p.x -= 1000;
    vis.reset(p);
    expect(vis.chain[0]).toBeCloseTo(p.x + p.w / 2 - CHAIN_ANCHOR.dx, 4);
    expect(vis.idleT).toBe(0);
    expect(vis.smileT).toBe(0);
  });

  it('the idle clock counts seconds standing still and resets on movement, a dash, a stomp, the air or death', () => {
    const vis = new PlayerVisual();
    const p = player();
    vis.reset(p);
    step(vis, p, 5);
    expect(vis.idleT).toBeGreaterThan(4.9);
    expect(vis.rig(p, SKINS.clawd).idle).toBeCloseTo(vis.idleT, 6);
    p.vx = 100; vis.update(1 / 60, p); expect(vis.idleT).toBe(0);
    p.vx = 0; step(vis, p, 1); expect(vis.idleT).toBeGreaterThan(0.9);
    p.dashT = 0.1; vis.update(1 / 60, p); expect(vis.idleT).toBe(0); p.dashT = 0;
    step(vis, p, 1); p.grounded = false; vis.update(1 / 60, p); expect(vis.idleT).toBe(0); p.grounded = true;
    step(vis, p, 1); p.stomping = true; vis.update(1 / 60, p); expect(vis.idleT).toBe(0); p.stomping = false;
    step(vis, p, 1); p.dead = true; vis.update(1 / 60, p); expect(vis.idleT).toBe(0);
  });

  it('smile() starts a SMILE_T smile the rig reads as a 0..1 remainder that runs out', () => {
    const vis = new PlayerVisual();
    const p = player();
    vis.reset(p);
    expect(vis.rig(p, SKINS.clawd).smile).toBe(0);
    vis.smile();
    expect(vis.rig(p, SKINS.clawd).smile).toBe(1);
    step(vis, p, SMILE_T / 2);
    const mid = vis.rig(p, SKINS.clawd).smile!;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    step(vis, p, SMILE_T);
    expect(vis.rig(p, SKINS.clawd).smile).toBe(0);
  });
});

// ================================================================ Actors: pickup cue, wind, foe anticipation
describe('Actors · pickup cue, biome wind and foe anticipation helpers (P5-2)', () => {
  const stage = {} as Stage;
  function stateWith(entities: EntityState[]): SimState {
    return {
      tick: 0, time: 0, phase: 'play', phaseT: 0, player: player(), entities, foes: [], bolts: [],
      respawn: { x: 0, y: 0 }, switchA: true,
      stats: { shards: 0, relics: 0, deaths: 0, jumps: 0, dashes: 0, wallJumps: 0, foes: 0, combo: 0, bestCombo: 0 },
    };
  }
  const shard = (alive: boolean, kind: EntityState['kind'] = 'shard'): EntityState => ({ id: 7, kind, x: 50, y: 50, w: 9, h: 9, alive, t: 1, state: 0 });

  it('a shard or relic consumed between two updates cues a SMILE_T smile for the live player; one already gone on first sight does not', () => {
    const actors = new Actors(stage, BIOMES.tidepool);
    const s = stateWith([shard(true)]);
    actors.update(1 / 60, s);
    expect(pickupCue()).toBe(0);
    s.entities[0].alive = false;
    actors.update(1 / 60, s);
    expect(pickupCue()).toBe(SMILE_T);
    actors.update(0.2, s);
    expect(pickupCue()).toBeCloseTo(SMILE_T - 0.2, 6);
    actors.update(1, s);
    expect(pickupCue()).toBe(0);
    // first sight of a dead shard (a respawn keeps collected shards dead): no smile
    const fresh = new Actors(stage, BIOMES.tidepool);
    fresh.update(1 / 60, stateWith([shard(false)]));
    expect(pickupCue()).toBe(0);
    // a relic smiles too; a crystal does not
    const relic = new Actors(stage, BIOMES.tidepool);
    const rs = stateWith([shard(true, 'relic'), { ...shard(true, 'crystal'), id: 8 }]);
    relic.update(1 / 60, rs);
    rs.entities[1].alive = false;
    relic.update(1 / 60, rs);
    expect(pickupCue()).toBe(0);
    rs.entities[0].alive = false;
    relic.update(1 / 60, rs);
    expect(pickupCue()).toBe(SMILE_T);
    // a new level clears the cue
    relic.setLevel(BIOMES.tidepool);
    expect(pickupCue()).toBe(0);
    // the live draw takes the cue into the rig (draw needs a stage; the rig path is the same clamp)
    const vis = new PlayerVisual();
    expect(vis.rig(player(), SKINS.clawd).smile).toBe(0);
  });

  it('the scarf wind follows the biome weather: a breeze in the tide pools, a gale against the storm spire, a drift in the reef, steady snow at the summit', () => {
    const actors = new Actors(stage, BIOMES.tidepool);
    const s = stateWith([]);
    actors.update(1 / 60, s);
    const tide = sceneWind();
    expect(tide).toBeGreaterThan(0);
    actors.setLevel(BIOMES.stormspire); actors.update(1 / 60, s);
    const storm = sceneWind();
    expect(storm).toBeLessThan(0);
    expect(Math.abs(storm)).toBeGreaterThan(Math.abs(tide));
    actors.setLevel(BIOMES.voidreef); actors.update(1 / 60, s);
    expect(Math.abs(sceneWind())).toBeLessThan(Math.abs(tide));
    actors.setLevel(BIOMES.summit); actors.update(1 / 60, s);
    expect(sceneWind()).toBeGreaterThan(tide);
    // the chain feels it: with the storm wind the tail drifts left of the anchor
    actors.setLevel(BIOMES.stormspire); actors.update(1 / 60, s);
    const vis = new PlayerVisual();
    const p = player();
    vis.reset(p);
    for (let i = 0; i < 120; i++) vis.update(1 / 60, p);
    expect(vis.chain[(CHAIN_N - 1) * 2]).toBeLessThan(vis.chain[0] - 2);
  });

  it('hopper crouch and turret charge grow monotonically as the countdown runs out, and are 0 outside their window', () => {
    for (const [fn, T] of [[hopperCrouch, HOPPER_CROUCH_T], [turretCharge, TURRET_AIM_T]] as const) {
      expect(fn(T + 0.5)).toBe(0);
      expect(fn(T)).toBe(0);
      expect(fn(0)).toBe(0);
      expect(fn(-0.2)).toBe(0);
      let last = 0;
      for (let s = T - 0.01; s > 0; s -= 0.02) {
        const v = fn(s);
        expect(v).toBeGreaterThan(last);
        expect(v).toBeLessThanOrEqual(1);
        last = v;
      }
      expect(last).toBeGreaterThan(0.9);
    }
  });

  it('the chaser shakes only while winding up, harder as the charge nears; the flyer flaps faster with speed; walkers blink briefly and out of step', () => {
    expect(chaserShake(0, 1)).toBe(0);
    expect(chaserShake(-0.4, 1)).toBe(0);
    const peak = (state: number) => { let m = 0; for (let t = 0; t < 1; t += 0.001) m = Math.max(m, Math.abs(chaserShake(state, t))); return m; };
    expect(peak(0.45)).toBeGreaterThan(0);
    expect(peak(0.05)).toBeGreaterThan(peak(0.45));
    expect(peak(0.05)).toBeLessThan(2);
    expect(CHASER_WINDUP_T).toBe(0.5);
    expect(flyerFlap(2, 0)).toBeGreaterThan(flyerFlap(1, 0));
    expect(flyerFlap(1, 150)).toBeGreaterThan(flyerFlap(1, 0));
    expect(flyerFlap(1, 400)).toBe(flyerFlap(1, 200));     // speed influence capped
    let closed = 0, open = 0;
    for (let t = 0; t < 4; t += 1 / 60) { if (walkerBlink(t, 3) > 0.5) closed++; else open++; }
    expect(closed).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(closed * 8);
    // two walkers do not blink at the same moment
    let together = 0;
    for (let t = 0; t < 4; t += 1 / 60) if (walkerBlink(t, 3) > 0.5 && walkerBlink(t, 4) > 0.5) together++;
    expect(together).toBe(0);
  });
});
