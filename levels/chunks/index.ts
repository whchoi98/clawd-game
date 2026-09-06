/**
 * Registry of the authored tower chunks (roadmap P2-9). Every chunk here is
 * validated by levels/build.ts (validateChunk + the DSL validator on its solo
 * room) and emitted, sorted by id, into src/sim/chunks.generated.ts — the
 * list the generator splices from. The emitted order is part of the generator
 * output (the seeded rng picks by index), so it is sorted by id regardless of
 * the order below; adding, removing or editing a chunk changes the towers and
 * needs a GEN_VERSION bump.
 *
 * Each chunk is proven clearable by a golden replay of its solo room in
 * levels/chunks/solutions/<id>.json (`npm run solve -- --chunks`).
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ChunkDef } from '../../src/sim/gen/chunks.js';
import { readSolutionFile } from '../solutions.js';
import type { Solution } from '../solutions.js';
import { crystalChain } from './crystal-chain.js';
import { crystalGap } from './crystal-gap.js';
import { crystalLadder } from './crystal-ladder.js';
import { dashCrumble } from './dash-crumble.js';
import { dashGap } from './dash-gap.js';
import { dashTwin } from './dash-twin.js';
import { spikeAlley } from './spike-alley.js';
import { switchDash } from './switch-dash.js';
import { switchGate } from './switch-gate.js';
import { switchStairs } from './switch-stairs.js';
import { wallDash } from './wall-dash.js';
import { wallRest } from './wall-rest.js';
import { wallShaft } from './wall-shaft.js';
import { wallZig } from './wall-zig.js';

/** Every authored chunk, sorted by id. */
export const CHUNK_SOURCES: readonly ChunkDef[] = [
  crystalChain, crystalGap, crystalLadder, dashCrumble, dashGap, dashTwin, spikeAlley,
  switchDash, switchGate, switchStairs, wallDash, wallRest, wallShaft, wallZig,
].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Golden replays of the chunk solo rooms. */
export const CHUNK_SOLUTIONS_DIR = fileURLToPath(new URL('./solutions/', import.meta.url));

export function chunkSolutionPath(id: string): string { return join(CHUNK_SOLUTIONS_DIR, `${id}.json`); }

export function readChunkSolution(id: string): Solution | null { return readSolutionFile(chunkSolutionPath(id)); }
