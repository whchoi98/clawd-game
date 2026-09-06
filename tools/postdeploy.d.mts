/** Type surface of tools/postdeploy.mjs for the TypeScript tests. */
export const STACK_NAME: string;
export const DEFAULT_REGION: string;
export const USAGE: string;

export type StackOutputs = Record<string, string>;

export interface SpawnLike {
  (cmd: string, args: string[], options?: unknown): {
    status: number | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    error?: Error;
  };
}

export interface ResolveOptions {
  /** Path of the `cdk deploy --outputs-file` JSON; default `cdk-outputs.json`. */
  outputsPath?: string;
  /** CloudFormation stack name; default `STACK_NAME`. */
  stackName?: string;
  /** Overrides `regionFromEnv(env)`. */
  region?: string;
  /** Environment used for the region lookup; default `process.env`. */
  env?: Record<string, string | undefined>;
  /** child_process.spawnSync stand-in; default the real one. */
  spawn?: SpawnLike;
}

export interface ResolvedOutputs {
  outputs: StackOutputs | null;
  /** Where the outputs came from (file path or the describe-stacks command). */
  source: string | null;
  /** One line per source that failed, in the order tried. */
  errors: string[];
}

export function regionFromEnv(env?: Record<string, string | undefined>): string;
export function describeStacksArgs(opts: { stackName: string; region: string }): string[];
export function outputsFromFile(path: string): { outputs: StackOutputs | null; error: string | null };
export function outputsFromCloudFormation(
  opts: { stackName: string; region: string; spawn?: SpawnLike },
): { outputs: StackOutputs | null; error: string | null };
export function resolveOutputs(opts?: ResolveOptions): ResolvedOutputs;
