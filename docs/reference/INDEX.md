# Implementation reference index

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

These guides map current behavior to its source. Start with
[architecture](../architecture.md) for the complete flow.

| Reference | Scope | Main source |
|---|---|---|
| [Game and content](game.md) | Browser composition, deterministic simulation, saves, levels and replay corpora | `src/client/`, `src/sim/`, `levels/` |
| [Server and API](server.md) | Runtime configuration, routes, replay verification and storage | `src/server/`, `src/shared/protocol.ts` |
| [Infrastructure](infrastructure.md) | Imported network, service, edge, data and operations | `infra/`, `Dockerfile`, `cdk.json` |

Build and test commands are in [onboarding](../onboarding.md), operational
procedures in the [documentation index](../README.md), and browser-specific
checks in [the QA guide](../../tools/qa/README.md).

<a id="korean"></a>
## 한국어

현재 동작과 소스 위치를 연결하는 안내입니다. 전체 흐름은
[아키텍처](../architecture.md)에서 먼저 확인하세요.

| 참조 | 범위 | 주요 소스 |
|---|---|---|
| [게임과 콘텐츠](game.md) | 브라우저 구성, 결정론적 시뮬레이션, 저장, 레벨과 리플레이 코퍼스 | `src/client/`, `src/sim/`, `levels/` |
| [서버와 API](server.md) | 런타임 설정, 라우트, 리플레이 검증과 저장소 | `src/server/`, `src/shared/protocol.ts` |
| [인프라](infrastructure.md) | 기존 네트워크, 서비스, 엣지, 데이터와 운영 | `infra/`, `Dockerfile`, `cdk.json` |

빌드·검사 명령은 [온보딩](../onboarding.md), 운영 절차는
[문서 색인](../README.md), 브라우저별 검사는
[QA 안내](../../tools/qa/README.md)에 있습니다.
