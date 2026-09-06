# 시크릿 런북 / Secrets Runbook

대상: `ClawdEchoTowerStack`(리전 `ap-northeast-2`)이 만드는 Secrets Manager 시크릿 세 개. 모두 CDK가 `GenerateSecretString`으로 생성하고(`infra/lib/constructs/service.ts`), 합성된 템플릿에는 평문이 없다(테스트로 단언). 값은 콘솔이나 `aws secretsmanager get-secret-value`로만 볼 수 있다.

| 논리 이름 (CDK) | 용도 | 길이 | 소비자 | 회전 시 영향 |
| --- | --- | --- | --- | --- |
| `Service/OriginToken` | CloudFront → ALB `X-Origin-Verify` 헤더 값 | 40 | ALB 리스너 규칙(동적 참조) · CloudFront 오리진 커스텀 헤더(동적 참조) | 두 곳이 어긋나면 사이트 전체가 403 |
| `Service/DailySecret` | 데일리 타워 시드 HMAC 키 (`DAILY_SECRET`) | 48 | ECS 컨테이너 시크릿 | **앞으로의** 데일리 시드가 바뀐다. 이미 지난 날짜의 보드는 그대로 |
| `Service/TagSecret` | playerTag HMAC 키 (`TAG_SECRET`) | 48 | ECS 컨테이너 시크릿 | 모든 플레이어의 playerTag가 바뀐다 |

실제 시크릿 이름은 `ClawdEchoTowerStack-ServiceOriginToken…` 같은 CloudFormation 생성 이름이다. 찾는 법:

```bash
aws secretsmanager list-secrets --filters Key=description,Values="CLAWD ECHO TOWER" \
  --query 'SecretList[].{Name:Name,Desc:Description}' --output table
```

## 0. 원칙

- 시크릿은 코드·`cdk.json`·`cdk-outputs.json`·로그·이슈에 절대 적지 않는다. 컨테이너에는 환경변수로만 들어가고(`ecs.Secret.fromSecretsManager`), 서버는 값을 로그에 남기지 않는다.
- 세 시크릿은 서로 독립이다. 하나를 회전해도 나머지는 건드리지 않는다(TAG_SECRET을 DAILY_SECRET과 분리한 이유).
- 자동 회전(Secrets Manager rotation Lambda)은 붙이지 않았다. 스택에 Lambda가 없다는 원칙을 지키고, 회전 자체가 아래처럼 사이트 동작을 바꾸므로 사람이 시점을 정한다.
- 회전은 트래픽이 낮은 시간에, `npm run postdeploy:check`가 PASS인 상태에서 시작한다.

## 1. 오리진 토큰 (`X-Origin-Verify`) 회전

토큰은 ALB 리스너 규칙 조건과 CloudFront 오리진 헤더 **두 곳**에 CloudFormation 동적 참조(`{{resolve:secretsmanager:…}}`)로 들어간다. CloudFormation은 동적 참조를 스택 업데이트 시점에만 다시 읽으므로, 시크릿 값만 바꾸면 아무 데도 반영되지 않는다. 두 곳을 같은 배포에서 함께 갱신해야 한다.

```bash
TOKEN_ARN=$(aws secretsmanager list-secrets --filters Key=description,Values="X-Origin-Verify" \
  --query 'SecretList[0].ARN' --output text)

# 1) 새 값 생성 (문장부호 없이 40자 — 리스너 규칙 조건은 128자 이하·ASCII)
aws secretsmanager put-secret-value --secret-id "$TOKEN_ARN" \
  --secret-string "$(aws secretsmanager get-random-password --exclude-punctuation --password-length 40 --query RandomPassword --output text)"

# 2) 두 소비자를 한 번에 갱신: 스택을 다시 배포한다
#    리스너 규칙(ap-northeast-2)과 CloudFront 배포(글로벌)가 같은 changeset 안에서 바뀐다.
#    CloudFront 전파(수 분) 동안 일부 엣지는 옛 헤더를 보내 403을 받을 수 있다 — 짧고 자동 복구된다.
npm run deploy
npm run postdeploy:check          # 'site /' PASS, 'alb direct blocked' PASS
```

중간 403 창을 완전히 없애려면 리스너 규칙에 새 값·옛 값 두 조건을 잠시 두는 2단계 배포가 필요하다. 현재 트래픽 규모에서는 단일 배포로 충분하다고 판단했고, 필요해지면 `service.ts`의 `Verified` 규칙 `Values`에 옛 값을 임시로 추가하는 방식으로 한다.

주의: 리스너 규칙 조건 값에는 `{{resolve:secretsmanager:…}}`가 그대로 들어가므로, 시크릿 값을 바꾼 뒤 배포 없이 `cdk diff`를 보면 변경이 없다고 나온다. 동적 참조는 배포 시점에만 해석된다.

## 2. `DAILY_SECRET` 회전

데일리 시드는 `HMAC-SHA256(DAILY_SECRET, 날짜)`로 만든다(`src/server/daily.ts`). 키를 바꾸면 **회전 이후 날짜**의 시드가 달라진다. 이미 시작된 오늘의 보드(`LB#daily#<date>`)는 시드가 바뀌면 기존 참가자와 새 참가자가 다른 탑을 오르게 되므로, 회전은 KST 자정(데일리 리셋) 직후에 한다.

```bash
DAILY_ARN=$(aws secretsmanager list-secrets --filters Key=description,Values="daily tower seeds" \
  --query 'SecretList[0].ARN' --output text)
aws secretsmanager put-secret-value --secret-id "$DAILY_ARN" \
  --secret-string "$(aws secretsmanager get-random-password --exclude-punctuation --password-length 48 --query RandomPassword --output text)"

# ECS는 태스크 시작 시점에 시크릿을 읽는다. 새 태스크로 교체해야 새 값이 적용된다.
CLUSTER=$(node -e "console.log(require('./cdk-outputs.json').ClawdEchoTowerStack.ClusterName)")
SERVICE=$(node -e "console.log(require('./cdk-outputs.json').ClawdEchoTowerStack.ServiceName)")
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
curl -s "$SITE/api/daily"          # seed 가 바뀌었는지(자정 직후라면 새 날짜·새 시드)
```

롤링 교체 동안 옛 태스크와 새 태스크가 함께 떠 있는 1~2분은 `/api/daily`가 요청마다 다른 시드를 줄 수 있다. 자정 직후 저트래픽 시간대라면 무시할 수 있고, 그 시간에 시작된 데일리 런은 서버가 시드를 재계산해 검증하므로 옛 시드로 만든 런은 `422`로 거절된다(클라이언트가 다시 시작하도록 안내).

## 3. `TAG_SECRET` 회전

playerTag는 `HMAC(TAG_SECRET, playerId)`에서 파생한 짧은 태그다. 키를 바꾸면 **모든** 플레이어의 태그가 한 번에 바뀐다. 리더보드 항목의 `playerId`는 그대로이므로 순위·기록은 유지되지만, 플레이어가 자기 태그로 기억하던 표시는 달라진다. 태그 유출(다른 사람이 특정 플레이어의 태그를 위조할 수 있다는 의심)이 있을 때만 회전한다.

```bash
TAG_ARN=$(aws secretsmanager list-secrets --filters Key=description,Values="player tags" \
  --query 'SecretList[0].ARN' --output text)
aws secretsmanager put-secret-value --secret-id "$TAG_ARN" \
  --secret-string "$(aws secretsmanager get-random-password --exclude-punctuation --password-length 48 --query RandomPassword --output text)"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
```

서버는 `TAG_SECRET`이 없으면 `DAILY_SECRET`으로 대체한다(P3 이전 배포와의 호환). 그러므로 TAG_SECRET이 처음 도입된 배포에서는 **모든 태그가 한 번 바뀐다** — 릴리스 노트에 적는다.

## 4. 사고 대응 요약

| 증상 | 의심 | 조치 |
| --- | --- | --- |
| 사이트 전체 403 (`site /` FAIL, `alb direct blocked` PASS) | 오리진 토큰이 리스너와 CloudFront 사이에서 어긋남 | `npm run deploy`로 두 곳을 같은 값으로. 배포 실패 시 `docs/runbooks/rollback.md` 1절 |
| `/api/daily` 시드가 요청마다 다름 | DAILY_SECRET 회전 중 롤링 교체 | `aws ecs wait services-stable` 후 재확인 |
| 태그가 전부 바뀌었다는 문의 | TAG_SECRET 회전 또는 첫 도입 배포 | 의도된 동작. 릴리스 노트 링크 |
| 태스크가 `ResourceInitializationError: unable to pull secrets` 로 재시작 | 시크릿 삭제/이름 변경, 또는 실행 역할 권한 | 시크릿이 존재하는지 확인(`list-secrets`). CDK가 만든 실행 역할에는 세 시크릿 `GetSecretValue`가 있다 |

## 5. 절대 하지 말 것

- 시크릿 리소스를 콘솔에서 삭제하거나 이름을 바꾸지 않는다. CDK가 다음 배포에서 새 리소스를 만들면서 컨테이너가 참조하는 ARN이 바뀌고, 삭제 대기(7~30일) 중인 이름과 충돌할 수 있다.
- `cdk.json`이나 `-c` 컨텍스트로 시크릿 값을 넘기지 않는다. 컨텍스트는 `cdk.context.json`과 합성 결과에 남는다.
- 회전 후 옛 값을 어디에도 보관하지 않는다. Secrets Manager는 직전 값을 `AWSPREVIOUS` 라벨로 한 세대만 남기고, 그 다음 회전에서 라벨을 잃은 버전을 정리한다. 유출이 의심되는 값이라면 한 번 더 회전해 `AWSPREVIOUS`에서도 밀어낸다.
