# Development onboarding

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Install and play locally

The package requires Node.js 20 or newer; CI and Docker use Node.js 22. npm and
a browser are enough for local play. Use the committed lockfile:

```bash
git clone https://github.com/whchoi98/clawd-game.git
cd clawd-game
npm ci
npm run dev
```

Open `http://127.0.0.1:8099`. The dev tool watches the client, server, public files
and level sources. Reload the page after an edit. It removes `TABLE_NAME` from
the server environment so local runs use memory and disappear on server restart.
Browser progress remains in localStorage. `PORT=8100 npm run dev` changes the port.
Stop the process with Ctrl+C.

### Check and run a build

```bash
npm run typecheck
npm run levels -- --check
npx tsx tools/hash-corpus.ts --check
npm test
npm run build -- --prod
```

`--check` compares generated files without rewriting them. `npm run levels`
regenerates level, echo and chunk modules after an intentional content change.
The build writes `dist/public`, `dist/server/index.js` and `dist/build.json`;
without `--prod` or `NODE_ENV=production`, it uses development output.

With `TABLE_NAME` unset, start the built app in one terminal:

```bash
PORT=8099 STATIC_DIR=dist/public DAILY_SECRET=local-development npm start
```

`npm start` alone listens on port 8080 and serves only the API when `STATIC_DIR`
is unset. The sample daily key is for local reproducibility. Production variables
and their defaults are documented in [the server reference](reference/server.md).
The scripts read environment variables; they do not automatically load `.env`.

### Browser checks

Keep the local server running and use another terminal:

```bash
npm run qa:browser
npm run qa:smoke
npm run qa:premium
npm run qa:audio
```

Smoke and premium default to `http://127.0.0.1:8099`; set `BASE_URL` for another
local port. Audio tests launch their own browser fixture. Normal `npm test`
skips the opt-in WebAudio cases. On a supported host, install additional engines
and system libraries to run the full determinism check:

```bash
npx playwright install --with-deps chromium webkit firefox
npm run qa:webkit
npx tsx tools/qa/selftest.ts --require=chromium,webkit,firefox
```

See [QA instructions](../tools/qa/README.md) for mobile, readability and grid
checks. Screenshots go to ignored `tools/qa/out/`. The dated
[quality report](quality/2026-09-13-premium-report.md) records the container
setup used for WebKit on the development host.

### Inspect infrastructure without deploying

This command uses the checked-in VPC lookup cache. Its account and region must
match that cache; it does not deploy resources or build a container:

```bash
CDK_DEFAULT_ACCOUNT=061525506239 CDK_DEFAULT_REGION=ap-northeast-2 \
AWS_REGION=ap-northeast-2 AWS_EC2_METADATA_DISABLED=true CDK_DOCKER=echo \
CDK_DISABLE_VERSION_CHECK=1 \
npx cdk synth --quiet --no-lookups --no-notices
```

Read [architecture](architecture.md), [implementation references](reference/INDEX.md)
and [contribution guidance](../CONTRIBUTING.md) before the first change. Actual
AWS operations are covered by [the release runbook](runbooks/release.md).

<a id="korean"></a>
## 한국어

### 설치와 로컬 실행

패키지는 Node.js 20 이상을 요구하며, CI·Docker는 Node.js 22를 사용합니다.
로컬 플레이에는 npm과 브라우저면 충분합니다. 커밋된 잠금 파일로 설치하세요.

```bash
git clone https://github.com/whchoi98/clawd-game.git
cd clawd-game
npm ci
npm run dev
```

`http://127.0.0.1:8099`를 엽니다. 개발 도구는 클라이언트·서버·공개 파일·레벨 소스를
감시합니다. 수정 후 브라우저를 새로고침하세요. 서버 환경에서 `TABLE_NAME`을
제거하므로 로컬 기록은 메모리에 저장되고 서버 재시작 시 사라집니다. 브라우저
진행도는 localStorage에 남습니다. `PORT=8100 npm run dev`로 포트를 바꿀 수 있습니다.
종료는 Ctrl+C입니다.

### 검사와 빌드 실행

```bash
npm run typecheck
npm run levels -- --check
npx tsx tools/hash-corpus.ts --check
npm test
npm run build -- --prod
```

`--check`는 생성 파일을 쓰지 않고 비교합니다. 의도한 콘텐츠 변경 후에는
`npm run levels`로 레벨·메아리·청크 모듈을 재생성합니다. 빌드는 `dist/public`,
`dist/server/index.js`, `dist/build.json`을 만듭니다. `--prod` 또는
`NODE_ENV=production`이 없으면 개발 모드 산출물을 만듭니다.

`TABLE_NAME`이 설정되지 않은 상태에서 터미널 하나에 빌드된 앱을 실행합니다.

```bash
PORT=8099 STATIC_DIR=dist/public DAILY_SECRET=local-development npm start
```

`npm start`만 실행하면 기본 포트는 8080이며, `STATIC_DIR`이 없으면 API만 제공합니다.
예시 데일리 키는 로컬 재현용입니다. 운영 변수와 기본값은
[서버 참조](reference/server.md)에 있습니다. 스크립트는 환경 변수를 읽으며
`.env` 파일을 자동으로 불러오지는 않습니다.

### 브라우저 검사

로컬 서버를 켜 둔 채 다른 터미널에서 실행합니다.

```bash
npm run qa:browser
npm run qa:smoke
npm run qa:premium
npm run qa:audio
```

스모크·프리미엄 검사의 기본 주소는 `http://127.0.0.1:8099`입니다. 다른 로컬 포트는
`BASE_URL`로 지정합니다. 오디오 검사는 자체 브라우저 픽스처를 실행하며 일반
`npm test`는 선택 실행인 WebAudio 항목을 건너뜁니다. 지원되는 호스트에서 추가
엔진과 시스템 라이브러리를 설치하면 전체 결정론 검사를 실행할 수 있습니다.

```bash
npx playwright install --with-deps chromium webkit firefox
npm run qa:webkit
npx tsx tools/qa/selftest.ts --require=chromium,webkit,firefox
```

모바일·판독성·격자 검사는 [QA 안내](../tools/qa/README.md)를 참고하세요.
스크린샷은 Git에서 제외된 `tools/qa/out/`에 저장됩니다. 날짜가 있는
[품질 보고서](quality/2026-09-13-premium-report.md)에 개발 호스트에서 WebKit을
실행한 컨테이너 구성을 기록했습니다.

### 배포 없이 인프라 확인

다음 명령은 커밋된 VPC 조회 캐시를 사용합니다. 계정·리전은 캐시와 같아야 하며,
리소스 배포나 컨테이너 빌드는 하지 않습니다.

```bash
CDK_DEFAULT_ACCOUNT=061525506239 CDK_DEFAULT_REGION=ap-northeast-2 \
AWS_REGION=ap-northeast-2 AWS_EC2_METADATA_DISABLED=true CDK_DOCKER=echo \
CDK_DISABLE_VERSION_CHECK=1 \
npx cdk synth --quiet --no-lookups --no-notices
```

첫 변경 전에 [아키텍처](architecture.md), [구현 참조](reference/INDEX.md),
[기여 안내](../CONTRIBUTING.md)를 읽어 주세요. 실제 AWS 운영은
[릴리스 런북](runbooks/release.md)에 정리했습니다.
