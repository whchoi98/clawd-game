# Changelog

이 프로젝트의 눈에 띄는 변경을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/),
버전은 [Semantic Versioning](https://semver.org/lang/ko/)을 따른다.
`npm run release`(`tools/release.mjs`)가 릴리스 시점에 `[Unreleased]` 절을 `[x.y.z] - 날짜` 절로 바꾸고 git 태그 `vx.y.z`를 만든다.
`[Unreleased]`가 비어 있으면 릴리스가 거절된다 — 배포 전에 여기에 적는다.

## [Unreleased]

### Added
- `SIM_VERSION = 2`, `GEN_VERSION = 1`: 리플레이(`Replay.v`)와 제출(`RunSubmit.sim` / `gen`)이 sim 버전을 싣는다. 서버는 불일치를 마스크 디코딩 전에 `422 sim-version`으로 거절하고, `/api/health`(`simVersion`, `genVersion`)와 `/api/daily`(`sim`, `gen`)가 검증 버전을 알린다.
- `POST /api/events`: 익명 텔레메트리(EventBatch ≤ 4 KB, ≤ 20건, IP당 30/분). 이벤트당 pino 한 줄(`evt`, `at`, `s`, `build`, `sim`, …), `js_error` / `submit_result` / `fps_sample`은 CloudWatch EMF 메트릭 줄을 추가로 남긴다. IP·플레이어 id·이름은 기록하지 않는다.
- `IN.RETRY`(64): 플레이 중 R 탭으로 마지막 체크포인트에서 즉시 재도전(사망 1회로 집계, 마스크 로그에 포함되어 리플레이가 재현한다).
- `tools/release.mjs`(`npm run release`): typecheck → levels --check → vitest → build → cdk deploy → postdeploy:check → CloudFront 무효화(Completed까지 대기) → `/assets/*` 20회 200 확인 → `npm version` + CHANGELOG + git 태그. `--dry-run`, `--no-deploy`, `--no-tag`.
- `tools/stats.mjs`(`npm run stats`): 이벤트 로그 NDJSON에서 boot → zone_start → clear 퍼널, D1 프록시(`daysSinceFirstSeen` 버킷 1 비율), 존별 사망/클리어, 사망 좌표 ASCII 히트맵. `--logs-insights`로 같은 수치를 내는 Logs Insights 쿼리 출력.
- `docs/runbooks/rollback.md`: 이전 태그 `cdk deploy` 롤백, ECS 태스크 정의 리비전 롤백, 버전 보드 정리 절차.
- `tools/postdeploy.mjs`: `/api/health.simVersion` / `genVersion`이 이 트리의 `src/sim/types.ts`와 같은지, `/api/daily`가 `gen` / `sim`을 싣는지 검사.

### Changed
- 죽음 → 조작 복귀 0.6초: `DYING_T` 1.05 → 0.45, 리스폰 후 인트로 `RESPAWN_INTRO_T` 0.15(첫 스폰 `INTRO_T` 0.45 유지). 서버의 마스크 예산(`maxMasksFor`)은 이 sim 상수에서 파생된다.
- 스토리 리더보드 파티션 키가 `LB#story#<levelId>#s<SIM_VERSION>r<rev>`(플레이어 베스트 sk도 동일 접미)로 바뀌어 sim 범프마다 새 보드가 열린다. 데일리 보드는 `LB#daily#<date>`를 유지하고 `gen` 불일치 제출을 거절한다.

## [0.1.0] - 2026-09-06

### Added
- 최초 배포: 9개 스토리 존, 데일리 타워, 검증 리플레이 리더보드와 메아리(고스트), PWA. CloudFront → ALB → ECS Fargate(Graviton) → DynamoDB 단일 테이블.
