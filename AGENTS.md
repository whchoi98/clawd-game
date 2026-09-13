# Repository guidance

CLAWD JUMP: ECHO TOWER is a Korean browser platformer with a shared TypeScript
simulation and server-verified replay leaderboards. Read [README.md](README.md)
for gameplay and [docs/README.md](docs/README.md) for development documentation.

## Entry points and ownership

- `src/client/main.ts` composes the browser application; `scenes.ts` coordinates
  runs, screens, saves and replay submission through `contracts.ts`.
- `src/sim/` is the shared 120 Hz engine. `types.ts` owns the input bits,
  `SIM_VERSION` and `GEN_VERSION`; `replay.ts` owns encoding and verification.
- `src/shared/protocol.ts` defines API schemas. `src/server/index.ts` starts
  Fastify, the repository and verification worker; `app.ts` composes routes.
- `levels/zones/` and `levels/chunks/` are authored with `levels/dsl.ts`.
  `levels/build.ts` generates `src/sim/{levels,echoes,chunks}.generated.ts`.
- `infra/bin/app.ts` and `infra/lib/stack.ts` compose AWS CDK infrastructure.
  The stack imports an existing VPC; deployment settings live in `cdk.json`.
- `tools/build.mjs` builds the client, service worker and server. `tools/dev.mjs`
  watches sources on port 8099 and removes `TABLE_NAME` from its child environment.

## Development and checks

Use Node.js 20 or newer; CI and the Dockerfile use Node.js 22. Install with
`npm ci`, then start with `npm run dev`.

```bash
npm run typecheck
npm run levels -- --check
npx tsx tools/hash-corpus.ts --check
npm test
npm run build -- --prod
```

Choose additional checks for the change: `npm run qa:smoke`, `qa:mobile`,
`qa:premium`, `qa:webkit`, `qa:readability` and `qa:grid` need a running server
(`BASE_URL`, default `http://127.0.0.1:8099`). `npm run qa:audio` separately
enables the Chromium WebAudio tests. See [onboarding](docs/onboarding.md) and
[the QA guide](tools/qa/README.md); do not report skipped browser tests as passed.

## Invariants

- Keep DOM, Canvas, WebAudio, Node APIs and wall-clock time out of `src/sim/`.
  Use its deterministic math and seeded RNG; input edges come from tick masks.
- Do not hand-edit generated simulation files. Regenerate from the DSL and
  replay corpora, then review both source and generated changes.
- Changes to replay behavior, shipped geometry or generator output require
  reviewing `SIM_VERSION`, zone `rev`, `GEN_VERSION`, golden replays and corpus
  digests together. Never regenerate fixtures merely to silence a regression.
- Keep simulation state separate from visual effects and replay-viewer state.
  Preserve save migrations, cross-tab merging and the persistent submission queue.
- Validate API changes against shared schemas and server replay checks. Public
  leaderboards must not expose raw player IDs or cache personal `/api/me` rows.
- Keep `.dockerignore` and `IMAGE_CONTEXT_EXCLUDE` in
  `infra/lib/constructs/service.ts` aligned when changing image input exclusions.
  Keep `cdk.context.json` tracked for credential-free CI synthesis.

## Documentation and Git

Update affected guides and `CHANGELOG.md` under `[Unreleased]`. Preserve published
release entries and dated quality evidence. Existing Korean documents stay Korean;
new public guides use English followed by Korean with matching facts and commands.
Use two-space indentation, LF and the repository's `.js` TypeScript import suffixes.

Review the exact staged diff and run checks relevant to it. Keep secrets, local
environment files, generated build outputs and session state out of Git.
`clawd-jump.tar.gz` is the original reference project, not an ECHO TOWER release
archive. Deployment, release tagging and infrastructure destruction are distinct
from a normal documentation commit; follow the user's requested Git scope.
