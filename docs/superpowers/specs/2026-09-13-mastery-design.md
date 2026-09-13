# Mastery, rewards and replay motivation

The commercial-quality goal continues after the presentation/reliability pass.
Current production aggregates (2026-09-08 through 2026-09-13) contain seven boot
sessions, one t1 start and no clear. They are insufficient to tune level geometry
or claim a player retention result. Existing novice heatmaps are directional bot
probes; zero-clear vertical runs do not prove that human players cannot finish.

The current code already awards four medals per zone and unlocks eight skins.
Their rules and next steps are poorly exposed: medal slots are small symbols,
skin progress lives inside settings, and a replay attempt has no chosen goal.
This pass makes those existing accomplishments a coherent play loop.

## Requirements

1. A **도전 수첩** modal shows all story medals with readable criteria, completion
   totals and all eight character appearances with exact unlock progress.
   Unavailable zones explain their lock. Earned skins can be equipped here.
2. A zone's goal can be automatic, free play, or one of its attainable medals:
   nodeath, par, shards, relic. Automatic goals only suggest a replay target
   after a first clear, in the order relic → shards → par → nodeath. Empty
   collectible categories cannot become goals. A fully mastered zone is free
   play by default.
3. Goal preferences persist in Settings, independently of earned progress.
   Pinning a goal never awards anything or unlocks a zone.
4. The live HUD shows the selected goal and real progress. It never announces a
   medal before the goal is reached. A missed nodeath/par attempt remains missed
   after checkpoint retry. Whole-run retry resets the live status.
5. Result feedback explains whether the selected goal was achieved and presents
   the next attainable unearned goal with a direct retry. Existing medal rules
   stay authoritative: assisted story clears still earn local medals, while a
   locked race records no local progress and must not claim a medal. Public
   leaderboard eligibility remains separate.
6. Journal, goal selection, result retry and skin equipment work with keyboard,
   controller navigation and touch. Their overlays pause the original run;
   closing them preserves its input log, elapsed time and state.
7. Existing physics, authored geometry, replay versions and ranking contracts
   remain valid. This adds motivations and feedback to actual gameplay.

## Structure

- `goal-settings.ts`: small preference schema/normalizer without UI dependencies.
- `goals.ts`: pure goal selection/evaluation and skin milestone projections,
  using existing medal/unlock rules.
- `ui/journal.ts`: medal matrix, criteria and skin gallery.
- `ui/objective.ts`: reusable goal picker/live/result surfaces.
- `contracts.ts`, `save.ts`, `scenes.ts`, `ui/ui.ts`: persistence and lifecycle.

The visual language remains the expedition/tower palette. Give achievements real
names and readable states, keep gameplay feedback compact, and retain a free-play
option. No currency, streak penalty, artificial scarcity, new service or account
is needed.

## Validation

Verify goal boundaries against the real medal award rules; save sanitization and
reload; assist behavior; post-clear target selection; checkpoint/full retry
semantics; no mutation from journal/preview; modal focus and responsive layout.
Run existing game/corpus checks as well as real browser journal journeys. Record
the production aggregate's sampling limit separately from synthetic evidence.
