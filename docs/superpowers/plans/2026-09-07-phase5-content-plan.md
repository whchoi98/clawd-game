# Phase 5 — 캐릭터 강화 · 배경 강화 · 스테이지 추가 (계획)

> 오너 목표 (2026-09-07 02:00): **"게임캐릭터 강화, 게임 배경 강화, 게임 스테이지 추가"**.
> 출발점: v0.3.0 라이브(12구역 · SIM_VERSION 3 · GEN_VERSION 2). 로드맵 `2026-09-06-top-chart-roadmap.md`의 보류 항목 중
> GF-04(4번째 바이옴), GF-08(적 예고 포즈), GF-05(B-side)가 이 목표와 맞물린다.

## 상태 (2026-09-07 05:30 UTC)

- **P5-1 · P5-2 · P5-3 완료, v0.4.0으로 라이브**(04:20 UTC): 16구역·4층, 배경·캐릭터 패스. 라이브 QA 배포 후 점검 13/13 · 스모크 22/22 · 모바일 54/54 · 데일리 E2E.
- **P5-4 + P5-4b 완료, v0.4.1 배포 중**: 밴드 순환에 정점 추가(GEN 2 유지)와 조류 레벨의 밴드 크로스페이드(배경·지형·안개·비콘, 1.2 s, 히스테리시스 1타일, low 티어 하드컷). 컨테이너 QA 스모크 23/23 · 판독성 10/10 · 모바일 54/54.
- **P5-5 완료, v0.5.0 라이브(2026-09-07 20:51 UTC)**: 거품 적(SIM_VERSION 4) + m1(퍼치 2)·m3(마당 퍼치 1 + 추격자 방 파편 계단 2)·m4(우물 체인 3) rev 1. m3의 '상승기류 사이 거품 사다리'는 초보 봇 히트맵에서 사망 227건 중 202건(한 칸 97.8 %)이 몰려 기각하고 파편 경로로 옮겼다(재개 계획 `2026-09-07-phase5-c-resume-plan.md` 참조). 라이브 QA 13/13 · 23/23 · 54/54 · E2E.
- 후속 후보: 데일리 맨 위 6~10행짜리 부분 밴드는 GEN 3에서 클램프 검토; `balanced` 티어 밴드 하드컷 여부는 폰 티어 스텝다운 텔레메트리로 결정; 정점 구역 체크포인트 튠업은 사망 히트맵(텔레메트리) 기준.

## 원칙

- **SIM_VERSION 3 유지.** `src/sim/**`는 생성 파일(`levels.generated.ts`, `echoes.generated.ts`) 외에는 건드리지 않는다. 새 구역은 기존 기믹(스위치·승강 발판·크리스탈·상승기류·톱날·5종 적)만 쓴다. `npx tsx tools/hash-corpus.ts --check`가 기존 14 다이제스트를 그대로 지키는 것이 증명이다.
- **GEN_VERSION 2 유지.** 데일리의 `BAND_ORDER`는 `src/sim/gen/daily.ts` 안에 3개로 고정돼 있어 4번째 바이옴이 데일리 생성에 영향을 주지 않는다(데일리 4밴드는 P5-4에서 GEN 3으로 별도).
- **리플레이는 렌더를 모른다.** 캐릭터·배경 강화는 전부 `src/client/render/**`·오디오·UI 안의 시각/청각 메모리다. 결정론 자가진단(`?shot=selftest`)과 코퍼스 다이제스트가 회귀 방패.
- **판독성 우선.** 배경이 화려해져도 `tools/qa/readability.ts`(상승기류 기둥 밝기 차 ≥25/255, 가시 팁 대비 ≥3:1, 골 비콘)와 모바일 QA(적이 터치 버튼 아래 없음)를 통과해야 한다. 새 레이어는 품질 티어 `low`에서 꺼진다.
- **계약 먼저.** `36ccbd0`에 넣은 계약: `BiomeId`에 `'summit'`, `BIOMES.summit` 임시 팔레트(`AURORA SUMMIT / 오로라 정점`, weather `'snow'`, track `'summit'`), `TIER_LINES.summit`, `stingSummit`/`TRACKS.summit` 자리표시자, `TITLE_SEEDS.summit`, `Skin.accessory?/trim?`. `BIOME_ORDER`는 구역이 생기는 P5-1에서 늘린다.

## 항목

### P5-1 — 4층 '오로라 정점' 구역 4개 (스테이지 추가)
- 영역: levels · 소유: `levels/**`, 생성 파일 2개, `src/shared/biomes.ts`의 `BIOME_ORDER` 한 줄, `tools/qa/{smoke,mobile}.ts` 구역 목록, `test/levels/**`, `test/fixtures/corpus-digests.json`, `test/client/ui.test.ts`(REAL_LEVELS 12→16)·`test/client/selftest.test.ts`(GOAL_ECHOES 12→16), README·CHANGELOG 자기 절.
- 내용: `m1` 얼음 회랑(FROST GALLERY, 가로, par ≈80, 얼음 판=일방 발판·크리스탈 사다리), `m2` 오로라 다리(AURORA BRIDGE, 가로, par ≈95, 무너지는 다리 + 승강 발판 + 포탑 사격 회랑), `m3` 바람의 첨탑(WIND SPIRE, 가로, par ≈110, 상승기류 계단 + 스위치 극성 회랑 + 추격자), `m4` 정점 승강(SUMMIT ASCENT, 세로 44×72~80, par ≈130, 통로 월점프 + 승강 발판 + 상승기류 3단 + 크리스탈 체인, 탑의 마지막 구역). 모두 `biome: 'summit'`, `rev: 0`, 체크포인트 밀도·간격 규칙(`validateZone`) 준수, 파편 8~12, 유물 1. `ZONES` 끝에 4개 등록 → `CHAPTERS` 4층. 해금 규칙(N→N+1·N+2, 층 경계)·메달 분모(×3/×4)·엔딩 합계·ROMAN `IV`는 순서/목록 기반이라 자동.
- 코퍼스: 빠른 코퍼스 4개(`tools/solve.ts`), 페이스 코퍼스 4개(`--pace`, 95~110 %, m4는 `--budget=600` 권장), `GOAL_ECHOES` 16/16, 초보 봇 히트맵 4개(`tools/novice.ts`), 다이제스트 14→18(기존 14 불변).
- 완료 기준: `npm run levels -- --check` 녹색, `hash-corpus --check` 녹색, `test/levels/zones.test.ts`에 m1~m4 규칙(4층 4개·m4 세로 봉투·통로 폭 4), 스모크 `shot:m1~m4` 콘솔 오류 0, 모바일 스폰 프레임 4개 추가, `ui.test` 16구역, 선택 화면 4층 카드 렌더.

### P5-2 — 캐릭터 강화: 리그 표정·2차 모션·액세서리·스킨 8종·적 예고 포즈
- 영역: render/audio/unlocks · 소유: `src/client/render/{clawd,actors,particles}.ts`, `src/client/unlocks.ts`, `src/client/ui/ui.ts`(스킨 피커 힌트 문구만), `src/client/audio/{music,sfx}.ts`, `test/client/{unlocks,audio,render-clawd}.test.ts`, CHANGELOG 자기 절.
- 캐릭터: (1) 표정 — 상태별 눈썹·입(달리기 집중, 낙하 놀람, 대시 이악물기, 파편 획득 미소 0.4 s, 피격/사망 X눈), 대기 4 s 후 둘러보기·기지개, 골 6타일 내 시선 유도(기존). (2) 2차 모션 — 안테나/귀 2개가 감쇠 스프링으로 가속에 뒤따르고, 스카프/후드는 5점 체인(시각 전용, 결정론 무관)이 바람·속도에 흐른다. (3) 액세서리 — `Skin.accessory`(`scarf·antenna·crown·fins·hood·halo·goggles`)를 리그와 초상(`drawClawdPortrait`, 공유 카드에도 반영)에서 그린다. (4) 스킨 8종 — 기존 4 + `coral`(지느러미, 메달 12개), `frost`(후드, 4층 진입), `gold`(왕관, 16구역 전부 클리어), `nova`(후광, S 등급 3개). `SKIN_RULES`·힌트·`Progress.unlockedSkins` 영속은 기존 경로.
- 적 예고 포즈(GF-08 일부, `actors.ts` 시각 전용): 호퍼 점프 전 0.3 s 스쿼시(state=다음 점프까지 초), 포탑 재장전 마지막 0.4 s 조준선 밝아짐, 추격자 와인드업 진동(state>0), 플라이어 날갯짓 위상, 워커 눈 깜빡임.
- 오디오: `summit` 트랙 실제 작곡(F# 리디안 76 bpm, 글라스 벨·바람 패드, 새 `arrange`), `stingSummit` 실제 스팅어(오프닝이 다른 3개와 다름 — `audio.test`가 검사), 스킨 해금 차임은 기존 `uiUnlock`.
- 완료 기준: `render.test`/새 테스트에서 8스킨 × 11포즈 drawClawd 예외 0, 초상 8종 예외 0, 액세서리 없는 스킨은 기존 실루엣과 픽셀 동일(회귀 스냅샷: 기존 4스킨 idle 프레임 해시), `unlocks.test` 규칙 경계값, 스모크 fpsP95 회귀 없음(<20 ms).

### P5-3 — 배경 강화: 레이어·소품·오로라·고도 구름·바이옴 장식·정점 팔레트 확정
- 영역: render · 소유: `src/client/render/{sky,tiles,renderer,stage,debug}.ts`, `src/shared/biomes.ts`(summit 팔레트 값만), `tools/qa/readability.ts`, `test/client/render.test.ts`(배경 절), CHANGELOG 자기 절.
- 내용: (1) 스카이 4·5번째 패럴랙스 층(원경 구조물 실루엣 + 중경 동물 무리: 갈매기/박쥐/빛벌레, 바이옴별), (2) 바이옴 소품 확장 — tidepool 등대·난파선·야자, stormspire 창불 켜진 첨탑(번개 때 밝아짐), voidreef 해파리 갓·산호 아치, summit 눈 덮인 봉우리·부유 사당·**오로라 리본 층**(fbm 흐름, 색 `accent`↔`skyLight`), (3) 세로 구역 고도 연출 — camY가 높아지면 구름 갑판을 뚫고 올라가 별이 짙어지는 `cloudDeck`(t4·s4·v4·m4), 눈 날씨 `'snow'`(느린 낙하 + 바람 흔들림) 구현, (4) 구역 내 진행에 따른 미세한 시간대 변화(camX/폭으로 sky 그라디언트 0.15 보간), (5) `tiles.ts` 바이옴 장식 패스 — tidepool 따개비·이끼, stormspire 룬 발광, voidreef 결정, summit 얼음 광택·눈 모자(노출면 위쪽), (6) 품질 게이트 — `QualityTier` `low`는 새 층·오로라·무리 끄고 `mid`는 무리 절반, (7) summit 팔레트를 `readability.ts`로 확정(가시 팁 대비 ≥3:1 vs crust, 상승기류 밝기, 비콘) — `readability.ts`에 `shot=m3`(상승기류)·`shot=m1`(가시) 단계 추가는 P5-1 병합 후 통합자가 켠다(구역 id를 상수로 남길 것).
- 완료 기준: `render.test` 4바이옴 setLevel+draw 예외 0, `low` 티어에서 새 레이어 호출 0(스파이) , 스모크 12구역 fpsP95 <20 ms 유지, 판독성 3/3(+summit 단계), 모바일 40/46 유지, 배경 어느 픽셀도 플레이필드 밴드에서 crust보다 밝지 않음(readability에 'backdrop-band' 단계 추가).

### P5-4 / P5-4b — 데일리·끝없는 등반 4밴드 + 밴드 팔레트 크로스페이드 — 2차 파동 (완료, v0.4.1)
- 실제 구현은 **GEN_VERSION 2 유지**로 갔다: `daily.ts BAND_ORDER`에 summit을 4번째로 추가하되 바닥 밴드는 기존 3층 중에서만 뽑아(`pick.int(0, 2)`) `def.biome`·지형·스폰이 비트 동일 — 밴드는 `bandBiome`이 정하는 시각 정보일 뿐이므로 서버 검증·이전 클라이언트 호환에 영향이 없다(다이제스트 18개 불변). 정점 청크(지형 변경 → GEN 3)는 하지 않았다.
- P5-4b(렌더러): 조류 레벨에서 발 밑 행의 밴드가 바뀌면 배경(스카이 2개 블렌드, 같은 seed·박스로 실루엣 유지)·지형 팔레트(레벨당 바이옴별 Terrain 미리 베이킹)·안개·골 비콘이 1.2 s 크로스페이드, 경계 1타일 히스테리시스, 텔레포트·리스폰은 하드컷, `low` 티어는 항상 하드컷. 원래 HUD 라벨만 밴드를 따르던 불일치를 해소했다.

### P5-5 — 새 적 '버블'(bubble) + 정점 구역 통합 (SIM_VERSION 4) — 3차 파동 (착수 2026-09-07 06:30 UTC · 완료 v0.5.0 20:51 UTC)
- **게이트 확인(텔레메트리, 2026-09-06~07, 109 세션)**: boot 109 → zone_start 68(62 %) → clear 17(16 %). t1 시작 61·클리어 16(26 %, 사망 31), t2 60 %, t3 3/3, s1 1/2; 정점 구역 m1~m4 시작 0 — 아직 아무도 4층에 이르지 못해 정점 클리어율은 비어 있다. 오너 지시로 P2-8과 같이 **초보 봇 히트맵을 대체 지표**로 삼아 착수하고, 실데이터는 배포 후 다시 본다.
- **설계**: 스폰 문자 `b` → `FoeKind 'bubble'`. 제자리에서 세로로 떠다니는(진폭 `PHYS.bubbleBobAmp` 10u, 주기 1.6 s) 반투명 거품. **위에서 밟으면 터지며**(`bubblePop` 이벤트) 플레이어를 `PHYS.bubbleBounce`(-352, 스톰프 바운스와 용수철 사이)로 튕겨 올리고, `PHYS.bubbleRespawn` 2.5 s 뒤 같은 자리에 다시 생긴다(`bubbleBack`). 옆·아래 접촉은 다른 적처럼 즉사(사망 원인 문자열 `bubble`). 터진 거품은 콤보·처치 수에 들지 않는다(무한 파밍 방지). 결정론: dmath만.
- **SIM_VERSION 4**: 새 엔티티 종류는 이전 클라이언트가 검증할 수 없으므로 정직하게 범프한다 — 스토리 보드가 `s4r*`로 새로 열리고(직전 리셋 후 실기록 소수), 이전 클라이언트는 `sim-version` 거절 → 업데이트 바. 기존 물리는 비트 동일: 코퍼스 다이제스트 18개가 `sim 4` 헤더로 값 불변, 46개 녹화·16개 히트맵은 재녹화 없이 스탬프만 4로 올렸다(생성 단계의 `verifyReplay`가 다시 증명).
- **적용 구역**: 정점 4구역(rev 1) — m3 바람의 첨탑(상승기류 사이 거품 사다리), m4 정점 승강(우물을 가로지르는 거품 체인 대안 경로), m1 얼음 회랑(가시 침대 위 거품 퍼치 1~2개), m2는 선택. 다른 층은 건드리지 않는다.
- **소유**: A(sim+levels) `src/sim/foes.ts`·`sim.ts`(필요 시)·`player.ts`(바운스 처리)·`levels/**`·생성 파일·코퍼스·히트맵·다이제스트·`tools/qa/{smoke,mobile}.ts`·`test/sim/**`·`test/levels/**`·`test/server/**`; B(client) `src/client/render/actors.ts`(거품 렌더·팝/재생성 파티클·예고), `particles.ts`, `audio/sfx.ts`(진짜 팝·재생성 소리), `ui/hints.ts`(사망 원인 `bubble` 힌트), 관련 클라이언트 테스트.
- **완료 기준**: 정점 4구역 골든(빠른·페이스) 재녹화 + GOAL_ECHOES 16/16, 히트맵 4개 재기록, `hash-corpus` 22 다이제스트(정점 4 갱신·기존 14 불변), 스모크 23/23·판독성 10/10·모바일 54/54, m1/m4 실제 제출 200.

## 실행

- **1차 파동(병렬 worktree 3개, base `36ccbd0`)**: A1 = P5-1, A2 = P5-3, A3 = P5-2. 소유 파일이 겹치지 않도록 위 소유 목록을 따르고, 남의 파일이 꼭 필요하면 고치지 말고 `notesForIntegrator`에 적는다. `src/sim/**`(생성 파일 제외)·`src/shared/protocol.ts`·`src/client/contracts.ts`·`src/sim/types.ts`는 누구도 건드리지 않는다.
- 통합: `git merge-tree` 드라이런 → `--no-ff` 병합 → tsc → vitest 전체 → `npm run levels -- --check` → `hash-corpus --check` → Docker → 컨테이너 QA(스모크·모바일·판독성·격자·m1/m4 실제 제출) → 배포(v0.4.0) → 라이브 점검(postdeploy·스모크·모바일·데일리 E2E).
- **2차 파동**: P5-4 + 1차 파동 잔여(정점 구역 히트맵 튠업, 판독성 단계 켜기).
