# Project initialization verification — 2026-09-13

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Scope

Initialize repository guidance and navigable documentation from the existing
v0.6.0 codebase, synchronize active setup/QA instructions, and prepare the first
push to `whchoi98/clawd-game`. Existing release entries and dated QA reports remain
historical evidence.

The work adds agent/contribution guidance, onboarding, architecture, three
implementation references, a documented existing simulation decision, and a release
runbook. `.editorconfig` uses the existing two-space style and is excluded from
both Docker context definitions. Local environment variants and session state
are covered by `.gitignore`.

### Findings resolved

- The shared server test fixture gave Fastify a fixed 2026-09-06 clock while
  `MemoryRepo` used the actual date. Its seven-day transfer snapshots therefore
  appeared expired after 2026-09-13 12:00 UTC. The default test repository now
  shares the injected app clock; existing expiry tests still advance time.
- A random transfer-code test assumed two HMAC keys could never produce the same
  single check character. It now uses a fixed body with different check characters
  under the two test keys.
- The existing image-input test caught `.editorconfig` entering the Docker asset.
  Both exclusions now include it.
- Setup/QA instructions now describe the actual first-play flow, sixteen zones,
  eighteen digests, explicit production builds, and current CI engines. Stack
  destruction correctly distinguishes retained DynamoDB from other deletion
  policies and the nonempty access-log bucket constraint.
- Existing operations guides now distinguish UTC seed rotation, transfer-code
  key effects, actual dynamic-reference resource updates, worker inactivity
  monitoring and same-owner replay resubmission.

### Checks performed

Host: Node.js `20.20.1`, npm `10.8.2`.

| Check | Result |
|---|---|
| `npm run typecheck` | Passed for application and infrastructure |
| `npm run levels -- --check` | All three generated simulation modules current |
| `npx tsx tools/hash-corpus.ts --check` | 18 digests current, sim 4 / gen 2 |
| `npm test -- --reporter=dot` | 1,726 passed; one opt-in audio test skipped |
| `npm run qa:audio` | That audio test passed in Chromium |
| `npm run build -- --prod` | Passed, v0.6.0, build `b7a69cd7` |
| `BASE_URL=http://127.0.0.1:18199 npm run qa:smoke -- --no-shots` | 6/6 steps passed, zero issues; offline and 18-digest Chromium selftest included |
| Credential-free CDK synth from [onboarding](../onboarding.md) | Passed with `--no-lookups --no-notices` |
| Project Init documentation audit | Passed structure and local-link checks |
| Bilingual command/diagram comparison | Matching command and Mermaid blocks in both languages |

The temporary smoke server used MemoryRepo and was stopped after the check.
Initial sandbox execution blocked CLI subprocess/IPC operations; those checks
were rerun with the required local process permissions. CDK emitted existing
deprecation warnings; synthetic infra fixtures also emit resource-ID warnings.

This pass did not run WebKit/Firefox journeys, the ARM64 Docker image build, or
live AWS checks. The [CI workflow](../../.github/workflows/ci.yml) declares those
browser/container checks; this report does not claim a GitHub Actions result.

<a id="korean"></a>
## 한국어

### 범위

기존 v0.6.0 코드를 기준으로 저장소 지침과 탐색 가능한 문서 구조를 만들고,
사용 중인 설치·QA 안내를 맞춘 뒤 `whchoi98/clawd-game`의 첫 푸시를 준비했습니다.
기존 릴리스 항목과 날짜가 있는 QA 보고서는 당시 근거로 보존합니다.

에이전트·기여 지침, 온보딩, 아키텍처, 구현 참조 세 개, 기존 시뮬레이션 결정을
기록한 ADR, 릴리스 런북을 추가했습니다. `.editorconfig`는 기존 공백 2칸 관례를
사용하며 Docker 컨텍스트 정의 두 곳에서 제외합니다. 로컬 환경 파일 변형과
세션 상태는 `.gitignore`에 반영했습니다.

### 해결한 항목

- 공통 서버 테스트 픽스처는 Fastify에 2026-09-06 고정 시계를 주면서
  `MemoryRepo`에는 실제 날짜를 사용했습니다. 그 결과 7일짜리 이전 스냅샷이
  2026-09-13 12:00 UTC 이후 만료로 처리됐습니다. 기본 테스트 저장소가 앱에 주입한
  시계를 공유하도록 수정했으며, 기존 만료 검사는 계속 시간을 진행시킵니다.
- 무작위 이전 코드 검사는 서로 다른 HMAC 키의 단일 검사 문자가 항상 다르다고
  가정했습니다. 두 테스트 키의 검사 문자가 다른 고정 본문을 사용하도록 했습니다.
- 기존 이미지 입력 검사가 Docker 에셋에 `.editorconfig`가 들어오는 것을 발견해
  제외 목록 두 곳에 반영했습니다.
- 설치·QA 안내를 실제 첫 실행 흐름, 16구역, 18개 다이제스트, 명시적 운영 빌드와
  현재 CI 엔진에 맞췄습니다. 스택 삭제 설명은 보존되는 DynamoDB와 나머지 삭제
  정책, 비어 있지 않은 접근 로그 버킷의 제약을 구분합니다.
- 기존 운영 가이드에서 UTC 시드 회전, 이전 코드 키의 영향, 동적 참조 리소스의
  실제 갱신, 워커 활동 감시와 같은 소유자의 리플레이 재제출을 구분했습니다.

### 실행한 검사

호스트: Node.js `20.20.1`, npm `10.8.2`.

| 검사 | 결과 |
|---|---|
| `npm run typecheck` | 앱·인프라 모두 통과 |
| `npm run levels -- --check` | 생성 시뮬레이션 모듈 세 개 최신 |
| `npx tsx tools/hash-corpus.ts --check` | 다이제스트 18개 최신, sim 4 / gen 2 |
| `npm test -- --reporter=dot` | 1,726개 통과, 선택 실행 오디오 1개 제외 |
| `npm run qa:audio` | 해당 오디오 1개 Chromium에서 통과 |
| `npm run build -- --prod` | v0.6.0, 빌드 `b7a69cd7` 성공 |
| `BASE_URL=http://127.0.0.1:18199 npm run qa:smoke -- --no-shots` | 6/6 통과, 이슈 0개, 오프라인·Chromium 다이제스트 18개 자가진단 포함 |
| [온보딩](../onboarding.md)의 자격 증명 없는 CDK 합성 | `--no-lookups --no-notices`로 통과 |
| Project Init 문서 감사 | 구조·로컬 링크 검사 통과 |
| 이중 언어 명령·다이어그램 비교 | 양쪽 언어의 명령·Mermaid 블록 일치 |

임시 스모크 서버는 MemoryRepo를 사용하고 검사 뒤 종료했습니다. 처음 샌드박스에서
CLI 하위 프로세스·IPC 작업이 차단되어 필요한 로컬 프로세스 권한으로 다시
검사했습니다. CDK의 기존 폐기 예정 API 경고와 합성 인프라 픽스처의 리소스 ID
경고는 출력됐습니다.

이번 점검에서는 WebKit·Firefox 흐름, ARM64 Docker 이미지 빌드, 라이브 AWS 검사를
실행하지 않았습니다. [CI 워크플로](../../.github/workflows/ci.yml)에 해당 브라우저·
컨테이너 검사가 선언되어 있으며, 이 보고서는 GitHub Actions 결과를 주장하지 않습니다.
