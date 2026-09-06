# CLAWD JUMP: ECHO TOWER — design spec

Date: 2026-09-06 · Region: ap-northeast-2 · Account: 061525506239
Reference: `clawd-jump.tar.gz` (CLAWD JUMP — Azure Ascent, MIT). Extracted copy for study only:
`/tmp/claude-1000/-home-ec2-user-my-project-clawd-game/f8aa643c-bc48-400a-8c09-d71da38a73d7/scratchpad/ref/clawd-jump`

## 0. Decisions made without user input (autonomous session)

The user asked for three things: a game that references Clawd Jump, a
CloudFront → (prefix-list SG) ALB → ECS Fargate architecture, and a structure
that *exceeds* the reference. The user is not available for questions, so the
following calls were made and are recorded here so they can be reversed later:

| Decision | Choice | Why |
|---|---|---|
| Game identity | Direct successor: same lobster hero, same feel constants, new tower setting, new biomes, new mechanics | "참조해서" — a successor is the honest reading; MIT licence permits porting algorithms |
| What "exceeds" means | (1) isomorphic deterministic sim that runs on the server → verified leaderboards + ghost replays + daily seeds; (2) TypeScript + hashed immutable assets; (3) CF→ALB→Fargate with prefix-list SG, origin-verify header, autoscaling, circuit breaker; (4) tests at every layer | The reference is a static site; a backend only earns its place if it does something a static site cannot |
| Language | TypeScript everywhere (client, sim, server, infra, tools). Python level builder replaced by a TS DSL | One toolchain, one type system shared client↔server |
| Datastore | DynamoDB on-demand, single table, TTL on daily runs | Serverless, ~free at demo scale |
| Network | **User decision (2026-09-06):** reuse the existing VPC `cc-on-bedrock-vpc` (`vpc-0dfa5610180dfa628`, stack `CcOnBedrock-Network`) and its two NAT gateways; ALB in its Public subnets, tasks in its Private subnets. No new VPC, NAT or endpoints | The VPC already has NAT per AZ plus gateway endpoints (S3, DynamoDB) and interface endpoints (ECR api/dkr, logs, secretsmanager, sts, monitoring) |
| Deployment | Deploy to the user's account after local verification; report URL + destroy command | Reference README carried a live URL; stack is one `cdk destroy` away |
| Identity | No login. Client-generated player id + display name; rate limits per IP and per player | Demo scope; auth is out of scope |
| UI language | Korean (like the reference). Code, comments, spec in English. README in Korean | Matches reference and user preference |

## 1. What we are building

A browser precision platformer. Run, double jump, 8-way dash, wall jump,
stomp — plus **dash crystals** (mid-air refill), **switch blocks** (dash into a
toggle to flip `%`/`&` solidity) and **echoes**: translucent ghosts of your own
best run and the world's best run, replayed from verified input logs.

Modes:
- **Story** — 9 hand-authored zones in 3 biomes (tiers of the tower).
- **Daily Tower** — procedurally generated tower; the seed is issued by the
  server (HMAC of the UTC date), identical for every player for 24 h, with a
  daily leaderboard.
- **Endless** — local seed, rising tide, personal best only.

Nothing is downloaded but code: art, terrain, sky and audio are procedural,
exactly as in the reference. The only external fetch is the UI webfont.

## 2. Architecture (the part that exceeds)

```
 Browser ──HTTPS──> CloudFront ──HTTP + X-Origin-Verify──> ALB ──> ECS Fargate (Graviton)
                    │  /assets/* cached 1y (hashed)        │ SG: ingress only from        │ Node 22 · Fastify
                    │  /api/*   never cached               │ com.amazonaws.global.        │ serves static + /api
                    │  /        no-cache (index.html)      │ cloudfront.origin-facing     │ replays runs with
                    │  CSP · HSTS · nosniff at the edge    │ listener default → 403       │ the same sim bundle
                    │                                      │ rule: header == secret → fwd │        │
                    └──────────────────────────────────────┴──────────────────────────────┴──> DynamoDB (single table)
```

### 2.1 Isomorphic simulation (`src/sim`)
- Zero DOM/Canvas/Audio imports. Runs in the browser and in Node.
- Fixed tick `DT = 1/120`. One tick consumes one **input mask byte**:
  `LEFT=1 RIGHT=2 UP=4 DOWN=8 JUMP=16 DASH=32`. Press edges are derived
  inside the sim from `mask & ~prevMask`, so a replay is just `Uint8Array`.
  (The reference's "input boundary" bug cannot exist here: one tick, one mask.)
- Determinism contract: seeded RNG (mulberry32) only; no `Date`, no
  `Math.random`; no `Math.sin/cos/tan/exp/pow/hypot/atan2` — use
  `src/sim/dmath.ts` polynomial approximations (only `+ - * /`, `sqrt`,
  `floor`, `abs`, `min`, `max`, which IEEE-754 guarantees bit-identical).
- `Sim` API (see `src/sim/index.ts` contract in §5):
  `new Sim(levelDef, {seed, assist})`, `step(mask)`, `state`, `drainEvents()`,
  `snapshot()` (for ghost/echo rendering), `summary()`.
- `Replay` = `{ v, levelId, seed, assist, masks: Uint8Array }`; wire format
  RLE-encoded base64. `verifyReplay(levelDef, replay)` replays to completion
  and returns `{ cleared, ticks, shards, relics, deaths, height }`.

### 2.2 Presentation (`src/client`)
- `render/` (stage + bloom, sky, tiles as one `Path2D`, particles, the Clawd
  rig, entity drawing), `audio/` (WebAudio synth), `ui/` (DOM screens; the
  canvas is the world, every glyph is DOM), `input/` (keyboard, gamepad, touch
  → per-tick mask with press latching), `net/` (API client), `echo/` (ghost
  playback: a second `Sim` fed the downloaded mask log, drawn translucent).
- Visual-only state (squash, trails, particles) lives here, never in the sim.

### 2.3 Server (`src/server`)
- Fastify 5. Routes: `GET /healthz` (ALB), `GET /api/health`, `GET /api/daily`,
  `POST /api/runs`, `GET /api/leaderboard`, `GET /api/ghost/:runId`.
- `POST /api/runs` decodes the replay, runs `verifyReplay` with the same sim
  code the client shipped, and **rejects (422)** any claim the replay does not
  reproduce (ticks, shards, cleared). Caps: ≤ 10 minutes of ticks, ≤ 64 KB body.
- Rate limit per IP (from `X-Forwarded-For`, first hop) and per player id.
- Static files: `/assets/*` → `Cache-Control: public, max-age=31536000,
  immutable`; `/index.html` → `no-cache`.
- Structured JSON logs (pino) → CloudWatch.

### 2.4 Data (DynamoDB, single table `pk`/`sk`)
| Item | pk | sk | notes |
|---|---|---|---|
| Leaderboard entry | `LB#<mode>#<board>` | `<ticks zero-padded 10>#<runId>` | board = levelId for story, `YYYY-MM-DD` for daily; query ascending = fastest first |
| Run / ghost | `RUN#<runId>` | `META` | replay (base64), verified summary, player, createdAt; `ttl` for daily (30 d) |
| Player best | `PLAYER#<playerId>` | `BEST#<mode>#<board>` | so "your rank" is one GetItem |

### 2.5 Infrastructure (`infra/`, AWS CDK v2, single stack `ClawdEchoTowerStack`)
Constructs: `Data`, `Service`, `Edge` (the VPC is imported in the stack).
- VPC: imported with `ec2.Vpc.fromLookup` by context `vpcId`
  (`vpc-0dfa5610180dfa628`, `cc-on-bedrock-vpc`). Its subnets carry
  `aws-cdk:subnet-type` tags, so `SubnetType.PUBLIC` (ALB) and
  `SubnetType.PRIVATE_WITH_EGRESS` (tasks, egress via the VPC's existing NAT
  gateways) resolve without extra configuration. Nothing network-level is
  created except the two security groups. `cdk.context.json` is committed so
  the lookup is reproducible; unit tests rely on CDK's dummy-VPC fallback.
- ALB SG ingress: **only** `ec2.Peer.prefixList(cloudfrontPrefixListId)` on
  :80. Context key `cloudfrontPrefixListId`, default `pl-22a6434b`
  (ap-northeast-2). Listener default action: fixed 403. Rule priority 1:
  `X-Origin-Verify` header equals a Secrets Manager–generated token → forward.
- CloudFront: origin = ALB (HTTP only, custom header from the secret via a
  CFN dynamic reference, never plaintext in the template). Behaviours:
  `/assets/*` CACHING_OPTIMIZED; `/api/*` CACHING_DISABLED +
  ALL_VIEWER_EXCEPT_HOST_HEADER; default: custom policy honouring origin
  `Cache-Control` (min TTL 0). Response headers policy: CSP (self + Google
  Fonts, no wildcards), HSTS 1 y, nosniff, frame DENY, referrer strict.
  HTTP/2+3, IPv6, PriceClass 200.
- ECS: cluster with Container Insights; Fargate task 256 CPU / 512 MiB,
  `ARM64` (image built on this aarch64 host); desired 2, autoscale 2–6 on CPU
  60 % and ALB requests/target; deployment circuit breaker with rollback;
  log group 14 days; task role: DynamoDB table RW only; execution role: ECR +
  logs only.
- Outputs: `SiteUrl`, `DistributionId`, `AlbDnsName`, `TableName`,
  `ClusterName`, `ServiceName`.

### 2.6 Build & container
- `tools/build.mjs` (esbuild): client → `dist/public/assets/app.<hash>.js`,
  `styles.<hash>.css`; `index.html` rewritten with hashed paths; server →
  `dist/server/index.js` (ESM bundle). `npm run build` does everything.
- `Dockerfile` multi-stage on `node:22-alpine`, non-root user, `HEALTHCHECK`,
  `CMD ["node","dist/server/index.js"]`.

## 3. Game design

### 3.1 Feel constants
Ported from the reference `PHYS` (they are the product of tuning we cannot
redo blind): maxRun 132, gravity 860/1120/620 with apex window 42, jumpVel
-272 / -238, coyote 0.095, buffer 0.13, dash 300 for 0.145 s → 168, wall jump
(168, -258) with 0.13 s lock, stomp 400, spring -430. New: dash crystal
refills `dashReady` and one air jump; respawns after 2.0 s.

### 3.2 Tile legend (grid) and spawn legend (removed from grid at load)
```
grid:  . empty  # solid  = one-way  X crumble  ~ water surface  W water
       ^ V { } spikes (up/down/right/left)  % switch-A solid  & switch-B solid
spawn: P player  G goal  C checkpoint  o shard  R relic  S spring  D dash crystal
       k switch toggle  w walker  h hopper  f flyer  t turret  c chaser
       m platform-h  M platform-v  s saw  z updraft
```
Rules from the reference that still bind level geometry: wall-jump shafts are
4 tiles wide, shaft walls stop 2 tiles above the floor, never enclose a region,
no pit wider than a double jump (7 tiles). The level builder validates all
four (flood fill from `P` over non-solid cells must reach every `o`, `R`, `G`).

### 3.3 Biomes (tower tiers)
| id | KR | EN | palette idea | weather |
|---|---|---|---|---|
| tidepool | 조수 웅덩이 | TIDE POOLS | dawn teal → coral pink, low sun | sea spray motes |
| stormspire | 폭풍 첨탑 | STORM SPIRE | indigo night, gold lightning flashes | rain streaks |
| voidreef | 공허의 초 | VOID REEF | near-black, bioluminescent cyan/magenta | drifting spores |

Zones: `t1 t2 t3` (tidepool), `s1 s2 s3` (stormspire), `v1 v2 v3` (voidreef).
Each zone: par time, ~20–30 shards, 1 relic, a hint line in Korean.
Progression: `t1` open; clearing a zone opens the next; Daily Tower and
Endless are open from the title.

### 3.4 Echoes
On a cleared story zone or a daily run, the client submits the replay. If the
server accepts, the client stores `runId`. On the zone select screen the player
can toggle "내 메아리" (own best) and "세계 메아리" (world best); during play a
second `Sim` is stepped with the ghost's masks and drawn at 40 % alpha in the
biome's accent colour. Ghost sims never emit audio or particles.

### 3.5 Scoring
Reference rank formula (`rankFor`) kept: S/A/B/C from par ratio, shard ratio,
deaths. Leaderboards sort by ticks (fastest), tiebreak by more shards.

## 4. Repository layout
```
clawd-game/
  package.json  tsconfig.json  vitest.config.ts  cdk.json  Dockerfile  .dockerignore
  src/sim/        isomorphic engine (no DOM)      src/shared/   zod protocol + types
  src/client/     render · audio · ui · input · net · echo · main.ts
  src/server/     Fastify app · routes · dynamo repo · verify
  levels/         TS DSL sources + builder → src/sim/levels.generated.ts
  public/         index.html template · favicon.svg · styles.css
  tools/          build.mjs · dev.mjs · qa/ (playwright smoke)
  infra/          bin/app.ts · lib/stack.ts · lib/constructs/*.ts
  test/           sim/ · server/ · infra/ · levels/
  docs/           this spec · README assets
```

## 5. Module contracts (authoritative; agents implement against these)
The TypeScript contracts live in `src/sim/types.ts`, `src/shared/protocol.ts`
and the `index.ts` of each module; they are written before the fan-out and
are the source of truth. Summary:

- `sim`: `Sim`, `LevelDef`, `Level`, `InputMask`, `SimEvent`, `Snapshot`,
  `Replay`, `encodeReplay/decodeReplay`, `verifyReplay`, `makeDailyLevel(seed)`,
  `makeEndlessLevel(seed)`, `LEVELS`, `LEVEL_BY_ID`, `BIOMES`, `PHYS`, `rankFor`.
- `shared/protocol`: zod schemas for every request/response in §2.3.
- `client`: `main.ts` owns the fixed-step loop and the scene machine; each
  subsystem exposes a class with `update(dt)`/`draw()` and reads sim state.
- `server`: `buildApp(deps)` returns a Fastify instance; deps = `{ repo,
  clock, dailySecret }` so tests inject an in-memory repo.
- `infra`: `new ClawdEchoTowerStack(app, id, { env, vpcId, cloudfrontPrefixListId,
  desiredCount })`.

## 6. Testing
- `test/sim`: determinism (same masks → identical snapshots twice; JSON
  equality of 7200-tick runs), jump apex ≈ 2.7 tiles, dash distance, wall
  jump carries ~3 tiles, replay encode/decode round trip, verify rejects
  tampered claims, every story level loads and its start cell is not solid.
- `test/levels`: builder validation (rectangular rows, flood-fill reachability
  of every collectible and the goal, pit width, shaft width).
- `test/server`: routes with in-memory repo; run accepted when replay
  reproduces claim; 422 on mismatch; 429 on rate limit; daily seed stable per
  date and different across dates.
- `test/infra`: CDK assertions — ALB SG has no `0.0.0.0/0` ingress and uses
  `SourcePrefixListId`; listener default 403; header rule; CF origin custom
  header; HTTPS redirect; CSP has no `*`; HSTS 1 y; ARM64 runtime platform;
  circuit breaker rollback; table on-demand + PITR; log retention set;
  autoscaling target present; outputs exist; **no** `AWS::EC2::VPC`,
  `AWS::EC2::NatGateway` or `AWS::EC2::VPCEndpoint` resources are created.
- `tools/qa`: Playwright smoke — page loads with zero console errors, canvas
  is non-blank, a zone starts, `?shot=` harness renders each zone.
- Post-deploy smoke: `curl` SiteUrl 200; `curl` ALB DNS directly → 403 or
  timeout (SG); `/api/daily` returns today's seed; submit a synthetic run.

## 7. Out of scope (explicitly)
Accounts/login, WAF, custom domain/ACM, multiplayer racing, level editor UI,
mobile app wrappers.
