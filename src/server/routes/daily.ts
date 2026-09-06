/** GET /api/daily — today's (UTC) Daily Tower seed. */
import type { FastifyInstance } from 'fastify';
import type { DailyResponse } from '../../shared/protocol.js';
import { dailySeed, utcDateStr } from '../daily.js';
import type { AppDeps } from '../types.js';

export function dailyRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/daily', async () => {
    const { date, seed, expiresAt } = dailySeed(utcDateStr(deps.now()), deps.dailySecret);
    const body: DailyResponse = { date, seed, levelId: 'daily', expiresAt };
    return body;
  });
}
