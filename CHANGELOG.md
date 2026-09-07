# Changelog

이 프로젝트의 눈에 띄는 변경을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/),
버전은 [Semantic Versioning](https://semver.org/lang/ko/)을 따른다.
`npm run release`(`tools/release.mjs`)가 릴리스 시점에 `[Unreleased]` 절을 `[x.y.z] - 날짜` 절로 바꾸고 git 태그 `vx.y.z`를 만든다.
`[Unreleased]`가 비어 있으면 릴리스가 거절된다 — 배포 전에 여기에 적는다.

## [Unreleased]

### Changed (P2-8 — 9존 튠업, SIM_VERSION 3)
- `SIM_VERSION = 3` — **위험물 즉사**: 보통 모드에서 가시·톱날·볼트·적·스위치 압착 접촉은 같은 틱의 사망이다(`hurt` 이벤트도 hp 변화도 없고, 사망 원인 문자열 `spike`/`saw`/`bolt`/`foe`/`switch`는 그대로). 하트 3개는 어시스트 모드만(`ASSIST.maxHp`, 기존 피격·무적 동작 유지). 체크포인트는 활성화 시점의 스위치 극성을 기억해 리스폰이 극성을 `A`로 되돌리지 않는다(토글 뒤의 체크포인트에서 죽으면 관문 앞에 갇히던 s2 결함 수정). 모든 스토리 보드가 `s3r1`로 새로 열린다.
- **9존 튠업(모두 rev 1)** — 체크포인트를 파 20초당 1개 이상, 이웃한 `P`/`C`/`G`가 수평 32칸 이내가 되도록 초보 봇 히트맵의 사망 밀집 지점 바로 앞에 배치(t1 1→3 · t2 2→4 · t3 1→4 · s1 2→5 · s2 1→4 · s3 1→6 · v1 2→5 · v2 1→5 · v3 2→7). 파편을 존당 8~12개로 줄여(t1 20→11, 나머지 22~30→9~11) 대시·월점프·2단 점프가 필요한 옆길로 옮겼다. t1의 두 치명 구덩이는 5칸(7·6칸에서), s2의 첫 관문은 지붕으로 봉인해 벽차기 우회를 막았고 복도 입구의 호퍼는 워커로 바꿨으며(호퍼가 체크포인트 77을 지키고 서서 초보 봇과 페이스 솔버를 모두 죽였다), v3 선반의 스파이커는 통로 출구에서 떨어졌다. DSL 검증기에 `zoneRules`/`validateZone`(체크포인트 밀도·간격, 파편 8~12) 추가. 빠른·페이스 두 코퍼스와 청크 골든 14개를 v3에서 재녹화하고 `GOAL_ECHOES`·코퍼스 다이제스트를 갱신했다.

### Added
- `tools/novice.ts` — 초보 봇 사망 히트맵: 존당 300 에피소드의 단순 반응 정책(오른쪽 홀드·지연 점프·잊는 대시·90초/25사망 포기)을 실제 Sim에 돌려 `levels/heatmap/<zone>.json`(사망 칸·원인·체크포인트 도달률·클리어율·hot spot)과 ASCII 오버레이를 만든다. `--levels`로 이전 지형과 전후 비교, `--guide`로 길잡이 메아리 녹화. 텔레메트리 2주치를 대신하는 합성 대체물.

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
