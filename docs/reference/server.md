# Server implementation reference

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Overview

[The entrypoint](../../src/server/index.ts) starts Fastify and a replay worker from the same `dist/server/index.js` bundle. The server resolves levels, verifies submitted inputs with the shared simulation, and stores personal bests for story and daily boards. Endless play has no submission mode in the [wire contract](../../src/shared/protocol.ts).

### Components

Runtime configuration comes from [index.ts](../../src/server/index.ts#L30), [health.ts](../../src/server/routes/health.ts#L18), and [seed.ts](../../src/server/seed.ts#L120):

| Variable | Implemented default and effect |
| --- | --- |
| `PORT` | `8080`; listens on `0.0.0.0`. |
| `TABLE_NAME` | Unset selects `MemoryRepo`; data is lost on restart. Set selects `DynamoRepo` through the AWS SDK. |
| `DAILY_SECRET` | Unset generates a random key per process; seeds then differ across tasks and restarts. |
| `TAG_SECRET` | Falls back to `DAILY_SECRET`; keys public player tags and transfer-code check characters. |
| `STATIC_DIR` | Unset serves APIs only; Docker sets `/app/dist/public`. |
| `APP_VERSION` | Defaults to `dev`; ECS supplies the Docker asset hash for `/api/health`. |
| `SEED_BOARDS` | Only `0` disables boot seeding of empty story boards with verified goal echoes. |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | Health reports the first available value; ECS explicitly supplies `AWS_REGION`. |

`npm run dev` uses [tools/dev.mjs](../../tools/dev.mjs#L111): default port `8099`, built static files, and `TABLE_NAME` removed from the child environment. `npm run build -- --prod` builds the bundles; `npm run start` runs the built server with its runtime environment.

| Route | Contract and behavior |
| --- | --- |
| `GET /healthz`, `GET /api/health` | Plain `ok` without rate limiting/request logs; API health reports build, uptime, region when set, and sim/generator versions. |
| `GET /api/daily` | Today's UTC date/seed, next UTC midnight, versions, and yesterday's date/seed. |
| `POST /api/runs` | `RunSubmit` → accepted result or `422` rejection; schema/name errors `400`, body cap `96 KiB`, encoded masks cap `64 KiB`. |
| `GET /api/leaderboard` | `mode`, `board`, `limit` (default `20`, maximum `50`); public top-N, `you: false`, no `yours`; legacy `playerId` is ignored. |
| `GET /api/me` | Requires `mode`, `board`, `playerId`; personal best, total, and bounded rank (`1000` better entries; `rankCapped` reports truncation). |
| `GET /api/ghost/:runId` | Stored masks and replay metadata; missing or flagged runs return `404`; `60` requests/minute/IP. |
| `POST /api/events` | Up to `20` events / `4 KiB`, `30` batches/minute/IP, success `204`; structured event/EMF logs with forbidden identity keys removed. |
| `POST /api/transfer`, `GET /api/transfer/:code` | Progress cap `16 KiB`, eight-character code, seven-day TTL, single successful redemption; `5` requests/minute/IP; invalid check `400`, unknown/used/expired code `410`. |

The [DynamoDB key builders](../../src/server/repo/dynamo.ts#L94) use string `pk`/`sk`. Here `<board>` means `boardKey(mode, board)`, including the story version suffix.

| Records | Stored responsibility |
| --- | --- |
| `LB#<mode>#<board>` / `<score:12>#<99999-shards:5>#<runId>` | Sorted public board projection; excludes masks, heuristics, and flags. |
| `RUN#<runId>` / `META` | Full replay, summary, replay hash, heuristics, optional moderation flag and TTL. |
| `PLAYER#<id>` / `BEST#<mode>#<board>` | Current best projection; fetching it alone does not compute rank. |
| `HASH#<mode>#<board>#<hash>` / `META`; `BOARD#<mode>#<board>` / `META` | Replay ownership and board-total counter. |
| `PLAYER#<id>` / `SNAPSHOT`; `CODE#<code>` / `META` | Transfer snapshot and its redeemable code; replacement retires the previous code. |
| `RL#<ip>#<minute>` / `META` | Shared submit counter, `120`-second TTL from the window start. |

### Key Decisions

1. [Submission checks](../../src/server/runs.ts#L209) run in order: assist → sim/generator versions → level/date/seed → RLE/base64 decoding and claim-derived mask budget → replay → story clear → server score → personal-best transaction. Verification compares ticks, shards, deaths, cleared state, and floored height.
2. [The pool](../../src/server/verifyPool.ts#L249) uses one worker, four in-flight verifications, and sixteen waiting slots. The shared verifier yields every `2400` ticks; overflow/worker failure returns `503 busy` with `Retry-After: 3`. Its `20000` ms watchdog is rearmed on job dispatch/completion.
3. [Request limits](../../src/server/app.ts#L41) default to `120`/minute/IP in-process. Runs additionally use a fleet-shared `12`/minute/IP counter and a local `10`/minute `ip:playerId` budget. Counter failures log and allow the request; [IP selection](../../src/server/ip.ts) prefers `CloudFront-Viewer-Address`, then the first forwarded hop, then `req.ip`.
4. [Daily seeds](../../src/server/daily.ts#L35) are the first four big-endian bytes of HMAC-SHA256(current secret, UTC date). Both today and yesterday are recalculated and accepted; changing the key affects those open dates too. [Story keys](../../src/server/boards.ts#L25) append `#s<SIM_VERSION>r<rev>`; daily keys remain dates.
5. [Best persistence](../../src/server/runs.ts#L165) skips non-improvements, guards concurrent replacement, retries one conflict, and rejects another owner's replay hash. Heuristics are recorded, not automatic rejection criteria. Daily runs carry `30`-day TTLs; current story bests have none, and replaced story replay records receive [90-day TTLs](../../src/server/repo/ttl.ts).
6. [Public boards](../../src/server/routes/leaderboard.ts#L62) use HMAC tags and `public, s-maxage=5, stale-while-revalidate=30`. `/api/me` and other API responses default to `no-store`; API compression supports Brotli/gzip from `1024` bytes. Transfer redemption returns the credential to the receiving client; its snapshot does not establish leaderboard scores.
7. [Static responses](../../src/server/static.ts#L15) give `/assets/*` one-year immutable caching. `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest` use `max-age=0, s-maxage=60, stale-while-revalidate=300`; other root files use `no-cache`. Unknown paths return `404`.
8. [Boot seeding](../../src/server/app.ts#L113) completes before listening. [SIGTERM/SIGINT handling](../../src/server/index.ts#L81) closes Fastify, then the worker pool, with a `10`-second forced-exit timer.

### Code Pointers

- [Composition and error mapping](../../src/server/app.ts), [request/response schemas](../../src/shared/protocol.ts), [route handlers](../../src/server/routes).
- [Level resolution](../../src/server/levels.ts), [replay verifier](../../src/sim/replay.ts), [score calculation](../../src/sim/config.ts#L102), [replay hashing](../../src/server/hash.ts).
- [Persistence interface](../../src/server/repo/types.ts), [DynamoDB implementation](../../src/server/repo/dynamo.ts), [memory implementation](../../src/server/repo/memory.ts).
- [Transfer format](../../src/server/transfer.ts), [tag key selection](../../src/server/players.ts), [telemetry filtering and metrics](../../src/server/routes/events.ts).

### Cross-references

- [Infrastructure](infrastructure.md) · [Architecture](../architecture.md) · [Onboarding](../onboarding.md).
- [Scale runbook](../runbooks/scale.md) · [Anti-cheat runbook](../runbooks/anticheat.md) · [Secrets runbook](../runbooks/secrets.md).

---

<a id="korean"></a>
## 한국어

### 개요 (Overview)

[진입점](../../src/server/index.ts)은 동일한 `dist/server/index.js` 번들에서 Fastify와 리플레이 워커를 시작합니다. 서버는 레벨을 결정하고 공유 시뮬레이션으로 제출된 입력을 검증한 뒤 스토리·데일리 보드의 개인 최고 기록을 저장합니다. [통신 계약](../../src/shared/protocol.ts)에는 끝없는 등반의 제출 모드가 없습니다.

### 구성 요소 (Components)

런타임 설정은 [index.ts](../../src/server/index.ts#L30), [health.ts](../../src/server/routes/health.ts#L18), [seed.ts](../../src/server/seed.ts#L120)에 정의되어 있습니다.

| 변수 | 구현된 기본값과 동작 |
| --- | --- |
| `PORT` | `8080`; `0.0.0.0`에서 수신합니다. |
| `TABLE_NAME` | 미설정 시 `MemoryRepo`를 사용하며 재시작하면 데이터가 사라집니다. 설정하면 AWS SDK를 통해 `DynamoRepo`를 사용합니다. |
| `DAILY_SECRET` | 미설정 시 프로세스마다 임의 키를 생성하므로 태스크·재시작 간 시드가 달라집니다. |
| `TAG_SECRET` | `DAILY_SECRET`으로 대체되며 공개 플레이어 태그와 이전 코드 검사 문자의 키로 쓰입니다. |
| `STATIC_DIR` | 미설정 시 API만 제공합니다. Docker는 `/app/dist/public`으로 설정합니다. |
| `APP_VERSION` | 기본값은 `dev`이며 ECS는 `/api/health`에 표시할 Docker 에셋 해시를 제공합니다. |
| `SEED_BOARDS` | `0`일 때만 부팅 시 빈 스토리 보드에 검증된 목표 메아리를 넣는 동작을 끕니다. |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | 헬스 응답은 먼저 설정된 값을 사용하며 ECS는 `AWS_REGION`을 명시합니다. |

`npm run dev`는 [tools/dev.mjs](../../tools/dev.mjs#L111)를 사용합니다. 기본 포트는 `8099`이고 빌드된 정적 파일을 제공하며 자식 환경에서 `TABLE_NAME`을 제거합니다. `npm run build -- --prod`는 번들을 빌드하고, `npm run start`는 런타임 환경을 적용해 빌드된 서버를 실행합니다.

| 경로 | 계약과 동작 |
| --- | --- |
| `GET /healthz`, `GET /api/health` | 일반 텍스트 `ok`는 속도 제한·요청 로그 없이 제공합니다. API 헬스는 빌드, 가동 시간, 설정된 리전, sim/생성기 버전을 반환합니다. |
| `GET /api/daily` | 오늘의 UTC 날짜·시드, 다음 UTC 자정, 버전, 어제의 날짜·시드를 반환합니다. |
| `POST /api/runs` | `RunSubmit` → 수락 결과 또는 `422` 거절; 스키마·이름 오류는 `400`, 본문 한도는 `96 KiB`, 인코딩된 마스크 한도는 `64 KiB`입니다. |
| `GET /api/leaderboard` | `mode`, `board`, `limit`(기본 `20`, 최대 `50`); 공개 top-N이며 `you: false`, `yours` 없음; 이전 클라이언트의 `playerId`는 무시합니다. |
| `GET /api/me` | `mode`, `board`, `playerId` 필수; 개인 최고 기록, 총원, 제한된 순위(상위 항목 `1000`개까지 계산, 제한 도달은 `rankCapped`)를 반환합니다. |
| `GET /api/ghost/:runId` | 저장된 마스크와 리플레이 메타데이터를 반환합니다. 없거나 관리 플래그가 설정된 기록은 `404`; IP당 분당 `60`회입니다. |
| `POST /api/events` | 이벤트 최대 `20`개 / `4 KiB`, IP당 분당 `30`개 배치, 성공 `204`; 금지된 식별 키를 제거한 구조화 이벤트·EMF 로그를 남깁니다. |
| `POST /api/transfer`, `GET /api/transfer/:code` | 진행도 한도 `16 KiB`, 여덟 문자 코드, TTL 7일, 성공한 복원은 한 번; IP당 분당 `5`회; 검사 오류 `400`, 없거나 사용·만료된 코드 `410`입니다. |

[DynamoDB 키 생성기](../../src/server/repo/dynamo.ts#L94)는 문자열 `pk`/`sk`를 사용합니다. 아래 `<board>`는 스토리 버전 접미사를 포함한 `boardKey(mode, board)`입니다.

| 항목 | 저장 책임 |
| --- | --- |
| `LB#<mode>#<board>` / `<score:12>#<99999-shards:5>#<runId>` | 정렬된 공개 보드용 사본이며 마스크·휴리스틱·플래그는 제외합니다. |
| `RUN#<runId>` / `META` | 전체 리플레이, 요약, 리플레이 해시, 휴리스틱, 선택적 관리 플래그와 TTL입니다. |
| `PLAYER#<id>` / `BEST#<mode>#<board>` | 현재 최고 기록의 사본이며 이 항목 조회만으로 순위를 계산하지는 않습니다. |
| `HASH#<mode>#<board>#<hash>` / `META`; `BOARD#<mode>#<board>` / `META` | 리플레이 소유권과 보드 총원 카운터입니다. |
| `PLAYER#<id>` / `SNAPSHOT`; `CODE#<code>` / `META` | 이전 스냅샷과 복원 코드이며 새 코드가 이전 코드를 대체합니다. |
| `RL#<ip>#<minute>` / `META` | 공유 제출 카운터이며 구간 시작부터 `120`초의 TTL을 가집니다. |

### 주요 결정 (Key Decisions)

1. [제출 검사](../../src/server/runs.ts#L209)는 보조 모드 → sim/생성기 버전 → 레벨·날짜·시드 → RLE/base64 디코딩과 주장 기반 마스크 한도 → 재생 → 스토리 클리어 → 서버 점수 → 개인 최고 기록 트랜잭션 순서입니다. 검증은 틱, 파편, 사망, 클리어 상태, 내림한 높이를 비교합니다.
2. [검증 풀](../../src/server/verifyPool.ts#L249)은 워커 하나에서 검증 네 건을 진행하고 열여섯 건을 대기시킵니다. 공유 검증기는 `2400`틱마다 양보하며, 용량 초과·워커 실패는 `Retry-After: 3`과 함께 `503 busy`를 반환합니다. `20000` ms 감시 타이머는 작업 전달·완료 때 다시 설정됩니다.
3. [요청 제한](../../src/server/app.ts#L41)은 기본적으로 프로세스 내 IP당 분당 `120`회입니다. 기록 제출에는 플릿 공유 IP당 분당 `12`회 카운터와 로컬 `ip:playerId`당 분당 `10`회 제한이 추가됩니다. 카운터 오류는 로그를 남기고 요청을 허용합니다. [IP 선택](../../src/server/ip.ts)은 `CloudFront-Viewer-Address`, 첫 전달 홉, `req.ip` 순서입니다.
4. [데일리 시드](../../src/server/daily.ts#L35)는 HMAC-SHA256(현재 시크릿, UTC 날짜)의 첫 네 바이트를 big-endian으로 읽은 값입니다. 오늘·어제 모두 다시 계산하고 제출을 받으므로 키 변경은 열린 두 날짜에도 영향을 줍니다. [스토리 키](../../src/server/boards.ts#L25)는 `#s<SIM_VERSION>r<rev>`를 붙이고 데일리 키는 날짜를 유지합니다.
5. [최고 기록 저장](../../src/server/runs.ts#L165)은 개선되지 않은 기록을 건너뛰고, 동시 교체를 조건식으로 보호하며, 충돌을 한 번 재시도하고 다른 소유자의 리플레이 해시를 거절합니다. 휴리스틱은 기록하며 자동 거절 기준으로 쓰지 않습니다. 데일리 런의 TTL은 `30`일이고 현재 스토리 최고 기록에는 TTL이 없으며 교체된 스토리 리플레이 항목에는 [90일 TTL](../../src/server/repo/ttl.ts)을 부여합니다.
6. [공개 보드](../../src/server/routes/leaderboard.ts#L62)는 HMAC 태그와 `public, s-maxage=5, stale-while-revalidate=30`을 사용합니다. `/api/me`와 나머지 API 응답의 기본값은 `no-store`이며 `1024`바이트부터 Brotli/gzip 압축을 지원합니다. 이전 코드 복원은 받는 클라이언트에 자격 증명을 반환하며 스냅샷으로 보드 점수를 인정하지 않습니다.
7. [정적 응답](../../src/server/static.ts#L15)은 `/assets/*`에 1년 immutable 캐시를 적용합니다. `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`는 `max-age=0, s-maxage=60, stale-while-revalidate=300`을 사용하며 다른 루트 파일은 `no-cache`입니다. 알 수 없는 경로는 `404`를 반환합니다.
8. [부팅 시딩](../../src/server/app.ts#L113)은 수신 시작 전에 끝납니다. [SIGTERM/SIGINT 처리](../../src/server/index.ts#L81)는 Fastify, 워커 풀 순서로 닫으며 `10`초 강제 종료 타이머를 둡니다.

### 코드 위치 (Code Pointers)

- [조립과 오류 매핑](../../src/server/app.ts), [요청·응답 스키마](../../src/shared/protocol.ts), [경로별 핸들러](../../src/server/routes).
- [레벨 결정](../../src/server/levels.ts), [리플레이 검증기](../../src/sim/replay.ts), [점수 계산](../../src/sim/config.ts#L102), [리플레이 해시](../../src/server/hash.ts).
- [저장 인터페이스](../../src/server/repo/types.ts), [DynamoDB 구현](../../src/server/repo/dynamo.ts), [메모리 구현](../../src/server/repo/memory.ts).
- [이전 데이터 형식](../../src/server/transfer.ts), [태그 키 선택](../../src/server/players.ts), [텔레메트리 필터와 메트릭](../../src/server/routes/events.ts).

### 관련 문서 (Cross-references)

- [인프라](infrastructure.md) · [아키텍처](../architecture.md) · [온보딩](../onboarding.md).
- [스케일 런북](../runbooks/scale.md) · [안티치트 런북](../runbooks/anticheat.md) · [시크릿 런북](../runbooks/secrets.md).
