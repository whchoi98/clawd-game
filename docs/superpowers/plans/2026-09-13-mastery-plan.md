# Mastery implementation plan

**Goal:** Make existing medals and character unlocks clear, selectable reasons to
replay the tower while preserving verified gameplay.

**Spec:** `docs/superpowers/specs/2026-09-13-mastery-design.md`

**Architecture:** Pure goal projections drive persistent preferences and DOM
surfaces. Scenes uses the actual run for live progress; existing medal awards
remain the only source of earned progress.

- [x] Inspect current worktree and production aggregates; distinguish real player
  evidence from the novice bot's limited policy.
- [x] Implement and test goal preference validation, recommendations, live/result
  states and skin unlock progress in `goal-settings.ts` and `goals.ts`.
- [x] Integrate `Settings.goalTargets`, save repair, explicit pin/free/auto actions,
  run goal state and result feedback with meaningful regressions.
- [x] Implement the journal and accessible goal controls, using the existing
  portrait painter and unlock rules.
- [x] Connect title/campaign/pause/result navigation and equipment actions without
  replacing an active run or silently submitting/awarding anything.
- [x] Verify desktop/phone and keyboard/touch workflows in Chromium and WebKit.
- [x] Run typecheck, full tests, level/corpus checks and production build; inspect
  final screens and update the quality report.

Verified build: `bd8f1cb4`. All 1,727 tests pass; Chromium and WebKit each pass
39 real-input journey steps; mobile passes 54 checks; all three browser engines
match the 18 Node corpus digests. The ARM64 image is healthy. Evidence and
screenshots are in `docs/quality/2026-09-13-mastery-report.md`. These results were
recorded before production deployment.

Follow-up: the user authorized production deployment. Release `v0.6.0`, build
`b7a69cd7`, was deployed on 2026-09-13. Production checks and operational state
are recorded in `docs/quality/2026-09-13-release-0.6.0.md`.
