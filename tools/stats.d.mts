/** Type surface of tools/stats.mjs for the TypeScript tests (same pattern as postdeploy.d.mts). */
export interface StatsOptions {
  file?: string;
  level: string;
  insights: boolean;
  json: boolean;
  help: boolean;
  errors: string[];
}

/** One event log record: the fixed fields plus whatever `d` carried. */
export interface EventRecord {
  evt: string;
  at?: number;
  s?: string;
  build?: string;
  sim?: number;
  msg?: string;
  [key: string]: unknown;
}

export interface Funnel {
  events: { boot: number; zone_start: number; clear: number };
  sessions: { boot: number; zone_start: number; clear: number };
  share: { zone_start: number; clear: number };
}

export interface D1Proxy {
  boots: number;
  d1: number;
  share: number;
  buckets: Record<string, number>;
}

export interface ZoneStat {
  levelId: string;
  starts: number;
  deaths: number;
  clears: number;
  deathsPerClear: number | null;
  clearRate: number | null;
}

export interface Heatmap {
  levelId: string;
  deaths: number;
  /** "tx,ty" → deaths. */
  cells: Map<string, number>;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  max: number;
}

export interface InsightsQuery { title: string; query: string }

export interface Summary {
  lines: number;
  funnel: Funnel;
  d1: D1Proxy;
  zones: ZoneStat[];
  heatmap: null | {
    levelId: string; deaths: number; minX: number; maxX: number; minY: number; maxY: number; max: number;
    cells: { tx: number; ty: number; deaths: number }[];
  };
}

export declare const DEFAULT_LEVEL: string;
export declare const RAMP: string;
export declare const MAX_HEATMAP_WIDTH: number;
export declare const D1_BUCKET: string;
export declare const USAGE: string;

export declare function parseArgs(argv: string[]): StatsOptions;
export declare function parseNdjson(text: string): EventRecord[];
export declare function funnel(records: EventRecord[]): Funnel;
export declare function d1Proxy(records: EventRecord[]): D1Proxy;
export declare function zoneStats(records: EventRecord[]): ZoneStat[];
export declare function heatmap(records: EventRecord[], levelId: string): Heatmap | null;
export declare function renderHeatmap(hm: Heatmap | null, opts?: { maxWidth?: number }): string;
export declare function report(records: EventRecord[], opts?: { level?: string }): string;
export declare function summary(records: EventRecord[], opts?: { level?: string }): Summary;
export declare function insightsQueries(opts?: { level?: string }): InsightsQuery[];
export declare function formatInsights(queries: InsightsQuery[]): string;
