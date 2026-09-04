import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Hands routes in this plugin scope the request body as the exact bytes that
 * arrived, with no parsing at all.
 *
 * A webhook signature is an HMAC over the bytes Razorpay sent. Re-serialising
 * parsed JSON does not reliably reproduce them — key order, unicode escaping
 * and float formatting are all free to differ — so a signature checked against
 * `JSON.stringify(request.body)` passes most of the time and fails on the
 * payloads that happen to round-trip differently. That failure is intermittent
 * and looks like a Razorpay problem rather than ours, which is the expensive
 * kind of bug.
 *
 * Fastify encapsulates content type parsers, so registering this inside a
 * plugin scopes it to that plugin's routes. Everything outside it keeps the
 * default JSON parsing; `POST /quotes` is unaffected.
 */
export async function rawBodyPlugin(scope: FastifyInstance): Promise<void> {
  scope.removeContentTypeParser(['application/json', 'text/plain']);
  scope.addContentTypeParser(
    '*',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );
}

/** The untouched request bytes, for a route registered under rawBodyPlugin. */
export function rawBodyOf(request: FastifyRequest): Buffer {
  const body = request.body;
  if (!Buffer.isBuffer(body)) {
    throw new Error(
      'Expected a raw Buffer body. This route must be registered inside rawBodyPlugin.',
    );
  }
  return body;
}
