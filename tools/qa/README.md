# QA: Playwright smoke

## Campaign, replay and mastery quality

`npm run qa:premium` drives the shipped UI on fresh desktop (1440×900),
landscape phone (750×340) and portrait phone (390×844) browser contexts.
It checks readable locked-zone names and unlock instructions, the selected
zone's preview, replay pause/speed/seeking/checkpoint controls, preservation of
the suspended run, checkpoint retry recording, and native Tab focus in settings.
The journal checks cover all 16 zones and ten appearances (three free starters),
readable unlock conditions,
goal selection without awarding progress, a real reload, reversible goal changes
while paused, and a whole-run restart after a missed no-death goal. Tab and
Shift+Tab must remain inside the journal. Each engine runs 42 steps.
Each profile also selects the rabbit, robot and cat before starting a run,
reloads to check the saved selection and title renderer, and verifies that
zone records and earned costumes did not change.
Actions go through real controls; browser evaluation only reads diagnostics.
Same-origin errors fail the run. Captures are written to
`tools/qa/out/premium-*.png`. Use `BASE_URL` to point at a running built server.
`npm run qa:webkit` runs the same journeys in WebKit; its screenshots go to
`tools/qa/out/webkit/`. Each virtual device receives a distinct synthetic
CloudFront viewer address on API requests, so the real server applies its
normal per-viewer limits independently to each profile. API responses are real.

Install browser dependencies on a supported Linux host with
`npx playwright install --with-deps chromium webkit firefox`. The isolated
container procedure and measured results are recorded in
`docs/quality/2026-09-13-premium-report.md` and
`docs/quality/2026-09-13-mastery-report.md`.

`tools/qa/smoke.ts` drives a real Chromium against a running server and fails
on anything a player would notice on the first screen: a console error, an
uncaught exception, a blank canvas, a menu that does not open, a zone that does
not start, a service worker that cannot serve the title screen offline, or a
zone the `?shot=` harness cannot render.

## Run

```bash
npm run qa:browser                 # once: download the pinned Chromium
npm run build                      # dist/public (+ sw.js, manifest, icons) + dist/server
PORT=8099 STATIC_DIR=dist/public node dist/server/index.js &   # or: npm run dev
npm run qa:smoke                   # = npx tsx tools/qa/smoke.ts
npm run qa:smoke -- --no-shots     # skip the per-zone harness pass
BASE_URL=https://dxxxx.cloudfront.net npm run qa:smoke   # post-deploy
```

Exit code 0 means every step passed and no issue was recorded; anything else
is 1. Screenshots are written to `tools/qa/out/` (git-ignored):

| file | what |
|---|---|
| `01-title.png` | title screen after boot |
| `02-select.png` | zone select after pausing and quitting the first run |
| `03-play.png` | first zone running after one `Enter` on a fresh profile's title |
| `04-offline.png` | title screen after a reload with the network cut, served by the service worker |
| `shot-<zone>.png` | `?shot=<zone>&frames=240&hold=right&pulse=jump:26` for all 16 zones: `t1..t4`, `s1..s4`, `v1..v4`, `m1..m4` |
| `shot-daily-band.png` | Daily tower capture after moving into a different biome band |

## What is asserted

1. `GET /` renders and `#scr-title` becomes visible within 30 s.
2. `canvas#world` is painted: 48 pixels sampled on an 8x6 grid contain at least
   4 distinct colours and are not all transparent. A flat or unsized canvas fails.
3. For a fresh profile, one `Enter` on the title opens `#scr-play` and the canvas
   is painted with the world. `Escape` opens pause; clicking quit returns to
   `#scr-select`. The telemetry step checks the resulting events and a controlled
   error without transmitting player identity.
4. **offline**: back on `/`, the script polls (up to 20 s) until
   `navigator.serviceWorker.getRegistration()` has an active worker and a
   `cet-*` cache holds `/index.html` — that is, `/sw.js` installed and its
   precache (`/`, `/index.html`, every `/assets/*`, favicon, manifest, icons)
   finished. Then `context.setOffline(true)`, `page.reload()`, and `#scr-title`
   must appear with a painted canvas before the network is restored. Console
   errors of the `net::ERR_INTERNET_DISCONNECTED` kind are downgraded to
   warnings during this step only.
5. **selftest** (runs with `--no-shots` too): `?shot=selftest` steps the
   determinism corpus on this Chromium and stamps one digest per zone; every
   digest must equal `test/fixtures/corpus-digests.json` (Node's), and the
   page's `sim` / `gen` must be the fixture's. See "Cross-engine selftest".
6. For each zone the harness stamps `document.documentElement.dataset.shot`
   (JSON from the client's `shot.ts`); a stamp containing `error` fails, and the
   canvas must again be painted.
7. Throughout: console messages of type `error` and `pageerror` events on the
   page's own origin, and same-origin HTTP 5xx responses, are collected as
   issues and fail the run. Off-origin console errors (the Google Fonts
   stylesheet on an offline machine) and same-origin 4xx are printed as
   warnings only.

The summary is a table of steps with PASS/FAIL, elapsed ms and a one-line note,
followed by the issue and warning lists.

### Offline step: when it is skipped, and `--register-sw`

Service workers need a secure context. `https://…` and `http://localhost` /
`http://127.0.0.1` qualify; plain `http://` on any other host does not, so
there the offline step is **skipped with a warning** (WARN, not FAIL) and the
rest of the run proceeds. Point `BASE_URL` at the CloudFront URL or at a local
server to exercise it.

The app registers the worker from `src/client/main.ts`. `--register-sw` makes
the smoke script call `navigator.serviceWorker.register('/sw.js')` itself
before polling — useful for proving the worker while the app-side registration
is not wired yet, and for nothing else: a release run must pass **without** the
flag, otherwise the app is not actually registering its worker.

## The `?shot=` harness

Headless browsers throttle `requestAnimationFrame`, so screenshotting the live
loop is unreliable. The client's capture mode (`src/client/shot.ts`) steps the
simulation synchronously for a fixed number of ticks, draws once, and stamps a
JSON diagnostics blob on `<html data-shot>`. It never engages without the flag.

```
?shot=<zoneId|daily|endless|title>   what to capture
&frames=240                          fixed 1/120 s steps to run
&hold=right,left,up,down,jump,dash   actions held for the whole run
&pulse=jump:26,dash:60               tap an action every N steps (jump and dash need a press edge)
?shot=selftest                       no capture: run the determinism corpus and stamp its digests (see below)
```

The smoke test uses `frames=240&hold=right&pulse=jump:26` for every zone so the
player runs right and hops, which exercises movement, collision and the camera
without needing a solved route.

## Caution

A harness that builds its own input is more correct than the product and will
happily pass while the shipped input layer is broken; the reference project
shipped a halved jump height that way. The first three steps therefore drive
the real UI and `Input` through Playwright key presses; only the per-zone pass
uses the synchronous harness. The same applies to `--register-sw`: it proves
the worker, not the app.

## Cross-engine selftest

`npx tsx tools/qa/selftest.ts [--engines=chromium,webkit,firefox] [--require=chromium,webkit]`
(`BASE_URL` env, default `http://127.0.0.1:8099`) is the determinism proof
across JavaScript engines. The sim must reach bit-identical state from the
same input log on the server (Node / V8) and in every player's browser
(Blink / V8, WebKit / JavaScriptCore, Gecko / SpiderMonkey); a drift on one of
them would make a run cleared there fail the server's replay with
`claim-mismatch`.

- `src/client/selftest.ts` steps the 16 bundled goal echoes (`GOAL_ECHOES`,
  one paced developer clear per story zone) and two scripted daily towers
  (seeds 1 and 20260906, 3000 ticks of "hold right 60 ticks, tap jump") through
  a fresh `Sim` and reduces each final state to a digest:
  `{ key, levelId, seed, tick, ticks, cleared, shards, deaths, x, y, hash }` with
  `hash` = FNV-1a 32 over the canonical (key-sorted) JSON of the final `SimState`.
- `npx tsx tools/hash-corpus.ts` writes Node's digests to
  `test/fixtures/corpus-digests.json` (`--check` exits 1 when stale). vitest
  (`test/client/selftest.test.ts`, `test/tools/selftest.test.ts`) pins the
  in-process digests to that file, so the fixture is also the regression net
  for physics / level / generator edits — rewrite it only alongside a deliberate
  sim change.
- `?shot=selftest` makes the page run the same corpus synchronously and stamp
  `{ phase: 'selftest', engine, ua, sim, gen, corpus, selftest: [...] }` on
  `<html data-shot>`; `engine` is derived from the user agent (`v8`, `jsc`,
  `spidermonkey`; every iOS browser is `jsc`).
- The script launches each engine in turn, opens `?shot=selftest`, compares
  every digest field by field with the fixture and prints an engine × zone
  table (fixture hash, then each engine's hash; `!` marks a mismatch, `-` a
  missing zone, `SKIP` an engine that could not launch). Exit 1 on any
  mismatch, a same-origin console / page error, a `sim` / `gen` that differs
  from the fixture, a `--require`d engine that could not run, or no engine at
  all. An engine that is not installed is otherwise reported as SKIP with the
  launcher's reason.

`npm run qa:smoke` carries the same comparison as its `selftest` step (Chromium
only, also with `--no-shots`). CI ([workflow](../../.github/workflows/ci.yml)) runs
`selftest.ts --require=chromium,webkit,firefox` after installing all three engines
with `npx playwright install --with-deps chromium webkit firefox`.
The development host's container setup and measured cross-engine results are
recorded in [the quality report](../../docs/quality/2026-09-13-premium-report.md).

## Mobile layout QA

`npm run qa:mobile` (`BASE_URL` env, default `http://127.0.0.1:8099`) emulates iPhone 14 landscape (750x340), Galaxy S9+ landscape (658x320), iPad Pro 11 landscape and portrait, plus an iPhone portrait profile, and asserts: zero same-origin console errors, both title menu ends inside the viewport, tap-through to play with the touch pad visible, the HUD hint clear of the DASH/JUMP buttons, no rotate prompt on tablet portrait, and the rotate prompt shown/dismissed/remembered on a phone in portrait. Screenshots land in `tools/qa/out/mobile-*.png`.

## Readability QA

`npx tsx tools/qa/readability.ts` (`BASE_URL` env, default `http://127.0.0.1:8099`)
checks the P1-6 readability pass at the pixel level, at 1280x800 @1 through the
`?shot=` harness. Geometry (updraft columns, spike tiles, the renderer's camera
transform, `renderer.goalScreen`) is read from the live page via `window.__clawd`,
never re-derived from level sources, so a level edit cannot move a probe off
target. Screenshots land in `tools/qa/out/readability-*.png`; exit code 1 on any
failed step or same-origin console error.

| step | capture | assertion |
|---|---|---|
| `updraft` | `?shot=v2&frames=60&at=248,384` — Clawd parked on the start yard's edge, the first updraft column (tile 17, rows 13..25) in view with nobody inside it | mean luma (Rec. 709, 0..255) down the column's centre pixel column is **>= 25** above the background sampled 1.5 tiles left and right over the same rows; the column's bottom two tiles are skipped because the neighbours there are pit rock and spikes, not background |
| `spike` | `?shot=v1&frames=60` — the first spike bed (tiles 13..22, row 19) is in view | in the tip zone of the spike tile nearest the screen centre (3 world units wide, 5 tall from the tallest blade's tip, `SPIKE_TIP_INSET`) the **darkest** pixel has a WCAG contrast **>= 3:1** with the biome `crust` colour, and the brightest pixel is a real highlight (relative luminance >= 0.4); on voidreef the upper 60 % of the tile also holds a pixel within RGB distance 60 of the magenta accent (the rim) |
| `beacon` | `?shot=v2&frames=60` — from the start, the goal ~1200 units to the right | `renderer.goalScreen` is non-null, `onScreen === false`, `x` beyond the canvas width, and a pixel within RGB distance 24 of the biome accent sits inside the 48 px band along the canvas edges (the chevron is filled opaque in the accent and drawn after the film pass, so no vignette or grain shifts it) |

Why the spike check looks for a *dark* pixel: the voidreef crust `#22E6D2` has a
relative luminance of 0.62, so no highlight — not even pure white — can reach
3:1 against it. What separates a cyan blade from a cyan ledge is the dark
outline and drop shadow around every blade (luminance edge) plus the magenta
rim (hue edge); the probe asserts both, and separately that the `spike.hi` tip
highlight exists.

## Grid overlay QA

`npm run qa:grid` (`BASE_URL` env, default `http://127.0.0.1:8099`; `ZONE=t2` for
another zone) opens `?shot=<zone>&grid=1&frames=60`, asserts that the harness
stamped `grid: true` with `gridStats` (lines, labels, spawns, checkpoint
segments) and no error, then reads the canvas back: columns and rows dominated
by the overlay's yellow (`#FFE600`) must repeat at one tile's spacing, at least
six of each. Screenshot: `tools/qa/out/grid-<zone>.png`. The overlay is drawn by
`src/client/render/debug.ts` only when the flag is present.

## Telemetry step

The smoke starts t1, quits, and asserts that a `POST /api/events` batch carried `zone_start` and `quit` (and a forced `js_error`), with no player id, name or IP in any batch.

## Character and icon QA

After changing the cat rig, portrait placement or static artwork, run the focused
rig, renderer, UI, share-card and PWA checks:

```bash
npx vitest run test/client/clawd.test.ts test/client/render.test.ts test/client/ui.test.ts test/client/share.test.ts test/tools/pwa.test.ts
```

`test/fixtures/clawd-baseline.json` pins the four base palettes' idle and portrait
canvas call logs. Before refreshing that visual fixture, inspect all ten appearances,
live play, echoes, dash afterimages, and portraits in settings, results, shared
cards and the ending. Check that labels clear the rabbit's ears and robot's
antenna during jumps and stomps, and that all ten settings choices wrap within
the modal. Check that the ending portrait's feet meet the summit at
desktop and phone sizes; the painter and ending UI share `PORTRAIT_FEET` from
`src/client/contracts.ts`. Keep the existing saved skin ids and unlock rules.

Update `public/favicon.svg` and `public/icons/icon.svg` to match the character.
`npm run icons` reads the latter SVG and writes the four app-icon PNGs; it does
not generate either SVG from the rig. Install Chromium, generate the icons, then
build and start the capture server in one terminal:

```bash
npm run qa:browser
npm run icons
npm run build
env -u TABLE_NAME PORT=8099 STATIC_DIR=dist/public DAILY_SECRET=local-development node dist/server/index.js
```

Once the server is listening, capture the social previews in a second terminal:

```bash
BASE_URL=http://127.0.0.1:8099 npm run icons -- --social
```

The social command uses the built client's `?shot=` harness to write
`public/og/og.png` and the three `public/screenshots/*.png` images. The icon tool
also accepts `CHROME=/path/to/chrome` for a system Chromium. Review the SVGs and
generated PNGs together. Stop the capture server, rebuild and restart it before
final browser QA: `npm run build` copies the images from `public/` and does not
run the icon generator.

## Native WebAudio

```bash
npm run qa:audio
```

This command opts into `test/client/audio-output.browser.test.ts` with
`CLAWD_BROWSER_TESTS=1`. It bundles the audio source in memory and uses Playwright
Chromium's native `OfflineAudioContext` to check mute silence and audible
unmuted categories. It needs the installed Chromium but no game server or
`BASE_URL`. A normal `npm test` skips this suite unless the opt-in is set;
record a skipped suite separately from a passed audio check.
