/**
 * API client — `class Api implements ApiPort`. Thin fetch wrapper: every
 * response is parsed with the shared zod schemas, every request is aborted
 * after `timeoutMs`, and every failure surfaces as an `ApiError` carrying the
 * HTTP status (0 for network / timeout / parse failures) and a short reason.
 *
 * A 422 from POST /api/runs is not an error: the body is a `RunRejected` and
 * is returned as such, so the caller shows "거절됨: <reason>".
 *
 * Since P3-12 GET /api/leaderboard is public and edge-cached, so it never
 * carries a personal row: `leaderboard()` sends no player id, and the caller's
 * own row comes from GET /api/me (`me()`, never cached). A `503 { error: 'busy' }`
 * (the verification pool is full) or a 429 carries `Retry-After`, surfaced as
 * `ApiError.retryAfter` (seconds) for the submission queue's retry timer.
 */
import type { z } from 'zod';
import {
  API_PREFIX, DailyResponse, ErrorResponse, GhostResponse, HealthResponse, LeaderboardResponse, MeResponse, RunResponse,
  TransferCode, TransferCreateResponse, TransferGetResponse,
} from '../../shared/protocol.js';
import type { LeaderboardQuery, RunSubmit, TransferCreateRequest } from '../../shared/protocol.js';
import type { ApiPort } from '../contracts.js';

export const API_TIMEOUT_MS = 8000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    message: string, readonly status: number, readonly reason: string, readonly body?: unknown,
    /** Seconds the server asked us to wait (`Retry-After` header, else `detail.retryAfter`), when it said. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** Network-level failure (offline, DNS, timeout) as opposed to a server verdict. */
  get offline(): boolean { return this.status === 0 || this.status >= 500; }
  /** The server is up but asked for a retry: the verification pool is full (503 busy) or a rate limit hit (429). */
  get retryable(): boolean { return this.status === 429 || (this.status === 503 && this.reason === 'busy'); }
}

/**
 * The retry delay a refused request carries: the `Retry-After` header in
 * seconds (delta-seconds only; an HTTP date is ignored), else the body's
 * `detail.retryAfter`. Undefined when neither says.
 */
export function retryAfterOf(headers: { get(name: string): string | null } | null | undefined, body: unknown): number | undefined {
  const raw = headers?.get('retry-after');
  if (raw !== null && raw !== undefined) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const detail = (body as { detail?: { retryAfter?: unknown } } | null)?.detail;
  const v = detail?.retryAfter;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
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

/** No complete response means no verdict; the identical submission may safely be retried. */
function transportError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'AbortError') return new ApiError('request timed out', 0, 'timeout');
  if (name === 'SyntaxError') return new ApiError('invalid response JSON', 0, 'bad-response');
  return new ApiError('network error', 0, 'network');
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

  /**
   * The public top-N of a board. A `playerId` in the query is deliberately
   * dropped: the response is shared between viewers at the edge and the server
   * ignores the id anyway — our own row is `me()`.
   */
  leaderboard(q: LeaderboardQuery): Promise<LeaderboardResponse> {
    const p = new URLSearchParams();
    p.set('mode', q.mode);
    p.set('board', q.board);
    p.set('limit', String(q.limit ?? 20));
    return this.request(`${API_PREFIX}/leaderboard?${p.toString()}`, {}, LeaderboardResponse);
  }

  /** Our own row on a board (GET /api/me, never cached). Refused locally without a player id, like the server's 400. */
  me(q: LeaderboardQuery): Promise<MeResponse> {
    if (!q.playerId) return Promise.reject(new ApiError('playerId is required', 400, 'bad-request'));
    const p = new URLSearchParams();
    p.set('mode', q.mode);
    p.set('board', q.board);
    p.set('playerId', q.playerId);
    return this.request(`${API_PREFIX}/me?${p.toString()}`, {}, MeResponse);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race both stages against the same deadline, including fetch adapters whose
    // body streams do not react to AbortSignal. Native fetch is also cancelled.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ApiError('request timed out', 0, 'timeout'));
        ctl?.abort();
      }, this.timeoutMs);
    });
    try {
      let res: Response;
      try {
        res = await Promise.race([this.fetchFn(`${this.base}${path}`, {
          ...init,
          headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
          signal: ctl?.signal,
          credentials: 'same-origin',
        }), deadline]);
      } catch (err) {
        throw transportError(err);
      }

      let body: unknown = null;
      try {
        body = await Promise.race([res.json(), deadline]);
      } catch (err) {
        if (res.ok) throw transportError(err);
        // A known HTTP refusal remains authoritative even when its error body
        // is missing, malformed or timed out (429 / 5xx still retain their status).
      }

      if (!res.ok && !okStatuses.includes(res.status)) {
        let headers: { get(name: string): string | null } | null = null;
        try { headers = res.headers ?? null; } catch { headers = null; }
        throw new ApiError(`HTTP ${res.status}`, res.status, reasonFor(res.status, body), body, retryAfterOf(headers, body));
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new ApiError('unexpected response shape', res.ok ? 0 : res.status, 'bad-response', body);
      return parsed.data as z.infer<S>;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
