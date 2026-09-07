# Changelog

이 프로젝트의 눈에 띄는 변경을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/),
버전은 [Semantic Versioning](https://semver.org/lang/ko/)을 따른다.
`npm run release`(`tools/release.mjs`)가 릴리스 시점에 `[Unreleased]` 절을 `[x.y.z] - 날짜` 절로 바꾸고 git 태그 `vx.y.z`를 만든다.
`[Unreleased]`가 비어 있으면 릴리스가 거절된다 — 배포 전에 여기에 적는다.

## [Unreleased]

### Added (Phase 5 A)
- P5-3 배경 강화(`src/client/render/{sky,tiles,renderer,stage}.ts`, 렌더 전용 — sim·리플레이 무관): 스카이에 패럴랙스 층 2개를 더했다 — **원경 구조물 실루엣**(조수 웅덩이 등대(회전 광선)·난파선·야자, 폭풍 첨탑 창불 켜진 첨탑(번개 때 밝아짐), 공허의 초 해파리 갓·산호 아치, 정점 눈 봉우리·부유 사당)과 **중경 동물 무리**(갈매기/박쥐/빛벌레/눈바다제비 14마리 V자 편대, 화면 상단 42 % 밴드 안에서만). 정점 **오로라 리본** 3줄(fbm 흐름, `accent`↔`skyLight`, 느린 드리프트), 눈 날씨 `'snow'`(느린 낙하·바람 흔들림, 고품질 90개), 세로 구역 **구름 갑판**(`cloudDeck`: 높이 55 % 지점의 구름층을 뚫고 오르면 별이 짙어지고 발밑이 구름 바다로, `deckFactor` 단조), 가로 구역 **시간대 드리프트**(진행도에 따라 하늘 그라디언트를 최대 0.15 보간, 캐시 48단계). `tiles.ts` 바이옴 **면 장식 패스**(노출면만, 타일 좌표 결정론 `tileDecor`, 종류별 Path2D 1회 채우기 — 지형 Path2D fill 상한 6→9): 조수 웅덩이 따개비·이끼, 폭풍 첨탑 발광 룬, 공허의 초 결정, 정점 얼음 광택·눈 모자; 정점 가시에도 민트 림(`SPIKE_RIM_BIOMES`), 정점 선반 소나무 소품. 품질 게이트: `low`는 새 층 전부 끄고(`Sky.counters` 스파이 0) `balanced`는 무리 절반. **정점 팔레트 확정**(`BIOMES.summit` 값만: crust `#5FA3D6`·crustHi `#D8F4FF`·fog `#4F86A8` — 가시 윤곽 대비 4.5:1↑, 상승기류 밝기 차 ≥25/255, 비콘 accent와 하늘·지형 색 거리 >48). `tools/qa/readability.ts`에 `backdrop:t1/s1/v1` 단계(스카이만 다시 그려 플레이필드 밴드의 어느 픽셀 열 평균도 crust 루마를 넘지 않음)와 `tier4-updraft/spike/beacon` 단계(임시로 기존 구역을 가리키는 `SUMMIT_*` 상수, P5-1 병합 후 m1/m3로 전환) 추가. 테스트: `sky.test.ts`(층·게이트·눈·갑판·시간대·팔레트 판독성 수식) · `tiles.test.ts`(장식 결정론·면 규칙) · `render.test.ts`(4바이옴 setLevel+draw, 게이트 스파이, 지형 fill 상한, 정점 림).

## [0.3.0] - 2026-09-07

배포: https://clawd-game.whchoi.net/ (CloudFront E38DW91AO2DWTB, ECS 롤아웃 완료 242 s, 라이브 QA 통과 — 배포 점검 13/13, 스모크 18/18(12구역 캡처·자가진단), 모바일 46/46, 데일리 기록 제출 E2E, 알람 11/11 OK). SIM_VERSION 3으로 모든 스토리 보드가 `s3r1`(새 세로형 존은 `s3r0`)로 새로 열리고, 이전 클라이언트는 `sim-version` 거절 → 업데이트 바를 받는다. Fargate 태스크는 512 CPU / 1024 MiB로 커졌다.

### Added (Phase 4 B)
- P2-10 층마다 세로형 존 1개: `t4` 소금 굴뚝(SALT CHIMNEY, par 90 — 벽에 붙은 4칸 월점프 통로 3개·용수철·일방 휴식 발판, 선반마다 물웅덩이 안전망), `s4` 천둥 승강기(THUNDER LIFT, par 110 — 4행마다 바위 착지가 있는 무너지는 계단, 세로 승강 발판 `M` 2개, 토글 2개로 번갈아 켜는 `&`/`%` 스위치 블록 계단, 포탑·톱날), `v4` 별빛 우물(STARLIGHT WELL, par 120 — 상승기류 3단, 벽면 가시 옆 크리스탈 4개(중간에 휴식 발판)로 정점 선반에 오른 뒤 우물을 가로지르는 회랑 바닥으로 내려와 다시 정상 데크로 오르는 크리스탈 체인 8개 — 회랑이 벽까지 닿아 체인 외의 길이 없다). 모두 44×66~72 타워(데일리 타워처럼 양쪽 2칸 벽·4행 바닥, `Room.tower()`), 체크포인트 6~8개, 파편 9~12개. 각 층의 4번째 구역으로 등록(`ORDER` t1 t2 t3 t4 s1 … v4, `CHAPTERS` 4개씩; 해금 규칙 N → N+1·N+2와 층 경계 규칙은 순서 기반이라 변경 없음). DSL: `Room.tower()`, `shaft(..., { floorDepth })`, `ZONE_SHAPES`/`zoneShape`/`zoneSizeProblem`(가로 60~120×16~30 또는 세로 36~48×60~100), `climbOrder`와 세로 존의 체크포인트 간격 규칙(등반 순서 맨해튼 거리 ≤ 32). 카메라는 세로 존(rows > cols)에서 지면 접촉 시 위쪽 리드 +18(`CAM_VERTICAL_LEAD`, 공중에서는 유지 — 흔들림 없음). 구역 선택 카드 4열(`.tier__cards`). 골든 리플레이 빠른·페이스 코퍼스 3개씩(페이스 103~104 %), 초보 봇 히트맵 3개(오른쪽 홀드 정책은 탑을 오르지 못해 사망 0·클리어 0으로 기록), 코퍼스 다이제스트 14개로 갱신, `qa:smoke`가 12구역을 캡처.
- P3-6 구역 메달·랭크·최고 콤보·스킨 해금·카드 세계 순위(`src/client/unlocks.ts`): 스토리 클리어마다 무사 통과(사망 0)·목표 시간 안·파편 전부·유물 회수 메달을 `LevelRecord.medals`에 합집합으로 기록하고(한 번 얻은 메달은 잃지 않는다), 새로 얻은 메달은 결과 화면 메달 단계에서 `is-new`로 팝하며 unlock 사운드가 난다. 최고 등급 문자·최고 콤보(`stats.bestCombo`)·제출된 베스트의 세계 순위를 기록 확장 필드로 저장(`save.ts bestRankOf`/`worldRankOf`, 이전 코드 스냅샷·병합 포함). 선택 화면 카드에 등급 문자·메달 4칸·'세계 N위' 배지, 헤더에 '별 N/36 · 메달 N/48'(분모는 LEVELS × 3 · × 4). 스킨 해금: 아마조니(`azure`) 별 6개·엠버 2층 진입·보이드 첫 S, `Progress.unlockedSkins` 영속, 설정에서 잠긴 스킨은 회색 + 해금 힌트(`aria-disabled`), 이미 선택된 스킨은 그랜드파더링. 콤보 8+ HUD 칩 `is-hot`, 결과 화면 '최고 콤보' 행.
- P3-12 클라이언트 배선: `GET /api/leaderboard`에 `playerId`를 보내지 않고(엣지 캐시 공유) 개인 행은 `Api.me` → `GET /api/me`(`rankCapped` → '1000위 밖')에서 가져와 결과 화면·데일리(오늘/어제 내 순위)·라이벌 선택·카드 세계 순위(선택 화면 진입 시 top 페이지 캐시 → 없으면 `/api/me`, 존당 5분 스로틀)에 붙인다(`withPersonalRow`). 즉시 순위는 `POST /api/runs` 응답에서 온다. `SubmitQueue`는 `503 { error: 'busy' }`·429의 `Retry-After`(헤더 → `detail.retryAfter`, 기본 3초·최대 30초·반복 시 2배)로 재시도 타이머를 걸고 결과 줄은 '서버가 붐빈다 · 잠시 후 자동으로 다시 보낸다'; 부팅·online 플러시는 그대로. HUD 하트(`#hud-hearts`)는 보조 모드에서만 보인다(SIM v3에서 hp는 보조 모드 밖에서 변하지 않는다).

### Added (Phase 4 A)
- P3-12 스케일 절벽 제거: 리플레이 검증을 `worker_threads` 워커 1개 + 세마포어(동시 4 · 대기 16)로 옮기고 초과 시 `503 { error: 'busy' }` + `Retry-After: 3`(`src/server/verifyPool.ts`), `POST /api/runs` IP 예산(12/분)을 DynamoDB `RL#<ip>#<minute>` 카운터(TTL 120 s)로 플릿 공유, `GET /api/leaderboard`는 공개 top-N만 + `Cache-Control: public, s-maxage=5, stale-while-revalidate=30`과 CloudFront `/api/leaderboard*` 전용 캐시 behaviour(최대 60 s), 새 `GET /api/me?mode&board&playerId`(no-store, `rankCapped` 1,000), `BOARD#<mode>#<board>` 총원 카운터(`saveBest`가 유지, 없으면 COUNT 폴백), Fargate 태스크 512 CPU / 1024 MiB · 상한 10(`cdk.json` `taskCpu` · `taskMemory` · `maxTasks`) + ALB p95 > 0.8 s 스텝 스케일링(+2), 부하 스크립트 `tools/load/submit.mjs`, 런북 `docs/runbooks/scale.md`.
- P3-9 오디오 연출 패스·캐릭터 주스·세레머니: 바이옴 조성별 클리어 스팅어 3종(트랙 키로 선택), 층 돌파 팡파르·엔딩 화음·별/메달 UI 사운드(`AudioEngine.stinger`), 체크포인트 순번별 차임 상승, 5음계 콤보 사다리(8+에서 5도 시머), hp 무관 피격음, 엔딩 트랙 `ending`(타이틀 변주); 착지 먼지 임팩트 스케일·스킨 색 대시 잔상·벽 슬라이드 스파크·골 컨페티·리스폰 팝·골 6타일 내 시선 유도(`clawd.ts setLookTarget`); 결과 화면 단계 리빌(등급 → 별 → 메달 행 → 보드, `ui/ceremony.ts Timeline`, reduced-motion·캡처 하네스는 즉시), 층 마지막 존 첫 클리어의 `#scr-tier` 비스타 카드(3초·아무 키 스킵, `Progress.tiersBroken`), 탑 완주 첫 회의 `#scr-ending`(절차적 밤하늘·정상의 클로드·3줄 서사·합계·제출 줄·'다시 오르기', `Progress.endingSeen`), 엔딩 후 타이틀 한 줄 서사. 이전 코드 스냅샷·병합이 두 플래그를 싣고, 진행 기록 삭제가 둘을 지운다.
- `tools/novice.ts` — 초보 봇 사망 히트맵: 존당 300 에피소드의 단순 반응 정책(오른쪽 홀드·지연 점프·잊는 대시·90초/25사망 포기)을 실제 Sim에 돌려 `levels/heatmap/<zone>.json`(사망 칸·원인·체크포인트 도달률·클리어율·hot spot)과 ASCII 오버레이를 만든다. `--levels`로 이전 지형과 전후 비교, `--guide`로 길잡이 메아리 녹화. 텔레메트리 2주치를 대신하는 합성 대체물.

### Changed (P2-8 — 9존 튠업, SIM_VERSION 3)
- `SIM_VERSION = 3` — **위험물 즉사**: 보통 모드에서 가시·톱날·볼트·적·스위치 압착 접촉은 같은 틱의 사망이다(`hurt` 이벤트도 hp 변화도 없고, 사망 원인 문자열 `spike`/`saw`/`bolt`/`foe`/`switch`는 그대로). 하트 3개는 어시스트 모드만(`ASSIST.maxHp`, 기존 피격·무적 동작 유지). 체크포인트는 활성화 시점의 스위치 극성을 기억해 리스폰이 극성을 `A`로 되돌리지 않는다(토글 뒤의 체크포인트에서 죽으면 관문 앞에 갇히던 s2 결함 수정). 모든 스토리 보드가 `s3r1`로 새로 열린다.
- **9존 튠업(모두 rev 1)** — 체크포인트를 파 20초당 1개 이상, 이웃한 `P`/`C`/`G`가 수평 32칸 이내가 되도록 초보 봇 히트맵의 사망 밀집 지점 바로 앞에 배치(t1 1→3 · t2 2→4 · t3 1→4 · s1 2→5 · s2 1→4 · s3 1→6 · v1 2→5 · v2 1→5 · v3 2→7). 파편을 존당 8~12개로 줄여(t1 20→11, 나머지 22~30→9~11) 대시·월점프·2단 점프가 필요한 옆길로 옮겼다. t1의 두 치명 구덩이는 5칸(7·6칸에서), s2의 첫 관문은 지붕으로 봉인해 벽차기 우회를 막았고 복도 입구의 호퍼는 워커로 바꿨으며(호퍼가 체크포인트 77을 지키고 서서 초보 봇과 페이스 솔버를 모두 죽였다), v3 선반의 스파이커는 통로 출구에서 떨어졌다. DSL 검증기에 `zoneRules`/`validateZone`(체크포인트 밀도·간격, 파편 8~12) 추가. 빠른·페이스 두 코퍼스와 청크 골든 14개를 v3에서 재녹화하고 `GOAL_ECHOES`·코퍼스 다이제스트를 갱신했다.

## [0.2.0] - 2026-09-06

배포: https://clawd-game.whchoi.net/ (CloudFront E38DW91AO2DWTB, ECS 롤아웃 완료, 라이브 QA 통과 — 배포 점검 13/13, 스모크 15/15, 모바일 40/40, 기록 제출 E2E).

### Added (Phase 3 C)
- P3-4 절차적 결과 공유 카드(1200×630 캔버스 · Web Share 파일/링크 · 클립보드 폴백, `src/client/share/card.ts`), `og:`/`twitter:` 메타와 `public/og/og.png`, 매니페스트 `id`/`description`/`categories`/`shortcuts`(`?go=daily|endless`)/`screenshots`, 스토리 클리어 결과 화면의 설치 카드(3회 거절 시 숨김, `Progress.installCardDismissed`), `tools/icons.mjs --social`.

### Added (Phase 3 B)
- P3-2 크로스 엔진 결정론 자가진단(`?shot=selftest`, `tools/qa/selftest.ts`, 코퍼스 다이제스트 고정값) · P3-10 GitHub Actions CI.
- P3-7 터치 레이아웃 편집기(크기·투명도·오프셋·플로팅 스틱), 8방향 대시 조준, 게임패드 자동 숨김, 44px/11px 감사, 음소거 칩.
- P3-3 친구 메아리 경주 링크(`?race=<runId>` 진입·결과 화면 공유).

### Added (Phase 3 A)
- P3-1 리플레이 해시 중복 차단, 휴리스틱 기록, `VerifyMs` 지표, 관리자 CLI, 금칙어 필터, 고스트 속도 제한.
- P3-5 진행도 이전 코드(서버 API + 설정 UI), `storage.persist` 요청.
- P3-8 햅틱(Vibration API + 게임패드 럼블), 설정 '진동'.
- P3-11 알람·대시보드·ALB 액세스 로그·테이블 RETAIN/삭제 보호/백업·`TAG_SECRET`·엣지 s-maxage·시크릿 런북.
- P3-13 적응 화질 v2(p95·주사율 추정·히스테리시스·티어 영속화).

### Added (Phase 2 C)
- P2-4 라이벌 메아리·체크포인트 스플릿·사망 마커·구간 PB·라이벌 대비 결과 행, 설정 '세계 메아리 = 라이벌/1위'.
- P2-9 데일리 저작 청크 14개(`levels/chunks/`), 생성기 삽입과 격자 계약 검사, 청크 골든 리플레이, `GEN_VERSION` 2.

### Added
- `SIM_VERSION = 2`, `GEN_VERSION = 1`: 리플레이(`Replay.v`)와 제출(`RunSubmit.sim` / `gen`)이 sim 버전을 싣는다. 서버는 불일치를 마스크 디코딩 전에 `422 sim-version`으로 거절하고, `/api/health`(`simVersion`, `genVersion`)와 `/api/daily`(`sim`, `gen`)가 검증 버전을 알린다.
- `POST /api/events`: 익명 텔레메트리(EventBatch ≤ 4 KB, ≤ 20건, IP당 30/분). 이벤트당 pino 한 줄(`evt`, `at`, `s`, `build`, `sim`, …), `js_error` / `submit_result` / `fps_sample`은 CloudWatch EMF 메트릭 줄을 추가로 남긴다. IP·플레이어 id·이름은 기록하지 않는다.
- `IN.RETRY`(64): 플레이 중 R 탭으로 마지막 체크포인트에서 즉시 재도전(사망 1회로 집계, 마스크 로그에 포함되어 리플레이가 재현한다).
- `tools/release.mjs`(`npm run release`): typecheck → levels --check → vitest → build → cdk deploy → postdeploy:check → CloudFront 무효화(Completed까지 대기) → `/assets/*` 20회 200 확인 → `npm version` + CHANGELOG + git 태그. `--dry-run`, `--no-deploy`, `--no-tag`.
- `tools/stats.mjs`(`npm run stats`): 이벤트 로그 NDJSON에서 boot → zone_start → clear 퍼널, D1 프록시(`daysSinceFirstSeen` 버킷 1 비율), 존별 사망/클리어, 사망 좌표 ASCII 히트맵. `--logs-insights`로 같은 수치를 내는 Logs Insights 쿼리 출력.
- `docs/runbooks/rollback.md`: 이전 태그 `cdk deploy` 롤백, ECS 태스크 정의 리비전 롤백, 버전 보드 정리 절차.
- `tools/postdeploy.mjs`: `/api/health.simVersion` / `genVersion`이 이 트리의 `src/sim/types.ts`와 같은지, `/api/daily`가 `gen` / `sim`을 싣는지 검사.
- 페이스 골든 코퍼스 `levels/solutions/par/<zone>.json`(`npm run solve:par`, `tools/solve.ts --pace`): 9개 존 모두 사망 0·파의 98~103 %로 사람처럼 클리어(대시는 지형이 요구하는 곳에만 0~7회, 안전한 지점에서 멈춤, 파편 수집). `GOAL_ECHOES`('목표' 메아리·`개발자` 시딩)는 이 코퍼스에서 만들고, 빠른 코퍼스(`levels/solutions/`)는 회귀망으로만 남는다(없는 존만 폴백 + 경고). 테스트: 페이스 비율 창·대시 감소·멈춤 하한, 시딩 점수 ≥ 0.9 × par.

### Changed
- 죽음 → 조작 복귀 0.6초: `DYING_T` 1.05 → 0.45, 리스폰 후 인트로 `RESPAWN_INTRO_T` 0.15(첫 스폰 `INTRO_T` 0.45 유지). 서버의 마스크 예산(`maxMasksFor`)은 이 sim 상수에서 파생된다.
- 스토리 리더보드 파티션 키가 `LB#story#<levelId>#s<SIM_VERSION>r<rev>`(플레이어 베스트 sk도 동일 접미)로 바뀌어 sim 범프마다 새 보드가 열린다. 데일리 보드는 `LB#daily#<date>`를 유지하고 `gen` 불일치 제출을 거절한다.

## [0.1.0] - 2026-09-06

### Added
- 최초 배포: 9개 스토리 존, 데일리 타워, 검증 리플레이 리더보드와 메아리(고스트), PWA. CloudFront → ALB → ECS Fargate(Graviton) → DynamoDB 단일 테이블.
