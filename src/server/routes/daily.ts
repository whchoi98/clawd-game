/**
 * GET /api/daily — today's (UTC) Daily Tower seed, with the generator and sim
 * versions the server will verify submissions against; a client that cannot
 * reproduce them refuses to start the daily instead of recording a run it
 * could never submit.
 */
import type { FastifyInstance } from 'fastify';
import type { DailyResponse } from '../../shared/protocol.js';
import { GEN_VERSION, SIM_VERSION } from '../../sim/types.js';
import { dailySeed, utcDateStr } from '../daily.js';
import type { AppDeps } from '../types.js';

export function dailyRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/daily', async () => {
    const { date, seed, expiresAt } = dailySeed(utcDateStr(deps.now()), deps.dailySecret);
    const body: DailyResponse = { date, seed, levelId: 'daily', gen: GEN_VERSION, sim: SIM_VERSION, expiresAt };
    return body;
  });
}
