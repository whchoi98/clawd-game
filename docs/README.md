# Documentation

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

Start with the [project README](../README.md) for gameplay and the
[onboarding guide](onboarding.md) for a local development session.

| Guide | Purpose |
|---|---|
| [Architecture](architecture.md) | Components, replay flow and deployment boundaries |
| [Implementation references](reference/INDEX.md) | Game, server and infrastructure code pointers |
| [Contributing](../CONTRIBUTING.md) | Checks, documentation and commit preparation |
| [Repository guidance](../AGENTS.md) | Commands and invariants for coding agents |
| [Shared simulation decision](decisions/0001-shared-replay-validation.md) | Why client and server replay the same input log |
| [Browser QA](../tools/qa/README.md) | Smoke, input journeys and cross-engine determinism |

### Operations

| Runbook | Use it for |
|---|---|
| [Release](runbooks/release.md) | Version preparation, deployment and post-deployment checks |
| [Rollback](runbooks/rollback.md) | Previous release or ECS task revision |
| [Scaling](runbooks/scale.md) | Replay capacity, task sizing and load checks |
| [Anticheat](runbooks/anticheat.md) | Investigating and moderating submitted records |
| [Secrets](runbooks/secrets.md) | Origin verification, daily seeds and player-tag keys |

### Design and evidence

[The original design](superpowers/specs/2026-09-06-clawd-echo-tower-design.md) and
[roadmap](superpowers/plans/2026-09-06-top-chart-roadmap.md) record initial intent.
Plans are historical context; use the code and implementation references for
current behavior.

The latest [v0.7.0 deployment record](quality/2026-09-19-release-0.7.0.md)
covers three starter characters, saved selection, native audio, live gameplay and
documentation sync.

The [v0.6.1 deployment record](quality/2026-09-19-release-0.6.1.md)
covers the cat character, native audio checks, live verification and documentation
sync, with deployment data and screenshots.

The dated [presentation report](quality/2026-09-13-premium-report.md),
[mastery report](quality/2026-09-13-mastery-report.md) and
[v0.6.0 deployment record](quality/2026-09-13-release-0.6.0.md) retain their
original verification scope. [CHANGELOG.md](../CHANGELOG.md) records releases and
unreleased changes. A historical passing result is not a test of the current tree.
The [Project Init verification](quality/2026-09-13-project-init.md) records the
documentation sync and test-fixture corrections made before the initial push.

<a id="korean"></a>
## 한국어

게임 소개는 [프로젝트 README](../README.md), 로컬 개발 시작은
[온보딩 가이드](onboarding.md)에서 확인하세요.

| 가이드 | 목적 |
|---|---|
| [아키텍처](architecture.md) | 구성 요소, 리플레이 흐름과 배포 경계 |
| [구현 참조](reference/INDEX.md) | 게임·서버·인프라 코드 위치 |
| [기여 안내](../CONTRIBUTING.md) | 검사, 문서와 커밋 준비 |
| [저장소 지침](../AGENTS.md) | 코딩 에이전트의 명령과 불변 조건 |
| [공유 시뮬레이션 결정](decisions/0001-shared-replay-validation.md) | 클라이언트와 서버가 같은 입력 로그를 재생하는 이유 |
| [브라우저 QA](../tools/qa/README.md) | 스모크, 실제 입력 흐름과 엔진 간 결정론 |

### 운영

| 런북 | 용도 |
|---|---|
| [릴리스](runbooks/release.md) | 버전 준비, 배포와 배포 후 점검 |
| [롤백](runbooks/rollback.md) | 이전 릴리스 또는 ECS 태스크 리비전 복구 |
| [확장](runbooks/scale.md) | 리플레이 처리량, 태스크 크기와 부하 점검 |
| [부정 기록 대응](runbooks/anticheat.md) | 제출 기록 조사와 관리 |
| [시크릿](runbooks/secrets.md) | 원본 검증, 데일리 시드와 플레이어 태그 키 |

### 설계와 검증 기록

[초기 설계](superpowers/specs/2026-09-06-clawd-echo-tower-design.md)와
[로드맵](superpowers/plans/2026-09-06-top-chart-roadmap.md)은 당시의 의도를 기록합니다.
계획은 과거 맥락이며, 현재 동작은 코드와 구현 참조를 기준으로 확인하세요.

최신 [v0.7.0 배포 기록](quality/2026-09-19-release-0.7.0.md)에는 기본 캐릭터 3종,
선택 저장, 실제 오디오·운영 플레이 검증과 문서 동기화 결과를 남겼습니다.

[v0.6.1 배포 기록](quality/2026-09-19-release-0.6.1.md)에는 고양이 캐릭터,
실제 오디오 검사, 운영 검증과 문서 동기화 결과를 데이터·화면과 함께 남겼습니다.

날짜가 있는 [화면 보고서](quality/2026-09-13-premium-report.md),
[도전 목표 보고서](quality/2026-09-13-mastery-report.md),
[v0.6.0 배포 기록](quality/2026-09-13-release-0.6.0.md)은 당시 검증 범위를 보존합니다.
[CHANGELOG.md](../CHANGELOG.md)는 릴리스와 미배포 변경을 기록합니다.
과거의 통과 결과가 현재 작업 트리의 검증을 대신하지는 않습니다.
[Project Init 검증](quality/2026-09-13-project-init.md)은 최초 푸시 전 문서 동기화와
테스트 픽스처 수정을 기록합니다.
