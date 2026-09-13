# Release runbook

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Prepare

[tools/release.mjs](../../tools/release.mjs) is the release entrypoint. Check the
target AWS account, region and [CDK context](../../cdk.json), use a clean working
tree, and put the intended release notes under `[Unreleased]` in
[CHANGELOG.md](../../CHANGELOG.md). An empty section stops release preparation.
Docker must be able to build the ARM64 image; AWS credentials must cover the
existing deployment. Network, DNS and certificate assumptions are described in
[the infrastructure reference](../reference/infrastructure.md).

Inspect the plan without running its steps:

```bash
npm run release:dry -- minor
```

### Execute an authorized release

```bash
export CDK_DEFAULT_ACCOUNT=061525506239
export CDK_DEFAULT_REGION=ap-northeast-2
export AWS_REGION=ap-northeast-2
npm run release -- minor
```

Use `patch` instead of `minor` for a patch release; the default is `patch`.
The orchestrator stops at the first failed step:

1. Typecheck, generated-level check and Vitest.
2. Prepare the npm version and changelog before the build embeds the version.
3. Build production assets, then deploy CDK and write `cdk-outputs.json`.
4. Check deployment paths and versions.
5. Invalidate `/`, `/index.html`, `/sw.js` and `/manifest.webmanifest`; wait for
   completion and request each referenced asset twenty times.
6. Commit the prepared version files and create the annotated `v<version>` tag.

The script does not push Git refs. Publish the resulting commit and tag in the
requested Git workflow after reviewing them. CI builds and tests; it does not
deploy the application.

`--no-deploy` skips only deployment: version preparation and checks against the
resolved deployment still run. `--no-tag` skips the commit and tag, while keeping
version-file edits. Use `--dry-run` when only the plan is needed.

### Verify and recover

```bash
npm run postdeploy:check
npm run postdeploy:smoke
```

The first command checks the edge path, cache/security headers, API versions and
direct ALB access. The second adds Playwright smoke against the deployment.
They use stack outputs from `cdk-outputs.json` or CloudFormation.

If a step fails after version preparation, the version and changelog may already
be modified; inspect the worktree and deployed version before retrying. A failed
verification does not automatically roll back AWS. Follow [rollback](rollback.md)
and preserve the dated evidence under `docs/quality/`. Use [scaling](scale.md),
[anticheat](anticheat.md) and [secrets](secrets.md) for their respective operations.

`npm run destroy` invokes `cdk destroy --force`; it is not a rollback. The
DynamoDB table is retained with deletion protection. Secrets, application logs
and the ALB access-log bucket have deletion policies; the bucket has no automatic
object deletion, so a nonempty bucket can prevent stack deletion. Do not describe
this command as deleting all project data.

<a id="korean"></a>
## 한국어

### 준비

릴리스 진입점은 [tools/release.mjs](../../tools/release.mjs)입니다. 대상 AWS 계정·리전과
[CDK 컨텍스트](../../cdk.json)를 확인하고 깨끗한 작업 트리에서 시작합니다.
[CHANGELOG.md](../../CHANGELOG.md)의 `[Unreleased]`에 배포할 변경을 적으세요.
이 절이 비어 있으면 릴리스 준비가 중단됩니다. Docker가 ARM64 이미지를 빌드할 수
있어야 하며 AWS 자격 증명은 기존 배포를 다룰 수 있어야 합니다. 네트워크·DNS·
인증서 전제는 [인프라 참조](../reference/infrastructure.md)에 있습니다.

각 단계를 실행하지 않고 계획만 확인합니다.

```bash
npm run release:dry -- minor
```

### 승인된 릴리스 실행

```bash
export CDK_DEFAULT_ACCOUNT=061525506239
export CDK_DEFAULT_REGION=ap-northeast-2
export AWS_REGION=ap-northeast-2
npm run release -- minor
```

패치 릴리스는 `minor` 대신 `patch`를 사용하며 기본값도 `patch`입니다.
오케스트레이터는 첫 실패에서 중단합니다.

1. 타입 검사, 생성 레벨 검사, Vitest를 실행합니다.
2. 빌드에 버전이 들어가기 전에 npm 버전과 변경 기록을 준비합니다.
3. 운영 에셋을 빌드하고 CDK를 배포해 `cdk-outputs.json`을 기록합니다.
4. 배포 경로와 버전을 점검합니다.
5. `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`를 무효화하고
   완료를 기다린 뒤 참조 에셋마다 스무 번 요청합니다.
6. 준비한 버전 파일을 커밋하고 주석 태그 `v<version>`을 만듭니다.

스크립트는 Git ref를 푸시하지 않습니다. 생성된 커밋·태그를 검토한 뒤 요청된 Git
흐름으로 게시하세요. CI는 빌드와 검사를 수행하며 앱을 배포하지 않습니다.

`--no-deploy`는 배포만 건너뜁니다. 버전 준비와 확인된 배포에 대한 점검은 계속
실행됩니다. `--no-tag`는 커밋·태그만 생략하고 버전 파일 변경은 남깁니다.
계획만 필요할 때는 `--dry-run`을 사용하세요.

### 검증과 복구

```bash
npm run postdeploy:check
npm run postdeploy:smoke
```

첫 명령은 엣지 경로·캐시/보안 헤더·API 버전·ALB 직접 접근을 점검합니다.
두 번째 명령은 배포 대상에 대한 Playwright 스모크를 추가합니다.
`cdk-outputs.json` 또는 CloudFormation의 스택 출력을 사용합니다.

버전 준비 뒤 실패하면 버전·변경 기록이 이미 수정되어 있을 수 있으므로, 재시도
전에 작업 트리와 배포 버전을 확인하세요. 검증 실패가 AWS를 자동 롤백하지는
않습니다. [롤백](rollback.md) 절차를 따르고 `docs/quality/`에 날짜가 있는 근거를
보존합니다. 각각의 운영에는 [확장](scale.md), [부정 기록 대응](anticheat.md),
[시크릿](secrets.md) 런북을 사용하세요.

`npm run destroy`는 `cdk destroy --force`를 호출하며 롤백 명령이 아닙니다.
DynamoDB 테이블은 삭제 보호와 함께 보존됩니다. 시크릿·앱 로그·ALB 접근 로그
버킷에는 삭제 정책이 있습니다. 버킷 객체는 자동 삭제하지 않으므로 비어 있지
않으면 스택 삭제가 실패할 수 있습니다. 프로젝트 데이터가 전부 삭제되는
명령으로 설명하지 마세요.
