# Contributing

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Start

Read [repository guidance](AGENTS.md), [onboarding](docs/onboarding.md) and the
[architecture](docs/architecture.md). Use Node.js 20 or newer; Node.js 22 matches
CI and Docker. Run `npm ci`, then `npm run dev`.

Make changes on a branch from `main` and open a pull request when using the
GitHub review workflow. [CI](.github/workflows/ci.yml) runs on pull requests,
pushes to `main` and manual dispatch. Required checks and approval rules are
repository settings; the workflow file does not configure branch protection.

### Validate a change

```bash
npm run typecheck
npm run levels -- --check
npx tsx tools/hash-corpus.ts --check
npm test
npm run build -- --prod
git diff --check
```

For UI, input, save, audio or PWA changes, run the relevant browser journeys from
[the QA guide](tools/qa/README.md). Browser QA uses a running local server;
`npm run qa:audio` is a separate opt-in test run. For infrastructure changes,
use the credential-free synthesis command in [onboarding](docs/onboarding.md).
Report which checks ran, which were skipped and any actual failures.

### Preserve the contracts

- Author levels in the DSL and regenerate the three `src/sim/*.generated.ts`
  files. Keep golden replays and digests consistent with intentional changes.
- Keep replay-affecting simulation changes versioned, and visual effects outside
  simulation state. See [the game reference](docs/reference/game.md).
- Keep API schemas, replay validation and public/personal leaderboard separation
  consistent. See [the server reference](docs/reference/server.md).
- Use `.editorconfig` and existing TypeScript conventions. Game UI copy is Korean;
  retain the language of existing documents. New public guides have matching
  English and Korean sections.

### Prepare a commit

Update affected documentation and `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
Keep dated release and QA evidence intact. Stage only intended paths and inspect
`git diff --cached` and `git diff --cached --check` before committing. Existing
commit subjects commonly use `docs:`, `fix:`, `feat:` and `chore:`.

Describe the concrete behavior changed and validation performed in the pull
request. Do not include local `.env` files, build output or session locks.
[Release operations](docs/runbooks/release.md) are a separate workflow; ordinary
commits do not require a version bump, tag or deployment. Contributions retain
the existing [MIT license and attribution](LICENSE).

<a id="korean"></a>
## 한국어

### 시작하기

[저장소 지침](AGENTS.md), [온보딩](docs/onboarding.md),
[아키텍처](docs/architecture.md)를 읽어 주세요. Node.js 20 이상이 필요하며,
Node.js 22가 CI·Docker와 같습니다. `npm ci` 후 `npm run dev`로 시작합니다.

GitHub 리뷰 흐름을 사용할 때는 `main`에서 작업 브랜치를 만들고 풀 리퀘스트를
여세요. [CI](.github/workflows/ci.yml)는 풀 리퀘스트, `main` 푸시, 수동 실행에서
동작합니다. 필수 검사와 승인 규칙은 저장소 설정이며, 워크플로 파일이 브랜치
보호를 설정하지는 않습니다.

### 변경 검증

```bash
npm run typecheck
npm run levels -- --check
npx tsx tools/hash-corpus.ts --check
npm test
npm run build -- --prod
git diff --check
```

UI·입력·저장·오디오·PWA 변경은 [QA 안내](tools/qa/README.md)의 관련 브라우저
흐름도 실행해 주세요. 브라우저 QA에는 실행 중인 로컬 서버가 필요하며,
`npm run qa:audio`는 별도 선택 실행입니다. 인프라 변경은
[온보딩](docs/onboarding.md)의 자격 증명 없는 합성 명령으로 확인합니다.
실행한 검사, 건너뛴 검사와 실제 실패를 구분해 기록해 주세요.

### 계약 유지

- 레벨은 DSL에서 저작하고 `src/sim/*.generated.ts` 세 파일을 재생성합니다.
  골든 리플레이와 다이제스트는 의도한 변경과 함께 갱신합니다.
- 리플레이 결과를 바꾸는 시뮬레이션 변경은 버전을 관리하고 시각 효과는
  시뮬레이션 상태와 분리합니다. [게임 참조](docs/reference/game.md)를 확인하세요.
- API 스키마, 리플레이 검증, 공개·개인 리더보드 분리를 함께 유지합니다.
  [서버 참조](docs/reference/server.md)를 확인하세요.
- `.editorconfig`와 기존 TypeScript 관례를 따릅니다. 게임 UI 문구는 한국어이며,
  기존 문서의 언어를 유지합니다. 새 공개 가이드는 영어·한국어 내용을 맞춥니다.

### 커밋 준비

영향받는 문서와 [CHANGELOG.md](CHANGELOG.md)의 `[Unreleased]`를 갱신합니다.
날짜가 있는 릴리스·QA 기록은 보존합니다. 의도한 경로만 스테이징하고
`git diff --cached`, `git diff --cached --check`로 확인한 뒤 커밋합니다.
기존 커밋 제목에는 `docs:`, `fix:`, `feat:`, `chore:`가 주로 쓰입니다.

풀 리퀘스트에는 구체적인 동작 변경과 검증 결과를 적어 주세요. 로컬 `.env`,
빌드 산출물, 세션 잠금 파일은 포함하지 않습니다.
[릴리스 운영](docs/runbooks/release.md)은 별도 절차이며, 일반 커밋에 버전 증가·태그·
배포가 필요한 것은 아닙니다. 기여 시 기존 [MIT 라이선스와 출처 표기](LICENSE)를
유지합니다.
