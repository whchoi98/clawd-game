# CLAWD JUMP: ECHO TOWER — 차트 상위권 로드맵

생성: 2026-09-06 · 방법: 디렉터 4관점 제안(55개) → 심사 3인 채점 → 종합. 실행은 Phase 1부터 순서대로.

## North star

낯선 플레이어의 D1 복귀율 35%(익명 boot 이벤트의 daysSinceFirstSeen==1 비율, P1-3 계측 이후 측정) — 이를 끌어올리는 세 관문은 (1) 첫 세션 t1 클리어 70%·죽음→조작 복귀 0.6초, (2) 데일리 다음날 재도전 30%, (3) 결과 화면 공유 8%·메아리 링크 진입 30%. 원칙: sim 필 상수(config.ts PHYS)는 지키고, 그 위의 실패 루프·온보딩·메아리(고스트)·데일리 루프를 앱 수준으로 끌어올린다. sim 변경은 SIM_VERSION 범프 두 번(v2=P1 실패 루프, v3=P2 즉사·튠업·데일리 청크)으로만 묶는다.


> **오너 결정 (2026-09-06 21:20)** — v0.2.0 배포 후 "다음 단계 진행" 지시로 P2-8·P2-10·P3-6·P3-9·P3-12의 데이터/트래픽 게이트를 해제했다. 텔레메트리 사망 히트맵 대신 노이즈 입력 노비스 봇(`tools/novice.ts`)의 합성 히트맵을 근거로 쓰고, 비용에 민감한 태스크 크기·최대 태스크 수는 CDK 컨텍스트(`taskCpu`·`taskMemory`·`maxTasks`)로 둔다. 스킨 `azure`의 표시 이름은 `AMAZONI / 아마조니`로 바꿨다.

## Phase 1 — 2 weeks: feel, onboarding, polish that every player hits

죽음→재도전을 0.6초로 만들고(sim.ts DYING_T 1.05+INTRO_T 0.45 확인), 첫 60초를 폰에서 재설계하고(힌트 '← →'·'SHIFT'가 levels.generated.ts:13,40에 하드코딩, iPhone14 캡처에서 힌트가 필드 중앙·워커가 JUMP 버튼 안), 그 모든 변경을 안전하게 배포할 SIM_VERSION·릴리스 절차와 측정 파이프를 세운다. 합계 약 12.5 개발일 — 테스트·QA 하네스 작성은 에이전트 병렬로 2주에 맞춘다. 스토리 보드(라이브 t1 1건·v3 0건)는 v2 범프로 리셋되며 지금이 유일하게 공짜인 시점.

### P1-1 — SIM_VERSION·Replay v2·릴리스/롤백 절차·SW 리로드 안전 (TECH-03 + TECH-12 + GF-01 버전 절)

- 영역: server · 공수: 2.5일 · 의존: 없음
- 내용: src/sim/types.ts에 SIM_VERSION=2, GEN_VERSION=1(데일리/엔드리스 생성기), Replay.v를 리터럴 1에서 SIM_VERSION으로; LevelDef에 rev 필드(지형 변경 시 증가). src/shared/protocol.ts RunSubmit에 sim·gen 추가(누락=0), src/server/runs.ts는 검증 전 불일치 시 422 'sim-version'(RejectReason 추가, ui.ts REASON_KR '새 버전으로 새로고침'). 스토리 보드 pk를 LB#story#<levelId>#s<SIM>r<rev>로(repo/dynamo.ts·memory), 데일리는 날짜 키 유지+gen 불일치 거절. /api/health·/api/daily 응답에 simVersion → 클라이언트가 부팅·결과 화면에서 비교해 upbar 강조+registration.update(). src/client/pwa.ts controllerchange(138-141)에 isBusy() 훅: 플레이 중이면 reload 보류, 이 탭이 apply()하지 않았으면 upbar 재제안. tools/release.mjs = typecheck→test→build→deploy→postdeploy:check→CloudFront invalidation('/','/index.html','/sw.js','/manifest.webmanifest')→index가 참조하는 /assets/* 20회 200 확인; npm version+git tag+CHANGELOG.md; docs/runbooks/rollback.md. Progress.levels[*].masks가 구버전이면 loadEchoes에서 버리고 기록만 유지(save.ts repairProgress).
- 완료 기준:
  - test/server/runs.test.ts: sim≠SIM_VERSION 제출 → 422 {reason:'sim-version'}, verify 미호출; 정상 제출 200
  - test/server/dynamo-repo.test.ts: saveBest pk가 LB#story#t1#s2r0 형식; 데일리 pk는 LB#daily#<date> 유지
  - test/client/pwa.test.ts: isBusy=true에서 controllerchange → reload 0회, onRunEnd 후 1회; apply() 없이 온 controllerchange는 onUpdateReady 재호출
  - test/client/save.test.ts: v:1 masks를 가진 구 Progress 로드 → masks 제거, time/stars 보존
  - tools/postdeploy.mjs: /api/health.simVersion === 번들 SIM_VERSION, 무효화 Completed, git tag v0.2.0·CHANGELOG 항목 존재

### P1-2 — 무료 실패: 죽음→조작 복귀 0.6초, R 탭=체크포인트 즉시 재도전 / R 홀드=존 재시작 (GF-01)

- 영역: sim · 공수: 1.5일 · 의존: P1-1
- 내용: src/sim/sim.ts DYING_T 1.05→0.45, 리스폰 후 intro 0.15s(첫 스폰만 INTRO_T 0.45 유지, phase 'intro'에 firstSpawn 플래그). src/client/fx.ts DEATH_FADE_AT 0.7→0.25, 페이드인 half-life 0.1→0.06. src/client/ui/ui.ts frame()의 'restart' 액션을 분리: 탭 = sim.kill('retry')로 마지막 체크포인트 즉시 리스폰(deaths +1, 리플레이 정직성 유지), 0.6s 홀드 = 기존 scenes.restartRun(). 서버 runs.ts의 DEATH_TICKS/INTRO_TICKS 파생값은 자동 일치 확인. SIM_VERSION 2 범프와 같은 배포. 사망 스팅/리스폰 sfx는 짧게(sfx.ts 기존 이벤트 길이 조정).
- 완료 기준:
  - test/sim: spike 접촉 death 이벤트 tick부터 phase==='play'까지 ≤72 ticks; 최초 스폰 intro 54 ticks 유지; determinism.test 600/3600/7200틱 스냅샷 동일
  - test/client/shell.test.ts: death 후 fx.fade≥0.9 도달, respawn 이벤트 후 20프레임 내 fade<0.05
  - test/client/ui.test.ts: R 탭 → stats.deaths+1·위치==마지막 체크포인트; R 0.6s 홀드 → restart 액션
  - npm run qa:smoke 12/12 유지, 콘솔 오류 0
  - 지표(P1-3 이후): death→respawn 체감 p50 ≤0.7s(클라이언트 측정), t1 60초 내 이탈률 ≤15%

### P1-3 — 익명 텔레메트리 + 사망 좌표 + 데이터 안내 화면 (TECH-01 + analytics-events 통합)

- 영역: client-shell · 공수: 2일 · 의존: P1-1
- 내용: src/shared/protocol.ts에 zod EventBatch(≤4KB, ≤20건): boot{build,sim,uaFamily,dpr,hwConcurrency,daysSinceFirstSeen(로컬 Progress에서 파생, 0/1/2-6/7+ 버킷),daysPlayedBucket}, screen, zone_start, death{levelId,cause,tx,ty,checkpointIdx}, clear{ticks,deaths,shards}, result_shown, retry, quit, daily_start/clear, share_click, race_link_open, submit_result{accepted,reason}, fps_sample(30s마다 frame ms p50/p95,tier), js_error{message,stack 3프레임}. player id·이름·IP는 절대 미전송(서버 로그도 IP 제외) — D1/D7은 daysSinceFirstSeen 버킷 집계로 계산. src/client/net/telemetry.ts: 메모리 버퍼→30s/화면 전환/pagehide(sendBeacon) 전송, ?shot=에서 비활성. src/server/routes/events.ts: IP당 30/min, pino 구조화 로그 + EMF JSON(js_error_count, submit_reject{reason}, fps_p95{tier}). tools/stats.mjs: Logs Insights 쿼리로 퍼널·D1/D7·존별 사망 히트맵(tx,ty 격자 ASCII) 출력. 크레딧 옆 '데이터 안내' 화면(index.html #scr-data): 수집 항목·미수집 항목·서버 기록 삭제 요청 경로(playerTag 제시).
- 완료 기준:
  - test/server/events.test.ts: 스키마 위반 400, 21건 400, IP 31번째 429, 정상 204, 로그 라인에 playerId/name/ip 필드 부재 단언
  - test/client/telemetry.test.ts: 10초 내 N개 이벤트 1요청 배치, pagehide에서 sendBeacon 1회, ?shot=에서 0요청
  - Playwright(smoke 확장): t1 시작 후 quit → /api/events 본문에 zone_start·quit 포함; 강제 예외 → js_error 이벤트
  - tools/stats.mjs가 MemoryRepo 픽스처로 boot→zone_start→clear 카운트, D1 비율, t1 사망 히트맵을 출력(test/tools)
  - test/client/ui-template.test.ts: #scr-data 존재, 크레딧 화면에서 진입 버튼

### P1-4 — 첫 실행 바로 시작 + 해금의 순간 (first-run-straight-in)

- 영역: ui · 공수: 1.5일 · 의존: 없음
- 내용: src/client/ui/ui.ts: save.firstRun && progress.lastLevel===null이면 타이틀 첫 항목 '바로 시작 · 새벽 물가' → emit start t1(선택 화면 건너뜀; 02-select.png의 잠긴 카드 8개를 첫 방문에 보이지 않게). 첫 클리어 후에는 선택 화면으로 복귀시켜 탑 구조를 보상으로 보여준다. refreshSelect(269-307)에 justUnlocked 집합 전달 → 새 카드 is-unlocking 클래스 + audio.ui('unlock')(contracts.ts:146에 정의만 있고 미사용). showResult에 '#res-unlock 다음 구역 해금: <이름>' 행(nextLevelId 있을 때만), 등급 글자 팝 애니메이션(CSS).
- 완료 기준:
  - Playwright: 새 프로필에서 타이틀 Enter 1회 → #scr-play.is-active 3초 내(현재 Enter 2회)
  - test/client/ui.test.ts: 잠겼던 카드가 열리면 audio.ui('unlock') 정확히 1회, 카드에 is-unlocking; #res-unlock은 nextLevelId 있을 때만 표시
  - test/client/shell.test.ts: 첫 클리어 후 ui.screen==='select'이고 t2 카드에 data-default
  - 지표: boot→zone_start ≥85%, zone_start까지 중앙값 ≤8초

### P1-5 — 기기 인식 힌트·죽음 원인 재힌트·길잡이 메아리 (UX-01, 게임패드 글리프 분기 포함)

- 영역: ui · 공수: 2.5일 · 의존: P1-2
- 내용: LevelDef.hint를 토큰 템플릿('{move} 이동 · {jump} 점프 · 공중에서 {jump} 한 번 더')으로, levels/dsl.ts 검증기가 원문 키 이름('SHIFT','Space','←')을 거절. 렌더 시 input.lastDevice(keyboard/gamepad/touch)별 글리프 치환(UX-10의 글리프 부분만 흡수). scenes.ts onSimEvent('death'): 같은 체크포인트 구간에서 cause='pit' 2회면 2단 점프 힌트, spike/saw면 대시 힌트 재표시(HINT_DELAY/HINT_DURATION 재사용). styles.css:379 터치 힌트를 HUD 바로 아래 상단 플레이트로. 길잡이 메아리: 개발자가 v2 sim에서 녹화한 t1 첫 15초 입력 로그(RLE base64, 수백 바이트)를 src/client/echo/guide.ts에 번들 → 첫 플레이에서 3초 뒤 반투명 '길잡이'가 첫 치명 구덩이를 2단 점프로 시연하고 첫 체크포인트에서 소멸(자산 0바이트). t1.ts의 연습 구덩이(x=15-17)는 이미 존재하므로 지형 변경 없음.
- 완료 기준:
  - vitest: hintFor(def,device)가 9구역×3기기 문자열 반환, 'touch' 결과가 /Shift|Space|←|→/에 매치되지 않음; 검증기가 원문 키 이름 포함 hint에 실패
  - qa:mobile(iphone14-landscape): 힌트 박스 하단이 뷰포트 높이 35% 이내, .tbtn/tpad와 교차 0
  - test/client/shell.test.ts: 새 Progress t1 시작 → run.echoes에 label '길잡이' 1개, 첫 checkpoint 이벤트 후 제거; guide 리플레이가 현재 sim에서 verifyReplay 시 첫 구덩이 통과(사망 0)
  - test/client/shell.test.ts: 동일 구간 pit 사망 2회 → ui.hint 재호출(2단 점프 문구)
  - 지표: t1 첫 세션 클리어율 ≥70%, t1 사망 히트맵의 첫 구덩이 비중 감소

### P1-6 — 판독성 패스: 상승기류·가시·골 비콘·터치 버튼 겹침 (GF-09)

- 영역: render · 공수: 2일 · 의존: 없음
- 내용: src/client/render/actors.ts updraft: 초당 8개 상승 스트릭 파티클 + 기둥 경계 1px 하이라이트 + 바닥 발광(quality low는 절반). tiles.ts spike: 1.3× 확대(타일 클리핑 유지), 팁 하이라이트 biome.spike.hi + 그림자, voidreef는 마젠타 림(shot-v1.png의 청록 가시/청록 크러스트 동계열 해소). 골 G가 뷰포트 밖이면 화면 가장자리 비콘(#hud-beacon, renderer가 카메라 투영을 HUD에 전달), 골이 우상단 220×90px 안이면 #hud-level 숨김(shot-v2.png 겹침). touch.ts/CSS: 버튼 idle 알파 0.35→눌림 0.9, 12px 위로 이동; qa:mobile에 스폰 프레임 적-버튼 교차 검사(iPhone14 캡처의 워커-JUMP 겹침).
- 완료 기준:
  - test/client/render.test.ts: updraft sim 60프레임 후 particles ≥60 증가(high), ≥30(low)
  - Playwright shot=v2: 상승기류 기둥 중심 열 평균 밝기가 배경보다 ≥25/255; shot=v1 가시 팁 픽셀과 crust 색 대비율 ≥3:1
  - Playwright shot=v2 골 근처: #hud-level.hidden===true; 골 화면 밖 좌표에서 #hud-beacon 표시
  - qa:mobile: 9존 스폰 프레임에서 foe 화면 좌표와 .tbtn rect 교차 0, 버튼 computed opacity 0.35

### P1-7 — 모바일 라이프사이클 잔여: 복귀 dt 폐기·메뉴 렌더 30fps·게임패드 해제 일시정지 (TECH-02 축소)

- 영역: client-shell · 공수: 0.5일 · 의존: 없음
- 내용: ui.ts:641-643이 이미 hidden/blur에서 pause()하므로 남은 것만: scenes.frame()이 document.hidden 복귀 시 누적 dt를 버리고 첫 프레임 렌더만 수행; 메뉴 화면(title/select/daily/settings/credits)에서 titleFrame을 누적 dt≥1/30일 때만 drawTitle; gamepaddisconnected → 플레이 중이면 pause + 토스트 '게임패드 연결이 끊겼다'; audio/engine.ts hidden 시 stopClock, visible 시 startClock+Sequencer 재동기 확인. resultTimer는 정지 대상에서 분리.
- 완료 기준:
  - test/client/shell.test.ts: 메뉴 화면에서 frame(1/60) 60회 → renderer.drawTitle ≤31회
  - test/client/shell.test.ts: gamepaddisconnected → ui.screen==='pause'; 결과 화면 대기 중에는 resultTimer 계속 감소
  - test/client/audio.test.ts: hidden 후 timer null, visible 후 non-null·nextTime ≥ currentTime
  - Playwright: t1 플레이 중 visibility hidden→visible 후 sim tick이 hidden 구간만큼 진행하지 않음(≤2틱 차)

## Phase 2 — 4 weeks: content and daily-loop depth

골든 리플레이로 안전망을 깐 뒤, 텔레메트리 사망 히트맵과 5~10명 플레이테스트를 게이트로 즉사+체크포인트 밀도(SIM v3)로 전환하고 기존 9존을 튠업한다. 데일리는 '오늘의 탑'이 매일 다른 기술 시험이 되도록 저작 청크를 넣고, 스트릭·어제의 탑·라이벌 메아리·게임오버 컴백으로 내일 돌아올 이유를 만든다. 세로형 존 3개로 '탑'이라는 약속을 지킨다. 합계 약 21.75 개발일.

### P2-1 — 골든 리플레이 코퍼스: 존 완주 증명 + 빈 보드 시딩 + 목표 메아리 (GF-10 + cold-start-par-echo 통합)

- 영역: tooling · 공수: 2일 · 의존: P1-2
- 내용: 개발자가 v2 sim에서 클리어한 window.__clawd.run.masks.bytes()를 levels/solutions/<id>.json으로 커밋(파의 95~110% 속도, deaths 0). test/levels/solutions.test.ts: 모든 LevelDef에 대해 verifyReplay cleared·deaths 0·time ≤par×1.2 — 이후 모든 물리·레벨 변경의 회귀 테스트. 서버 부트 시 repo.seedIfEmpty: 해당 s<SIM>r<rev> 보드가 비면 playerTag '개발자'로 조건부 put(Repo 인터페이스·fake Dynamo). 클라이언트 loadEchoes: 보드가 비거나 오프라인이면 번들된 solutions를 '목표' 라벨 메아리로 로드(src/sim/echoes.generated.ts, npm run levels가 생성·검증). README에 재녹화 절차.
- 완료 기준:
  - test/levels/solutions.test.ts: LEVELS 전부 solutions 존재, cleared && deaths===0 && time ≤ par×1.2
  - test/server: 빈 MemoryRepo로 buildApp → /api/leaderboard?mode=story&board=t1 entries ≥1, name '개발자'; 비어 있지 않으면 시드 안 함
  - test/client/shell.test.ts: 빈 보드 → 고스트 1개 라벨 '목표'; 보드에 항목 있으면 세계 기록 로드
  - ?shot=t1&ghost=par가 고스트 1개 렌더(qa:smoke)

### P2-2 — 게임 오버 컴백 루프: 같은 탑 다시·신기록 바·자기 최고 메아리 (over-screen-comeback-loop)

- 영역: client-shell · 공수: 1일 · 의존: 없음
- 내용: scenes.ts retryRun(419-424)이 endless에서 startEndless()로 새 시드를 뽑는 것을 수정: 게임오버 화면에 '같은 탑 다시'(startEndless(run.seed))와 '새 탑' 버튼 분리. 최고 높이 대비 진행 바('신기록까지 N칸', CSS --pct). progress.endless.bestMasks·bestSeed 저장(MAX_MASKS_B64 이하일 때만) → 같은 시드 재도전 시 자기 최고 메아리 로드. 데일리 게임오버에 '내 최고 높이 · 세계 최고' 행.
- 완료 기준:
  - test/client/shell.test.ts: '같은 탑 다시' → run.seed 동일, '새 탑' → 상이; 같은 시드 재도전 시 self 메아리 1개
  - test/client/ui.test.ts: over 화면 진행 바 --pct == h/best, 데일리 over에 세계 최고 행
  - 지표: 게임오버 후 retry 비율 ≥55%

### P2-3 — 데일리 스트릭·7일 달력·어제의 탑 회고/재도전·확정 배지 (daily-streak-history + GF-07 스트릭 절)

- 영역: ui · 공수: 2일 · 의존: 없음
- 내용: save.ts streakFor(progress.daily, serverDate)(연속 UTC 일수, DailyResponse.date만 사용). ui.ts renderDailyMine 한 칸을 7일 스트립(도전/클리어/미도전, 클리어는 순위 숫자)+'N일 연속' 배지로. 부팅 시 어제 보드 1회 조회(GET /api/leaderboard?mode=daily&board=<어제>&playerId) → '어제의 탑 · 세계 N위 / M명', 날짜가 2일 이상 지나면 '확정' 배지. 서버 GET /api/daily에 yesterdaySeed(또는 ?date=어제) 추가 → '어제의 탑 재도전' 버튼(isFreshDate가 이미 접수). 타이틀 '데일리 타워' 소제목 동적('오늘 미도전 · 3일 연속').
- 완료 기준:
  - test/client/save.test.ts: 연속 3일→3, 하루 빈 뒤→1, 미래 날짜 무시
  - test/server/daily.test.ts: /api/daily 응답에 yesterdaySeed, 어제 시드로 제출 접수, 2일 전 stale-date
  - Playwright: 데일리 화면 .daily__week 자식 7개, 오늘 셀 is-today; 어제 yours 있으면 '어제의 탑 · 세계 N위'
  - 지표: 데일리 플레이어의 다음날 daily_start ≥30%, 2주 후 스트릭≥3 비율 ≥15%

### P2-4 — 라이벌 메아리 + 체크포인트 스플릿 + 사망 마커/구간 PB (echo-rival-and-live-split + 심사 누락 항목)

- 영역: client-shell · 공수: 2.5일 · 의존: P2-1
- 내용: scenes.ts loadEchoes(825-826, entries[0]만) → limit 50+playerId로 받아 yours.rank−1 항목(없으면 중앙값, 없으면 1위, 보드 비면 P2-1 목표 메아리)을 '라이벌 · 이름'으로. Echo 클래스에 체크포인트 통과 틱 기록 → checkpoint 이벤트 시 HUD 칩 +0.84s/−1.20s(1.5초, 색 구분), 자기 PB 대비 스플릿도 동일 코드. 세션 내 사망 위치를 X 마커로 렌더(actors.ts, 최근 5개), 구간별 사망 수·구간 PB를 일시정지 화면에 표시. 결과 화면 '#res-vs-world 라이벌보다 0.6s 빠름/느림' 행. 설정에 '세계 메아리 = 1위 / 라이벌' 세그먼트.
- 완료 기준:
  - test/client/shell.test.ts: 가짜 보드 1..10, yours.rank 7 → 고스트 runId rank 6; yours 없음 → 중앙값; 빈 보드 → 목표 메아리
  - test/client/shell.test.ts: checkpoint 이벤트 다음 프레임 hud.split 설정, 1.5초 후 null; 메아리 미도달 시 '—'
  - test/client/render.test.ts: 사망 3회 후 마커 3개 그리기(draw 호출 카운트), 리스폰 후 유지
  - test/client/ui.test.ts: #res-vs-world 부호·소수 2자리 포맷
  - 지표: 라이벌 메아리 있는 결과 화면의 retry 클릭률 ≥ +20% 대비

### P2-5 — 이름 온보딩: 첫 제출 전 인라인 이름 입력 (UX-11 이름 절)

- 영역: ui · 공수: 0.75일 · 의존: 없음
- 내용: save.ts DEFAULT_NAME '클로드'가 묻지 않고 제출되는 것(라이브 t1 1위 이름 '클로드'로 확인)을 고친다: 첫 eligible 클리어에서 이름이 기본값이면 등급 연출(RESULT_DELAY) 뒤 결과 화면 안에 기존 name 모달을 인라인으로 띄우고 확정 후 submit(순위표 로딩과 병렬). '건너뛰기'는 '클로드 #'+playerTag 앞 4자. 서버 스키마 변경 없음.
- 완료 기준:
  - test/client/shell.test.ts: 기본 이름 첫 eligible 클리어 → api.submitRun 전 ui.screen==='name', setName 후 body.player.name이 새 이름
  - test/client/shell.test.ts: 건너뛰기 → /^클로드 #[0-9a-f]{4}$/ 패턴 저장·제출
  - 지표: 보드에서 이름 '클로드' 정확 일치 비율 <5%

### P2-6 — 막힘 감지 → 보조 모드 제안 + 2구역 선행 해금 (stuck-detector-assist-offer, 임계값 상향)

- 영역: client-shell · 공수: 1.5일 · 의존: P1-3
- 내용: ui.ts refreshSelect(271) 해금 규칙을 'N 클리어 → N+1, N+2'로(티어 경계 t3→s1, s3→v1은 직전 클리어 필수). scenes.ts onSimEvent('death'): 해당 존 세션 사망 ≥20(즉사 전환 후 재조정)이고 !settings.assist이고 progress.seen['assist:'+id] 없으면 ui.offerAssist() 모달 — '보조 모드로 이 구역을 다시 시작할까? 기록은 순위표에 오르지 않는다 · 설정에서 언제든 끈다'(Sim은 assist를 생성자에서 받으므로 재시작임을 명시), '다시 묻지 않기'.
- 완료 기준:
  - test/client/ui.test.ts: t1만 done → t2·t3 해금, s1 잠김; t3 done → s1·s2 해금
  - test/client/shell.test.ts: 같은 존 20번째 death에 offerAssist 1회, 21번째 없음, 재시작 후 재제안 없음
  - 지표: t3·s2의 zone_start→clear가 3세션 내 ≥60%, 보조 제안 수락률 관측

### P2-7 — 콘텐츠 툴링 라이트: 격자 미리보기·DSL 오류 덤프·레벨 워치 모드 (TECH-11 축소)

- 영역: tooling · 공수: 1일 · 의존: 없음
- 내용: levels/dsl.ts validate 오류에 문제 셀 주변 ASCII 덤프+열 눈금+(x,y) 포함; Room에 mark(name,x,y)/at(name) 앵커. tools/dev.mjs: levels/ 변경 시 npm run levels 재실행+라이브 리로드; /dev/preview?level=<id>(dev 전용 라우트)가 ?shot= 하네스 위에 타일 격자·좌표·스폰 문자·체크포인트 구간 길이 오버레이. 솔버는 만들지 않음(P2-1 골든이 완주 증명). README '구역 만들기 10분 가이드'.
- 완료 기준:
  - test/levels/dsl.test.ts: 잘못된 문자 zone의 오류 메시지에 해당 행 ASCII 덤프와 (x,y) 포함
  - Playwright(dev): levels/zones/t1.ts 저장 후 3초 내 /dev/preview?level=t1 갱신, 격자 DOM 표시
  - npm run levels --check가 P2-8·P2-10 저작 중 회귀 없이 통과

### P2-8 — 9존 튠업: 위험물 즉사(하트는 어시스트만)·체크포인트 2배·파편 루트화·파 검증 — SIM v3 (GF-02 + 심사 누락 '기존 존 튠업')

- 영역: levels · 공수: 4일 · 의존: P1-1, P1-3, P2-1, P2-7
- 내용: 게이트: P1-3 사망 히트맵 2주치 + 낯선 플레이어 5~10명 플레이테스트에서 오너 결정. src/sim/player.ts hurt(): assist가 아니면 hp 무시하고 kill(cause)(spike·saw·bolt·foe·switch; shot-v1.png의 가시 위 깜빡임 제거), ASSIST.maxHp 3 유지, HUD hud-hearts는 assist에서만. 9개 levels/zones/*.ts에 C를 par 20초당 ≥1(인접 C/P/G 수평 거리 ≤32칸), 히트맵 상위 사망 지점 직전에 우선 배치. 파편을 존당 8~12개로 줄이고 대시·월점프를 요구하는 옆길로 이동(2성 '전 파편'이 실제 도전이 되게), t1 row16 7칸 구덩이는 5칸으로. LevelDef.rev 증가, SIM_VERSION 3, 골든 재검증·필요 시 재녹화(0.5일 포함). zones.test 'v3 checkpoints===2' 등 하드코딩 갱신.
- 완료 기준:
  - test/sim: normal 모드 spike/saw/bolt/foe 접촉 → 같은 tick death, hurt 0회; assist 모드 hurt+hp 감소(physics/entities 테스트 유지)
  - test/levels/zones.test.ts: 각 존 checkpoints ≥ ceil(par/20), 인접 체크포인트 거리 ≤32칸, shards 8~12, t1 최대 구덩이 ≤5칸
  - test/client/ui.test.ts: assist=false에서 #hud-hearts.hidden===true
  - test/levels/solutions.test.ts 9개 골든 cleared·deaths 0 유지(재녹화 시 커밋)
  - 지표: 존별 사망/클리어 비 전후 비교, t1~t3 첫 세션 클리어율 하락 없음(≥70%), 세션 내 재도전율 상승

### P2-9 — 데일리 스킬 천장: 저작 청크 삽입 (GF-07 청크 절, 모디파이어 제외)

- 영역: sim · 공수: 3일 · 의존: P1-1, P2-1
- 내용: levels/chunks/*.ts에 DSL 청크 12개+(태그 dash/wall/crystal/switch, 폭 40, 높이 8~14, 진입/출구 행 명시, 표준 발판 폭으로 경계 고정). src/sim/gen/endless.ts buildTower에 chunks 옵션: 밴드(50행)마다 1~2개를 rng로 골라 삽입, effectiveClimb 계약을 청크 경계에서 검사(헤더 '월점프 필수 아님' 계약은 청크 내부에서만 완화). GEN_VERSION 2. 각 청크의 골든 리플레이(단독 룸)로 클리어 증명. 서버 makeDailyLevel 동일 코드.
- 완료 기준:
  - test/sim/tide.test.ts: 시드 50개에서 밴드마다 청크 ≥1, 청크 밖 towerSteps 계약(rise ≤4, gap ≤5) 유지
  - test/levels/chunks.test.ts: 12개 청크 골든 리플레이 단독 룸 cleared, validate 통과
  - test/server: gen≠GEN_VERSION 제출 422 'sim-version'; 오늘 시드 검증 시간 ≤ 기존 +20%
  - 지표: 데일리 클리어율 40~70% 유지, 데일리 상위 10위 기록 분산(표준편차) 증가

### P2-10 — 층마다 세로형 존 1개: t4·s4·v4 (GF-03)

- 영역: levels · 공수: 4일 · 의존: P2-1, P2-8
- 내용: levels/dsl.ts Room은 임의 크기이므로 44×80 세로 룸 3개 저작: t4(4칸 통로 3개+물웅덩이 안전망), s4(M 세로 발판·크럼블 계단·번개 스위치 승강), v4(상승기류 3단+크리스탈 체인 하강). 체크포인트 12행마다(P2-8 규칙). zones.test 크기 규칙을 '가로 60~120×16~30 또는 세로 36~48×60~100'으로, ORDER 12개, CHAPTERS 생성(build.ts), .tier__cards 3열→4열(styles.css:235). camera.ts: 세로 존에서 grounded 시 위쪽 리드 +18. 골든 3개 녹화, 힌트 토큰 템플릿.
- 완료 기준:
  - test/levels: t4/s4/v4 validate 통과, rows ≥60, cols ≤48, t4 4칸 통로 ≥2, v4 'z' ≥3, s4 'M' ≥2, 체크포인트 ≥5
  - test/levels/solutions.test.ts: 3개 골든 cleared, time ≤ par×1.2
  - test/client/camera.test.ts: 세로 존 grounded 시 카메라 y가 발 위 CAM_LIFT+18 이내 수렴
  - qa:smoke shot=t4,s4,v4 콘솔 오류 0; 02-select 캡처에 4열 카드
  - 지표: 세로 존 클리어율 ≥ 같은 층 평균 −10%p 이내, 세로 존 재플레이 비율

## Phase 3 — 6 weeks: social, retention, technical excellence

검증 보드의 신뢰(리플레이 도용 차단, V8↔JSC 결정론 증명)를 먼저 굳힌 뒤, 이 게임의 유일한 고유 훅인 메아리를 링크로 내보내고(경주·관전·공유 카드·og:image), 계정 없는 게임의 필수품(진행도 이전 코드)과 마스터리 표현(메달·스킨), 폰 조작·햅틱·오디오·클리어 연출로 앱 체감을 완성한다. 트래픽이 붙는 순간의 스케일 절벽·알람·CI는 경주 링크 배포 전후로 배치. 합계 약 30 개발일.

### P3-1 — 안티치트: 리플레이 도용 차단(해시 중복)·휴리스틱 기록·관리자 CLI·금칙어 (TECH-09)

- 영역: server · 공수: 2일 · 의존: P1-1
- 내용: src/server/runs.ts: sha256(masks)를 StoredRun.hash에 저장, saveBest 트랜잭션에 HASH#<mode>#<board>#<hash> 조건부 Put(attribute_not_exists) → 충돌 시 422 'duplicate'(protocol.ts:76에 정의만 있고 미사용). 검증 시 휴리스틱(1틱 프레스 비율, 초당 엣지, 프레임 격자 정렬률, 대시→점프 퍼펙트 수)을 StoredRun.hx에 기록·EMF 히스토그램만(자동 차단 없음). tools/admin.mjs delist/rename/ban-name/export-board; src/shared/names.ts 한·영 금칙어 → 400. GET /api/ghost IP당 60/min.
- 완료 기준:
  - test/server/runs.test.ts: A의 1위 masks를 B가 제출 → 422 duplicate, 보드에 B 없음
  - test/server/dynamo-repo.test.ts: TransactItems에 HASH Put+attribute_not_exists, 데일리는 ttl
  - test/server/heuristics.test.ts: 코퍼스 리플레이 hx 계산·로그 포함; 매 틱 엣지 합성 리플레이 frameAligned <0.6
  - tools/admin.mjs delist <runId> → topRuns에서 제거, RUN에 flagged:true; 금칙어 이름 400

### P3-2 — 크로스 엔진 결정론 코퍼스: Node + Chromium + WebKit(JSC) 자가 진단 (TECH-04)

- 영역: sim · 공수: 1.5일 · 의존: P2-1, P1-3
- 내용: README:94가 인정한 iOS 미실측을 메운다. test/fixtures/replays/에 P2-1 골든 12개+데일리 시드 3개+엔드리스 시드 2개(masks, 기대 RunSummary, 종료 state JSON FNV-1a 해시). vitest(Node). src/client/shot.ts에 ?selftest=1 하네스 → <html data-selftest> 결과 JSON. tools/qa/smoke.ts에 chromium+webkit selftest 단계. 설정 데이터 탭 '엔진 자가 진단' 버튼 → P1-3 selftest_result 이벤트. 실기기 iPhone 1회 실측 후 README 갱신.
- 완료 기준:
  - npx vitest run test/sim/golden.test.ts: 17개 픽스처 summary·해시 일치; PHYS 상수 변경 시 실패
  - npx tsx tools/qa/smoke.ts --selftest: chromium·webkit 모두 17/17, 불일치 시 exit 1
  - 실기기 iPhone 자가 진단 → CloudWatch Logs에 selftest_result{pass:17,fail:0}
  - 지표: submit_reject 비율 uaFamily별 <2%

### P3-3 — 친구 메아리 링크로 경주 + 관전 모드 + 어트랙트 데모 (race-a-friend-echo-link + 심사 누락 '관전')

- 영역: client-shell · 공수: 4일 · 의존: P3-1, P3-2, P2-4
- 내용: main.ts가 location.hash race=<runId> 파싱 → api.ghost → story면 해당 존(잠긴 존도 1회 플레이 허용, eligible=false·해금 없음), daily면 isFreshDate일 때 그 시드(아니면 '이 탑은 닫혔다' 토스트) → Echo(C.echoFriend, name) 추가, HUD '○○의 메아리와 경주 중'. 결과 화면 '친구 대비 −1.32s' 행 + '메아리 링크 공유'(navigator.share → clipboard 폴백+토스트). 리더보드 행에 '경주'·'보기' 버튼: 관전 = 입력 없이 카메라가 메아리를 따르는 재생(1×/2×, 아무 키로 종료). 타이틀 무입력 20초 시 세계 기록 메아리가 비스타 위에서 뛰는 어트랙트 데모. 서버: /api/ghost/* 응답 Cache-Control public, max-age=31536000 + edge.ts 별도 behaviour(CACHING_OPTIMIZED), app.ts no-store 훅 예외.
- 완료 기준:
  - Playwright: MemoryRepo 시드 runId로 /#race=<id> 접속 → 새 프로필에서 #scr-play, run.echoes.length===1, 라벨 친구 이름; 클리어 후 해금 없음·제출 없음
  - test/client/shell.test.ts: 잘못된 hash 무시, 만료 데일리 runId는 토스트 후 타이틀; 관전 시작 → 입력 마스크 0, 카메라 타깃==에코 위치
  - test/infra/stack.test.ts: /api/ghost/* behaviour CACHING_OPTIMIZED, /api/* CACHING_DISABLED 유지
  - test/client/ui.test.ts: #res-vs 행 부호·소수 2자리; 타이틀 20초 무입력 후 attract 상태
  - 지표: share_click/result_shown ≥8%, race_link_open/share_click ≥30%(2주 창)

### P3-4 — 절차적 공유 카드 + og:image·매니페스트·설치 카드 (result-share-card + UX-11 공유 절 + UX-07)

- 영역: ui · 공수: 2.5일 · 의존: P3-3
- 내용: src/client/share/card.ts: 오프스크린 캔버스 1200×630에 바이옴 그라디언트(단순 그라디언트로 Sky 대체)+drawPortrait 초상+구역명·기록·등급·별·'세계 N위 / M명'·race 링크 텍스트(에셋 0). canvas.toBlob → navigator.share({files,text,url}) → canShare 실패 시 링크 공유 → clipboard 폴백. 결과·게임오버 화면 '공유' 버튼. index.html og:image/twitter:card(tools/icons.mjs 확장으로 ?shot= 하네스에서 렌더해 커밋 — 브라우저·SNS 메타데이터 예외를 README에 명시), manifest id/description/categories/shortcuts(/?go=daily, /?go=endless)/screenshots, orientation은 유지. 첫 story 클리어 결과에 설치 카드(3회 거절 시 숨김).
- 완료 기준:
  - test/client/share.test.ts: 카드 1200×630, fillText에 구역명·기록·URL 포함
  - Playwright(navigator.share 스텁): 공유 클릭 → files[0].type==='image/png', url에 runId; share 없으면 clipboard.writeText+토스트
  - test/client/ui-template.test.ts: manifest에 id·description·categories·≥2 screenshots·≥2 shortcuts; index.html og:image·twitter:card
  - postdeploy: og:image 200·image/png·1200×630; shell.test: 설치 카드 dismiss 3회 후 영구 숨김

### P3-5 — 진행도 이전 코드 + 저장소 영속 요청 (심사 누락: iOS 7일 삭제 대책, 계정 없는 게임의 필수품)

- 영역: server · 공수: 2일 · 의존: P1-1
- 내용: navigator.storage.persist()를 첫 클리어 후 요청. 설정 데이터 탭 '다른 기기로 옮기기': 서버 POST /api/transfer가 PLAYER#<id>/SNAPSHOT(Progress JSON ≤16KB, masks 제외, TTL 7일)을 저장하고 8자 코드(HMAC 서명, 1회용)를 반환 → 새 기기에서 코드 입력 시 GET /api/transfer/<code>로 playerId+Progress 복원(기존 기록·runId·playerTag 유지). QR은 코드 텍스트를 절차적으로 그린 canvas. 코드 조회 IP당 5/min.
- 완료 기준:
  - test/server/transfer.test.ts: 코드 생성→복원 1회 성공, 2회째 410, 8일 후 만료, 잘못된 서명 400, 16KB 초과 413
  - test/client/save.test.ts: 복원 후 progress.player.id가 원본과 동일, levels 기록 병합(더 좋은 기록 우선)
  - Playwright: 기기 A에서 코드 생성 → 새 컨텍스트에서 입력 → 선택 화면 진행도 동일
  - 지표: 설정 '옮기기' 사용 수, 복원 성공률 ≥95%

### P3-6 — 구역 메달(노데스·파 이내·전 파편·유물)·랭크·최고 콤보 저장·스킨 해금·카드 세계 순위 (GF-06 + zone-medals-skin-unlocks 통합)

- 영역: ui · 공수: 2.5일 · 의존: P2-8
- 내용: contracts.ts LevelRecord에 deathless/underPar/allShards/bestRank/bestCombo(save.ts repairLevelRecord 기본값). recordProgress 갱신, 새 메달 시 결과 화면 팝+sound('unlock'). 카드에 메달 4칸·최고 등급·'세계 N위'(선택 화면 진입 시 보드 top 조회 캐시). 헤더 '별 N/36 · 메달 N/48'. src/client/unlocks.ts 순수 함수: 아마조니(azure 스킨)=별 6, 엠버=2층 진입, 보이드=첫 S; 기존 선택 스킨은 그랜드파더링. 콤보 8+ HUD 칩 색·sfx 피치 상승.
- 완료 기준:
  - test/client/save.test.ts: 구 세이브 복구 시 새 필드 기본값; deaths 0 클리어 → deathless=true 이후 유지
  - test/client/unlocks.test.ts: 규칙 표 경계값(별 5/6), 잠긴 스킨 설정은 보유 시 유지·미보유 시 clawd 폴백
  - test/client/ui.test.ts: 카드 .medal 4개·세계 순위 배지, 잠긴 스킨 aria-disabled, showResult '최고 콤보' 행
  - 지표: 스토리 완주자의 클리어 존 재시작 ≥35% of zone_start

### P3-7 — 터치 컨트롤 커스터마이즈·플로팅 스틱·8방향 대시 조준 규칙·게임패드 자동 숨김·44px/11px 감사·음소거 칩 (UX-06 + UX-14 + UX-12 일부 + 심사 누락 '터치 대시 조준'·'입력 지연 QA')

- 영역: ui · 공수: 3일 · 의존: 없음
- 내용: src/client/input/touch.ts: 플로팅 스틱(왼쪽 절반 아무 곳이 원점), 8방향 스냅 각도 ±22.5°, Y 데드존 0.45, 대시 순간 방향 잠금 규칙 명시. Settings v2 touch:{side,size,opacity,floating}, haptics, reduceMotion(명시 토글), textScale. input.lastDevice 'gamepad' 시 #hud-touch 페이드아웃. 폰 규칙 글자 ≥11px, 버튼 ≥44px, 일시정지 2.75rem. 타이틀·일시정지 음소거 칩, suspended 시 '탭하여 소리 켜기'. qa:mobile에 폰트/타겟 감사와 입력 지연 측정(pointerdown 타임스탬프→다음 프레임 플레이어 vy 변화 ≤1프레임), 대각 대시 성공률 스크립트.
- 완료 기준:
  - test/client/input.test.ts: 왼쪽 임의 좌표 pointerdown → 원점, 20px 이동 시 x 마스크; 대각 입력이 8방향으로 스냅
  - test/client/ui.test.ts: lastDevice gamepad → #hud-touch.hidden true, 터치 후 false; 음소거 칩 토글·복원
  - qa:mobile(iphone14, galaxy): #ui 보이는 텍스트 ≥11px 위반 0, #scr-play 버튼 ≥44×44, 입력→반응 ≤1프레임, 대각 대시 8방향 스크립트 성공률 100%
  - test/client/save.test.ts: v1 설정 로드 시 touch 기본값 채움·기존 값 보존

### P3-8 — 햅틱: Vibration API + 게임패드 럼블 (UX-02)

- 영역: client-shell · 공수: 1일 · 의존: P3-7
- 내용: src/client/haptics.ts EVENT_HAPTIC: Record<SoundedEvent, number[]|null>(land impact>0.5→[8], dash→[12], wallJump→[10], death→[30,40,60], checkpoint→[15], goal→[20,60,20,60,80], shard→null), sfx.ts GATE_MS와 같은 게이트, 초당 총 진동 ≤80ms. navigator.vibrate + gamepad.vibrationActuator.playEffect 병행. Settings.haptics(coarse pointer 기본 on, reduced-motion 시 off). Scenes.tick 이벤트 디스패치에 한 줄.
- 완료 기준:
  - test/client/haptics.test.ts: 모든 SimEvent type이 EVENT_HAPTIC에 존재, 패턴 합 ≤200ms
  - happy-dom: death → vibrate 1회, haptics=false 0회, 40ms 내 연속 land 1회
  - Playwright(Pixel 에뮬, vibrate 스텁): t1 구덩이 사망 후 호출 ≥2, 콘솔 오류 0

### P3-9 — 오디오 연출 패스 + 캐릭터 주스 + 클리어 세레머니·층 돌파(첫 통과 1회)·엔딩 화면·한 줄 서사 (GF-11 + GF-04 엔딩 절 + 심사 누락 '오디오'·'캐릭터'·'서사')

- 영역: client-shell · 공수: 4일 · 의존: P2-10
- 내용: music.ts/sfx.ts: 체크포인트 모티프·유물 스팅어·클리어 팡파르·사망 시 음악 덕킹·층 전환 트랙 크로스페이드·마스터 리미터. clawd.ts 리그: 대기·피격·사망·골 세레머니 포즈, 착지 먼지·대시 잔상(fx.ts). scenes.ts finish(): 바이옴 마지막 존 첫 클리어에만 3초 층 돌파 시퀀스(drawTitle 비스타 팔레트 크로스페이드, 배너 'II층 폭풍 첨탑', 아무 키 스킵), 일반 클리어는 RESULT_DELAY 유지+별 순차 팝. v3(또는 v4) 첫 클리어 후 #scr-ending(총 별·유물·사망·시간·메아리 순위, 3줄 엔딩 문구)→타이틀. 존 진입 배너 한 줄·유물 획득 로어 한 줄(LevelDef.lore).
- 완료 기준:
  - test/client/audio.test.ts: goal/relic/checkpoint 이벤트에 스팅어 노트 >0, death 후 music gain 덕킹 후 복귀; 리미터 출력 피크 ≤0dBFS(오프라인 렌더)
  - test/client/shell.test.ts: t3 첫 goal → 'tier' 상태 3초 후 result, 두 번째 클리어는 바로 result; v3 첫 goal → 'ending' → 타이틀
  - test/client/ui-template.test.ts: #scr-tier·#scr-ending 존재·live region; 별 3개 결과에서 .star.is-on delay-0/1/2
  - qa:smoke ui=ending 캡처 콘솔 오류 0; render.test: 사망/골 포즈 프레임이 대기 포즈와 다른 Path 카운트

### P3-10 — GitHub Actions CI: typecheck·levels --check·vitest·Playwright(chromium+webkit selftest)·qa:mobile·cdk synth·ARM64 이미지 (TECH-07)

- 영역: tooling · 공수: 1.5일 · 의존: P3-2
- 내용: git remote가 없으므로 저장소 생성 선행. .github/workflows/ci.yml: npm ci → typecheck → levels --check → test → build → 로컬 서버 기동 후 qa:smoke(--selftest 포함)+qa:mobile → cdk synth --quiet(cdk.context.json) → cfn-lint; ubuntu-arm 러너에서 docker build --platform linux/arm64(푸시 없음); tools/qa/out/*.png 아티팩트. main 보호 규칙, deploy는 workflow_dispatch 수동.
- 완료 기준:
  - 실패 테스트 PR이 빨간불·머지 차단
  - 정상 PR CI ≤10분, 스크린샷 아티팩트 첨부
  - cdk synth job이 자격 증명 없이 통과; ARM64 이미지 ≤200MB

### P3-11 — 운영 위생 번들: 알람·대시보드·EMF + 데이터 RETAIN·백업·구 RUN TTL + 엣지 캐시 s-maxage (TECH-08 + TECH-14 + TECH-13)

- 영역: infra · 공수: 2일 · 의존: P1-1
- 내용: infra/lib/constructs/observability.ts: SNS + 알람(ALB 5xx>1%, p95>1s, UnHealthyHost≥1, ECS CPU>80%/Mem>85%, DDB throttle>0, CloudFront 5xx>1%, verify_ms p95>2s, submit_reject>30%) + 대시보드 1장 + ALB 액세스 로그 S3 30일. data.ts RemovalPolicy.DESTROY→RETAIN, deletionProtection, AWS Backup 일간 35일; saveBest에 이전 RUN ttl 90일; TAG_SECRET 분리+docs/runbooks/secrets.md. static.ts index/sw/manifest Cache-Control public,max-age=0,s-maxage=60,stale-while-revalidate=300(release.mjs 무효화가 이미 있음).
- 완료 기준:
  - test/infra/stack.test.ts: Alarm ≥10, Dashboard 1, Topic 1, 테이블 DeletionProtection true·Retain, BackupPlan 1, 시크릿 3개, access_logs 활성
  - test/server/metrics.test.ts: 검증 1건 후 stdout EMF 라인(ClawdEchoTower, verify_ms)
  - test/server/static.test.ts: index cache-control s-maxage=60; postdeploy: '/'·'/sw.js' 2회 GET 시 x-cache Hit
  - 태스크 1개 수동 중지 → 5분 내 알람 이메일(1회 실측·런북 기록)

### P3-12 — 스케일 절벽 제거: 검증 백프레셔·worker 격리·태스크 사이징·플릿 공유 제출 한도 + 리더보드 캐시/ /api/me 분리 (TECH-05 + TECH-06, 트래픽 게이트)

- 영역: server · 공수: 3.5일 · 의존: P3-3, P3-11
- 내용: 게이트: accepted/min ≥20 또는 경주 링크 배포 직후. src/server/verifyPool.ts worker_threads 1개+세마포어(동시 4, 대기 16), 초과 503+Retry-After 3(클라이언트 SubmitQueue에 재시도 타이머 추가 — 현재 boot/online에서만 flush). service.ts cpu 512/mem 1024, autoscale 2~10, p95 스텝 스케일링. POST /runs IP 한도를 DynamoDB 카운터(RL#<ip>#<minute>, TTL 120s)로 플릿 공유. GET /api/leaderboard는 공개 top-N만(playerId 제거) + Cache-Control public,s-maxage=5 + edge.ts 전용 behaviour; 새 GET /api/me(no-store)=GetItem+COUNT Limit 1000(rankCapped); BOARD#<mode>#<board> total 카운터. tools/load/submit.mjs 부하 스크립트.
- 완료 기준:
  - test/server/backpressure.test.ts: 동시 5번째 POST /runs 503+retry-after, 앞선 4건 200; 큐잉된 클라이언트가 3초 후 재시도
  - tools/load/submit.mjs 200 동시 실행 시 /healthz p99 <100ms, 503 외 5xx 0
  - test/server/leaderboard.test.ts: /api/leaderboard 응답에 you 없음·public s-maxage=5; /api/me no-store; fake Dynamo RCU: 리더보드 ≤2, /api/me ≤3
  - test/infra/stack.test.ts: Cpu 512·Memory 1024·MaxCapacity 10·p95 ScalingPolicy

### P3-13 — 적응 화질 v2: p95 기반·히스테리시스·티어 영속화 (TECH-10)

- 영역: render · 공수: 1일 · 의존: P1-3
- 내용: stage.ts sampleFps를 2초 창 frame ms p95(32버킷 히스토그램)로: p95>24ms→다운, 60초 p95<13ms→업(세션 1회, 다운 후 60초 잠금), rAF 간격 중앙값으로 Hz 추정. 정착 티어를 localStorage 'clawd-echo.autotier.v1'에 저장해 다음 세션 첫 프레임부터 적용. ?fps=1 오버레이(p50/p95/tier)를 shot 하네스와 공유, data-shot에 fpsP95.
- 완료 기준:
  - test/client/render.test.ts: 58↔41fps 교대 60초 → setQuality 전환 ≤2회, 안정 55fps 0회; low 정착 후 새 Stage가 localStorage 티어로 시작
  - Playwright CPU 6x 스로틀 t1 5초 → qualityTier 'low', 리로드 첫 프레임부터 'low'
  - qa:smoke 9존 fpsP95 <20ms(스로틀 없음)
  - 지표: fps_sample p95 tier별 분포, low 티어 세션의 첫 5초 p95 개선

## 기각·보류 (사유)

- GF-04 4번째 바이옴+결정론 보스+엔딩 (6일): feasibility 4·4·5 — 심사 2인 이상 ≤4. BiomeId·weather 유니온·BAND_ORDER·music까지 신작 렌더이고 dmath 결정론 보스는 전례 없는 규모(12~15일 추정). 엔딩 화면·층 돌파 비스타·한 줄 서사만 P3-9에 흡수; 정점 존/보스는 P2-10 세로 존 클리어율과 스토리 완주율(v3 clear/t1 start)을 본 뒤 재검토.
- pwa-push-daily-reminder (4일): feasibility 4·4·4, fit 4·5·5 — 심사 3인 ≤4. iOS 홈 화면 설치 필수·옵트인 한 자리 수, VAPID·EventBridge·Lambda·GSI는 CF→ALB→Fargate→DDB 스택 제약을 벗어남. 스트릭 UI(P2-3)가 습관을 먼저 만든다.
- season-ladder-lite (4일): feasibility 5·5·4, fit 5·5·5 — 두 판정관 fit/feasibility ≤5, 한 명 ≤4·나머지 5. 데일리 인구 0에서 포인트 래더는 순서가 뒤이고 배치 Lambda로 스택이 커진다. 데일리 DAU ≥100 후 재검토.
- UX-04 한/영 i18n (4일): fit 5·5·6 — 오너 제약 '한국어 UI'와 충돌하고 해라체 톤의 영어 카피 검수 비용이 별도. 오너가 시장(한국 1위 vs 글로벌)을 정하면 typed string table 방식으로 재상정.
- GF-05 B-side 9개 (5일, 심사 추정 8~10일): feasibility 6·5·6. '클론 아님' 리믹스 9개는 1인 저작 예산을 넘고 9존 완주자만 혜택. 보류 게이트: 스토리 완주율 ≥25%이고 P3-6 메달 재플레이 지표가 포화될 때, 층당 1개(3개)부터.
- GF-07 요일 모디파이어 절 (3일): feasibility 6·5·5. mods는 player.ts 깊숙한 sim 변경+서버 패리티이며 결정론 테스트 부담이 크다. 청크(P2-9)로 데일리가 기술 시험이 된 뒤 데일리 DAU ≥50에서 재검토(mods 비활성 시 비트 동일 조건으로 SIM_VERSION 범프 없이 가능).
- GF-12 super/hyper 테크 (2일): impact 7·4·4, fit 9·6·6. config.ts 헤더의 '플레이테스트 산물 재조정 금지'와 긴장, 낯선 플레이어는 보지 못하고 스킵 방지 봇 테스트가 실제 비용. 보드가 채워져 상위 기록이 수렴(top10 표준편차 <1%)하는 신호가 나오면 v4 범프에 묶어 재상정.
- GF-08 새 적 '버블' 절 (3일 중 2일): 새 스폰 문자·검증기·렌더 분기 확장이 콘텐츠 없이 선행되면 낭비. 예고 포즈(turret 조준선·hopper 스쿼시, 0.5~1일)는 P2-8 튠업 중 여유가 나면 편입, 버블은 B-side/정점 콘텐츠와 함께.
- UX-03 세로 모드 (4일): feasibility 5·5·5, fit 6·6·7. 100×20 스토리 방은 세로에서 선행 시야가 죽고 Stage·Camera·CSS 전면 변경. 타이드 모드(44폭 세로 탑)만 지원하는 축소판(2~2.5일)을 P3 이후 백로그 1순위로.
- weekly-challenge-board (3일): 데일리 보드가 0건인 지금 빈 보드를 하나 더 열면 사회적 증거가 더 얇아진다(심사 3인 동의). 게이트: 데일리 다음날 재도전 ≥30% 달성 후.
- friends-board-by-code (3~5일): feasibility 6·6·6. 12자 코드 입력 마찰이 크고 경주 링크(P3-3)가 가치의 80%를 더 싸게 준다. race_link_open 지표를 본 뒤 재검토.
- country-board (1.5일): impact 4·4·4. 초기 인구가 대부분 KR이라 국가 보드≈세계 보드. 국가 코드는 P1-3 텔레메트리 헤더로 관측만 하고 인구 ≥1,000에서 스위치로 켠다.
- UX-05 색각·고대비 팔레트 (2.5일): impact 4·4·4. P1-6이 모든 플레이어의 가시·크러스트 대비를 먼저 고친다; 형태 코딩(스위치 ▲/■, 가시 빗금)은 P3 이후 접근성 백로그.
- UX-08 부팅 시간·폰트 전략 (1.5일), UX-09 fps 상한 (1일), UX-10 패드 리매핑 (2일), UX-13 스토어 스크린샷·트레일러 파이프라인 (2일): 모두 impact ≤4, 재플레이와 무관한 폴리시. UX-10 글리프는 P1-5에, og:image는 P3-4에, fps 진단 줄은 P3-13에 흡수. 나머지는 PWA 래퍼(TWA/Capacitor) 진입 여부를 오너가 결정한 뒤.
- analytics-events, cold-start-par-echo, zone-medals-skin-unlocks, result-share-card, daily-streak(GF-07 절), Replay v2(GF-01 절), UX-11 공유 절, UX-12 대부분: 중복으로 각각 P1-3, P2-1, P3-6, P3-4, P2-3, P1-1, P3-4, P3-7에 통합(별도 항목 없음).
- 심사 누락 중 미채택: 풀 타워 any% 모드(파 합계 670s > MAX_TICKS 600s라 단일 리플레이 제출 불가, 클라이언트 체인 설계가 필요해 백로그), 끝없는 등반 검증 보드(임의 시드 간 높이 비교의 공정성 문제, 주간 챌린지와 함께 재검토), 스토리 보드 노데스/전 파편 카테고리(P3-6 메달로 개인 표현은 해결, 보드 정렬 키 추가는 인구 후).

## 지표

- [획득·첫 60초] boot→zone_start 전환율 ≥85%, zone_start까지 중앙값 ≤8초; t1 zone_start 후 60초 내 quit 비율 ≤15% (P1-3 이벤트, 세션 id만·player id 없음)
- [실패 루프] death→respawn 체감 시간 p50 ≤0.7s(클라이언트 측정 이벤트 메타); 세션 내 death 후 retry 비율 ≥80%; 존별 deaths/clear와 사망 좌표 히트맵(tx,ty)으로 P2-8 체크포인트 배치·튠업 근거
- [첫 세션 완주] 첫 세션 t1 클리어율 ≥70%, t3 3세션 내 클리어 ≥60%; 스토리 완주율(v3 clear / t1 start) 추적 — GF-05·정점 콘텐츠 게이트
- [리텐션, 익명] D1 ≥35%·D7 ≥15%: boot 이벤트의 daysSinceFirstSeen 버킷(0/1/2-6/7+)과 daysPlayedBucket을 로컬 Progress에서 파생해 전송, 서버는 집계만(계정·id 없음)
- [데일리 루프] 데일리 플레이어의 다음날 daily_start ≥30%; 2주 후 스트릭≥3 비율 ≥15%; 데일리 클리어율 40~70% 유지·상위 10위 기록 표준편차 증가(P2-9 스킬 천장 확인)
- [소셜] share_click/result_shown ≥8%, race_link_open/share_click ≥30%(2주 창); 관전 시작 수/리더보드 조회 수; 라이벌 메아리 있는 결과의 retry 클릭률 ≥ +20% 대비군
- [마스터리·재플레이] 스토리 완주자의 클리어 존 재시작 ≥35% of zone_start; 메달 획득 분포; 게임오버 후 retry ≥55%('같은 탑 다시' 비율 별도)
- [신뢰·기술] submit_reject 비율 uaFamily별 <2%(iOS 결정론 감시), selftest_result pass 100%, duplicate 거절 건수(도용 시도 관측); js_error <5/1,000세션; fps_sample p95 tier별 분포·low 티어 첫 5초 p95; ALB p95 <300ms·5xx <0.5%(CloudWatch 알람)
- [보드 건강] 보드 이름 '클로드' 정확 일치 비율 <5%; 존별 보드 total ≥1(시딩) → 실플레이어 항목 비율; 데일리 참가자 수 일별
- [측정 원칙] 모든 지표는 P1-3의 POST /api/events 구조화 로그 + CloudWatch Logs Insights(tools/stats.mjs)에서 산출, IP·이름·player id 미수집을 테스트로 고정; Phase 1은 사전 기준선이 없으므로 P2-1 이후 배포 빌드(build 필드) 코호트 비교로 효과 판정
