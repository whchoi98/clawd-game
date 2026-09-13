# ADR 0001: Share the simulation for replay validation

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Status and context

Documented from the existing implementation on 2026-09-13. This records the
decision in the [2026-09-06 design](../superpowers/specs/2026-09-06-clawd-echo-tower-design.md),
not a new architecture approval.

The game needs shared leaderboards whose results the server can verify and ghost
runs that reproduce another player's movement. A client-reported score alone does
not supply the input needed to replay a run.

### Decision

Use one DOM- and Node-independent TypeScript simulation in `src/sim/`. The browser
records one input-mask byte for each 120 Hz tick. The server decodes the log,
replays it with the same level and seed, and compares the recomputed summary with
the claim. The same verified log drives ghost playback.

Keep presentation, browser storage and networking outside simulation state.
Version replay-affecting behavior with `SIM_VERSION`, generator output with
`GEN_VERSION`, and shipped zone geometry with `rev`.

### Consequences

- Simulation math, random generation and tick semantics must remain deterministic
  across JavaScript engines; golden replay and digest checks enforce this.
- Physics and content changes may require replay corpus regeneration and new
  board keys. Existing clients cannot submit against an incompatible simulation.
- The server pays the CPU cost of replaying inputs. The current worker pool,
  admission bounds and rate limits constrain that work.
- Browser rendering and audio can evolve independently while they preserve the
  simulation and input contract.

### Evidence and related documents

See [types.ts](../../src/sim/types.ts), [replay.ts](../../src/sim/replay.ts),
[run validation](../../src/server/runs.ts), [verification pool](../../src/server/verifyPool.ts)
and [browser selftest](../../src/client/selftest.ts). The
[architecture](../architecture.md) and [game reference](../reference/game.md)
describe the current implementation.

<a id="korean"></a>
## 한국어

### 상태와 배경

2026-09-13에 기존 구현을 바탕으로 문서화했습니다.
[2026-09-06 설계](../superpowers/specs/2026-09-06-clawd-echo-tower-design.md)의
결정을 기록한 것이며, 새로운 아키텍처 승인을 뜻하지 않습니다.

게임에는 서버가 결과를 검증하는 공유 리더보드와 다른 플레이어의 움직임을
재현하는 고스트가 필요합니다. 클라이언트가 점수만 보고하면 기록을 재생할
입력이 없습니다.

### 결정

`src/sim/`의 DOM·Node 비의존 TypeScript 시뮬레이션을 공유합니다. 브라우저는
120 Hz의 매 틱에 입력 마스크 1바이트를 기록합니다. 서버는 로그를 디코딩한 뒤
같은 레벨·시드로 재생하고, 다시 계산한 요약을 주장과 비교합니다.
같은 검증 로그로 고스트를 재생합니다.

화면 표현·브라우저 저장·네트워크는 시뮬레이션 상태 밖에 둡니다.
리플레이 결과가 바뀌는 동작은 `SIM_VERSION`, 생성기 출력은 `GEN_VERSION`,
배포된 구역 지형은 `rev`로 버전을 관리합니다.

### 결과

- 시뮬레이션 수학·난수·틱 의미는 JavaScript 엔진 사이에서 결정론을 유지해야 하며,
  골든 리플레이와 다이제스트 검사로 확인합니다.
- 물리·콘텐츠 변경에는 리플레이 코퍼스 재생성과 새 보드 키가 필요할 수 있습니다.
  기존 클라이언트는 호환되지 않는 시뮬레이션에 기록을 제출할 수 없습니다.
- 서버는 입력 재생의 CPU 비용을 부담합니다. 현재 워커 풀·접수량 제한·요청 속도
  제한이 이 작업량을 제어합니다.
- 브라우저 렌더링과 오디오는 시뮬레이션·입력 계약을 유지하면서 독립적으로
  변경할 수 있습니다.

### 근거와 관련 문서

[types.ts](../../src/sim/types.ts), [replay.ts](../../src/sim/replay.ts),
[기록 검증](../../src/server/runs.ts), [검증 풀](../../src/server/verifyPool.ts),
[브라우저 자가진단](../../src/client/selftest.ts)을 참고하세요.
[아키텍처](../architecture.md)와 [게임 참조](../reference/game.md)에 현재 구현을
설명했습니다.
