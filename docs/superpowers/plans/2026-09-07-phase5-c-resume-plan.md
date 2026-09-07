# Phase 5 C 재개 계획 — P5-5 버블 적 마무리 · 통합 · v0.5.0

> 오너 지시 (2026-09-07 18:00 UTC): **"재개순서대로 진행"**. 상위 문서: `2026-09-07-phase5-content-plan.md` §P5-5(설계·소유·완료 기준),
> 스펙 `docs/superpowers/specs/2026-09-06-clawd-echo-tower-design.md`. 감사(wf_e4287fba-653, 17:50 UTC) 결과를 출발점으로 삼는다.
>
> 출발 상태: main HEAD `15098aa`(계약: SIM_VERSION 4, FoeKind `bubble`, 이벤트 `bubblePop`/`bubbleBack`, 스폰 문자 `b`, `PHYS.bubbleBounce −352 · bubbleRespawn 2.5 · bubbleBobAmp 10 · bubbleBobPeriod 1.6`).
> 워크트리 B `.claude/worktrees/wf_a163b96a-a75-2`(브랜치 `worktree-wf_a163b96a-a75-2`) = 커밋 `f676095` 완료(클라이언트).
> 워크트리 A `.claude/worktrees/wf_a163b96a-a75-1`(브랜치 `worktree-wf_a163b96a-a75-1`, base 15098aa) = **미커밋**: `Bubble` 클래스(`src/sim/foes.ts`), `player.bubbleBounce()`, `sim.ts` reforms 처리, `levels/dsl.ts` b 규칙, m1(b 2)·m3(b 4)·m4(b 3) rev 1, `test/sim/bubble.test.ts` 17/17, tsc 0. `node_modules`는 main을 가리키는 심볼릭 링크(커밋 금지).

## Global Constraints (모든 Task에 구속)

- **기존 물리 비트 동일**: `npx tsx tools/hash-corpus.ts --check`에서 정점 3개(m1·m3·m4) 외 **15개 다이제스트**(t1 eeb02baf · t2 5bdafd99 · t3 db84bd58 · t4 7f7dc99c · s1 bd3010e8 · s2 1070b224 · s3 37e08efb · s4 02223d09 · v1 eefc1973 · v2 31c147a5 · v3 4b703ad5 · v4 b225e327 · m2 b4dae93a · daily:1 243be660 · daily:20260906 406acee7)는 바이트 동일해야 한다. 46개 녹화 중 m1/m3/m4 빠른·페이스 6개와 히트맵 3개만 새로 기록한다.
- **결정론**: `src/sim/**`는 `src/sim/dmath.ts` 헬퍼만 쓴다(Math.sin/cos/random/Date 금지). 서버 `verifyReplay`가 같은 Sim을 돌린다.
- **동결 파일(수정 금지)**: `src/sim/types.ts`, `src/sim/legend.ts`, `src/sim/config.ts`, `src/shared/protocol.ts`, `src/client/contracts.ts`. Task 1~3은 `src/client/**`를 건드리지 않는다(B 소유). Task 4만 `src/client/scenes.ts`·`test/client/shell.test.ts`·`test/fixtures/levels.ts`를 만진다.
- **버블 규칙(P5-5 설계)**: 위에서 밟으면(`fromAbove` 또는 `stomping`) 팝 → `bubblePop` + `vy = PHYS.bubbleBounce` + 공중 점프·대시 리필, `foeKilled`·`stats.foes`·콤보 변화 없음; 대시 관통은 팝(발사 없음); 옆·아래 접촉은 보통 모드 즉사(원인 문자열 정확히 `bubble`), 어시스트는 hurt; 팝 뒤 `dead = true`, `state`는 초 단위 카운트다운(2.5 → 0), `BUBBLE_RESPAWN_TICKS`(300) 뒤 홈에서 `bubbleBack`; 스톰프 착지 충격파는 거품을 터뜨리지 않는다.
- **레벨 규칙**: `validateZone`(체크포인트 파 20 s당 1개·이웃 ≤ 32칸, 파편 8~12, 유물 1) 유지; DSL b 규칙(위 칸이 지형이면 오류, P에서 Chebyshev 거리 ≤ 6이면 오류); 편집한 존은 `rev: 1`; 코퍼스 빠른 = 사망 0·par × 1.2 이내, 페이스 = 0.95~1.10 × par, m4는 `--budget=600`.
- **문체**: 코드·주석 영문, 사용자 노출 문자열 한국어 해라체(기존 UI와 같은 어미). CHANGELOG는 `[Unreleased]` 아래 `### Added (Phase 5 C)`(B 브랜치에 같은 헤딩이 있으므로 통합자가 접는다).
- **호스트 규칙**: 패턴 `pkill` 금지(자기 서버는 PID로 종료), `tools/qa/smoke.ts`와 `mobile.ts` 동시 실행 금지(IP당 429 예산), 부하 > 14면 타임아웃 재실행.
- **커밋 위생**: 워크트리 A의 `node_modules` 심볼릭 링크는 절대 스테이징하지 않는다 — `git add -A -- . ':!node_modules'` 또는 경로 명시.

---

### Task 1: m3 우물 사다리 재설계 · Bubble sim 보정 · 존/DSL 테스트 (워크트리 A)

작업 디렉터리: `/home/ec2-user/my-project/clawd-game/.claude/worktrees/wf_a163b96a-a75-1` (브랜치 `worktree-wf_a163b96a-a75-1`). 미커밋 변경을 이어받아 작업하고 이 Task 끝에 커밋한다.

**1-A. Bubble sim 보정 (`src/sim/foes.ts`)**
- `Bubble.pop()`에 `s.y = this.home.y;` 추가 — 팝 순간의 bob 위상(|y − home| ≤ 10)이 dead 동안 남지 않게 한다(렌더러 시머가 `f.x/f.y`에 그린다).
- `Bubble.reform()`이 플레이어에게 막혀 다음 틱을 기다릴 때 `s.state = 1 / TICK_HZ;`로 둔다(0이 아닌 최소 양수 — 클라이언트 `bubbleShimmer(state)`는 `0 < state < 0.5`에서만 그리므로 '완전히 모인 링'이 유지된다). 막히지 않으면 기존대로 `dead = false, state = 0, y = bobY(), bubbleBack`.
- `test/sim/bubble.test.ts` 갱신: (a) 팝 직후와 카운트다운 중 `bubbleOf(sim).y === home.y` 단언; (b) 새 테스트 — 카운트다운이 끝나는 틱에 플레이어가 홈 봉투 위에 서 있으면 거품은 dead를 유지하고 `state`가 `1 / TICK_HZ`이며 `bubbleBack`이 나오지 않고, 플레이어가 봉투를 벗어난 첫 틱에 `bubbleBack`이 나온다(봉투 = 박스 + bob 10 + margin 2); (c) 결정론 테스트 유지. 17개 전부 + 신규 통과.

**1-B. m3 우물 사다리 기하 (`levels/zones/m3.ts`)** — 감사 판정: 현재 (34,15)→(33,12)→(34,9)는 1열 오프셋이라 상승 중 머리가 위 거품 밑면에 닿아 `bubble` 사망(프로브 사망 좌표 타일 33.8,10.3). 우물이 32~34 세 열이라 2열 오프셋이 불가능하므로 **우물을 한 열 넓힌다**:
- `m.ground(31, 34, 19)` → `m.ground(31, 35, 19)`; `m.spikes(32, 34, 18)` → `m.spikes(32, 35, 18)`; `m.block(31, 34, 0, 3)` → `m.block(31, 35, 0, 3)`; `m.ground(35, 80, 7)` → `m.ground(36, 80, 7)`; `m.plat(35, 80, 0)` → `m.plat(36, 80, 0)`. 상승기류 `z`(31,18)·shelf 1·체크포인트·토글·관문 좌표는 그대로(C 37은 shelf 2 위에 남는다).
- 사다리 거품 시작값: `(33, 15)` → `(35, 12)` → `(33, 9)` (연속 거품 가로 중심 거리 32 u ≥ 2열; 모든 거품은 상승기류 열 31에서 ≥ 1열 떨어짐 → 열 ≥ 33; 린텔 rows 0..3이 발사를 막음). 마당 퍼치 거품 `(10, F−6)`과 파편 `(10, F−11)`은 유지. 헤더·인라인 주석을 새 기하에 맞게 고친다(옛 '한 열 옆' 서술 제거).
- 물리 참고: 플레이어 11×15, 거품 12×12(bob ±10), `bubbleBounce −352` → JUMP 미보유 상승 ≈ 55 u, 보유 ≈ 72 u; `jumpVel −272`(≈ 2.7 타일), `jumpVel2 −238`, `maxRun 132`, `accelAir 820`, `gravity 860 / gravityFall 1120 / gravityApex 620`. shelf 1 서는 행 15(바닥 top y = 256), shelf 2 서는 행 6(바닥 top y = 112, 열 36부터).
- **프로브로 증명**(스크래치 `tsx` 스크립트, `test/sim/helpers.ts`의 `run/stepUntil/collect`와 `Sim`을 직접 사용; 저장 위치 `/tmp/claude-1000/-home-ec2-user-my-project-clawd-game/12166bb1-0396-45c7-afa2-b910a29fae53/scratchpad/`): (P1) shelf 1 끝에서 거품 1 → 2 → 3을 밟고 shelf 2(열 ≥ 36, 행 6)에 사망 0으로 착지, `bubblePop` 3회; (P2) 기본 경로 — shelf 1 끝에서 걸어 내려 상승기류 2를 타고 shelf 2 도달, 거품 접촉 0·사망 0; (P3) shelf 1에서 전속력 점프(스톰프 없음)로 우물을 향해 뛰었을 때 사망 원인이 `bubble`이 아님(가시는 rev 0과 같으므로 허용). 프로브가 실패하면 우물(열 32..35, 행 8..16) 안에서 행·열을 조정하되 위 제약(2열 오프셋, 열 ≥ 33, DSL 규칙)을 지키고, 최종 좌표와 세 프로브의 출력(틱·좌표·팝 횟수)을 보고서에 적는다. 세 프로브를 만족하는 배치를 찾지 못하면 시도한 좌표표와 함께 BLOCKED로 보고한다(사다리 제거·거품 수 변경은 컨트롤러 판단).
- `npm run levels`로 `src/sim/levels.generated.ts`·`echoes.generated.ts`를 재생성하고 `npm run levels -- --check` 종료 코드 0(m1/m3/m4 'solution skipped' 경고는 Task 2까지 예상됨).

**1-C. 테스트 (`test/levels/`)**
- `test/levels/zones.test.ts` 약 137행 rev 단언 갱신: m1·m3·m4 = 1, m2 = 0, t4·s4·v4 = 0, 기존 9존 = 1. m1/m3/m4 describe 블록에 b 배치 단언 추가: 개수(m1 2 · m3 4 · m4 3)와 좌표(m1 `(79, F−5)`·`(84, F−3)` with F = 26 → (79,21)·(84,23); m3 최종 좌표; m4 `(18,11)`·`(15,8)`·`(12,5)`), 그리고 각 b 위 칸이 빈 칸/스폰이고 P에서 Chebyshev 거리 > 6임을 `LevelDef` 그리드에서 직접 확인.
- `test/levels/dsl.test.ts`에 b 규칙 부정 케이스 3개: 위 칸이 바위인 b → 오류 메시지에 `has no open tile above` 포함; 최상단 행(row 0)의 b → 같은 오류; P에서 6칸 이내 b → `tile(s) from P` 포함. 기존 `Room`/`room` 헬퍼 패턴을 따른다.

**1-D. 검증·커밋**
- `npx tsc --noEmit -p .` 0 오류; `npx vitest run test/sim test/levels/zones.test.ts test/levels/dsl.test.ts` 녹색(`test/levels/solutions.test.ts`·`heatmap.test.ts`는 Task 2 전까지 rev 불일치로 실패 — 보고서에 그대로 적는다).
- 커밋 1개(`git add -A -- . ':!node_modules'`): 제목 `sim+levels(phase5-c, P5-5): bubble y snap + blocked re-form state, m3 well widened to four columns with a two-column bubble ladder, zone/dsl tests`.

---

### Task 2: m1·m3·m4 코퍼스 재녹화 · 초보 봇 히트맵 · 다이제스트 (워크트리 A)

작업 디렉터리 동일. Task 1 커밋 위에서 시작한다.

- 빠른 코퍼스: `npx tsx tools/solve.ts m1 m3 --force` 와 `npx tsx tools/solve.ts m4 --force --budget=600` → `levels/solutions/{m1,m3,m4}.json`이 `rev 1 · sim 4`, deaths 0, ticks ≤ par × 1.2 × 120; `levels/solutions/PENDING.json`이 `{}`.
- 페이스 코퍼스: `npm run solve:par -- m1 m3 --force` 와 `npm run solve:par -- m4 --force --budget=600` → `levels/solutions/par/{m1,m3,m4}.json` ticks/(par×120) ∈ [0.95, 1.10]; `levels/solutions/par/PENDING.json`이 `{}`. 창에 못 들어오면 도달 비율과 함께 DONE_WITH_CONCERNS(par 변경은 컨트롤러 판단 — 임의로 바꾸지 않는다).
- `npm run levels` → 'solution skipped' 경고 0, `GOAL_ECHOES` 16/16(m1/m3/m4가 `rev: 1`), `npm run levels -- --check` 0.
- 히트맵: `npx tsx tools/novice.ts m1 m3 m4`(기본 300 에피소드) → `levels/heatmap/{m1,m3,m4}.json` `rev 1 · sim 4`. 보고: 존별 클리어율(rev 0 참고: m1 91 % · m3 23.7 % · m4 0/0), 최다 사망 셀 비율, 사망 원인 중 `bubble` 건수, 거품이 상위 사망 클러스터인지.
- `npx tsx tools/hash-corpus.ts` → `test/fixtures/corpus-digests.json`; `git diff test/fixtures/corpus-digests.json`에서 바뀐 줄이 m1·m3·m4 3개(및 헤더 카운트)뿐이고 나머지 15개 값이 Global Constraints의 값과 같음을 보고서에 표로 적는다. `npx tsx tools/hash-corpus.ts --check` 종료 코드 0.
- `npx vitest run test/levels test/sim test/server test/client/selftest.test.ts test/tools` 녹색(selftest 16/16·픽스처 동등).
- 커밋 1개: `corpus(phase5-c, P5-5): m1/m3/m4 fast + paced goldens, novice heat maps and summit digests re-recorded at rev 1 (15 digests unchanged)`.

---

### Task 3: README · CHANGELOG · 전체 검증 · 컨테이너 없는 QA · 커밋 (워크트리 A)

작업 디렉터리 동일. Task 2 커밋 위에서 시작한다.

- `README.md`: (1) 레벨 DSL 스폰 문자 범례(약 207행)에 `b` 거품 행 추가; (2) 요약 표(약 336행) `적 6종` → `적 7종`; (3) 구역 저작 안내에 거품 문단 1개(한국어 해라체, 기존 문단 길이 수준): 위에서 밟으면 팝·−352 발사·2.5 s 뒤 재생성·옆/아래 즉사·처치/콤보 제외·`b` 위는 빈 칸·P에서 6칸 초과·SIM_VERSION 4. **151행 P5-2 캐릭터/렌더 문단은 건드리지 않는다**(B가 편집).
- `CHANGELOG.md` `## [Unreleased]` 아래 `### Added (Phase 5 C)` 헤딩과 A 불릿 1개(SIM_VERSION 4 이유, 거품 sim 규칙, m1 2·m3 4·m4 3 배치와 m3 우물 확장, 코퍼스·히트맵·다이제스트 재기록, 테스트 수). 형식은 0.4.x 절과 같다.
- `tools/qa/smoke.ts`·`mobile.ts`는 실패하는 단계가 있을 때만 고친다(스폰 프레임 규칙은 DSL b 규칙으로 이미 만족).
- 전체 검증(순서대로, 각 결과 줄을 보고서에 인용): `npx tsc --noEmit -p .`; `npx vitest run`(전체, `test/tools/admin.test.ts` 포함); `npm run levels -- --check`; `npx tsx tools/hash-corpus.ts --check`; `node tools/build.mjs`.
- QA(서버 1개, 순차): `PORT=8371 DAILY_SECRET=x TAG_SECRET=y STATIC_DIR=dist/public node dist/server/index.js &`(PID 기억) → `BASE_URL=http://127.0.0.1:8371 npx tsx tools/qa/smoke.ts` 23/23(selftest 18/18, `shot:m1/m3/m4` 콘솔 오류 0) → `BASE_URL=... npx tsx tools/qa/readability.ts` 10/10 → `BASE_URL=... npx tsx tools/qa/mobile.ts` 54/54 → `kill <PID>`.
- 커밋 1개: `docs+qa(phase5-c, P5-5): README legend/paragraph, CHANGELOG Phase 5 C bullet; full suite, levels/hash checks, build, smoke/readability/mobile green`. 보고서에 통합자 메모(B `f676095`와의 CHANGELOG/README 병합 지점, 추천 병합 순서 B → A).

---

### Task 4: 통합 — B·A 병합, `scenes.ts` 거품 배선, shell 테스트, 문서 접기, v0.5.0 (main)

컨트롤러가 main에서 `git merge --no-ff worktree-wf_a163b96a-a75-2` → `git merge --no-ff worktree-wf_a163b96a-a75-1`(충돌은 CHANGELOG/README 텍스트만, 양쪽 유지)을 끝낸 뒤, 통합 작업은 main에서 딴 새 워크트리 브랜치에서 한다.

- `src/client/scenes.ts`(감사가 확정한 7곳): import를 `DEATH_LINE_BUBBLE, REHINT_BY_KIND, rehintKind, type RehintKind`로; `REHINT_DEATHS` 유지 + `export const REHINT_NEED: Readonly<Record<RehintKind, number>> = { pit: REHINT_DEATHS, hazard: REHINT_DEATHS, bubble: 1 };`; `Run.segDeaths: Record<RehintKind, number>`; `deathLine()`에 `case 'bubble': return DEATH_LINE_BUBBLE;`; Run 초기화 `{ pit: 0, hazard: 0, bubble: 0 }`; 체크포인트 리셋에 `run.segDeaths.bubble = 0;`; `rehint()`를 `rehintKind(cause)` / `REHINT_NEED[kind]` / `REHINT_BY_KIND[kind]`로 교체(첫 거품 사망에 힌트).
- `test/fixtures/levels.ts`에 `bubbleRoom()`(P 좌측, 진행 행에 `b` 1개) 추가, `test/client/shell.test.ts`에 '거품 사망 1회 → 토스트 `거품에 닿았다` + `REHINT_BUBBLE` 1개, `REHINT_PIT` 0개' 테스트 추가(기존 REHINT_PIT 테스트 패턴).
- CHANGELOG `[Unreleased]`의 `### Added (Phase 5 C)` 헤딩을 하나로 접고 A·B 불릿을 나란히 둔다; README `적 7종` 확인; `package.json` 버전은 릴리스 도구가 올리므로 손대지 않는다.
- 검증: `npx tsc --noEmit -p .`, `npx vitest run` 전체, `npm run levels -- --check`, `npx tsx tools/hash-corpus.ts --check`, `node tools/build.mjs`. 커밋 후 컨트롤러가 main에 `--no-ff` 병합.

---

### Task 5: 컨테이너 QA · v0.5.0 배포 · 라이브 점검 (main)

- Docker 이미지 빌드, 컨테이너 QA(스모크 23/23 · 판독성 10/10 · 격자 PASS · 모바일 54/54 · m1/m4 실제 기록 제출 200) — 기존 0.4.x 절차와 동일.
- 배포(오너 사전 승인): `export CDK_DEFAULT_ACCOUNT=061525506239 CDK_DEFAULT_REGION=ap-northeast-2 AWS_REGION=ap-northeast-2 && npm run deploy > deploy.log 2>&1`(백그라운드, ~5 분; CLI가 죽으면 `aws cloudformation wait stack-update-complete --stack-name ClawdEchoTowerStack`), 이어서 `node tools/postdeploy.mjs` 13/13, `BASE_URL=https://clawd-game.whchoi.net npx tsx tools/qa/smoke.ts`, `tools/qa/mobile.ts`(순차), CloudFront `E38DW91AO2DWTB` 무효화 `/ /index.html /sw.js /manifest.webmanifest`, 라이브 데일리 E2E(스크래치 스크립트, 테스트 데이터 정리 포함), 알람 확인.
- 릴리스 기록: CHANGELOG `[Unreleased]` → `[0.5.0] - 2026-09-07`(배포·QA 결과 줄 포함), `package.json` 0.5.0, 태그 `v0.5.0`, 상위 계획 §P5-5 상태 갱신.
