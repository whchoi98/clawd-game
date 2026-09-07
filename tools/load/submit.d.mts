/** Type surface of tools/load/submit.mjs for the TypeScript tests (same pattern as tools/admin.d.mts). */
import type { LevelDef, RunClaim } from '../../src/sim/types.js';
import type { RunSubmit } from '../../src/shared/protocol.js';
import type { Solution } from '../../levels/solutions.js';

export declare const DEFAULT_N: number;
export declare const DEFAULT_ZONES: readonly string[];
export declare const DEFAULT_HEALTHZ_INTERVAL_MS: number;
export declare const DEFAULT_MAX_P99_MS: number;
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const DEFAULT_BUILD: string;
export declare const MARKER_MASK: number;
export declare const USAGE: string;

export interface LoadOptions {
  baseUrl: string;
  n: number;
  zones: string[];
  build: string;
  healthzIntervalMs: number;
  maxP99Ms: number;
  timeoutMs: number;
  help: boolean;
  errors: string[];
}
export declare function parseArgs(argv: string[], env?: Record<string, string | undefined>): LoadOptions;

export interface PreparedZone {
  def: LevelDef;
  /** The solution's masks cut at the finish tick. */
  base: Uint8Array;
  claim: RunClaim;
  /** Distinct variants the mask budget allows. */
  variants: number;
}
export declare function finishTick(def: LevelDef, masks: Uint8Array): number;
export declare function prepareZone(def: LevelDef, solution: Solution): PreparedZone;
export declare function variantMasks(zone: PreparedZone, k: number): Uint8Array;
export declare function playerIdFor(tag: string, i: number): string;
export declare function buildBody(zone: PreparedZone, k: number, i: number, opts?: { tag?: string; build?: string }): RunSubmit;

export interface BuildBodiesOptions {
  zones?: readonly string[];
  tag?: string;
  build?: string;
  solutions?: Record<string, Solution>;
  levels?: Record<string, LevelDef>;
}
export interface BuiltBodies {
  bodies: RunSubmit[];
  prepared: PreparedZone[];
  skipped: { id: string; reason: string }[];
  tag: string;
}
export declare function buildBodies(n: number, opts?: BuildBodiesOptions): BuiltBodies;
export declare function runTag(now?: number): string;

export declare function histogram<T extends string | number>(values: readonly T[]): Record<string, number>;
export declare function percentile(values: readonly number[], p: number): number;
export declare function serverErrors(statuses: readonly number[]): number;

export interface LoadReport {
  n: number;
  elapsedMs: number;
  statuses: Record<string, number>;
  reasons: Record<string, number>;
  transportFailures: Record<string, number>;
  serverErrors: number;
  busy: number;
  submit: { p50: number; p99: number; max: number };
  healthz: { samples: number; failures: number; p50: number; p99: number };
}
export declare function exitCode(report: LoadReport, maxP99Ms?: number): 0 | 1;

export interface FetchResponseLike {
  status: number;
  json?(): Promise<unknown>;
  headers?: { get(name: string): string | null };
}
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchResponseLike>;

export interface RunLoadOptions {
  baseUrl: string;
  bodies: readonly RunSubmit[];
  fetch?: FetchLike;
  healthzIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
export declare function runLoad(opts: RunLoadOptions): Promise<LoadReport>;
export declare function formatReport(report: LoadReport, opts?: { maxP99Ms?: number }): string;
