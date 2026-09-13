# Infrastructure implementation reference

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Overview

[ClawdEchoTowerStack](../../infra/lib/stack.ts) declares the path HTTPS viewer → CloudFront → HTTP ALB `:80` → Fastify on Fargate `:8080` → DynamoDB. This reference describes the checked-in CDK configuration and its resource lifecycle.

### Components

| Construct | Implemented responsibility |
| --- | --- |
| [Network](../../infra/lib/constructs/network.ts) | Imports the existing VPC with `Vpc.fromLookup`; selects public subnets for ALB and `PRIVATE_WITH_EGRESS` for tasks. Creates no VPC, subnet, NAT, or endpoint. |
| [Service](../../infra/lib/constructs/service.ts) | Two security groups, ALB/listener/target group, ARM64 Docker asset, ECS cluster/task/service, three generated secrets, application logs, autoscaling. |
| [Data](../../infra/lib/constructs/data.ts) | One on-demand `TableV2` with string `pk`/`sk`, TTL attribute `ttl`, PITR, deletion protection, and daily AWS Backup recovery points retained for `35` days. |
| [Edge](../../infra/lib/constructs/edge.ts) | CloudFront behaviors, origin verification header, viewer HTTPS redirect, CSP/HSTS and other response headers; optional existing viewer certificate. |
| [Observability](../../infra/lib/constructs/observability.ts) | Ten SNS-connected alarms, dashboard, three application metric rollups, and ALB access-log bucket. CloudFront metrics appear on the dashboard; no CloudFront alarm is declared. |

[cdk.json](../../cdk.json) supplies defaults; [infra/bin/app.ts](../../infra/bin/app.ts) reads context and validates task sizing before constructing the stack.

| Input | Checked-in setting or resolution |
| --- | --- |
| `vpcId`, `cloudfrontPrefixListId` | `vpc-0dfa5610180dfa628`, `pl-22a6434b`. |
| `desiredCount`, `taskCpu`, `taskMemory`, `maxTasks` | `2`, `512` CPU units, `1024` MiB, `10`; autoscaling floor is `2`. |
| `domainName`, `certificateArn` | `clawd-game.whchoi.net` and the existing `us-east-1` ACM ARN in `cdk.json`; both must be set together. DNS is managed outside the stack. |
| `alarmEmail` | Unset; SNS topic exists without an email subscription. |
| `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION` | Set the stack environment; [cdk.context.json](../../cdk.context.json) contains the VPC lookup for account `061525506239`, region `ap-northeast-2`, with public/private/isolated subnet groups in `ap-northeast-2a`/`ap-northeast-2b`. |

Task sizing resolves explicit construct props → context → constants. The code validates its CPU/memory combinations, integer `maxTasks >= 2`, and `desiredCount <= maxTasks`. Tasks receive no public IP; imported private-subnet egress is an external dependency.

| Repository command | Lifecycle effect |
| --- | --- |
| `npm run synth` | `cdk synth --quiet`, running `npx tsx infra/bin/app.ts`; lookup cache must match the target account/region or a lookup is needed. |
| `npm run deploy` | `cdk deploy --require-approval never --outputs-file cdk-outputs.json`; deploys the stack and Docker asset, writes resource outputs. |
| `npm run release:dry` | Prints the release plan without executing it. The full release script checks types/levels/tests, prepares version/changelog, builds, deploys, checks, invalidates, checks assets, commits/tags. |
| `npm run destroy` | `cdk destroy --force`; the DynamoDB table is retained. The access-log bucket has no automatic object deletion. |

### Key Decisions

1. [Origin admission](../../infra/lib/constructs/service.ts#L196) allows only CloudFront's origin-facing prefix list on ALB TCP `80`; the listener defaults to `403` and forwards only a matching `X-Origin-Verify`. Tasks accept `8080` only from the ALB security group. Both groups allow outbound traffic.
2. [Secret wiring](../../infra/lib/constructs/service.ts#L175) generates a `40`-character origin token and separate `48`-character daily/tag keys. CloudFront and the listener consume the origin token as dynamic references; only `DAILY_SECRET` and `TAG_SECRET` enter ECS as container secrets. The task role receives table read/write access.
3. [Dockerfile](../../Dockerfile) builds with Node `22` Alpine and runs as `node`, copying the bundled server/static files without runtime `node_modules`. The asset targets Linux ARM64; `APP_VERSION` is its hash. Docs, tests, infrastructure, and authored level sources are excluded from the image context; generated simulation modules remain included.
4. [Service rollout](../../infra/lib/constructs/service.ts#L312) enables circuit-breaker rollback, `100%` minimum / `200%` maximum healthy tasks, and `60` seconds of health grace. ALB probes `/healthz` every `15` seconds with a `5`-second timeout; target draining lasts `15` seconds.
5. [Scaling](../../infra/lib/constructs/service.ts#L326) targets CPU `60%` and `400` requests/target, with `60`-second scale-out / `120`-second scale-in cooldowns. ALB p95 above `0.8` seconds for two one-minute periods adds two tasks with a `60`-second cooldown, within the configured ceiling.

Cache behavior combines [Edge](../../infra/lib/constructs/edge.ts#L130) with [static headers](../../src/server/static.ts#L15) and [leaderboard headers](../../src/server/routes/leaderboard.ts#L25):

| Path | Methods and caching |
| --- | --- |
| `/assets/*` | GET/HEAD; `CACHING_OPTIMIZED`, origin one-year immutable, edge compression. |
| `/api/leaderboard*` | GET/HEAD; full query-string cache key, TTL min/default `0`, max `60` seconds; origin `s-maxage=5, stale-while-revalidate=30`; ordered before `/api/*`. |
| `/api/*` | All methods, `CACHING_DISABLED`; forwards viewer/CloudFront headers including viewer address. Compression happens in Fastify. |
| Default | GET/HEAD; origin-controlled cache with TTL min/default `0`, max one day. `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest` use `max-age=0, s-maxage=60, stale-while-revalidate=300`. |

The origin connection is HTTP; viewer connections redirect to HTTPS. The configured custom domain uses SNI and `TLS_V1_2_2021`; the distribution enables HTTP/2+3, IPv6, and `PRICE_CLASS_200`. Error-cache TTLs for `403`/`404` are zero.

The table uses `RETAIN` and deletion protection. Application logs retain `14` days and use `DESTROY`; the private, encrypted ALB log bucket expires objects after `30` days and also uses `DESTROY`, without `autoDeleteObjects`, so a nonempty bucket needs emptying before deletion. Enhanced Container Insights is enabled on the cluster.

### Code Pointers

- [Stack composition, certificate import, and outputs](../../infra/lib/stack.ts#L50): site/distribution, ALB, table, cluster/service, alarm topic, dashboard, access-log bucket.
- [Image exclusions and sizing constants](../../infra/lib/constructs/service.ts#L23), [runtime environment and task role](../../infra/lib/constructs/service.ts#L290), [response-header policy](../../infra/lib/constructs/edge.ts#L79).
- [Alarm thresholds and metric filters](../../infra/lib/constructs/observability.ts), [data retention/backup](../../infra/lib/constructs/data.ts#L26), [release sequence and invalidation paths](../../tools/release.mjs).
- [Infrastructure assertions](../../test/infra/stack.test.ts), [CI lookup environment and checks](../../.github/workflows/ci.yml), [package commands](../../package.json#L11).

### Cross-references

- [Server](server.md) · [Architecture](../architecture.md) · [Onboarding](../onboarding.md).
- [Scale runbook](../runbooks/scale.md) · [Rollback runbook](../runbooks/rollback.md) · [Secrets runbook](../runbooks/secrets.md).

---

<a id="korean"></a>
## 한국어

### 개요 (Overview)

[ClawdEchoTowerStack](../../infra/lib/stack.ts)은 HTTPS 사용자 → CloudFront → HTTP ALB `:80` → Fargate의 Fastify `:8080` → DynamoDB 경로를 선언합니다. 이 문서는 저장소의 CDK 설정과 리소스 수명 주기를 설명합니다.

### 구성 요소 (Components)

| 구성체 | 구현된 책임 |
| --- | --- |
| [Network](../../infra/lib/constructs/network.ts) | `Vpc.fromLookup`으로 기존 VPC를 가져옵니다. ALB는 퍼블릭 서브넷, 태스크는 `PRIVATE_WITH_EGRESS`를 선택하며 VPC·서브넷·NAT·엔드포인트는 만들지 않습니다. |
| [Service](../../infra/lib/constructs/service.ts) | 보안 그룹 두 개, ALB·리스너·대상 그룹, ARM64 Docker 에셋, ECS 클러스터·태스크·서비스, 생성 시크릿 세 개, 애플리케이션 로그, 자동 확장을 담당합니다. |
| [Data](../../infra/lib/constructs/data.ts) | 문자열 `pk`/`sk`, TTL 속성 `ttl`, PITR, 삭제 보호가 있는 온디맨드 `TableV2` 하나와 복구 지점을 `35`일 보관하는 일간 AWS Backup을 만듭니다. |
| [Edge](../../infra/lib/constructs/edge.ts) | CloudFront 동작, 원본 검증 헤더, 사용자 HTTPS 리디렉션, CSP·HSTS 등 응답 헤더, 선택적 기존 사용자 인증서를 구성합니다. |
| [Observability](../../infra/lib/constructs/observability.ts) | SNS 연결 알람 열 개, 대시보드, 애플리케이션 메트릭 집계 세 개, ALB 액세스 로그 버킷을 만듭니다. CloudFront 메트릭은 대시보드에 표시하며 CloudFront 알람은 선언하지 않습니다. |

[cdk.json](../../cdk.json)이 기본값을 제공하고 [infra/bin/app.ts](../../infra/bin/app.ts)가 컨텍스트를 읽어 스택 생성 전에 태스크 크기를 검증합니다.

| 입력 | 저장소 설정 또는 결정 방식 |
| --- | --- |
| `vpcId`, `cloudfrontPrefixListId` | `vpc-0dfa5610180dfa628`, `pl-22a6434b`입니다. |
| `desiredCount`, `taskCpu`, `taskMemory`, `maxTasks` | `2`, CPU `512`단위, `1024` MiB, `10`; 자동 확장 하한은 `2`입니다. |
| `domainName`, `certificateArn` | `clawd-game.whchoi.net`과 `cdk.json`의 기존 `us-east-1` ACM ARN이며 둘을 함께 설정해야 합니다. DNS는 스택 밖에서 관리합니다. |
| `alarmEmail` | 미설정이며 이메일 구독 없이 SNS 토픽을 만듭니다. |
| `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION` | 스택 환경을 정합니다. [cdk.context.json](../../cdk.context.json)은 계정 `061525506239`, 리전 `ap-northeast-2`의 VPC 조회 결과와 `ap-northeast-2a`/`ap-northeast-2b`의 public/private/isolated 서브넷 그룹을 담고 있습니다. |

태스크 크기는 명시적 구성체 속성 → 컨텍스트 → 상수 순서로 결정합니다. 코드는 지원하는 CPU·메모리 조합, 정수 `maxTasks >= 2`, `desiredCount <= maxTasks`를 검증합니다. 태스크에는 퍼블릭 IP를 부여하지 않으며 기존 프라이빗 서브넷의 송신 경로에 의존합니다.

| 저장소 명령 | 수명 주기에 미치는 영향 |
| --- | --- |
| `npm run synth` | `npx tsx infra/bin/app.ts`를 실행하는 `cdk synth --quiet`입니다. 조회 캐시가 대상 계정·리전과 일치해야 하며 그렇지 않으면 조회가 필요합니다. |
| `npm run deploy` | `cdk deploy --require-approval never --outputs-file cdk-outputs.json`; 스택과 Docker 에셋을 배포하고 리소스 출력을 기록합니다. |
| `npm run release:dry` | 실행 없이 릴리스 계획을 출력합니다. 전체 릴리스 스크립트는 타입·레벨·테스트 검사, 버전·변경 기록 준비, 빌드, 배포, 점검, 무효화, 에셋 검사, 커밋·태그 순서입니다. |
| `npm run destroy` | `cdk destroy --force`; DynamoDB 테이블은 보존합니다. 액세스 로그 버킷에는 자동 객체 삭제가 없습니다. |

### 주요 결정 (Key Decisions)

1. [원본 접근](../../infra/lib/constructs/service.ts#L196)은 ALB TCP `80`에 CloudFront 원본 접근용 prefix list만 허용합니다. 리스너 기본 응답은 `403`이며 `X-Origin-Verify`가 일치할 때만 전달합니다. 태스크는 ALB 보안 그룹에서 오는 `8080`만 받고 두 그룹 모두 송신을 허용합니다.
2. [시크릿 연결](../../infra/lib/constructs/service.ts#L175)은 `40`문자 원본 토큰과 별도의 `48`문자 daily/tag 키를 생성합니다. CloudFront와 리스너는 원본 토큰을 동적 참조로 사용하고, ECS 컨테이너 시크릿에는 `DAILY_SECRET`과 `TAG_SECRET`만 들어갑니다. 태스크 역할에는 테이블 읽기·쓰기 권한을 부여합니다.
3. [Dockerfile](../../Dockerfile)은 Node `22` Alpine으로 빌드하며 번들된 서버·정적 파일을 복사해 런타임 `node_modules` 없이 `node` 사용자로 실행합니다. 에셋 대상은 Linux ARM64이고 `APP_VERSION`은 에셋 해시입니다. 문서·테스트·인프라·작성용 레벨 소스는 이미지 컨텍스트에서 제외하고 생성된 시뮬레이션 모듈은 포함합니다.
4. [서비스 배포](../../infra/lib/constructs/service.ts#L312)는 서킷 브레이커 롤백, 정상 태스크 최소 `100%` / 최대 `200%`, 헬스 유예 `60`초를 설정합니다. ALB는 `15`초마다 `/healthz`를 검사하고 타임아웃은 `5`초이며 대상 연결 정리는 `15`초입니다.
5. [자동 확장](../../infra/lib/constructs/service.ts#L326)은 CPU `60%`와 대상당 요청 `400`회를 목표로 하며 확장 대기 `60`초 / 축소 대기 `120`초를 사용합니다. ALB p95가 1분 구간 두 번 동안 `0.8`초를 넘으면 설정된 상한 안에서 태스크 두 개를 추가하고 `60`초를 기다립니다.

캐시 동작은 [Edge](../../infra/lib/constructs/edge.ts#L130), [정적 헤더](../../src/server/static.ts#L15), [리더보드 헤더](../../src/server/routes/leaderboard.ts#L25)의 조합으로 결정됩니다.

| 경로 | 메서드와 캐시 |
| --- | --- |
| `/assets/*` | GET/HEAD; `CACHING_OPTIMIZED`, 원본 1년 immutable, 엣지 압축입니다. |
| `/api/leaderboard*` | GET/HEAD; 전체 쿼리 문자열을 캐시 키로 사용하며 TTL 최소·기본 `0`, 최대 `60`초입니다. 원본은 `s-maxage=5, stale-while-revalidate=30`이며 `/api/*`보다 먼저 배치합니다. |
| `/api/*` | 모든 메서드, `CACHING_DISABLED`; 사용자 주소를 포함한 viewer/CloudFront 헤더를 전달하며 Fastify에서 압축합니다. |
| 기본 | GET/HEAD; 원본이 캐시를 제어하며 TTL 최소·기본 `0`, 최대 1일입니다. `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`는 `max-age=0, s-maxage=60, stale-while-revalidate=300`을 사용합니다. |

원본 연결은 HTTP이고 사용자 연결은 HTTPS로 리디렉션합니다. 설정된 사용자 도메인은 SNI와 `TLS_V1_2_2021`을 사용하며 배포는 HTTP/2+3, IPv6, `PRICE_CLASS_200`을 활성화합니다. `403`/`404` 오류 캐시 TTL은 0입니다.

테이블은 `RETAIN`과 삭제 보호를 사용합니다. 애플리케이션 로그는 `14`일 보관하며 `DESTROY`를 사용합니다. 비공개·암호화된 ALB 로그 버킷은 객체를 `30`일 뒤 만료시키고 `DESTROY`를 사용하지만 `autoDeleteObjects`가 없어 비어 있지 않으면 삭제 전에 비워야 합니다. 클러스터에는 Enhanced Container Insights를 활성화합니다.

### 코드 위치 (Code Pointers)

- [스택 조립, 인증서 가져오기, 출력](../../infra/lib/stack.ts#L50): 사이트·배포, ALB, 테이블, 클러스터·서비스, 알람 토픽, 대시보드, 액세스 로그 버킷입니다.
- [이미지 제외 항목과 크기 상수](../../infra/lib/constructs/service.ts#L23), [런타임 환경과 태스크 역할](../../infra/lib/constructs/service.ts#L290), [응답 헤더 정책](../../infra/lib/constructs/edge.ts#L79).
- [알람 기준과 메트릭 필터](../../infra/lib/constructs/observability.ts), [데이터 보관·백업](../../infra/lib/constructs/data.ts#L26), [릴리스 순서와 무효화 경로](../../tools/release.mjs).
- [인프라 검증 코드](../../test/infra/stack.test.ts), [CI 조회 환경과 검사](../../.github/workflows/ci.yml), [패키지 명령](../../package.json#L11).

### 관련 문서 (Cross-references)

- [서버](server.md) · [아키텍처](../architecture.md) · [온보딩](../onboarding.md).
- [스케일 런북](../runbooks/scale.md) · [롤백 런북](../runbooks/rollback.md) · [시크릿 런북](../runbooks/secrets.md).
