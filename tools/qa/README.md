# QA: Playwright smoke

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
| `02-select.png` | zone select after `Enter` on the title menu |
| `03-play.png` | first zone running after `Enter` on zone select |
| `04-offline.png` | title screen after a reload with the network cut, served by the service worker |
| `shot-<zone>.png` | `?shot=<zone>&frames=240&hold=right&pulse=jump:26` for `t1 t2 t3 s1 s2 s3 v1 v2 v3` |

## What is asserted

1. `GET /` renders and `#scr-title` becomes visible within 30 s.
2. `canvas#world` is painted: 48 pixels sampled on an 8x6 grid contain at least
   4 distinct colours and are not all transparent. A flat or unsized canvas fails.
3. `Enter` on the title opens `#scr-select`; `Enter` again opens `#scr-play`
   and the canvas is painted with the world.
4. **offline**: back on `/`, the script polls (up to 20 s) until
   `navigator.serviceWorker.getRegistration()` has an active worker and a
   `cet-*` cache holds `/index.html` — that is, `/sw.js` installed and its
   precache (`/`, `/index.html`, every `/assets/*`, favicon, manifest, icons)
   finished. Then `context.setOffline(true)`, `page.reload()`, and `#scr-title`
   must appear with a painted canvas before the network is restored. Console
   errors of the `net::ERR_INTERNET_DISCONNECTED` kind are downgraded to
   warnings during this step only.
5. For each zone the harness stamps `document.documentElement.dataset.shot`
   (JSON from the client's `shot.ts`); a stamp containing `error` fails, and the
   canvas must again be painted.
6. Throughout: console messages of type `error` and `pageerror` events on the
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

## Mobile layout QA

`npm run qa:mobile` (`BASE_URL` env, default `http://127.0.0.1:8099`) emulates iPhone 14 landscape (750x340), Galaxy S9+ landscape (658x320), iPad Pro 11 landscape and portrait, plus an iPhone portrait profile, and asserts: zero same-origin console errors, both title menu ends inside the viewport, tap-through to play with the touch pad visible, the HUD hint clear of the DASH/JUMP buttons, no rotate prompt on tablet portrait, and the rotate prompt shown/dismissed/remembered on a phone in portrait. Screenshots land in `tools/qa/out/mobile-*.png`.
