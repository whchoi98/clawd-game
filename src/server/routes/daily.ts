/**
 * GET /api/daily — today's (UTC) Daily Tower seed, with the generator and sim
 * versions the server will verify submissions against; a client that cannot
 * reproduce them refuses to start the daily instead of recording a run it
 * could never submit. Yesterday's date and seed ride along: that board stays
 * open until the end of today (isFreshDate), so the client can offer 어제의 탑
 * 재도전 without a second round trip.
 */
import type { FastifyInstance } from 'fastify';
import type { DailyResponse } from '../../shared/protocol.js';
import { GEN_VERSION, SIM_VERSION } from '../../sim/types.js';
import { dailySeed, freshDates } from '../daily.js';
import type { AppDeps } from '../types.js';

export function dailyRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/daily', async () => {
    const [today, yesterday] = freshDates(deps.now());
    const { date, seed, expiresAt } = dailySeed(today, deps.dailySecret);
    const y = dailySeed(yesterday, deps.dailySecret);
    const body: DailyResponse = {
      date, seed, levelId: 'daily', gen: GEN_VERSION, sim: SIM_VERSION, expiresAt,
      yesterday: { date: y.date, seed: y.seed },
    };
    return body;
  });
}
