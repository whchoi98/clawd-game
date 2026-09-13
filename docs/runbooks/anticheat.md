# 안티치트 런북 / Anti-cheat Runbook

대상: CLAWD JUMP: ECHO TOWER 검증 보드(`POST /api/runs` → 서버 재생 검증 → DynamoDB 보드). 이 문서는 서버가 자동으로 막는 것, 기록만 하는 것, 그리고 사람이 개입하는 절차를 적는다. 원칙은 하나다 — **리플레이 검증은 자동으로 거절하고, 휴리스틱은 사람이 판단한다.** 휴리스틱만으로 차단하는 코드는 없고 앞으로도 넣지 않는다(120 Hz 모니터·게임패드·아주 잘 하는 사람은 어느 숫자 하나로는 봇과 구분되지 않는다).

## 0. 서버가 스스로 막는 것

| 검사 | 응답 | 위치 |
| --- | --- | --- |
| 어시스트 런, 다른 SIM/GEN 버전, 잘못된 시드·날짜·레벨, 마스크 디코딩 실패, 클레임 대비 과도한 마스크 길이 | 422 `assist` / `sim-version` / `bad-seed` / `stale-date` / `bad-level` / `bad-masks` / `too-long` | `src/server/runs.ts` |
| 재생 결과가 클레임과 다름, 골에 못 닿음 | 422 `claim-mismatch` / `not-finished` | `src/sim/replay.ts` |
| **다른 플레이어의 리플레이를 그대로 제출(도용)** | 422 `duplicate` | `saveBest` 트랜잭션의 `HASH#…` 조건부 Put |
| 금칙어 이름 | 400 `{ error: 'bad-name' }` | `src/shared/names.ts` |
| 제출 과다 | 429 (IP당 12/min, `ip:playerId`당 10/min) · 고스트 조회 IP당 60/min · 이전 코드 IP당 5/min | `routes/*.ts` |

### 리플레이 해시(도용 차단)

- `StoredRun.hash = sha256(levelId ‖ seed ‖ 디코딩된 마스크)`. 마스크는 **끝의 유휴 틱(0)을 잘라낸 뒤** 해시하므로, 뒤에 0을 덧붙인 복사본도 같은 리플레이로 본다. 인코딩(RLE/base64)이 달라도 디코딩 결과가 같으면 같은 해시다.
- `saveBest`는 RUN·LB·PLAYER 항목과 함께 `pk = HASH#<mode>#<board>#<hash>`, `sk = META` 항목을 `attribute_not_exists(pk)` 조건으로 넣는다. 보드 키는 다른 항목과 같이 `boardKey`(스토리는 `<zone>#s<SIM>r<rev>`)를 쓰므로 sim 범프마다 새로 시작한다. 데일리 HASH 항목은 런과 같은 30일 `ttl`.
- 트랜잭션이 HASH 조건 때문에 취소되면(`CancellationReasons[i].Code === 'ConditionalCheckFailed'`) 서버가 HASH 항목을 읽어 소유자를 확인한다: **다른 플레이어**면 422 `duplicate`(아무것도 쓰지 않음), **같은 플레이어**면 200 `personalBest: false`(자기 기록 재전송은 무해).
- 빈 보드에 시딩되는 `개발자` 골든 리플레이(`GOAL_ECHOES`, 클라이언트 번들에 포함)도 HASH 항목을 가진다 — 누가 그걸 자기 런으로 내면 `duplicate`.
- 한계: 골 도달 뒤에 **유휴가 아닌** 입력을 덧붙이거나 중간 입력을 한 틱이라도 바꾼 복사본은 해시가 달라진다(재생 결과가 같으면 통과). 그런 건 아래 휴리스틱과 export-board로 잡는다.

## 1. 기록만 하는 것 — 휴리스틱 `hx`

검증에 통과한 새 개인 기록마다 마스크에서 계산해 RUN 항목의 `hx`에 저장하고, 로그에 한 줄을 남긴다(`msg: "hx"`):

```json
{ "evt": "hx", "runId": "…", "playerTag": "3fa1…", "mode": "story", "board": "t1", "levelId": "t1",
  "ticks": 5430, "edges": 212, "edgesPerSec": 4.685, "presses": 61, "press1": 0.033,
  "frameAligned": 0.97, "dashJumps": 4, "dashJumpPerfect": 0 }
```

| 필드 | 뜻 | 사람 | 스크립트 냄새 |
| --- | --- | --- | --- |
| `press1` | JUMP/DASH 프레스 중 정확히 1틱만 눌린 비율 | 60 Hz 클라이언트는 최소 2틱 홀드가 정상이라 ≈ 0 | 1.0 근처 |
| `edgesPerSec` | 초당 입력 변화 수 | 3–10 | 30 이상, 특히 `ticks`가 짧은데 높음 |
| `frameAligned` | 입력 변화가 우세한 틱 패리티에 놓인 비율. 60 Hz 클라이언트는 2틱 프레임의 첫 틱에만 입력을 넣으므로 ≈ 1.0 | 0.9–1.0 (60 Hz) / **0.5–0.6 (120 Hz 화면도 정상)** | 0.5 근처 + `press1` 높음 + `edgesPerSec` 높음 |
| `dashJumps` / `dashJumpPerfect` | 대시 뒤 대시 시간(18틱) 안의 점프 / 그중 **바로 다음 틱**의 점프 | perfect 0–1 | perfect가 dashJumps와 같음 |

플레이어 id는 절대 로그에 남기지 않는다 — `playerTag`(HMAC)만. 메트릭으로는 만들지 않는다(EMF는 `VerifyMs`만).

Logs Insights(ECS 서비스 로그 그룹):

```
filter msg = "hx"
| stats avg(press1) as press1, avg(frameAligned) as aligned, max(edgesPerSec) as edges, count(*) as runs by playerTag
| sort press1 desc
| limit 50
```

```
filter msg = "hx" and board = "t1" and press1 > 0.5 and frameAligned < 0.6
| fields @timestamp, runId, playerTag, ticks, edgesPerSec, dashJumpPerfect
| sort @timestamp desc
```

`frameAligned < 0.6`만으로 단정하지 말 것 — 120 Hz 기기에서는 사람도 그렇다. **세 가지가 함께**(press1 높음 · edgesPerSec 높음 · frameAligned 낮음)이고 기록이 개발자 페이스 리플레이보다 훨씬 빠를 때 리플레이를 직접 본다(`GET /api/ghost/<runId>`의 masks를 dev 서버의 고스트로 재생).

## 2. 사람이 하는 것 — `npm run admin`

`tools/admin.mjs`는 서버와 같은 repo 코드(`src/server/repo/dynamo.ts`)로 테이블을 다루므로 키를 손으로 조립할 일이 없다. `tsx`로 실행된다(`npm run admin -- …`).

```bash
export AWS_REGION=ap-northeast-2
export TABLE_NAME=$(node -e "console.log(require('./cdk-outputs.json').ClawdEchoTowerStack.TableName)")

# 1) 보드 보기 — hx 포함, masks 제외, JSON
npm run admin -- export-board story t1 --limit 50 > /tmp/t1.json
jq '.entries[] | {rank: .score, name, playerTag: .playerId[:0], hx}' /tmp/t1.json   # playerId는 출력에 있으니 공유 전에 지운다

# 2) 내리기 — RUN에 flagged: true, LB 항목 삭제, 그 런이 PLAYER 베스트면 그것도 삭제. HASH 항목은 남긴다(같은 리플레이가 다른 이름으로 돌아오지 못하게).
npm run admin -- delist 7b1c…-runId

# 3) 이름만 문제일 때
npm run admin -- rename 7b1c…-runId 플레이어

# 4) 금칙어 추가 — 파일에 append, 커밋 후 배포해야 서버에 반영된다(서버는 로드 시 한 번 읽는다)
npm run admin -- ban-name 새단어
git add src/shared/names.blocklist.json && git commit -m "names: ban 새단어"
```

- `delist`한 런의 고스트(`/api/ghost/<runId>`)는 404가 된다. 클라이언트는 로컬 마스크로 폴백한다.
- `delist`된 플레이어는 그 보드에 베스트가 없어지므로 새 입력 로그를 내면 다시 올라갈 수 있다. HASH가 남은 같은 리플레이를 다른 플레이어가 내면 `422 duplicate`이고, 원래 소유자가 다시 내면 `200`, `personalBest: false`로 끝나며 내려간 보드 항목을 복구하지 않는다.
- `export-board`의 출력에는 `playerId`(자격 증명)가 들어 있다. 팀 밖으로 공유하지 말고, 공유할 땐 `jq 'del(.entries[].playerId)'`.
- MemoryRepo(테스트)와 DynamoRepo 둘 다 `delistRun`/`renameRun`을 구현한다. 새 저장소를 붙이면 둘을 구현해야 CLI가 동작한다.

## 3. 금칙어 — `src/shared/names.ts`

- 내장 목록(한·영)은 코드에, 운영 추가분은 `src/shared/names.blocklist.json`(`{ "words": [] }`)에 있다. 둘 다 정규화 후 **부분 문자열**로 매칭한다: NFKC → 소문자 → 공백 제거 → (a) 글자만(숫자·기호 제거: `시1발`→`시발`), (b) 리트 치환 후 글자만(`sh!t`→`shit`, `5hit`→`shit`), (c) 반복 문자 축약(`fuuuck`→`fuck`).
- 짧은 파편(ass, sex, 시바, 니미, 개새…)은 일부러 넣지 않았다 — `peacock`, `시바견`, `미니미`, `무지개새` 같은 정상 이름을 막지 않기 위해. 필요한 건 복합어로 넣는다(`asshole`, `개새끼`).
- 적용 지점: `POST /api/runs`(제출 이름), `POST /api/transfer`(이전 스냅샷 이름). 둘 다 400 `{ error: 'bad-name' }`. 클라이언트는 형식만 검사하므로 이 응답을 이름 입력 화면으로 되돌려야 한다.
- 이미 보드에 올라간 이름은 `rename`으로.

## 4. 진행도 이전 코드 — 운영 메모

- `POST /api/transfer` → 8자 코드(`A-HJ-NP-Z2-9`, 7자 난수 + HMAC 검사 문자 1자, 키는 `TAG_SECRET` 없으면 `DAILY_SECRET`) · 스냅샷 `PLAYER#<id>/SNAPSHOT` + `CODE#<code>/META`, `ttl` 7일 · 플레이어당 하나(새 코드가 이전 코드를 무효화).
- `GET /api/transfer/<code>` → 200 한 번(CODE 항목 조건부 삭제), 그 뒤 410. 검사 문자가 틀리면 저장소를 조회하지 않고 400 `bad-code`. 둘 다 IP당 5/min.
- 410이 잦다는 문의: 코드는 1회용이다. 다시 만들어 달라고 안내한다. 400은 오타(`I`,`O`,`0`,`1`은 알파벳에 없다).
- **`TAG_SECRET`를 바꾸면** 발급된 모든 코드의 검사 문자가 무효가 되고(400), `playerTag`도 전부 바뀐다(보드의 "나" 표시는 `you`로 하므로 영향 없음). 로테이션은 트래픽 낮은 시간에, 7일 안에 코드를 다시 만들라는 공지와 함께.

## 5. 메트릭 · 알람

- `VerifyMs`(네임스페이스 `ClawdEchoTower`, 차원 `build` = 클라이언트 빌드): 검증 1건마다 EMF 한 줄(`msg: "metric"`). 인프라 알람은 p95 > 2000 ms. 오르면 (1) 긴 데일리 런이 몰렸는지(`ticks`), (2) 태스크 CPU, (3) `verifyReplayChunked`의 청크 양보가 살아 있는지(`/healthz` 지연) 순서로 본다.
- `SubmitRejected` / `SubmitAccepted`(클라이언트 텔레메트리 기반)는 비율 알람 30 %. `reason` 차원으로 `duplicate`가 튀면 도용 시도가 몰린 것 — `hx` 조회로 playerTag를 좁힌다. `sim-version`이 튀면 배포 문제(`rollback.md` 3절).

## 6. 점검표

- [ ] 신고/알람 → `export-board`로 보드 확보, `hx` 세 지표를 개발자 페이스 리플레이(`levels/solutions/par/<zone>.json`, `ratio`)와 비교
- [ ] 의심 런은 고스트를 직접 재생해 본 뒤 결정 — 숫자만으로 `delist`하지 않는다
- [ ] `delist` / `rename` 후 `GET /api/leaderboard?mode=…&board=…`로 확인, `CHANGELOG.md` [Unreleased]에 한 줄
- [ ] 새 금칙어는 `ban-name` → 커밋 → 릴리스. 서버는 재시작 없이 반영하지 않는다
- [ ] 시크릿 로테이션은 `docs/runbooks/secrets.md`(인프라)와 4절의 코드 무효화 공지를 함께
