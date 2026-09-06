/** Type surface of tools/release.mjs for the TypeScript tests (same pattern as postdeploy.d.mts). */
export type Bump = 'patch' | 'minor';

export interface ReleaseOptions {
  bump: Bump;
  deploy: boolean;
  tag: boolean;
  dryRun: boolean;
  help: boolean;
  outputsPath: string;
  region?: string;
  /** Unknown arguments, in order. */
  errors: string[];
}

export interface ExecResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
}
export type ExecLike = (cmd: string, args: string[], options?: unknown) => ExecResult;

export interface FetchResponseLike {
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init?: unknown) => Promise<FetchResponseLike>;

export interface ReleaseContext {
  exec?: ExecLike;
  fetch?: FetchLike;
  readFile?: (path: string) => string;
  writeFile?: (path: string, text: string) => void;
  log?: (line: string) => void;
  now?: () => Date;
  /** Project root; default process.cwd(). */
  root?: string;
}

export interface StepResult {
  id: string;
  title: string;
  ok: boolean;
  ms: number;
  note?: string;
  error?: string;
}

export interface ReleaseResult {
  ok: boolean;
  steps: StepResult[];
  /** The version written by the version step, when it ran. */
  version?: string;
  exitCode: 0 | 1;
}

export interface PlannedStep {
  id: string;
  title: string;
  commands: string[];
}

export interface Step {
  id: string;
  title: string;
  when?: (opts: ReleaseOptions) => boolean;
  commands: (opts: ReleaseOptions, current?: string) => string[];
  run: (ctx: Required<ReleaseContext>, opts: ReleaseOptions, state: Record<string, unknown>) => unknown;
}

export declare const INVALIDATION_PATHS: readonly string[];
export declare const ASSET_ROUNDS: number;
export declare const USAGE: string;
export declare const STEPS: readonly Step[];

export declare function parseArgs(argv: string[]): ReleaseOptions;
export declare function nextVersion(current: string, bump: Bump): string;
export declare function bumpChangelog(text: string, version: string, date: string): string;
export declare function assetRefs(html: string): string[];
export declare function plan(opts: ReleaseOptions, current?: string): PlannedStep[];
export declare function formatPlan(opts: ReleaseOptions, current?: string): string;
export declare function formatSummary(result: ReleaseResult): string;
export declare function release(opts: ReleaseOptions, ctx?: ReleaseContext): Promise<ReleaseResult>;
