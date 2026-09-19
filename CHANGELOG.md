# Changelog

이 프로젝트의 눈에 띄는 변경을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/),
버전은 [Semantic Versioning](https://semver.org/lang/ko/)을 따른다.
`npm run release`(`tools/release.mjs`)가 릴리스 시점에 `[Unreleased]` 절을 `[x.y.z] - 날짜` 절로 바꾸고 git 태그 `vx.y.z`를 만든다.
`[Unreleased]`가 비어 있으면 릴리스가 거절된다 — 배포 전에 여기에 적는다.

## [Unreleased]

## [0.7.0] - 2026-09-19

배포: 클라이언트 빌드 `605cae6b`, ECS 태스크 리비전 12·2개 정상, CloudFormation `UPDATE_COMPLETE`. 오디오 포함 검사 1,741/1,741, 운영 점검 13/13, 스모크 23/23, 캐릭터 선택·재접속 등 실제 입력 흐름 42/42를 통과했다. [배포·검증 기록](docs/quality/2026-09-19-release-0.7.0.md)에 토끼·로봇의 실제 플레이와 문서 동기화 근거를 남겼다.

### Added
- 처음부터 고를 수 있는 토끼·로봇을 추가해 기본 캐릭터가 고양이·토끼·로봇 3종이 됐다. 긴 귀·둥근 꼬리·앞니와 사각 몸체·LED 눈·안테나로 형태를 구분하고, 각 형태를 초상·메아리·대시 잔상에도 적용했다. 기본 캐릭터는 해금 알림을 만들지 않으며 기존 고양이 모습 7종의 획득 조건과 저장 기록을 유지한다.

### Changed
- 설정의 캐릭터 선택을 줄바꿈 격자로 바꿔 총 10가지 모습과 안내 문구가 작은 화면에서도 잘리지 않게 했다. 메아리 이름표는 귀·안테나와 점프·스톰프의 늘어남을 고려해 몸체 위에 배치한다.
- 실제 입력 QA에 세 기본 캐릭터의 선택·재접속·렌더러 적용·진행도 보존 검사를 추가하고 캐릭터·아키텍처·QA 문서를 동기화했다.

## [0.6.1] - 2026-09-19

배포: 2026-09-19, 클라이언트 빌드 `bcef57a6`, ECS 태스크 정의 리비전 11·태스크 2개 정상, CloudFormation `UPDATE_COMPLETE`. 오디오 포함 1,727개 검사, 운영 점검 13/13, 브라우저 23/23·모바일 모사 54/54, 리플레이 제출·정리 7/7을 확인했다. [배포 검증·문서 동기화 기록](docs/quality/2026-09-19-release-0.6.1.md)에 근거를 남겼다.

### Added
- Codex 작업 지침 `AGENTS.md`, 기여·온보딩 안내, 아키텍처와 구현 참조, 문서 색인, 공유 시뮬레이션 ADR, 릴리스 런북을 추가했다.
- `.editorconfig`로 UTF-8·LF·공백 2칸 기본 편집 규칙을 명시하고 컨테이너 빌드 입력에서 제외했다.

### Changed
- 플레이어를 민트색 스카프를 두른 고양이 클로드로 교체했다. 뾰족한 귀·앞발·말린 꼬리, 여덟 스킨과 장식, 메아리·초상·대시 잔상, 파비콘·PWA 아이콘과 공유 미리보기에 반영했다. 귀 스프링·스카프·표정은 시각 상태만 사용하며 기존 조작·히트박스·스킨 ID·해금·저장·리플레이 버전은 유지한다. 캐릭터 외형 픽스처를 새 고양이 프레임으로 갱신하고, 초상과 엔딩이 발 기준점을 공유해 정상 위에 정확히 서도록 했다.
- 캐릭터 표현 경계와 초상 기준점을 아키텍처·구현 참조에 동기화하고, SVG 수정부터 앱 아이콘·공유 이미지 생성·재빌드까지의 절차와 실제 WebAudio 검사 방법을 QA 가이드에 정리했다.
- README의 설치·검사 명령과 스택 삭제 시 리소스 보존 설명을 현재 코드에 맞추고 새 문서로 연결했다.
- QA·운영 문서의 캐시·순위 조회, 시크릿 회전·UTC 리셋, 검증 워커 감시와 중복 리플레이 처리 설명을 실제 구현에 맞췄다.
- 로컬 환경 파일 변형과 세션 잠금·서버 PID 파일을 Git 제외 대상으로 정리했다.

### Fixed
- 서버 테스트의 앱·저장소 시계를 일치시켜 실제 날짜가 지나도 진행도 이전 픽스처가 만료되지 않게 했다. 체크 문자의 무작위 충돌로 간헐적으로 실패하던 테스트는 고정 입력으로 검증한다.

## [0.6.0] - 2026-09-13

배포: 2026-09-13 11:55 UTC, 클라이언트 빌드 `b7a69cd7`, ECS 태스크 정의 리비전 10·새 태스크 2개 healthy, CloudFormation `UPDATE_COMPLETE`. 운영 점검 13/13, 실제 사용자 흐름 12/12, 오프라인 스모크 6/6, 에셋 40/40 요청과 진행도 이전의 일회성 복원·데이터 삭제를 확인했다. 상세 기록: `docs/quality/2026-09-13-release-0.6.0.md`.

### Added
- 타이틀의 네 층짜리 절차적 탑, 정상 비콘과 메아리 궤적, 현재 진행을 표시하는 층별 여정.
- 구역 선택의 실제 지형 미리보기, 기술·파편·유물·체크포인트 안내, 다음 도전 표시. 잠긴 구역도 이름과 해금 조건을 읽을 수 있다.
- **길잡이 보기**: 구역 선택과 일시정지에서 검증된 16구역 공략을 재생한다. 0.5×·1×·2× 배속, 위치 이동, 체크포인트 이동, 현재 조작 표시를 제공한다. 관람 중인 재생은 진행도·제출·현재 도전과 분리되며 닫으면 원래 화면으로 돌아간다.
- 터치에서도 쓸 수 있는 일시정지 메뉴의 **체크포인트 재도전**. 기존 `IN.RETRY`를 기록하므로 서버 리플레이로 그대로 검증된다.
- **도전 수첩**: 16구역의 메달 획득 상태와 조건, 여덟 가지 모습의 해금 진행·착용. 타이틀·구역 선택·일시정지·결과에서 열며 기존 도전의 시간·위치·입력 로그와 돌아갈 초점을 보존한다.
- **이번 목표**: 구역별 자동 추천·자유 등반·메달 고정, 재접속과 탭 사이의 설정 유지, HUD의 실제 진행·달성 준비·실패 표시. 첫 클리어 전에는 목표를 강요하지 않으며, 체크포인트 재도전은 이번 시도의 사망·경과 시간을 초기화하지 않는다.
- **다음 목표로 재도전**: 결과 화면에서 아직 얻지 못한 메달로 바로 다시 시작한다. 기존 보조 모드의 로컬 메달 규칙을 유지하며, 기록 없는 경주는 메달 획득으로 표시하지 않는다.
- `npm run qa:premium`과 `npm run qa:webkit`: 실제 키보드·포인터·터치로 데스크톱과 휴대폰의 수첩·목표 저장·캠페인·재생·재도전·초점 이동을 각각 39단계로 검사한다. CI 웹 검사에 포함한다.

### Fixed
- 릴리스 버전을 빌드 전에 확정해 배포 화면과 버전 태그가 일치하도록 수정했다. 배포·캐시·에셋 검증을 모두 통과한 뒤에만 커밋과 태그를 남긴다.
- 오래 열린 탭이 새 진행도를 덮어쓰는 문제를 수정했다. 최고 기록과 리플레이를 함께 유지하고, 초기화·가져오기는 별도 저장 경계로 처리한다. 다른 탭의 설정을 병합하면 실제 오디오·화면 설정에도 반영한다.
- 기록을 POST 전에 대기열에 보관해 전송 중 새로고침해도 복구한다. 실시간 전송과 대기열 전송의 중복 실행을 막고, 응답 본문까지 타임아웃을 적용하며, 불완전한 성공 응답은 재시도할 수 있게 유지한다.
- 진행도 이전의 스냅샷 읽기에 실패했을 때 이전 코드가 소모되지 않도록 조건부 트랜잭션으로 처리한다.
- 음악·효과음 채널의 0% 설정이 잔향에도 적용된다.
- 키 재지정 중 패드 취소·설정 닫기·탭 이동·창 전환을 처리하고, 슬라이더에서 Escape로 설정을 닫을 수 있다. 덮인 화면은 초점 대상에서 제외하고 모달의 Tab 이동과 돌아갈 초점을 관리한다.
- 동작 줄이기 설정에서는 타이틀의 이동과 메아리 궤적을 정지한다.

물리·레벨 지형·SIM_VERSION 4·GEN_VERSION 2·리더보드 계약은 유지한다. 검증 결과는 `docs/quality/2026-09-13-premium-report.md`와 `docs/quality/2026-09-13-mastery-report.md`에 기록한다.

## [0.5.0] - 2026-09-07

배포: https://clawd-game.whchoi.net/ (CloudFront E38DW91AO2DWTB, 2026-09-07 20:51 UTC, cdk 263 s, ECS 롤아웃 COMPLETED) — 새 적 '거품'이 정점 3구역에 들어간 Phase 5 3차 파동. **SIM_VERSION 4**(GEN_VERSION 2 유지): 스토리 리더보드 16개가 `s4r*` 보드로 새로 시작하고(이전 보드의 기록은 보존되지만 새 보드에는 나타나지 않는다) 이미 열어 둔 탭은 업데이트 바로 새로고침해야 기록이 제출된다 — 데일리·끝없는 등반은 영향 없음(생성기 불변, 데일리 다이제스트 2개 동일). 컨테이너 QA(이미지 0.5.0-rc): 스모크 23/23(자가진단 18/18, `shot:m1/m3/m4` 콘솔 오류 0), 판독성 10/10, 격자 PASS, 모바일 54/54, m1·m4 실제 기록 제출 E2E 9/9(접수 200 · 재제출 200 무변화 · 다른 플레이어의 같은 리플레이 422 duplicate). 라이브 점검: 배포 후 점검 13/13, CloudFront 무효화 완료, 스모크 23/23(타이틀 배지 `v0.5.0 · 빌드 1ef0d644`), 모바일 54/54, m1 기록 제출 E2E 8/9(유일 실패 `leaderboard has the run`은 `/api/leaderboard`의 엣지 캐시 s-maxage 5 s 지연 — 권위 응답 `/api/me`는 통과, 테스트 데이터 4건 정리 완료), 알람 10 OK + 1 INSUFFICIENT_DATA(오토스케일링 p95 상한, 저트래픽). 테스트 1,476개(80 파일).

### Added (Phase 5 C)
- P5-5 **거품 적**(`b`, `src/sim/foes.ts` `Bubble` · `src/sim/player.ts` `bubbleBounce()` · `src/sim/sim.ts` 재생성 처리 · `levels/dsl.ts` · `levels/zones/{m1,m3,m4}.ts`) — 밟아서 없애는 적이 아니라 **밟아서 타는 발판**이다. **sim**: 12×12 히트박스가 홈에서 `dsin`으로 ±10유닛·1.6 s 주기로 오르내리고, 위에서 닿거나(`fromAbove`) 공중에서 `stomping`(DOWN 홀드)으로 닿으면 터져 `bubblePop` + `vy = PHYS.bubbleBounce`(−352 — 스톰프 바운스 −300보다 세고 용수철 −430보다 약하다) + 공중 점프·대시 리필을 주지만 **처치가 아니다**(`foeKilled`·`stats.foes`·콤보 변화 없음), 대시 관통은 발사 없이 팝만 한다. 옆·아랫면 접촉은 보통 모드 **즉사**(사망 원인 `bubble`)·어시스트 모드 피격이다. 터진 거품은 적 목록에 `dead`로 남아 `state`가 2.5 s → 0으로 줄고(`BUBBLE_RESPAWN_TICKS` 300) 홈에서 다시 부풀며(`bubbleBack`), 그 자리를 플레이어가 막고 있으면 `state = 1 / TICK_HZ`로 비켜날 때까지 기다린다; dead 동안 `y`는 홈에 고정되고, 스톰프 착지 충격파는 거품을 건드리지 않으며, 플레이어 리스폰은 터진 거품을 즉시 되돌린다. 팝 직후 누른 점프는 리필된 공중 점프(−238)가 되어 발사를 **대신**하므로(스톰프 바운스와 같은 규칙) 거품 체인은 점프를 미리 누른 채 내려앉는 길이다. **DSL 규칙**(`validate`): `b`는 위 칸이 빈 칸(또는 파편 같은 스폰)이어야 하고 — 맨 윗행은 지도 밖을 바위로 읽어 거절 — `P`에서 Chebyshev 거리 6칸을 넘어야 한다. **구역**(전부 `rev 1`): `m1` 얼음 회랑은 가시 침대 위 선반 틈의 파편 발판 2개((79,17)·(84,19), 각각 6행 위 파편), `m3` 바람의 첨탑은 3개 — 시작 마당의 발판((10,20), 5행 위 파편)과 추격자 방 왼벽의 파편 계단((81,23) → (83,20) → 파편 (83,15), 추격자 각성 반경(중심 간 130유닛) 밖 — `zones.test`는 발판마다 **가로** 박스 간격만 `FOE_WAKE_GAP`(140유닛) 초과로 고정한다 — 사다리 위 라이더는 세로로는 각성 범위 안이라 가로 간격이 유일한 가드다)이고, 상승기류 우물은 rev 0 그대로다(우물 안 사다리는 초보 봇 사망이 한 칸에 97.8 % 몰려 폐기), `m4` 정점 승강은 우물을 건너 정상 데크로 가는 낮은 길로 거품 3연쇄((18,11) → (15,8) → (12,5)), 크리스탈 길은 손대지 않았다. **SIM_VERSION 4**: 옛 클라이언트는 새 엔티티를 검증할 수 없으므로 정직하게 올렸고(기존 물리는 비트 동일), 스토리 보드는 `s4r*` 키로 새로 열린다. m1·m3·m4의 빠른·페이스 코퍼스 재녹화(페이스 1.026 · 1.025 · 1.025 × 파, 사망 0), `GOAL_ECHOES` 16/16, 초보 봇 히트맵 재기록(m1 클리어 91.3 % · m3 23.7 % · m4 0 %(오른쪽 홀드 봇은 탑을 오르지 못한다), 세 구역 모두 **거품 사망 0**, m3 최다 사망 칸 20 %), 코퍼스 다이제스트 18개 중 정점 3개 외 **15개 바이트 동일**. 테스트: 새 `test/sim/bubble.test.ts` 18개, `zones.test`의 `b` 배치·추격자 각성 반경 가드, `dsl.test` 거절 케이스 3종.
- P5-5 거품 적의 클라이언트 표현(`src/client/render/{actors,particles,renderer}.ts`, `src/client/audio/sfx.ts`, `src/client/ui/hints.ts` — 렌더·오디오 전용, sim·리플레이 무관). **드로잉** — 살아 있는 거품은 히트박스 위에 정확히 얹힌(rx = w/2 · ry = h/2, `f.x`/`f.y`에 오프셋 없음 — 위아래 흔들림은 sim의 것) 반투명 홍채빛 구체: 바이옴 `accent`가 림에 모이는 비누막 그라디언트, 얇은 흰 림과 그 위를 도는 홍채 아크 3개(핑크·시안·연금색), 좌상단 광택·우하단 핀 글린트, 위쪽 크라운 하이라이트(워커·호퍼·포탑과 같은 '밟아라' 신호), 아랫 림의 희미한 위험색(옆·아래 접촉은 즉사), ±3.5 % 표면 웨이블(`bubbleWobble`, 면적 보존); 글로 버퍼는 힌트 수준(alpha 0.08). **재생성 예고** — 비활성(`dead`) 거품은 아무것도 그리지 않다가 카운트다운(`state`) 마지막 0.5 s(`BUBBLE_SHIMMER_T`, `bubbleShimmer`)에 홈 위치로 좁혀 드는 링(2.4 r → r)과 모트 4개가 밝아진다 — P5-2 예고 포즈(호퍼 웅크림·포탑 조준선)와 같은 문법. **파티클** — `bubblePop`은 새 이미터 `Particles.droplets`(accent 물방울 10개, 위로 튀어 중력 낙하) + 흰 링, `bubbleBack`은 `Particles.shimmerIn`(안쪽으로 닫히는 링 + 중심으로 모여드는 모트 6개); `renderer.onEvent`에 두 케이스 추가(햅틱은 이미 매핑). **사운드** — 플레이스홀더를 교체: `bubblePop`은 밴드패스 버스트(2100→800 Hz, 70 ms) + 상승 사인 처프(460→1180 Hz) + 물방울 틱, 피크 게인 0.11(`foeKilled` 0.18보다 조용 — 터뜨림은 처치가 아니라 바운스); `bubbleBack`은 5도 간격 사인 2성부의 느린 어택 글래스 시머 + 하이패스 숨, 피크 0.045. 둘 다 이벤트 필드(vol·pan)만 쓰고 난수 없음. **힌트** — `REHINT_BUBBLE` '거품은 위에서 밟아라 · 옆에서 닿으면 죽는다', 사망 토스트 `DEATH_LINE_BUBBLE` '거품에 닿았다', 사망 원인 → 힌트 가족 순수 매핑 `rehintKind`/`deathHint`(pit·hazard 기존 규칙 유지, `bubble` 추가; 셸 `scenes.ts`의 `rehint`/`deathLine` 연결은 통합 시). 테스트: 새 `test/client/bubble-render.test.ts`(순수 함수, 히트박스 충실성, 비활성 2.0 s = 호출 0 / 0.3 s = 시머 링·모트, 4바이옴 전체 draw, 이벤트별 파티클 수), `audio.test`(recording Synth로 피크 게인 비교·결정론·엔진 재생), 새 `test/client/hints.test.ts`.
- P5-5 거품 적의 **셸 배선**(`src/client/scenes.ts` — sim·리플레이 무관): 사망 원인 `bubble` → 토스트 `거품에 닿았다`(`DEATH_LINE_BUBBLE`, `deathLine()`에 케이스 1개)와 **첫 거품 사망에 재힌트**. 재힌트에 필요한 사망 수를 가족별로 분리한 `REHINT_NEED: Readonly<Record<RehintKind, number>>`(pit 2 · hazard 2 · **bubble 1** — 구덩이·가시는 두 번이면 스스로 배우지만, '위는 발판·옆은 즉사'라는 비대칭은 사망 한 번으로 학습되지 않는다)를 내보내고, `Run.segDeaths`를 `Record<RehintKind, number>`로 넓혀 체크포인트에서 거품 카운터도 0으로 되돌리며, `rehint()`의 인라인 삼항을 `ui/hints.ts`의 순수 매핑 `rehintKind`/`REHINT_BY_KIND`로 교체했다(pit·hazard 동작 불변). 테스트: `test/fixtures/levels.ts`에 `bubbleRoom()`(sim `bubble.test`의 `sideRoom`과 같은 배치 — 진행 행 6칸 오른쪽에 `b` 1개), `test/client/shell.test.ts`에 오른쪽 홀드로 옆면에 닿아 1회 사망하면 `REHINT_NEED.bubble === 1`대로 `HINT_DELAY` 뒤 `REHINT_BUBBLE`이 **정확히 1개**·토스트 `거품에 닿았다`·`REHINT_PIT` 0개인 케이스. 문서 정리: README **SIM_VERSION 4**와 스토리 보드 키 `LB#story#<zone>#s4r<rev>`(2·`s2r`로 낡아 있었다), 테스트 수 1,476개(80 파일)와 내려받기 용량(JS 503 KB · gz 153 KB), `{stomp}` 토큰 백틱 표기, `levels/zones/m3.ts` 헤더 주석 80칼럼 재정렬(주석만).

## [0.4.1] - 2026-09-07

배포: https://clawd-game.whchoi.net/ — 데일리·끝없는 등반이 밴드마다 배경·지형 팔레트를 실제로 바꾸는 Phase 5 2차 파동(정점 밴드 포함). SIM_VERSION 3·GEN_VERSION 2 유지, 다이제스트 18개 불변. 컨테이너 QA: 스모크 23/23(새 `shot:daily-band` 단계), 판독성 10/10, 격자 PASS, 모바일 54/54. 라이브 점검(2026-09-07 05:55 UTC, CloudFormation UPDATE_COMPLETE): 배포 후 점검 13/13, 스모크 23/23(자가진단 18/18), 모바일 54/54, 데일리 기록 제출 E2E, 알람 10 OK.

### Added (Phase 5 B)
- P5-4 데일리·끝없는 등반의 밴드 순환에 4층 정점을 추가(`src/sim/gen/daily.ts BAND_ORDER` 4개): 바닥 밴드는 여전히 기존 3층 중에서 뽑고 지형·스폰은 `buildTower(seed)`만이 정하므로 **GEN_VERSION 2 유지**, 코퍼스 다이제스트 18개 불변. 현재 밴드는 HUD 구역 이름(`hudState` → `bandBiome`)에 반영된다 — 예: 공허의 초에서 시작한 탑은 50~99 높이가 오로라 정점. 배경·지형 팔레트가 밴드를 따라 바뀌는 크로스페이드는 P5-4b(렌더러)에서 잇는다.
- 파편·유물 획득 이벤트가 렌더러에서 직접 캐릭터 미소(`PlayerVisual.smile`)를 켠다(P5-2의 엔티티 전이 감지 경로와 병존).
- P5-4b 데일리·끝없는 등반의 **밴드 크로스페이드**(`src/client/render/{renderer,sky,actors}.ts`, 렌더 전용 — sim·리플레이 무관): 조류 레벨(`def.tide`)에서 렌더러가 매 프레임 플레이어 발 밑 행의 밴드(`bandBiome(def, row)`, HUD 라벨과 같은 호출)를 따라가고, 밴드가 바뀌면 `BAND_FADE_S` 1.2 s 동안 새 밴드의 스카이·지형 팔레트 위로 이전 밴드가 사라진다 — 스카이 인스턴스 2개(같은 seed·박스라 능선·절벽·구름·별 실루엣이 일치, `Sky.opacity`로 블렌드), 레벨당 밴드 바이옴별 `Terrain` 캐시(setLevel에서 미리 베이킹해 전환 프레임 히치 없음), 안개 밴드·골 비콘 색 `mixHex` 보간, 액터 팔레트·바람은 `Actors.setBiome`(엔티티 시각 메모리 유지)으로 즉시 전환. 히스테리시스: 진행 방향으로 경계 1타일을 지나야 전환(경계에서 깡충거려도 깜빡임 없음); 리스폰·인트로 이벤트와 한 프레임에 `BAND_SNAP_ROWS`(4행) 이상 점프하는 텔레포트(`?shot=daily&at=` 하네스)는 페이드 없이 하드컷, `low` 티어는 항상 하드컷(스카이 1개). 스토리 구역은 `def.biome` 고정·밴드 계산 없음, 타이틀 비스타·공유 카드 무관. `Sky.setBiome`이 바이옴 무관 레이아웃(rng 순서가 어떤 바이옴 분기에도 안 밀림)과 바이옴 틴트로 나뉘어 절차적 배경 배치가 이전 빌드와 조금 달라진다(시각 전용). 테스트: 새 `test/client/band-fade.test.ts`(밴드 추적·히스테리시스·역전·텔레포트·리스폰·스토리·low·endless 90행), `render.test`(4밴드 조류 레벨 draw·페이드 중 fill 예산 2배 이내), `sky.test`(같은 seed 실루엣 일치·opacity 스케일), `tiles.test`(Terrain이 외부 globalAlpha를 건드리지 않음); `qa:smoke`에 `shot:daily-band` 단계.

## [0.4.0] - 2026-09-07

배포: https://clawd-game.whchoi.net/ (CloudFront E38DW91AO2DWTB). 탑이 **4층 16구역**이 되고 캐릭터·배경이 강화된 Phase 5 1차 파동. SIM_VERSION 3·GEN_VERSION 2 유지(기존 12구역 보드·데일리 생성 불변, 코퍼스 다이제스트 14개 바이트 동일 + 정점 4개 추가). 컨테이너 QA: 스모크 22/22(16구역 캡처·자가진단 18/18), 판독성 10/10(정점 가시 대비 5.97:1·상승기류 +80·배경 밴드), 격자 PASS, m1/m4 실제 기록 접수 200·중복 422. 테스트 1,408개(76 파일). 라이브 점검(2026-09-07 04:20 UTC 배포, ECS 롤아웃 287 s): 배포 후 점검 13/13, 스모크 22/22(자가진단 18/18 다이제스트 = Node), 모바일 54/54, 데일리 기록 제출 E2E, 알람 10 OK.

### Added (Phase 5 A)
- P5-1 4층 '오로라 정점'(biome `summit`) 구역 4개 — 탑이 3층 12구역에서 **4층 16구역**이 됐다. `m1` 얼음 회랑(FROST GALLERY, 114×26, par 80 — 일방 발판 `=`을 천장으로 덮은 얼음 복도(끝이 3칸 계단이라 2단 점프로 천장을 뚫고 올라가는 것이 길), 절벽 면의 크리스탈 사다리 2개, 가시 침대 위로 내려가는 일방 선반 3개, 톱날·워커·플라이어), `m2` 오로라 다리(AURORA BRIDGE, 118×24, par 95 — 무너지는 다리 5칸 × 4 + 바위 기둥, 포탑 회랑, 가시 침대 위 수평 발판 `m`과 정상 절벽으로 오르는 수직 발판 `M`, 포탑 3), `m3` 바람의 첨탑(WIND SPIRE, 116×30, par 110 — 둑 가장자리에 맞닿은 상승기류 3단, 지붕 덮인 스위치 회랑(토글 2 · `%`/`&` 관문 · 극성 사이에만 있는 `&` 선반), 유물만 지키는 추격자(바닥에서 12행 위·각성 반경 밖), 상승기류 우물 위 바위 상인방으로 지붕 우회 차단), `m4` 정점 승강(SUMMIT ASCENT, 44×80 세로, par 130 — 우벽 4칸 월점프 통로(용수철·일방 휴식 발판 2)·수직 발판·상승기류 3단·정상 데크로 건너는 크리스탈 2개·정점 첨탑 위 유물, 가시 없는 탑). 모두 `rev 0`, 파편 10~12, 유물 1, 체크포인트 4~7(파 20초당 1개 · 이웃 ≤ 32칸). `ZONES` 끝에 등록, `BIOME_ORDER`에 `summit` 추가 → `CHAPTERS` 4층(해금·메달 분모 ×3/×4·ROMAN `IV`·엔딩 합계는 목록 기반이라 자동). 빠른 코퍼스 4개(파의 8~12 %), 페이스 코퍼스 4개(m1 103 % · m2 96 % · m3 102 % · m4 103 %, 대시 2~7), `GOAL_ECHOES` 16/16, 초보 봇 히트맵 4개(m1 클리어 91 %·m2 85 %·m3 24 %(스위치 회랑에서 토글을 잊은 봇이 멈춤, s2와 같은 결)·m4 세로 0/0, 가로 구역 어느 칸도 사망의 25 % 미만 — m1 13 %·m2 19 %), 코퍼스 다이제스트 14 → 18(기존 14 바이트 동일). 테스트: 16구역·4층 4개·정점 구역별 기믹 단언, `ui.test` 16구역, `selftest.test` GOAL_ECHOES 16; `qa:smoke`·`qa:mobile` 구역 목록 16.
- P5-3 배경 강화(`src/client/render/{sky,tiles,renderer,stage}.ts`, 렌더 전용 — sim·리플레이 무관): 스카이에 패럴랙스 층 2개를 더했다 — **원경 구조물 실루엣**(조수 웅덩이 등대(회전 광선)·난파선·야자, 폭풍 첨탑 창불 켜진 첨탑(번개 때 밝아짐), 공허의 초 해파리 갓·산호 아치, 정점 눈 봉우리·부유 사당)과 **중경 동물 무리**(갈매기/박쥐/빛벌레/눈바다제비 14마리 V자 편대, 화면 상단 42 % 밴드 안에서만). 정점 **오로라 리본** 3줄(fbm 흐름, `accent`↔`skyLight`, 느린 드리프트), 눈 날씨 `'snow'`(느린 낙하·바람 흔들림, 고품질 90개), 세로 구역 **구름 갑판**(`cloudDeck`: 높이 55 % 지점의 구름층을 뚫고 오르면 별이 짙어지고 발밑이 구름 바다로, `deckFactor` 단조), 가로 구역 **시간대 드리프트**(진행도에 따라 하늘 그라디언트를 최대 0.15 보간, 캐시 48단계). `tiles.ts` 바이옴 **면 장식 패스**(노출면만, 타일 좌표 결정론 `tileDecor`, 종류별 Path2D 1회 채우기 — 지형 Path2D fill 상한 6→9): 조수 웅덩이 따개비·이끼, 폭풍 첨탑 발광 룬, 공허의 초 결정, 정점 얼음 광택·눈 모자; 정점 가시에도 민트 림(`SPIKE_RIM_BIOMES`), 정점 선반 소나무 소품. 품질 게이트: `low`는 새 층 전부 끄고(`Sky.counters` 스파이 0) `balanced`는 무리 절반. **정점 팔레트 확정**(`BIOMES.summit` 값만: crust `#5FA3D6`·crustHi `#D8F4FF`·fog `#4F86A8` — 가시 윤곽 대비 4.5:1↑, 상승기류 밝기 차 ≥25/255, 비콘 accent와 하늘·지형 색 거리 >48). `tools/qa/readability.ts`에 `backdrop:t1/s1/v1` 단계(스카이만 다시 그려 플레이필드 밴드의 어느 픽셀 열 평균도 crust 루마를 넘지 않음)와 `tier4-updraft/spike/beacon` 단계(임시로 기존 구역을 가리키는 `SUMMIT_*` 상수, P5-1 병합 후 m1/m3로 전환) 추가. 테스트: `sky.test.ts`(층·게이트·눈·갑판·시간대·팔레트 판독성 수식) · `tiles.test.ts`(장식 결정론·면 규칙) · `render.test.ts`(4바이옴 setLevel+draw, 게이트 스파이, 지형 fill 상한, 정점 림).
- P5-2 캐릭터 강화(`src/client/render/clawd.ts`·`actors.ts`, `src/client/unlocks.ts`, `src/client/audio/music.ts`·`sfx.ts`): **리그 표정** — 포즈별 눈썹·입(`expressionFor`: 달리기 집중, 낙하 놀람, 대시 이악물기, 피격·사망 X눈), 파편·유물 획득 뒤 0.4 s 미소(`Actors`가 소비 순간을 감지해 라이브 플레이어만 웃는다), 4 s 대기 후 시선 배회와 7 s 주기 기지개. **2차 모션** — 안테나 2개가 감쇠 스프링으로 속도 변화에 뒤따르고(대시·착지에 크게 흔들림), 5점 스카프 체인이 바이옴 바람(spray·rain·spores·snow별 세기)과 속도에 흐른다 — 전부 `PlayerVisual`의 시각 메모리, 리플레이 무관. **액세서리** — `Skin.accessory`(scarf·antenna·crown·fins·hood·halo·goggles)를 리그와 초상(설정 피커·결과·공유 카드)에서 그린다. **스킨 8종** — 기존 4 + 코랄(`coral`, 지느러미, 메달 12개)·프로스트(`frost`, 후드+스카프, 4층 진입 — 정점 구역이 없으면 잠김 유지)·골드(`gold`, 왕관, 구역 전부 클리어 — 힌트가 구역 수를 센다)·노바(`nova`, 후광, S 등급 3개); `SKIN_RULES`·`Progress.unlockedSkins`·그랜드파더링 경로 그대로. 액세서리 없는 기존 4스킨은 이전 프레임과 호출 단위로 동일(`test/fixtures/clawd-baseline.json`). **적 예고 포즈** — 호퍼 점프 전 0.3 s 스쿼시, 포탑 재장전 마지막 0.4 s 조준선, 추격자 와인드업 진동, 플라이어 날갯짓, 워커 깜빡임(모두 `FoeState`만 읽는 시각 전용). **정점 음악** — `summit` 트랙 실제 작곡(F# 리디안 76 bpm, 글라스 벨 4마디 모티프 + 바람 패드 `wind` 악기 + 소프트 베이스·글라스 아르페지오·심장 박동)과 `stingSummit`(F#5에서 떨어지는 글라스 벨 캐스케이드, 다른 세 스팅어와 오프닝이 다름).

## [0.3.1] - 2026-09-07

### Changed
- 타이틀 하단에 **게임 버전 표기** `v0.3.0 · 빌드 5a9af50a`(`package.json` 버전을 esbuild `__VERSION__`으로 인라인, 빌드 id 8자 — 스크린샷·버그 리포트가 어느 빌드인지 말해준다; `src/client/ui/title-meta.ts`, dev 트리는 `dev`). 탑 오르기 부제 'N개 층 · N개 구역'을 레벨 목록에서 계산해 층이 늘어도 낡지 않는다(9개로 굳어 있던 문구 수정). `tools/build.mjs` 요약 줄에 버전 출력, 빌드 테스트·스모크가 인라인/표기를 검사.

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
