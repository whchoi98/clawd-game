# ECHO TOWER premium quality implementation plan

> **For agentic workers:** Use the available parallel-agent workflow for disjoint
> modules; integrate and review in the current owner-authorised working tree.
> Steps use checkbox syntax for evidence-based tracking.

**Goal:** Improve the identity, campaign navigation, learning loop, recovery and
reliability of the existing game to a cohesive commercial-quality candidate.

**Architecture:** Keep authoritative simulation and verified input formats
unchanged. Add independent procedural-title, campaign-preview and replay-transport
modules; wire player actions through the existing UI/Scenes contracts.

**Tech Stack:** TypeScript, Canvas2D, DOM/CSS, Vitest, Playwright, existing Fastify.

**Spec:** `docs/superpowers/specs/2026-09-13-premium-quality-design.md`

**Stage status:** Implemented and verified as application build `2f522e8a`. Evidence and coverage limits: `docs/quality/2026-09-13-premium-report.md`. The broader commercial-quality goal continues with player-based difficulty and content evaluation.

## Global constraints

- Korean player copy; English code/comments. Existing saves stay readable.
- No new dependency, raster download or simulation/version/geometry change.
- Playback is isolated from progression, suspended runs and record submission.
- First Enter starts the first zone; touch, keyboard and gamepad remain usable.
- Verify with the actual product, not only the synchronous screenshot harness.

## 1. Establish the baseline

- [x] Inspect the current worktree, plans, current UI and replay architecture.
- [x] Capture current title, campaign and all 16 zones in Chromium.
- [x] Run `npm test` with local IPC available; record the actual result.
- [x] Run built-app smoke. Development-watch build IDs are not release IDs.

## 2. Title and campaign

Files: `src/client/render/title.ts`, `src/client/render/renderer.ts`,
`src/client/ui/campaign.ts`, `src/client/ui/ui.ts`, `public/index.html`,
`public/styles.css`, `test/client/campaign.test.ts`.

- [x] Add a layered procedural spire to the vista, honouring quality/motion.
- [x] Replace technical title copy with the climb's premise and clear actions.
- [x] Derive campaign technique, actual terrain preview and unlock explanations.
- [x] Integrate highlight-driven preview and visible next objective.
- [x] Verify normal/locked/completed progress and desktop/mobile layouts.

## 3. Replay learning

Files: `src/client/echo/playback.ts`, `src/client/ui/replay.ts`,
`src/client/scenes.ts`, `src/client/contracts.ts`, `src/client/ui/ui.ts`,
`public/index.html`, `public/styles.css`, `test/client/playback.test.ts`,
`test/client/shell.test.ts`.

Transport contract: `ReplayPlayback(def, masks, options?)` owns a separate Sim.
It exposes `sim`, `cursor`, `duration`, `playing`, `speed`, `mask`, `checkpoints`,
`update(dt)`, `seek(tick)`, `restart()`, `toggle()`, `setSpeed(speed)`.
Checkpoint entries have `{ tick, label }`. Seeking clamps finite ticks and
reconstructs the same state as sequential replay. Playback never mutates masks.

- [x] Test actual goal recording completion, backward/forward seek, pause,
  speed, end state and input immutability before implementing the transport.
- [x] Add campaign/pause entry points, transport controls and input display.
- [x] Suspend and restore the original run without save/network side effects.
- [x] Browser-test pointer, keyboard/controller-compatible actions and seek.

## 4. Retry and reliability

Files: `src/client/scenes.ts`, `src/client/ui/ui.ts`, `src/client/contracts.ts`,
`public/index.html`, plus audit-proven files in save/net/input/screens/audio.

- [x] Add `checkpointRetry` intent and inject `IN.RETRY` into the next run tick.
- [x] Test that the tick is recorded, the checkpoint is used, and full replay
  verification reproduces the resulting run.
- [x] Reproduce audit findings and implement bounded fixes with regression tests.
- [x] Check settings, overlays and focus with the real DOM.

## 5. Integrated quality gate

- [x] `npm run typecheck`
- [x] `npm run levels -- --check`
- [x] `npx tsx tools/hash-corpus.ts --check`
- [x] `npm test`
- [x] `NODE_ENV=production npm run build`
- [x] `npm run qa:smoke`, `npm run qa:mobile`, `npm run qa:readability`,
  `npm run qa:grid`, cross-engine selftest on available engines
- [x] Add/run `tools/qa/premium.ts` for real campaign/replay/retry journeys.
- [x] Inspect final desktop/mobile captures and measure render cost.
- [x] Update README, CHANGELOG and `docs/quality/2026-09-13-premium-report.md`
  with current evidence, resolved issues and genuine remaining gaps.
