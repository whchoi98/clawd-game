# 롤백 런북 / Rollback Runbook

대상: CLAWD JUMP: ECHO TOWER 프로덕션 스택 `ClawdEchoTowerStack`(CloudFront → ALB → ECS Fargate → DynamoDB, 리전 `ap-northeast-2`).
릴리스는 `npm run release`(`tools/release.mjs`)로만 나가고, 성공한 릴리스마다 git 태그 `vX.Y.Z`와 `CHANGELOG.md` 항목이 남는다. 이 문서는 그 릴리스를 되돌리는 절차다.

## 0. 언제 롤백하나

- `npm run postdeploy:check`가 FAIL을 내는데 원인이 5분 안에 안 보일 때.
- CloudWatch에서 ALB 5xx, ECS 태스크 재시작 루프, `JsErrorCount`(EMF 메트릭, 네임스페이스 `ClawdEchoTower`) 급증이 보일 때.
- 클라이언트가 `sim-version`(422)으로 제출을 대량 거절당할 때 — 서버와 클라이언트의 `SIM_VERSION`이 어긋난 배포다(아래 3절).

먼저 확인할 것:

```bash
SITE=$(node -e "console.log(require('./cdk-outputs.json').ClawdEchoTowerStack.SiteUrl.replace(/\/$/,''))")
curl -s "$SITE/api/health"        # version · simVersion · genVersion
curl -s "$SITE/api/daily"         # gen · sim
git tag --sort=-v:refname | head  # 현재 태그와 직전 태그
```

## 1. 방법 A — 직전 태그로 `cdk deploy` (권장, 5–8분)

인프라·이미지·정적 자산을 한 번에 이전 상태로 되돌린다. 롤백도 일반 배포와 같은 경로를 타므로 `postdeploy:check`와 무효화까지 그대로 수행한다.

```bash
PREV=$(git tag --sort=-v:refname | sed -n 2p)   # 직전 릴리스 태그, 예: v0.1.9
git switch --detach "$PREV"
npm ci
npm run build
npm run deploy                                   # cdk deploy --require-approval never --outputs-file cdk-outputs.json
npm run postdeploy:check                         # /api/health.simVersion == 이 트리의 SIM_VERSION 까지 확인한다
```

CloudFront 캐시를 비운다(정적 자산은 태스크가 서빙하므로 `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`가 이전 해시를 가리키게 해야 한다):

```bash
DIST=$(node -e "console.log(require('./cdk-outputs.json').ClawdEchoTowerStack.DistributionId)")
INV=$(aws cloudfront create-invalidation --distribution-id "$DIST" \
  --paths / /index.html /sw.js /manifest.webmanifest --query 'Invalidation.Id' --output text)
aws cloudfront wait invalidation-completed --distribution-id "$DIST" --id "$INV"
```

마지막으로 `index.html`이 참조하는 `/assets/*`가 모두 200인지 확인한다(`tools/release.mjs`의 assets 단계와 같다):

```bash
curl -s "$SITE/index.html" | grep -o '/assets/[A-Za-z0-9._-]*' | sort -u | while read -r a; do
  for i in $(seq 1 20); do curl -s -o /dev/null -w '%{http_code} ' "$SITE$a"; done; echo " $a"
done
```

롤백이 끝나면 `main`으로 돌아가 원인을 고치고, 다음 릴리스를 정상 절차로 낸다. 롤백 자체는 태그를 만들지 않는다.

## 2. 방법 B — ECS 태스크 정의 리비전 롤백 (서버 코드만 문제일 때, 2–4분)

인프라 변경 없이 컨테이너만 문제라면 서비스가 직전 태스크 정의 리비전을 쓰게 한다. CDK가 만든 서비스는 배포 서킷 브레이커가 켜져 있어 헬스체크 실패 시 자동 롤백되지만, 헬스체크는 통과하는데 동작이 잘못된 경우가 이 절차의 대상이다.

```bash
CLUSTER=$(node -e "console.log(require('./cdk-outputs.json').ClawdEchoTowerStack.ClusterName)")
SERVICE=$(node -e "console.log(require('./cdk-outputs.json').ClawdEchoTowerStack.ServiceName)")

# 현재 리비전과 패밀리
CUR=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
FAMILY=$(aws ecs describe-task-definition --task-definition "$CUR" --query 'taskDefinition.family' --output text)
aws ecs list-task-definitions --family-prefix "$FAMILY" --sort DESC --max-items 5 --query 'taskDefinitionArns' --output text

# 직전 리비전으로 교체 (ACTIVE 상태여야 한다; CDK는 이전 리비전을 지우지 않는다)
PREV_TD=$(aws ecs list-task-definitions --family-prefix "$FAMILY" --sort DESC --max-items 2 --query 'taskDefinitionArns[1]' --output text)
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$PREV_TD" --force-new-deployment
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
```

그 다음 1절과 같은 CloudFront 무효화 + `/assets/*` 확인을 반드시 수행한다. 정적 자산은 태스크 이미지 안에 있으므로, 태스크를 되돌리면 `index.html`이 참조하는 해시 파일도 이전 것이 되어야 한다.

주의: 이 방법은 CloudFormation 스택 상태와 실제 서비스가 어긋난다. 다음 `cdk deploy`가 다시 최신 리비전을 올리므로, 원인을 고친 뒤 정상 릴리스로 덮어써서 정리한다.

## 3. SIM_VERSION이 바뀐 릴리스를 되돌릴 때

`SIM_VERSION`/`GEN_VERSION`(`src/sim/types.ts`)이 오른 릴리스를 롤백하면:

- 서버는 `RunSubmit.sim !== SIM_VERSION`(데일리는 `gen`도)을 마스크 디코딩 전에 `422 { reason: 'sim-version' }`으로 거절한다. 새 버전 클라이언트를 캐시한 브라우저는 업데이트 바(`registration.update()`)를 보고 새로고침하면 된다. `/api/health.simVersion`이 클라이언트 번들과 다르면 클라이언트가 스스로 안내한다.
- 스토리 보드는 버전별로 분리되어 있다: `LB#story#<levelId>#s<SIM_VERSION>r<rev>`. 롤백하면 이전 버전 보드가 그대로 다시 보이고, 새 버전 보드는 남아 있다가 재배포 시 다시 쓰인다. 데일리 보드(`LB#daily#<date>`)는 날짜 키를 유지하되 `gen` 불일치 제출이 거절된다.
- 서비스 워커는 자산 해시로 업데이트를 감지하므로 별도 조치가 없다. 단, 무효화(1절)는 꼭 해야 한다.

## 4. 버전 보드 정리 / Purging a versioned board

잘못된 sim으로 쌓인 보드(예: 테스트 배포가 만든 `s3r0`)를 지울 때. 테이블 이름은 `cdk-outputs.json`의 `TableName`.

```bash
TABLE=$(node -e "console.log(require('./cdk-outputs.json').ClawdEchoTowerStack.TableName)")
PK='LB#story#t1#s3r0'          # 지울 보드. 데일리는 LB#daily#2026-09-06

# 1) 보드 항목(LB) 나열 — runId, playerId를 함께 뽑아 둔다
aws dynamodb query --table-name "$TABLE" \
  --key-condition-expression 'pk = :pk' --expression-attribute-values '{":pk":{"S":"'"$PK"'"}}' \
  --projection-expression 'pk, sk, runId, playerId, #m, board' --expression-attribute-names '{"#m":"mode"}' \
  --output json > /tmp/board.json
jq '.Count' /tmp/board.json

# 2) LB 항목 삭제 (25개씩 batch-write)
jq -c '[.Items[] | {DeleteRequest: {Key: {pk: .pk, sk: .sk}}}] | _nwise(25) | {"'"$TABLE"'": .}' /tmp/board.json \
  | while read -r batch; do aws dynamodb batch-write-item --request-items "$batch" >/dev/null; done

# 3) 같은 보드의 PLAYER 베스트 항목 삭제 — sk 가 BEST#story#t1#s3r0 인 항목. pk 는 PLAYER#<playerId>
SUFFIX="${PK#LB#}"             # story#t1#s3r0
jq -r '.Items[].playerId.S' /tmp/board.json | sort -u | while read -r pid; do
  aws dynamodb delete-item --table-name "$TABLE" \
    --key '{"pk":{"S":"PLAYER#'"$pid"'"},"sk":{"S":"BEST#'"$SUFFIX"'"}}'
done

# 4) (선택) RUN 항목(리플레이/고스트)도 지우려면 runId 로
jq -r '.Items[].runId.S' /tmp/board.json | while read -r rid; do
  aws dynamodb delete-item --table-name "$TABLE" --key '{"pk":{"S":"RUN#'"$rid"'"},"sk":{"S":"META"}}'
done
```

PLAYER 항목은 pk가 플레이어별이라 보드 단위 쿼리가 없다. 위처럼 LB 항목에서 `playerId`를 모아 지우는 것이 정석이고, LB가 이미 지워진 뒤라면 `aws dynamodb scan --filter-expression 'begins_with(sk, :sk)'`로 `BEST#story#t1#s3r0`를 찾아 지운다(스캔은 테이블 전체를 읽으므로 트래픽이 낮은 시간에).

데일리 보드와 RUN 항목은 `ttl`(30일)로 스스로 사라지므로 보통 정리하지 않는다.

## 5. 롤백 후 점검표

- [ ] `curl $SITE/api/health` — `version`, `simVersion`, `genVersion`이 의도한 태그의 값인가
- [ ] `npm run postdeploy:check` 전부 PASS
- [ ] CloudFront 무효화 `Completed`, `/assets/*` 20회 모두 200
- [ ] CloudWatch: ALB 5xx 0, `SubmitRejected{reason=sim-version}`이 잦아드는가(구 클라이언트 캐시가 빠지는 데 수 분)
- [ ] `CHANGELOG.md` [Unreleased]에 롤백 사실과 원인을 한 줄 남긴다(다음 릴리스 노트가 된다)
