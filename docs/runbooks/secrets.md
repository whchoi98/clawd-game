# 시크릿 런북 / Secrets Runbook

대상: `ClawdEchoTowerStack`(리전 `ap-northeast-2`)이 만드는 Secrets Manager 시크릿 세 개. 모두 CDK가 `GenerateSecretString`으로 생성하고(`infra/lib/constructs/service.ts`), 합성된 템플릿에는 평문이 없다(테스트로 단언). 값은 콘솔이나 `aws secretsmanager get-secret-value`로만 볼 수 있다.

| 논리 이름 (CDK) | 용도 | 길이 | 소비자 | 회전 시 영향 |
| --- | --- | --- | --- | --- |
| `Service/OriginToken` | CloudFront → ALB `X-Origin-Verify` 헤더 값 | 40 | ALB 리스너 규칙(동적 참조) · CloudFront 오리진 커스텀 헤더(동적 참조) | 두 곳이 어긋나면 사이트 전체가 403 |
| `Service/DailySecret` | 데일리 타워 시드 HMAC 키 (`DAILY_SECRET`) | 48 | ECS 컨테이너 시크릿 | 오늘·어제와 이후 날짜의 시드가 바뀐다. 기존 보드 항목은 유지되지만 옛 시드 제출은 거절된다 |
| `Service/TagSecret` | playerTag·진행도 이전 코드 검사 문자 HMAC 키 (`TAG_SECRET`) | 48 | ECS 컨테이너 시크릿 | 플레이어 태그가 바뀌고 기존 이전 코드의 검사 문자에 영향을 준다 |

실제 시크릿 이름은 `ClawdEchoTowerStack-ServiceOriginToken…` 같은 CloudFormation 생성 이름이다. 찾는 법:

```bash
aws secretsmanager list-secrets --filters Key=description,Values="CLAWD ECHO TOWER" \
  --query 'SecretList[].{Name:Name,Desc:Description}' --output table
```

## 0. 원칙

- 시크릿은 코드·`cdk.json`·`cdk-outputs.json`·로그·이슈에 절대 적지 않는다. DailySecret·TagSecret만 컨테이너 환경변수로 주입하며(`ecs.Secret.fromSecretsManager`), OriginToken은 ALB·CloudFront의 동적 참조에 사용한다. 서버는 값을 로그에 남기지 않는다.
- 세 시크릿은 서로 독립이다. 하나를 회전해도 나머지는 건드리지 않는다(TAG_SECRET을 DAILY_SECRET과 분리한 이유).
- 자동 회전(Secrets Manager rotation Lambda)은 붙이지 않았다. 스택에 Lambda가 없다는 원칙을 지키고, 회전 자체가 아래처럼 사이트 동작을 바꾸므로 사람이 시점을 정한다.
- 회전은 트래픽이 낮은 시간에, `npm run postdeploy:check`가 PASS인 상태에서 시작한다.

## 1. 오리진 토큰 (`X-Origin-Verify`) 회전

토큰은 ALB 리스너 규칙 조건과 CloudFront 오리진 헤더 **두 곳**에 CloudFormation 동적 참조(`{{resolve:secretsmanager:…}}`)로 들어간다. 시크릿 값만 바꾸면 소비자가 갱신되지 않는다. [CloudFormation 문서](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-secretsmanager.html)에 따라 동적 참조를 포함한 **각 리소스를 실제로 변경하는 업데이트**가 필요하다. 현재 저장소에는 이를 자동으로 준비하는 회전 명령이 없으므로, 두 리소스의 변경을 검토한 뒤 아래 절차를 실행한다.

```bash
TOKEN_ARN=$(aws secretsmanager list-secrets --filters Key=description,Values="X-Origin-Verify" \
  --query 'SecretList[0].ARN' --output text)

# 1) 새 값 생성 (문장부호 없이 40자 — 리스너 규칙 조건은 128자 이하·ASCII)
aws secretsmanager put-secret-value --secret-id "$TOKEN_ARN" \
  --secret-string "$(aws secretsmanager get-random-password --exclude-punctuation --password-length 40 --query RandomPassword --output text)"

# 2) 리스너 규칙과 CloudFront 배포를 실제로 갱신하는, 검토된 CDK 변경을 배포한다.
#    시크릿 값만 바꾸고 같은 템플릿을 배포하면 두 소비자가 갱신되지 않을 수 있다.
#    전파 중 새 값·옛 값이 어긋나면 403이 발생할 수 있으므로 두 소비자의 적용을 확인한다.
npm run deploy
npm run postdeploy:check          # 'site /' PASS, 'alb direct blocked' PASS
```

중간 403 창을 완전히 없애려면 리스너 규칙에 새 값·옛 값 두 조건을 잠시 두는 2단계 배포가 필요하다. 현재 트래픽 규모에서는 단일 배포로 충분하다고 판단했고, 필요해지면 `service.ts`의 `Verified` 규칙 `Values`에 옛 값을 임시로 추가하는 방식으로 한다.

주의: 동적 참조 문자열이 그대로이면 시크릿 값을 바꿔도 `cdk diff`에 변경이 나타나지 않는다. 변경 없는 `npm run deploy`만으로 회전 적용을 완료했다고 판단하지 않는다.

## 2. `DAILY_SECRET` 회전

데일리 시드는 `HMAC-SHA256(DAILY_SECRET, UTC 날짜)`로 만들며, 조회·검증할 때마다 현재 키로 오늘·어제 시드를 계산한다(`src/server/daily.ts`, `routes/daily.ts`). 리셋은 **UTC 자정(KST 오전 9시)**이다. 키를 바꾸면 오늘·어제 시드도 달라지므로 리셋 직후라도 기존 참가자와 새 참가자가 같은 날짜 보드에서 다른 탑을 오를 수 있고, 옛 시드 기록은 거절된다. 현재 구현에는 날짜별 이전 키를 보존하는 경로가 없으므로, 접수 중인 두 날짜의 기록에 미치는 영향을 확인하고 회전한다.

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
SITE=$(node -e "console.log(require('./cdk-outputs.json').ClawdEchoTowerStack.SiteUrl)")
curl -fsS "${SITE%/}/api/daily"    # 오늘·어제 시드와 UTC 날짜 확인
```

롤링 교체 동안 옛 태스크와 새 태스크가 함께 있으면 `/api/daily`가 요청마다 다른 시드를 줄 수 있다. 교체 완료 후에도 오늘·어제의 옛 시드로 만든 런은 서버 재계산 결과와 달라 `422`로 거절된다. 완료 상태와 반복 조회 결과를 확인하고 영향을 받는 플레이어에게 재시작을 안내한다.

## 3. `TAG_SECRET` 회전

playerTag는 `HMAC(TAG_SECRET, playerId)`에서 파생한 짧은 태그다. 키를 바꾸면 **모든** 플레이어의 태그가 한 번에 바뀐다. 리더보드 항목의 `playerId`는 그대로이므로 순위·기록은 유지되지만, 플레이어가 자기 태그로 기억하던 표시는 달라진다. 태그 유출(다른 사람이 특정 플레이어의 태그를 위조할 수 있다는 의심)이 있을 때만 회전한다.

같은 키는 진행도 이전 코드의 마지막 검사 문자에도 사용한다(`src/server/players.ts`, `transfer.ts`). 회전하면 기존 코드가 `400 bad-code`로 거절될 수 있다. 검사 문자는 32개 중 하나라 키가 달라도 일치할 수 있으므로 키 회전을 모든 코드의 확실한 폐기 수단으로 사용하지 않는다. 롤링 교체가 끝난 뒤 이전 코드를 새로 발급받도록 안내한다.

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
| 사이트 전체 403 (`site /` FAIL, `alb direct blocked` PASS) | 오리진 토큰이 리스너와 CloudFront 사이에서 어긋남 | 1절에 따라 두 소비자 리소스의 실제 갱신을 확인. 배포 실패 시 `docs/runbooks/rollback.md` 1절 |
| `/api/daily` 시드가 요청마다 다름 | DAILY_SECRET 회전 중 롤링 교체 | `aws ecs wait services-stable` 후 재확인 |
| 태그가 전부 바뀌었다는 문의 | TAG_SECRET 회전 또는 첫 도입 배포 | 의도된 동작. 릴리스 노트 링크 |
| 태스크가 `ResourceInitializationError: unable to pull secrets` 로 재시작 | 시크릿 삭제/이름 변경, 또는 실행 역할 권한 | DailySecret·TagSecret 존재와 실행 역할의 두 시크릿 `GetSecretValue` 권한을 확인한다. OriginToken은 컨테이너에 주입하지 않는다 |

## 5. 절대 하지 말 것

- 시크릿 리소스를 콘솔에서 삭제하거나 이름을 바꾸지 않는다. CDK가 다음 배포에서 새 리소스를 만들면서 컨테이너가 참조하는 ARN이 바뀌고, 삭제 대기(7~30일) 중인 이름과 충돌할 수 있다.
- `cdk.json`이나 `-c` 컨텍스트로 시크릿 값을 넘기지 않는다. 컨텍스트는 `cdk.context.json`과 합성 결과에 남는다.
- 회전 후 옛 값을 파일·로그에 복사하지 않는다. `AWSPREVIOUS` 라벨을 옮기는 것과 옛 버전의 삭제는 다르다. [Secrets Manager 버전 문서](https://docs.aws.amazon.com/secretsmanager/latest/userguide/whats-in-a-secret.html)에 따르면 라벨이 있는 버전은 보존되며, 라벨이 없는 버전도 즉시 삭제되지 않는다. 추가 회전만으로 유출된 값이 저장소에서 제거됐다고 판단하지 않는다.
