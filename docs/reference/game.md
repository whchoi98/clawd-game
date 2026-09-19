# Game Implementation Reference

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Overview

CLAWD JUMP: ECHO TOWER shares a simulation across browser play, echo playback, tooling, and server replay verification.
Story mode has four tiers of four zones; daily and endless modes generate seeded towers.
Versions have separate responsibilities: package **0.6.0**, **SIM_VERSION 4**, **GEN_VERSION 2**, settings/progress schema **v1**.
Sources: [package](../../package.json), [simulation contract](../../src/sim/types.ts),
[zone registry](../../levels/build.ts), [client contracts](../../src/client/contracts.ts).

### Components

| Component | Implementation and boundary |
|---|---|
| Boot and flow | [main.ts](../../src/client/main.ts) constructs the concrete ports and starts `requestAnimationFrame`; [Scenes](../../src/client/scenes.ts) owns the live run, input log, echoes, progression, and submissions. |
| Simulation | [Sim](../../src/sim/sim.ts) owns phases, player, entities, foes, tide, and statistics; `step(mask)`, `drainEvents()`, and `summary()` connect it to consumers. [config.ts](../../src/sim/config.ts) owns physics/assist tuning. |
| Presentation and input | [contracts.ts](../../src/client/contracts.ts) defines the ports. [DOM UI](../../src/client/ui/ui.ts) emits actions and edits settings; [renderer](../../src/client/render/renderer.ts) reads simulation state; [audio](../../src/client/audio/engine.ts) synthesizes sound. [Input](../../src/client/input/input.ts) provides held and latched masks. |
| Character | [clawd.ts](../../src/client/render/clawd.ts) draws the cat, its eight skin palettes, portraits, and dash silhouette. [PlayerVisual](../../src/client/render/actors.ts) supplies ear springs and the scarf chain. The portrait and ending UI share the `PORTRAIT_FEET` anchor from [contracts.ts](../../src/client/contracts.ts). Existing skin ids, unlocks, hitboxes, and replay versions remain compatible. Follow [character and icon QA](../../tools/qa/README.md#character-and-icon-qa) for visual checks, SVG updates, PNG generation, and social preview capture. |
| Echoes and replay viewer | [Echo](../../src/client/echo/echo.ts) advances a separate `Sim` alongside the live run. [ReplayPlayback](../../src/client/echo/playback.ts) supports seeking, checkpoints, and 0.5×/1×/2× playback; Scenes preserves the paused live run while viewing a guide. |
| Local persistence | [Save](../../src/client/save.ts) owns settings, progress, identity, local echoes, and the daily seed cache. Goals, medals, and skins are coordinated by [goals.ts](../../src/client/goals.ts), [unlocks.ts](../../src/client/unlocks.ts), and Scenes. |
| Network | [Api](../../src/client/net/api.ts) parses responses with [shared Zod schemas](../../src/shared/protocol.ts); [SubmitQueue](../../src/client/net/queue.ts) retains pending story/daily submissions. Endless records remain local. |
| Content | [Level DSL](../../levels/dsl.ts), [builder](../../levels/build.ts), and [solution corpora](../../levels/solutions.ts) feed generated modules; [daily](../../src/sim/gen/daily.ts) and [endless](../../src/sim/gen/endless.ts) share tower construction and authored chunks. |

### Key Decisions

- **Fixed simulation contract:** `TICK_HZ = 120`, `DT = 1 / 120`, and one input byte per tick.
  `IN` uses `LEFT=1`, `RIGHT=2`, `UP=4`, `DOWN=8`, `JUMP=16`, `DASH=32`, `RETRY=64`; edges derive from the previous mask.
  Retry enters the death/respawn flow. Logs begin in `intro`; `state.tick` counts all phases, `summary().ticks` only play ticks.
- **Deterministic gameplay:** [dmath.ts](../../src/sim/dmath.ts) supplies deterministic math helpers,
  and [rng.ts](../../src/sim/rng.ts) supplies seeded mulberry32. Gameplay ticks have no DOM, rendering, audio, network, or wall-clock dependency.
  Change `SIM_VERSION` for replay behavior changes, `GEN_VERSION` for tower output changes, and a shipped zone's `rev` for tile changes.
- **Frame time stays outside physics:** [TickScheduler](../../src/client/loop.ts) clamps wall time
  to `1 / 20` second, with at most eight ticks per frame. Latched presses reach the first tick and survive frames with no ticks.
  Hitstop/slow motion change scheduling, not `DT`; Scenes discards hidden-tab gaps and limits menu backdrop redraws to 30 Hz.
- **Replay claims are checked:** [replay.ts](../../src/sim/replay.ts) encodes `(mask, count)` RLE pairs
  with counts `1..255`, then base64; the decoded cap is 72,000 ticks and the wire mask cap is 64 KiB.
  Verification checks version, level, completion, and claimed ticks/shards/deaths/clear status/integer height.
  The cooperative verifier yields every 2,400 ticks by default; [server submission](../../src/server/runs.ts) also checks eligibility and resolves the level.
- **Save and submission lifecycles are separate:** Save repairs defaults, debounces writes by
  250 ms, and reconciles edits with the latest stored document. Boot wires flushes on `pagehide` and hiding.
  Incompatible echo masks are dropped; endless echoes also require matching generator/seed metadata.
  Progress transfer omits replay masks, segment bests, and session deaths. Scenes enqueues eligible requests before POST.
  The queue holds at most 20, evicts oldest first, flushes at boot/reconnect, backs off for `429`/`503 busy`, and removes definitive verdicts.
  Api uses an eight-second deadline through response parsing; `422` is a parsed rejection. Storage failures leave only in-memory state.
- **PWA behavior is explicit:** [pwa.ts](../../src/client/pwa.ts) registers `/sw.js`, handles the
  deferred install prompt, and delays a requested reload until the run settles.
  [The worker](../../src/client/sw/sw.ts) atomically precaches build-supplied paths; [routing](../../src/client/sw/strategy.ts) uses cache-first assets
  and network-first navigation, bypassing API, health, worker, and cross-origin requests. Cached story/endless play needs no server.
  Daily play needs a previously fetched, unexpired seed; eligible offline submissions use the queue.
  [The manifest](../../public/manifest.webmanifest) declares fullscreen/landscape preferences, icons, and daily/endless shortcuts.

### Code Pointers

| Generated output (edit its source instead) | Source and writer |
|---|---|
| [levels.generated.ts](../../src/sim/levels.generated.ts) | `levels/zones/*.ts` and `ZONES`; `levels/build.ts` validates geometry/pacing and emits levels/chapters. |
| [echoes.generated.ts](../../src/sim/echoes.generated.ts) | `levels/solutions/par/*.json`, with verified fast fallback from `levels/solutions/*.json`; `levels/build.ts` emits `GOAL_ECHOES`. |
| [chunks.generated.ts](../../src/sim/chunks.generated.ts) | [Chunk registry](../../levels/chunks/index.ts) and chunk sources; `levels/build.ts` validates and sorts by id. This list affects generator output. |
| [corpus-digests.json](../../test/fixtures/corpus-digests.json) | [hash-corpus.ts](../../tools/hash-corpus.ts) writes Node/V8 results from [selftest.ts](../../src/client/selftest.ts). |
| `dist/public/`, `dist/server/` | [build.mjs](../../tools/build.mjs) bundles client/server and publishes hashed assets plus the service worker. Level generation is a separate command. |

[solve.ts](../../tools/solve.ts) writes death-free clears only after fresh replay verification.
Fast and paced story corpora bind to `(sim, rev, seed)`; paced targets are `0.95–1.10 × par`.
Missing/unsuitable solutions are tracked in each corpus's `PENDING.json`; chunk solo-room replays
live in `levels/chunks/solutions/`. The builder prefers a valid paced clear, warns on fast fallback,
and omits an echo if neither verifies. Pace-window enforcement belongs to solver/corpus checks.
For intended changes to `t1` or `wall-zig`, use the relevant recording commands, then regenerate:

```bash
npm run solve -- t1 --force
npm run solve:par -- t1 --force
npm run solve -- --chunks wall-zig --force
npm run levels
npx tsx tools/hash-corpus.ts
npm run levels -- --check
npx tsx tools/hash-corpus.ts --check
```

Rewrite the hash fixture only alongside reviewed version/content/replay changes. It currently
contains 16 story echoes plus daily seeds `1` and `20260906` (up to 3,000 scripted ticks each).
Digests include outcomes and FNV-1a of recursively key-sorted final `SimState` JSON.
[Browser QA](../../tools/qa/selftest.ts) compares `?shot=selftest` output with that fixture.
With a built server running (default `BASE_URL=http://127.0.0.1:8099`) and browsers installed:

```bash
npx tsx tools/qa/selftest.ts --require=chromium,webkit,firefox
```

### Cross-references

[Repository guide](../../README.md) · [Architecture](../architecture.md) · [Reference index](INDEX.md)
· [Replay verification runbook](../runbooks/anticheat.md) · [QA guide](../../tools/qa/README.md) · [CI workflow](../../.github/workflows/ci.yml).

<a id="korean"></a>
## 한국어

### 개요 (Overview)

CLAWD JUMP: ECHO TOWER는 브라우저 플레이, 메아리 재생, 도구, 서버 리플레이 검증에 같은 시뮬레이션을 사용합니다.
스토리는 4개 층마다 4개 구역이 있으며, 데일리와 끝없는 등반은 시드로 탑을 생성합니다.
패키지 **0.6.0**, **SIM_VERSION 4**, **GEN_VERSION 2**, 설정·진행도 스키마 **v1**은 각각 다른 변경 범위를 담당합니다.
근거: [패키지](../../package.json), [시뮬레이션 계약](../../src/sim/types.ts),
[구역 등록부](../../levels/build.ts), [클라이언트 계약](../../src/client/contracts.ts).

### 구성 요소 (Components)

| 구성 요소 | 구현과 경계 |
|---|---|
| 부팅과 흐름 | [main.ts](../../src/client/main.ts)가 포트의 실제 구현을 조립하고 `requestAnimationFrame`을 시작합니다. [Scenes](../../src/client/scenes.ts)는 진행 중인 도전, 입력 로그, 메아리, 진행도와 제출을 관리합니다. |
| 시뮬레이션 | [Sim](../../src/sim/sim.ts)이 페이즈, 플레이어, 엔티티, 적, 조류와 통계를 관리합니다. `step(mask)`, `drainEvents()`, `summary()`로 외부와 연결하며, [config.ts](../../src/sim/config.ts)가 물리·어시스트 조정을 담당합니다. |
| 표현과 입력 | [contracts.ts](../../src/client/contracts.ts)가 포트를 정의합니다. [DOM UI](../../src/client/ui/ui.ts)는 액션을 내보내고 설정을 수정하며, [렌더러](../../src/client/render/renderer.ts)는 시뮬레이션 상태를 읽고, [오디오](../../src/client/audio/engine.ts)는 소리를 합성합니다. [Input](../../src/client/input/input.ts)은 홀드·래치 마스크를 제공합니다. |
| 캐릭터 | [clawd.ts](../../src/client/render/clawd.ts)가 고양이와 여덟 스킨 팔레트, 초상, 대시 실루엣을 그립니다. [PlayerVisual](../../src/client/render/actors.ts)은 귀 스프링과 스카프 체인을 제공합니다. 초상과 엔딩 UI는 [contracts.ts](../../src/client/contracts.ts)의 `PORTRAIT_FEET` 기준점을 공유합니다. 기존 스킨 ID·해금·히트박스·리플레이 버전과 호환됩니다. 외형 확인, SVG 수정, PNG 생성과 공유 미리보기 캡처는 [캐릭터·아이콘 QA](../../tools/qa/README.md#character-and-icon-qa)를 따릅니다. |
| 메아리와 리플레이 뷰어 | [Echo](../../src/client/echo/echo.ts)는 별도 `Sim`을 실제 도전과 함께 진행합니다. [ReplayPlayback](../../src/client/echo/playback.ts)은 위치·체크포인트 이동과 0.5×/1×/2× 재생을 지원하며, Scenes는 길잡이를 보는 동안 일시정지된 실제 도전을 보존합니다. |
| 로컬 저장 | [Save](../../src/client/save.ts)가 설정, 진행도, 플레이어 식별 정보, 로컬 메아리와 데일리 시드 캐시를 관리합니다. [goals.ts](../../src/client/goals.ts), [unlocks.ts](../../src/client/unlocks.ts)와 Scenes가 목표·메달·모습을 조율합니다. |
| 네트워크 | [Api](../../src/client/net/api.ts)는 [공유 Zod 스키마](../../src/shared/protocol.ts)로 응답을 파싱하고, [SubmitQueue](../../src/client/net/queue.ts)는 대기 중인 스토리·데일리 제출을 보관합니다. 끝없는 등반 기록은 로컬에 남습니다. |
| 콘텐츠 | [레벨 DSL](../../levels/dsl.ts), [빌더](../../levels/build.ts), [솔루션 코퍼스](../../levels/solutions.ts)가 생성 모듈의 입력입니다. [데일리](../../src/sim/gen/daily.ts)와 [끝없는 등반](../../src/sim/gen/endless.ts)은 탑 구성 코드와 수작업 청크를 공유합니다. |

### 주요 결정 (Key Decisions)

- **고정 시뮬레이션 계약:** `TICK_HZ = 120`, `DT = 1 / 120`이며 틱마다 입력 1바이트를 받습니다.
  `IN`은 `LEFT=1`, `RIGHT=2`, `UP=4`, `DOWN=8`, `JUMP=16`, `DASH=32`, `RETRY=64`이며 이전 마스크로 누름 엣지를 계산합니다.
  재도전은 사망·리스폰 흐름으로 들어갑니다. 로그는 `intro`부터 시작하고, `state.tick`은 모든 페이즈를, `summary().ticks`는 플레이 틱만 셉니다.
- **결정론적 게임플레이:** [dmath.ts](../../src/sim/dmath.ts)가 결정론적 수학 함수를,
  [rng.ts](../../src/sim/rng.ts)가 시드 기반 mulberry32를 제공합니다. 게임플레이 틱은 DOM, 렌더링, 오디오, 네트워크, 실제 시계에 의존하지 않습니다.
  리플레이 동작이 달라지면 `SIM_VERSION`, 탑 출력이 달라지면 `GEN_VERSION`, 배포된 구역의 타일이 바뀌면 `rev`를 올립니다.
- **프레임 시간과 물리 분리:** [TickScheduler](../../src/client/loop.ts)는 실제 시간 간격을
  `1 / 20`초로 제한하고 프레임당 최대 8틱을 실행합니다. 래치 입력은 첫 틱에 전달하며 틱이 없는 프레임에도 유지합니다.
  히트스톱·슬로모션은 `DT` 대신 틱 실행 시점을 조절합니다. Scenes는 숨겨진 탭의 시간 간격을 버리고 메뉴 배경 갱신을 30 Hz로 제한합니다.
- **리플레이 주장 검증:** [replay.ts](../../src/sim/replay.ts)는 `(mask, count)` RLE 쌍을
  횟수 `1..255`로 묶어 base64로 인코딩합니다. 디코딩 상한은 72,000틱, 전송 마스크 상한은 64 KiB입니다.
  버전, 레벨, 종료 여부와 주장한 틱·파편·사망·클리어 여부·정수 높이를 검증합니다.
  협력형 검증기는 기본 2,400틱마다 실행을 양보하며, [서버 제출 처리](../../src/server/runs.ts)는 자격 확인과 레벨 결정도 수행합니다.
- **저장과 제출의 수명주기 분리:** Save는 기본값을 복구하고 쓰기를 250 ms 디바운스하며,
  변경을 최신 저장 문서와 병합합니다. 부팅 코드가 `pagehide`와 탭 숨김 시 flush를 연결합니다.
  호환되지 않는 메아리 마스크는 제거하며, 끝없는 등반 메아리는 생성기·시드 메타데이터도 맞아야 합니다.
  진행도 이전에는 리플레이 마스크, 구간 최고 기록과 세션 사망 횟수를 넣지 않습니다. Scenes는 적격 요청을 POST 전에 저장합니다.
  대기열은 최대 20개로 오래된 항목부터 비우며, 부팅·재연결 때 전송하고 `429`/`503 busy`에는 재시도 간격을 늘리며 확정 판정은 제거합니다.
  Api는 응답 파싱까지 8초 제한을 적용하고 `422`를 거절 응답으로 파싱합니다. 저장소 오류가 나면 메모리 상태만 남습니다.
- **코드에 명시된 PWA 동작:** [pwa.ts](../../src/client/pwa.ts)는 `/sw.js`를 등록하고,
  보류된 설치 프롬프트를 처리하며, 요청된 새로고침은 도전 처리가 끝날 때까지 미룹니다.
  [워커](../../src/client/sw/sw.ts)는 빌드가 전달한 경로를 원자적으로 프리캐시합니다. [라우팅](../../src/client/sw/strategy.ts)은 에셋에 cache-first,
  탐색에 network-first를 적용하며 API·헬스·워커·교차 출처 요청을 우회합니다. 캐시된 스토리·끝없는 등반은 서버 없이 실행됩니다.
  데일리는 미리 받아 둔 유효한 시드가 필요하며 적격 오프라인 제출은 대기열을 사용합니다.
  [매니페스트](../../public/manifest.webmanifest)는 전체 화면·가로 방향 선호, 아이콘, 데일리·끝없는 등반 바로가기를 선언합니다.

### 코드 위치 (Code Pointers)

| 생성 산출물 (직접 수정하지 않고 원본 수정) | 원본과 작성 도구 |
|---|---|
| [levels.generated.ts](../../src/sim/levels.generated.ts) | `levels/zones/*.ts`와 `ZONES`가 원본입니다. `levels/build.ts`가 지형·페이싱을 검증하고 레벨·챕터를 출력합니다. |
| [echoes.generated.ts](../../src/sim/echoes.generated.ts) | `levels/solutions/par/*.json`이 원본이며, 검증된 `levels/solutions/*.json`을 폴백으로 씁니다. `levels/build.ts`가 `GOAL_ECHOES`를 출력합니다. |
| [chunks.generated.ts](../../src/sim/chunks.generated.ts) | [청크 등록부](../../levels/chunks/index.ts)와 청크 원본을 `levels/build.ts`가 검증하고 id순으로 정렬합니다. 이 목록은 생성기 출력에 영향을 줍니다. |
| [corpus-digests.json](../../test/fixtures/corpus-digests.json) | [hash-corpus.ts](../../tools/hash-corpus.ts)가 [selftest.ts](../../src/client/selftest.ts)의 Node/V8 결과를 기록합니다. |
| `dist/public/`, `dist/server/` | [build.mjs](../../tools/build.mjs)가 클라이언트·서버를 번들링하고 해시 에셋과 서비스 워커를 발행합니다. 레벨 생성은 별도 명령입니다. |

[solve.ts](../../tools/solve.ts)는 새 시뮬레이션의 재생 검증을 거친 사망 없는 클리어만 기록합니다.
빠른·페이스 스토리 코퍼스는 `(sim, rev, seed)`에 묶이며, 페이스 목표는 `0.95–1.10 × par`입니다.
없거나 기준에 못 미치는 솔루션은 각 코퍼스의 `PENDING.json`에 남기고, 청크 솔로 룸 리플레이는
`levels/chunks/solutions/`에 둡니다. 빌더는 유효한 페이스 클리어를 우선하며, 빠른 폴백에는 경고하고
둘 다 검증되지 않으면 메아리를 생략합니다. 페이스 범위는 솔버·코퍼스 검사에서 확인합니다.
의도적으로 `t1` 또는 `wall-zig`를 바꾼 경우 필요한 녹화 명령을 골라 실행한 뒤 다시 생성합니다.

```bash
npm run solve -- t1 --force
npm run solve:par -- t1 --force
npm run solve -- --chunks wall-zig --force
npm run levels
npx tsx tools/hash-corpus.ts
npm run levels -- --check
npx tsx tools/hash-corpus.ts --check
```

해시 픽스처는 검토된 버전·콘텐츠·리플레이 변경과 함께만 갱신합니다. 현재 스토리 메아리 16개와
데일리 시드 `1`, `20260906`을 포함하며, 데일리는 각각 최대 3,000틱의 스크립트를 실행합니다.
다이제스트에는 결과와 최종 `SimState` JSON의 키를 재귀 정렬한 FNV-1a 해시가 들어갑니다.
[브라우저 QA](../../tools/qa/selftest.ts)는 `?shot=selftest` 출력을 이 픽스처와 비교합니다.
빌드된 서버가 실행 중이고(기본 `BASE_URL=http://127.0.0.1:8099`) 브라우저가 설치된 상태에서 실행합니다.

```bash
npx tsx tools/qa/selftest.ts --require=chromium,webkit,firefox
```

### 관련 문서 (Cross-references)

[저장소 가이드](../../README.md) · [아키텍처](../architecture.md) · [레퍼런스 색인](INDEX.md)
· [리플레이 검증 런북](../runbooks/anticheat.md) · [QA 가이드](../../tools/qa/README.md) · [CI 워크플로](../../.github/workflows/ci.yml).
