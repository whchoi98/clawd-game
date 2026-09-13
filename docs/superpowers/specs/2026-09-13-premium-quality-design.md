# ECHO TOWER — premium quality upgrade

The owner asked to analyse the current project and upgrade the game toward the
quality of a top commercial game. This is a whole-player-experience initiative,
not a claim that passing a test suite proves commercial success.

## Evidence and direction

The starting tree is `ab2d975`, version 0.5.0. It contains 16 authored story zones,
four biomes, deterministic replay verification, daily/endless towers, procedural
art/audio, progression, medals and an offline shell. Existing solutions cover
all story zones; both pending-solution manifests are empty.

Screenshots taken on 2026-09-13 show a detailed playable world but a title vista
without the titular tower, a selection screen dominated by anonymous blurred
locks, and no player-facing way to study the bundled verified demonstrations.
These are concrete improvements to identity, motivation and learning. Reliability
audits cover persistence/network delivery and input/focus/audio independently.

## Product requirements

1. **Recognisable title.** A procedural, layered tower rising through the game's
   four biomes, with a clear summit beacon and restrained echo motion. Keep the
   character visible and the first action readable. Korean story copy describes
   the climb rather than backend implementation. Preserve first-Enter-to-play.
2. **Readable campaign.** Every chapter and zone remains identifiable when
   locked. Explain how to unlock it. Show the highlighted zone's actual terrain,
   core technique, par, collectibles and record. Keyboard, controller and pointer
   highlight the same preview; touch can still start a zone directly. The next
   unfinished unlocked zone is explicit. Do not create a second unlock algorithm.
3. **Learn from a real run.** Offer the current bundled goal replay from the
   campaign and pause screens, with play/pause, restart, 0.5×/1×/2×, seek and
   checkpoint navigation. Display the demonstrated input. This must run the real
   Sim and reproduce a verified finish, not an animation of a fabricated path.
   Watching never changes progression, settings, submissions or a suspended run.
   Closing returns to the invoking screen and restores the suspended world.
4. **Fast recovery.** A pause-menu checkpoint retry uses the existing replay
   input bit, remains server-verifiable, and resumes the same run. Whole-zone
   restart remains separately labelled.
5. **Reliable controls and progress.** Fix reproduced failures from the two
   audits; regression tests must fail on the old implementation. Preserve current
   saves, offline operation, assist eligibility and all replay version contracts.
6. **Release evidence.** Type checks, generated-level check, corpus check, full
   test suite, production build, real-input browser smoke, mobile layout,
   readability and the new campaign/replay/retry journeys must pass. Inspect
   desktop and mobile screenshots. Record measured performance and any platform
   coverage gaps honestly.

## Visual language

- Ink `#07111C`, deep water `#102A39`, sea glass `#7FE3D6`, coral
  `#F28C6A`, warm signal `#F4C95D`, paper `#F3F6F4`.
- Preserve Outfit display/numerals and Noto Sans KR body, including local
  fallbacks. No additional fonts, raster downloads or libraries.
- The tower silhouette is the signature. Menus are quiet, compact expedition
  controls, with generous desktop spacing and usable landscape-phone density.
- Motion communicates the route or input. Reduced motion, quality tiers and
  hidden-tab lifecycle apply to new presentation.

## Technical boundaries

Keep `src/sim`, its constants and level geometry unchanged for these features.
Replay viewing is client-only and separate from `Scenes.run`. A standalone
transport owns its Sim, masks, tick cursor, speed and checkpoint index. A
campaign module derives readable metadata and lightweight previews from
`LevelDef`, existing records and `unlockedZones`. Procedural title art has its own
render module. UI emits intent; Scenes owns run transitions and retry recording.

No new dependency, external service, monetisation, account system, production
deployment or changed leaderboard contract is needed for this upgrade.

## Completion

Requirements above must have direct code, runtime and test evidence. A polished
title alone, a passing old suite alone, or bot solutions alone are insufficient.
The quality report must distinguish implemented/verified work from actual device
coverage and player research that has not occurred.
