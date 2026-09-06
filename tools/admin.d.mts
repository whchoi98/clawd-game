/** Type surface of tools/admin.mjs for the TypeScript tests (same pattern as stats.d.mts). */
import type { Mode } from '../src/shared/protocol.js';
import type { Repo, StoredRun } from '../src/server/repo/types.js';

export type AdminCommand = 'delist' | 'rename' | 'ban-name' | 'export-board';

export interface AdminOptions {
  command?: string;
  args: string[];
  /** Blocklist file path (ban-name), relative to `root`. */
  file: string;
  /** export-board page size. */
  limit: number;
  help: boolean;
  errors: string[];
}

/** The repo the commands need: the Repo contract plus the admin hooks both repos implement. */
export interface AdminRepo extends Repo {
  renameRun?(runId: string, name: string): Promise<boolean>;
}

export interface AdminContext {
  repo?: AdminRepo | null;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Returns '' for a missing file. */
  readFile?: (path: string) => string;
  writeFile?: (path: string, text: string) => void;
  now?: () => Date;
  /** Base for `file`; default process.cwd(). */
  root?: string;
}

export type BoardExportEntry = Omit<StoredRun, 'masks'>;

export declare const DEFAULT_BLOCKLIST: string;
export declare const DEFAULT_LIMIT: number;
export declare const COMMANDS: readonly string[];
export declare const USAGE: string;

export declare function parseArgs(argv: string[]): AdminOptions;
export declare function validName(name: string): boolean;
export declare function appendBanned(text: string, word: string): { text: string; added: boolean; words: string[] };
export declare function exportBoard(repo: AdminRepo, mode: Mode, board: string, limit: number): Promise<BoardExportEntry[]>;
export declare function runAdmin(opts: AdminOptions, ctx?: AdminContext): Promise<number>;
