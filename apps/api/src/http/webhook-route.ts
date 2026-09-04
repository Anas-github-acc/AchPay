import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { verifySignature } from '../webhooks/signature.js';
import { processWebhook } from '../webhooks/process.js';
import { rawBodyOf, rawBodyPlugin } from './raw-body.js';

/**
 * POST /webhooks/razorpay
 *
 * Registered as its own plugin so the raw-body parser inside it is scoped to
 * this route and nothing else. Every other route keeps Fastify's normal JSON
 * parsing.
 *
 * The handler is deliberately short. Razorpay retries any non-200, so slow or
 * throwing work here turns into duplicate deliveries. The work is three
 * statements in one transaction, well inside that budget; if it ever grows,
 * the thing to do is answer 200 and hand off, not to make the caller wait.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    await rawBodyPlugin(scope);

    scope.post('/webhooks/razorpay', async (request, reply) => {
      const secret = config.razorpay.webhookSecret;
      if (!secret) {
        // Refuse rather than accept unverified events: an endpoint that skips
        // the check when misconfigured is worse than one that is plainly down.
        request.log.error('RAZORPAY_WEBHOOK_SECRET is not set; refusing webhook');
        return reply.code(503).send({ error: 'WEBHOOK_NOT_CONFIGURED' });
      }

      const raw = rawBodyOf(request);
      const signature = request.headers['x-razorpay-signature'];

      if (!verifySignature(raw, typeof signature === 'string' ? signature : undefined, secret)) {
        // Nothing is written. An unverified body is not evidence of anything,
        // so it must not reach the ledger.
        return reply.code(400).send({ error: 'INVALID_SIGNATURE' });
      }

      const eventId = request.headers['x-razorpay-event-id'];
      const outcome = await processWebhook({
        eventId: typeof eventId === 'string' ? eventId : undefined,
        body: raw,
      });

      if (outcome.status === 'malformed') {
        return reply.code(400).send({ error: 'MALFORMED_EVENT', reason: outcome.reason });
      }

      // Everything else is a 200, including a replay and an event for an order
      // we do not recognise. Both are things Razorpay should stop resending.
      return reply.code(200).send(outcome);
    });
  });
}
