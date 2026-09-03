import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getCatalog } from '../catalog/catalog.js';
import { UnknownSkuError } from '../catalog/catalog.js';
import { QuoteService, InvalidQuoteRequestError } from '../quotes/service.js';
import { QuoteStore } from '../quotes/store.js';
import { redis } from '../redis.js';
import { pool } from '../db/pool.js';
import { verifyChain } from '../ledger/ledger.js';
import type { QuoteRequestItem } from '../quotes/types.js';

export interface BuildAppOptions {
  logger?: boolean;
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

  app.decorate('quotes', quotes);
  app.decorate('quoteStore', quoteStore);

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

  app.get('/ledger/verify', async () => verifyChain());

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    quotes: QuoteService;
    quoteStore: QuoteStore;
  }
}
