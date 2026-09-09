import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { reclaimStaleReservations } from '../payments/reclaim.js';

/** Called by Vercel Cron; never exposed without CRON_SECRET. */
export async function reclaimRoute(app: FastifyInstance): Promise<void> {
  app.get('/internal/reclaim', async (request, reply) => {
    const configured = config.cronSecret;
    const supplied = request.headers.authorization;
    if (!configured || supplied !== `Bearer ${configured}`) {
      return reply.code(401).send({ error: 'UNAUTHORISED' });
    }
    const result = await reclaimStaleReservations(app.adapter);
    return { ok: true, result };
  });
}
