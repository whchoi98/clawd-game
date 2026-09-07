# 스케일 런북 / Scale Runbook

대상: CLAWD JUMP: ECHO TOWER 프로덕션 스택 `ClawdEchoTowerStack`(CloudFront → ALB → ECS Fargate → DynamoDB, 리전 `ap-northeast-2`). 이 문서는 P3-12(스케일 절벽 제거)가 넣은 손잡이가 무엇인지, 알람을 어떻게 읽는지, 언제 태스크 상한을 올리는지를 적는다. 원칙은 하나다 — **서버는 한계에서 느려지는 대신 거절한다(503 busy)**, 그리고 사람이 상한을 올린다.

## 0. 어디서 절벽이 생기나

| 병목 | 증상 | P3-12가 한 일 |
| --- | --- | --- |
| 리플레이 검증(순수 CPU, 10분 로그 ≈ 300 ms) | 제출이 몰리면 이벤트 루프가 막혀 `/healthz`까지 느려지고 타깃이 비정상으로 빠진다 | `src/server/verifyPool.ts`: 검증을 **worker_threads 1개**로 옮기고 세마포어(동시 4 · 대기 16). 넘치면 즉시 `503 { error: 'busy' }` + `Retry-After: 3` |
| 태스크당 IP 한도가 프로세스 안에만 있음 | 태스크가 N개면 한 주소의 제출 예산이 N × 12/분으로 늘어난다 — 스케일 아웃할수록 느슨해진다 | `POST /api/runs` IP 예산을 DynamoDB 카운터 `RL#<ip>#<minute>`(UpdateItem ADD, TTL 120 s)로 **플릿 공유**. 테이블이 없으면(로컬 메모리 리포) 프로세스 안 카운터 |
| 리더보드 조회의 RCU | 보드 페이지마다 COUNT 두 번 + 매 뷰어마다 원본까지 왕복 | `GET /api/leaderboard`는 공개 top-N만(개인 행 없음) + `Cache-Control: public, s-maxage=5, stale-while-revalidate=30`, CloudFront `/api/leaderboard*` 전용 behaviour(최대 60 s). 개인 행은 새 `GET /api/me`(no-store). 보드 총원은 `BOARD#<mode>#<board>` 카운터(GetItem 1회) |
| 태스크가 작고(0.25 vCPU) 상한이 낮음(6) | 검증 워커와 메인 스레드가 코어 하나를 나눠 쓴다 | 태스크 512 CPU / 1024 MiB, 2~10개, ALB p95 스텝 스케일링 |

## 1. 손잡이

### 배포 시 바꾸는 것 — `cdk.json` 컨텍스트

| 키 | 기본 | 뜻 |
| --- | --- | --- |
| `taskCpu` | `512` | Fargate CPU 단위(256 = 0.25 vCPU). 허용: 256 / 512 / 1024 / 2048 / 4096 |
| `taskMemory` | `1024` | 태스크 메모리 MiB. CPU마다 허용 범위가 다르다(`infra/lib/constructs/service.ts` `FARGATE_MEMORY_BY_CPU`; 512 CPU는 1024~4096) |
| `maxTasks` | `10` | 오토스케일 상한. 하한은 2(`MIN_TASKS`)로 고정 — AZ마다 하나, healthy-hosts 알람의 전제 |
| `desiredCount` | `2` | 첫 배포 시 태스크 수. `maxTasks`를 넘으면 합성 단계에서 거절 |

```bash
# 한 번만: -c 로 덮어쓰기 (cdk.json은 그대로)
npx cdk deploy --require-approval never -c maxTasks=20
# 영구: cdk.json의 값을 고치고 정식 릴리스
npm run release -- patch
```

잘못된 조합(`-c taskCpu=512 -c taskMemory=512`)은 `infra/bin/app.ts`가 합성 전에 "taskMemory 512 MiB is not valid for 512 CPU units (allowed: 1024, 2048, 3072, 4096)"로 멈춘다 — CloudFormation 오류를 기다리지 않는다.

### 코드 상수 — 바꾸면 릴리스

| 상수 | 값 | 위치 |
| --- | --- | --- |
| `VERIFY_CONCURRENCY` / `VERIFY_QUEUE` | 4 / 16 | `src/server/verifyPool.ts` — 워커 안에서 동시에 도는 검증 수 / 자리를 기다리는 수. 그 뒤는 503 |
| `VERIFY_BUSY_RETRY_AFTER_SEC` | 3 | 503의 `Retry-After`. 클라이언트 SubmitQueue가 이 값 뒤에 재시도한다 |
| `VERIFY_TIMEOUT_MS` | 20 000 | 검증 하나가 이보다 오래 걸리면 워커가 멈춘 것으로 보고 종료·재생성(진행 중이던 제출은 503 timeout) |
| `RUNS_PER_IP_PER_MINUTE` | 12 | `src/server/routes/runs.ts` — 주소당 제출 예산(플릿 전체) |
| `LEADERBOARD_S_MAXAGE` / `…STALE_WHILE_REVALIDATE` | 5 / 30 | `src/server/routes/leaderboard.ts` — 엣지가 한 페이지를 들고 있는 시간 |
| `LEADERBOARD_EDGE_MAX_TTL_SECONDS` | 60 | `infra/lib/constructs/edge.ts` — 원본이 더 길게 요청해도 엣지가 넘지 않는 상한 |
| `LATENCY_STEP_SCALING` | p95 > 0.8 s · 1분 × 2회 · +2 태스크 · 쿨다운 60 s | `infra/lib/constructs/service.ts` |
| `SCALING_TARGETS` | CPU 60 % · 타깃당 400 req | 같은 파일(런치 때와 동일) |

동시 4 · 대기 16은 워커 **한 스레드**를 나눠 쓰는 숫자다. 워커가 chunked 검증으로 협조 양보하므로 짧은 리플레이가 긴 리플레이 뒤에 갇히지는 않지만, 태스크 하나의 검증 처리량은 코어 하나 분량이다. 처리량이 필요하면 상수를 올리는 게 아니라 **태스크를 늘린다**(아래 3절).

## 2. 알람과 로그 읽는 법

대시보드 `ClawdEchoTowerStack`(CloudWatch)에서 본다. 알람 이름은 `ClawdEchoTowerStack-<slug>`.

| 보이는 것 | 뜻 | 할 일 |
| --- | --- | --- |
| `alb-latency-p95` ALARM(1 s, 5분) | 스텝 스케일링 트리거(0.8 s, 1분 × 2)보다 느슨하고 늦다. 이 알람이 울렸다면 스케일 아웃이 이미 시작됐거나 **상한에 걸려** 못 늘고 있다 | ECS 서비스의 desired/running 태스크 수를 본다. `maxTasks`에 붙어 있으면 3절 |
| `verify-ms-p95` ALARM(2 000 ms) | 검증 하나가 오래 걸린다 — 워커 안에서 4개가 코어를 나눠 쓰고 있다는 뜻. CPU가 함께 높으면 정상적인 포화 | `ecs-cpu`와 함께 보고, 태스크 수가 상한이면 3절. CPU가 낮은데 이것만 높으면 워커 문제 → 로그 `verify worker` 줄 확인 |
| `ecs-cpu` ALARM(80 %) | 타깃 추적(60 %)이 따라잡지 못하는 급증 | 스텝 스케일링이 붙었는지(desired가 2씩 뛰는지) 확인, 상한이면 3절 |
| `ddb-read-throttles` / `ddb-write-throttles` | on-demand 테이블의 핫 파티션. `RL#<ip>#<minute>` 카운터(한 IP가 초당 수십 번 제출)나 `BOARD#…` 카운터(한 보드에 초당 수백 건 첫 진입)가 후보 | 제출은 12/분/IP에서 이미 잘리므로 보통 제출 폭주가 아니라 조회 폭주다. 리더보드 s-maxage(5 s)가 붙었는지 `x-cache` 헤더로 확인 |
| `alb-5xx-rate` ALARM | **503 busy도 5xx로 잡힌다**. 제출 폭주 중이면 이 알람은 백프레셔가 작동한다는 뜻이다 | 아래 쿼리로 503이 전부인지 확인. 500이 섞여 있으면 코드 문제 |

로그 그룹(`Service/Logs`)에서 Logs Insights:

```
# 백프레셔가 몇 번 발동했나 (풀이 꽉 차서 거절한 제출)
fields @timestamp, reason, running, waiting, refused
| filter msg = "run deferred: verify busy" or msg = "verify busy"
| stats count() by bin(1m)

# 503이 아닌 5xx가 있나 (있으면 버그)
fields @timestamp, res.statusCode, req.url
| filter res.statusCode >= 500 and res.statusCode != 503
| sort @timestamp desc | limit 50

# 플릿 공유 카운터를 못 읽어 열어 준 제출 (테이블 장애 신호)
filter msg = "submit rate counter unavailable; allowing" | stats count() by bin(5m)

# 워커 재시작
filter msg like /verify worker/ | sort @timestamp desc | limit 20
```

`503 busy`는 실패가 아니다: 클라이언트는 `Retry-After`(3 s) 뒤에 같은 기록을 다시 보내고, 검증은 어차피 서버가 재생하므로 늦게 도착해도 안전하다. 걱정할 것은 **분당 수십 건이 지속되는 503**(= 태스크가 모자란다)과 **503이 아닌 5xx**(= 버그)다.

## 3. 언제 `maxTasks`를 올리나

다음 중 하나가 **10분 이상** 이어지면 올린다.

1. ECS 서비스 desired == `maxTasks`이고 `alb-latency-p95` 또는 `ecs-cpu`가 ALARM.
2. 위 Logs Insights의 `verify busy` 건수가 분당 접수(`SubmitAccepted`)의 5 %를 넘는다.
3. 이벤트(경주 링크 배포, 노출)가 예고돼 있어 평소의 3배 이상이 예상된다 — 미리 올린다.

어떻게: `npx cdk deploy --require-approval never -c maxTasks=<현재 × 2>` (스택만 갱신, 이미지 재빌드 없음 — `cdk.json`의 다른 컨텍스트는 그대로 읽힌다). 안정되면 `cdk.json`에 반영하고 릴리스한다. 비용은 태스크당 약 $14/월(512 CPU · 1024 MiB · ARM64) × 평균 태스크 수 — 상한은 **최대치**이고 평소에는 타깃 추적이 2개로 되돌린다.

`taskCpu`를 올리는 경우는 다르다: 태스크 수는 여유가 있는데 `verify-ms-p95`가 높고 `/healthz`가 흔들리면(메인 스레드와 워커가 한 코어를 다툰다) `-c taskCpu=1024 -c taskMemory=2048`로 태스크를 키운다. 이건 태스크 정의 교체라 롤링 배포가 일어난다.

내리는 것: 트래픽이 빠졌으면 아무것도 하지 않는다 — 타깃 추적이 하한 2까지 알아서 줄인다. `maxTasks` 자체를 되돌리는 건 청구서를 볼 때.

## 4. 부하 테스트 — `tools/load/submit.mjs`

유효한 제출 N개를 동시에 쏘고(페이스 코퍼스 `levels/solutions/par`를 sim으로 재생해 클레임을 만들고, 플레이어 id와 리플레이 해시를 전부 다르게), 그동안 `/healthz`를 100 ms마다 찍는다.

```bash
# 로컬 빌드에 대해 (정식 검증: 200 동시 → /healthz p99 < 100 ms, 503 외 5xx 0)
node tools/build.mjs
PORT=8261 STATIC_DIR=dist/public DAILY_SECRET=load node dist/server/index.js &
BASE_URL=http://127.0.0.1:8261 npx tsx tools/load/submit.mjs --n 200
kill %1

# 옵션
npx tsx tools/load/submit.mjs --n 50 --zones t1,t2 --healthz-interval 50 --max-p99 100 --timeout 30000
```

출력은 상태 히스토그램(`200×184  503×16`), 422 사유별 건수, **503을 제외한 5xx**, 제출 p50/p99, `/healthz` p50/p99. exit 1 조건: 503 외 5xx > 0, `/healthz` 실패, `/healthz` p99 > `--max-p99`. 503은 기대되는 백프레셔라 실패가 아니다.

**주의**: 접수된 기록은 진짜 보드에 `부하-N`이라는 이름으로 올라간다. 라이브 사이트에는 쏘지 않는다. 쐈다면 `npm run admin -- export-board story t1`로 `load-<tag>-` 플레이어의 runId를 찾아 `npm run admin -- delist <runId>`로 내린다(`docs/runbooks/anticheat.md`). 한 IP에서 쏘므로 12/분 IP 한도에도 걸린다 — 부하 테스트는 한도 코드가 없는 로컬(메모리 리포는 프로세스 안 카운터, 같은 12/분)에서도 `--n 200`이면 대부분 429가 된다는 점을 알고 읽어라: 백프레셔(503)와 워커를 보려면 `RUNS_PER_IP_PER_MINUTE`를 넘지 않는 `--n 12` 이하로 여러 번 쏘거나, 테스트 서버 앞에 IP를 바꿔 주는 프록시를 둔다. `test/server/backpressure.test.ts`가 세마포어와 워커를 IP 한도 없이 단언하므로, 도구의 라이브 실행은 **배포된 스택의 감(p99, 5xx)** 을 잡는 용도다.

## 5. 리더보드 캐시와 총원 카운터

- `GET /api/leaderboard?mode&board&limit`는 뷰어와 무관한 같은 JSON이다. 엣지가 5초(최대 60초, stale 30초 허용) 들고 있으므로 제출 직후 순위표가 몇 초 늦을 수 있다 — 결과 화면의 내 순위는 `POST /api/runs` 응답과 `GET /api/me?mode&board&playerId`(no-store)가 즉시 준다.
- `total`은 `BOARD#<mode>#<board>` 카운터다. 새 플레이어의 첫 진입 트랜잭션에서 +1, `delist`에서 −1. 카운터가 없는 보드(P3-12 이전에 생긴 보드)는 첫 조회 때 COUNT로 채워 넣는다. 롤링 배포 중 옛 태스크가 쓴 첫 진입은 세지 않으므로 그 몇 분 사이 1~2건 어긋날 수 있다; 다음 sim 범프(스토리)나 다음 날(데일리)부터는 정확하다. 맞추고 싶으면:

```bash
TABLE=$(node -e "console.log(require('./cdk-outputs.json').ClawdEchoTowerStack.TableName)")
PK='LB#story#t1#s2r0'   # 보드 파티션 (스토리는 #s<SIM>r<rev> 접미)
N=$(aws dynamodb query --table-name "$TABLE" --select COUNT \
  --key-condition-expression 'pk = :pk AND sk < :end' \
  --expression-attribute-values '{":pk":{"S":"'"$PK"'"},":end":{"S":"SEED"}}' --query Count --output text)
aws dynamodb put-item --table-name "$TABLE" \
  --item '{"pk":{"S":"BOARD#story#t1#s2r0"},"sk":{"S":"META"},"n":{"N":"'"$N"'"}}'
```

## 6. 되돌리기

- 503이 너무 잦은데 태스크를 늘릴 수 없다면(비용) — 상수를 낮추는 게 아니라 그대로 둔다. 503은 클라이언트가 재시도하고, 큐를 키우면 지연이 늘어날 뿐 처리량은 같다.
- 워커가 계속 재시작한다(`verify worker exited` 반복) — 이미지 문제다. `docs/runbooks/rollback.md`의 방법 B(태스크 정의 리비전)로 직전 이미지로 돌린다. 서버 전체가 한 번들이라 워커만 따로 되돌릴 수는 없다.
- 리더보드 캐시를 끄고 싶다 — `edge.ts`의 `/api/leaderboard*` behaviour를 지우면 `/api/*`(CACHING_DISABLED)로 떨어진다. 서버의 `Cache-Control`은 그대로 두어도 된다(엣지가 무시한다).
