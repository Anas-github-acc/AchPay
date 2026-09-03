import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getCatalog } from '../catalog/catalog.js';
import { UnknownSkuError } from '../catalog/catalog.js';
import { QuoteService, InvalidQuoteRequestError } from '../quotes/service.js';
import { QuoteStore } from '../quotes/store.js';
import { redis } from '../redis.js';
import { pool } from '../db/pool.js';
import { readAll, verifyChain } from '../ledger/ledger.js';
import { checkout } from '../checkout/checkout.js';
import { createMandate, getMandate, revokeMandate } from '../mandates/repo.js';
import { FakeAdapter } from '../payments/fake.js';
import type { PaymentAdapter } from '../payments/types.js';
import { getPolicy } from '../policy/config.js';
import type { CheckoutRequest } from '../checkout/types.js';
import type { QuoteRequestItem } from '../quotes/types.js';

export interface BuildAppOptions {
  logger?: boolean;
  /** Swapped wholesale in Phase 5. Nothing above this line changes. */
  adapter?: PaymentAdapter;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? !config.isTest });

  const catalog = getCatalog();
  const quotes = new QuoteService({
    catalog,
    secret: config.quoteSigningSecret,
    ttlSeconds: config.quoteTtlSeconds,
  });
  const quoteStore = new QuoteStore(redis, config.quoteTtlSeconds);
  const adapter = opts.adapter ?? new FakeAdapter();

  app.decorate('quotes', quotes);
  app.decorate('quoteStore', quoteStore);
  app.decorate('adapter', adapter);

  app.get('/health', async () => {
    const [db, cache] = await Promise.allSettled([
      pool.query('select 1'),
      redis.ping(),
    ]);
    return {
      status: 'ok',
      catalog_items: catalog.size,
      postgres: db.status === 'fulfilled' ? 'up' : 'down',
      redis: cache.status === 'fulfilled' ? 'up' : 'down',
    };
  });

  app.get('/products', async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const maxPrice = q.max_price_paise === undefined ? undefined : Number(q.max_price_paise);
    if (maxPrice !== undefined && !Number.isSafeInteger(maxPrice)) {
      return { error: 'BAD_REQUEST', reason: 'max_price_paise must be an integer' };
    }
    const items = catalog.search({
      q: q.q,
      category: q.category,
      max_price_paise: maxPrice,
      limit: q.limit === undefined ? undefined : Number(q.limit),
    });
    return { items, count: items.length };
  });

  app.post('/quotes', async (request, reply) => {
    const body = request.body as { items?: QuoteRequestItem[] } | undefined;
    try {
      // Only sku and qty are read off the body. Any price the caller sends is
      // ignored outright — prices come from the catalog.
      const items = (body?.items ?? []).map((item) => ({ sku: item?.sku, qty: item?.qty })) as
        QuoteRequestItem[];
      const quote = quotes.create(items);
      await quoteStore.put(quote);
      return quote;
    } catch (err) {
      if (err instanceof UnknownSkuError) {
        return reply.code(404).send({ error: err.code, reason: err.message, sku: err.sku });
      }
      if (err instanceof InvalidQuoteRequestError) {
        return reply.code(400).send({ error: err.code, reason: err.message });
      }
      throw err;
    }
  });

  app.post('/quotes/verify', async (request, reply) => {
    const result = quotes.verify(request.body);
    if (result.ok) return { ok: true, quote: result.quote };
    return reply.code(400).send(result);
  });

  app.get('/policy', async () => getPolicy());

  app.post('/mandates', async (request, reply) => {
    const body = request.body as
      | { user_ref?: string; max_amount_paise?: number; expires_at?: string; ttl_hours?: number }
      | undefined;
    if (!body?.user_ref) {
      return reply.code(400).send({ error: 'BAD_REQUEST', reason: 'user_ref is required' });
    }
    if (!Number.isSafeInteger(body.max_amount_paise)) {
      return reply
        .code(400)
        .send({ error: 'BAD_REQUEST', reason: 'max_amount_paise must be an integer' });
    }
    const expiresAt =
      body.expires_at ??
      new Date(Date.now() + (body.ttl_hours ?? 24) * 3600_000).toISOString();
    const mandate = await createMandate({
      user_ref: body.user_ref,
      max_amount_paise: body.max_amount_paise!,
      expires_at: expiresAt,
    });
    return reply.code(201).send(mandate);
  });

  app.get('/mandates/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mandate = await getMandate(id);
    if (!mandate) return reply.code(404).send({ error: 'MANDATE_NOT_FOUND', mandate_id: id });
    return { ...mandate, headroom_paise: mandate.max_amount_paise - mandate.used_paise };
  });

  app.post('/mandates/:id/revoke', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mandate = await revokeMandate(id);
    if (!mandate) return reply.code(404).send({ error: 'MANDATE_NOT_FOUND', mandate_id: id });
    return mandate;
  });

  app.post('/checkout', async (request, reply) => {
    const body = request.body as CheckoutRequest | undefined;
    if (!body?.mandate_id) {
      return reply.code(400).send({ error: 'BAD_REQUEST', reason: 'mandate_id is required' });
    }
    // Note what is *not* read off the body: any amount. The only handle a
    // caller has on money is a quote_id.
    const result = await checkout(
      {
        mandate_id: body.mandate_id,
        quote_id: body.quote_id,
        quote: body.quote,
        intent_text: body.intent_text,
      },
      { quotes, quoteStore, adapter },
    );

    // Policy outcomes are answers, not errors, so an agent can act on them.
    // Only an unusable quote gets a 4xx.
    if (result.status === 'quote_invalid') return reply.code(409).send(result);
    return result;
  });

  app.get('/ledger', async (request) => {
    const { limit } = request.query as { limit?: string };
    const rows = await readAll(limit ? Number(limit) : 100);
    return { rows, count: rows.length };
  });

  app.get('/ledger/verify', async () => verifyChain());

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    quotes: QuoteService;
    quoteStore: QuoteStore;
    adapter: PaymentAdapter;
  }
}
