/**
 * API client — `class Api implements ApiPort`. Thin fetch wrapper: every
 * response is parsed with the shared zod schemas, every request is aborted
 * after `timeoutMs`, and every failure surfaces as an `ApiError` carrying the
 * HTTP status (0 for network / timeout / parse failures) and a short reason.
 *
 * A 422 from POST /api/runs is not an error: the body is a `RunRejected` and
 * is returned as such, so the caller shows "거절됨: <reason>".
 */
import type { z } from 'zod';
import {
  API_PREFIX, DailyResponse, ErrorResponse, GhostResponse, HealthResponse, LeaderboardResponse, RunResponse,
  TransferCode, TransferCreateResponse, TransferGetResponse,
} from '../../shared/protocol.js';
import type { LeaderboardQuery, RunSubmit, TransferCreateRequest } from '../../shared/protocol.js';
import type { ApiPort } from '../contracts.js';

export const API_TIMEOUT_MS = 8000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason: string, readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
  /** Network-level failure (offline, DNS, timeout) as opposed to a server verdict. */
  get offline(): boolean { return this.status === 0 || this.status >= 500; }
}

export interface ApiOptions {
  /** Origin (no trailing slash); '' = same origin. */
  base?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Map an HTTP status to the reason strings the UI knows how to translate. */
function reasonFor(status: number, body: unknown): string {
  const parsed = ErrorResponse.safeParse(body);
  if (parsed.success && parsed.data.error) return parsed.data.error;
  if (status === 429) return 'rate-limited';
  if (status === 404) return 'not-found';
  if (status === 410) return 'gone';
  if (status === 413) return 'too-long';
  if (status >= 400 && status < 500) return 'bad-request';
  return 'server-error';
}

export class Api implements ApiPort {
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: ApiOptions = {}) {
    this.base = (opts.base ?? '').replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
  }

  daily(): Promise<DailyResponse> {
    return this.request(`${API_PREFIX}/daily`, {}, DailyResponse);
  }

  submitRun(body: RunSubmit): Promise<RunResponse> {
    return this.request(`${API_PREFIX}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, RunResponse, [422]);
  }

  leaderboard(q: LeaderboardQuery): Promise<LeaderboardResponse> {
    const p = new URLSearchParams();
    p.set('mode', q.mode);
    p.set('board', q.board);
    p.set('limit', String(q.limit ?? 20));
    if (q.playerId) p.set('playerId', q.playerId);
    return this.request(`${API_PREFIX}/leaderboard?${p.toString()}`, {}, LeaderboardResponse);
  }

  ghost(runId: string): Promise<GhostResponse> {
    return this.request(`${API_PREFIX}/ghost/${encodeURIComponent(runId)}`, {}, GhostResponse);
  }

  health(): Promise<HealthResponse> {
    return this.request(`${API_PREFIX}/health`, {}, HealthResponse);
  }

  // ------------------------------------------------------------ progress transfer (P3-5)
  /** Store a snapshot; the server answers with a one-time 8-char code (413 past MAX_TRANSFER_BYTES, 429 when rate-limited). */
  transferCreate(body: TransferCreateRequest): Promise<TransferCreateResponse> {
    return this.request(`${API_PREFIX}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, TransferCreateResponse);
  }

  /**
   * Redeem a code. The code is checked against the wire alphabet here so a typo
   * never becomes a request: a malformed code fails with status 400 / 'bad-code'
   * exactly like the server's answer. 410 ('gone') = already used or expired.
   */
  transferGet(code: string): Promise<TransferGetResponse> {
    if (!TransferCode.safeParse(code).success) {
      return Promise.reject(new ApiError('bad transfer code', 400, 'bad-code'));
    }
    return this.request(`${API_PREFIX}/transfer/${encodeURIComponent(code)}`, {}, TransferGetResponse);
  }

  // ------------------------------------------------------------ core
  /**
   * Fetch + parse. `okStatuses` lists non-2xx statuses whose body still follows
   * `schema` (the 422 run rejection).
   */
  private async request<S extends z.ZodTypeAny>(
    path: string, init: RequestInit, schema: S, okStatuses: number[] = [],
  ): Promise<z.infer<S>> {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
        signal: ctl?.signal,
        credentials: 'same-origin',
      });
    } catch (err) {
      const aborted = (err as { name?: string } | null)?.name === 'AbortError';
      throw new ApiError(aborted ? 'request timed out' : 'network error', 0, aborted ? 'timeout' : 'network');
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }

    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new ApiError(`HTTP ${res.status}`, res.status, reasonFor(res.status, body), body);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError('unexpected response shape', res.status, 'bad-response', body);
    return parsed.data as z.infer<S>;
  }
}
