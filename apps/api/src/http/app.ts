import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getCatalog } from '../catalog/catalog.js';
import { UnknownSkuError } from '../catalog/catalog.js';
import { toDetailView, toListView } from '../catalog/views.js';
import { QuoteService, InvalidQuoteRequestError } from '../quotes/service.js';
import { QuoteStore } from '../quotes/store.js';
import { redis } from '../redis.js';
import { pool } from '../db/pool.js';
import { readAll, readByOrderRef, verifyChain } from '../ledger/ledger.js';
import { checkout } from '../checkout/checkout.js';
import { webhookRoutes } from './webhook-route.js';
import { approvalRoutes } from './approval-routes.js';
import { mcpRoutes } from './mcp-route.js';
import { createMandate, getMandate, listMandates, revokeMandate } from '../mandates/repo.js';
import { buildProductFeed } from '../catalog/feed.js';
import { getSecurityReport } from '../security/report.js';
import { createAdapter } from '../payments/index.js';
import type { PaymentAdapter } from '../payments/types.js';
import { getPolicy } from '../policy/config.js';
import { getPayment } from '../payments/repo.js';
import type { CheckoutRequest } from '../checkout/types.js';
import type { QuoteRequestItem } from '../quotes/types.js';

export interface BuildAppOptions {
  logger?: boolean;
  /**
   * Overrides the configured rail. Tests that need a specific adapter pass one
   * here; everything else takes whatever PAYMENT_ADAPTER selects, so switching
   * to real money is configuration rather than a code change.
   */
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
  const adapter = opts.adapter ?? (await createAdapter());

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
      catalog_flagged: catalog.report.items_flagged,
      catalog_quarantined: catalog.report.items_quarantined,
      postgres: db.status === 'fulfilled' ? 'up' : 'down',
      redis: cache.status === 'fulfilled' ? 'up' : 'down',
    };
  });

  // The read path is split in two on purpose.
  //
  // GET /products carries no description field at all, for any item, flagged or
  // not. It is the route an agent actually calls, so keeping untrusted prose out
  // of it removes most of the injection surface for free — no filtering, no
  // per-item decision, nothing to forget.
  //
  // GET /products/:sku/details is the only route that can return a description,
  // and only for an item that is both verified and unflagged. Most flows never
  // call it.
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
    return { items: items.map(toListView), count: items.length };
  });

  app.get('/products/:sku/details', async (request, reply) => {
    const { sku } = request.params as { sku: string };
    const product = catalog.get(sku);
    if (!product) {
      return reply.code(404).send({ error: 'UNKNOWN_SKU', reason: `Unknown sku: ${sku}`, sku });
    }
    return toDetailView(product);
  });

  /**
   * The machine-readable catalog export, in Agentic Commerce Protocol shape.
   *
   * Spec version 2026-04-17 — the `ProductsResponse` envelope. Served at the
   * conventional .well-known path so a buying agent can find it from the origin
   * alone, with no prior arrangement with this merchant.
   *
   * Note what a feed reader cannot do with this file: there is no price in it
   * that any endpoint here will accept back. Discovery and spending are
   * separate surfaces, and the only handle on money is a quote_id.
   */
  app.get('/.well-known/product-feed.json', async (_request, reply) => {
    const feed = buildProductFeed(catalog, {
      baseUrl: config.publicBaseUrl,
      sellerName: config.merchant.name,
      sellerUrl: config.merchant.url,
      privacyPolicyUrl: config.merchant.privacyPolicyUrl,
      termsUrl: config.merchant.termsUrl,
    });
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(feed);
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

  app.get('/mandates', async (request) => {
    const { limit } = request.query as { limit?: string };
    const mandates = await listMandates(limit ? Number(limit) : 100);
    return {
      mandates: mandates.map((m) => ({
        ...m,
        headroom_paise: m.max_amount_paise - m.used_paise,
      })),
      count: mandates.length,
    };
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

  await webhookRoutes(app);
  // The human approval screens and the ledger-rendered receipt. Registered
  // after checkout because they share its deps: an approved purchase runs
  // through the same checkout() call, not a second charge path.
  await approvalRoutes(app, { quotes, quoteStore, adapter });

  app.get('/payments/:order_ref', async (request, reply) => {
    const { order_ref } = request.params as { order_ref: string };
    const payment = await getPayment(order_ref);
    if (!payment) return reply.code(404).send({ error: 'PAYMENT_NOT_FOUND', order_ref });
    return payment;
  });

  /**
   * What the mandate-authorisation page needs to open Razorpay Checkout.
   *
   * Read-only, and it authorises nothing: it hands back the order the
   * storefront already created, plus the publishable key id that Razorpay's
   * own script requires. The secret key never leaves the server, and this
   * route cannot move a payment, register a mandate or alter a reservation —
   * only a signature-verified webhook does any of that.
   *
   * The order_ref is the capability, exactly as an approval token is: it is
   * provider-generated and unguessable, and knowing one reveals only the
   * basket the payer is about to authorise.
   */
  app.get('/authorise/:order_ref', async (request, reply) => {
    const { order_ref } = request.params as { order_ref: string };
    const payment = await getPayment(order_ref);
    if (!payment) return reply.code(404).send({ error: 'PAYMENT_NOT_FOUND', order_ref });

    const mandate = await getMandate(payment.mandate_id);
    const lines = await chargeLines(order_ref);

    return {
      order_ref: payment.order_ref,
      status: payment.status,
      amount_paise: payment.amount_paise,
      currency: 'INR',
      quote_id: payment.quote_id,
      mandate_id: payment.mandate_id,
      /** Publishable by design; Razorpay's browser script takes it as input. */
      key_id: config.razorpay.keyId ?? null,
      /**
       * Whether this is a test key. The page uses it to steer a payer away
       * from methods test mode cannot complete — a UPI QR in test mode has no
       * app to scan it, so it renders and then simply never settles. Derived
       * from the key rather than from NODE_ENV: what matters is which
       * Razorpay account the payment is going to.
       */
      test_mode: (config.razorpay.keyId ?? '').startsWith('rzp_test_'),
      customer_id: payment.provider_customer_id,
      /** Already registered, so this page has nothing left to do. */
      mandate_registered: Boolean(mandate?.provider_token),
      /** The ceiling the customer is authorising, not just this basket. */
      mandate_max_amount_paise: mandate?.max_amount_paise ?? null,
      lines,
      merchant_name: config.merchant.name,
    };
  });

  /**
   * The adversarial suite's last run, joined to the hand-written attack catalog.
   * Read by the dashboard's security page; nothing in the system depends on it.
   */
  app.get('/security/report', async (_request, reply) => {
    try {
      return getSecurityReport();
    } catch (err) {
      return reply.code(503).send({
        error: 'SECURITY_REPORT_UNAVAILABLE',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/ledger', async (request) => {
    const { limit } = request.query as { limit?: string };
    const rows = await readAll(limit ? Number(limit) : 100);
    return { rows, count: rows.length };
  });

  app.get('/ledger/verify', async () => verifyChain());

  // The MCP tools over HTTP, for a client that cannot spawn a subprocess. Only
  // when a token is configured — see http/mcp-route.ts for why.
  if (config.mcpHttpToken !== undefined) {
    await mcpRoutes(app, config.mcpHttpToken);
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    quotes: QuoteService;
    quoteStore: QuoteStore;
    adapter: PaymentAdapter;
  }
}

/**
 * The basket, read back from the ledger row that recorded the order.
 *
 * The quote itself lives in Redis for two minutes and this page may be opened
 * long after that, so the lines come from the hashed charge row instead —
 * which is also the copy that cannot have been edited since.
 */
async function chargeLines(orderRef: string): Promise<unknown[]> {
  const rows = await readByOrderRef(orderRef);
  const charge = rows.find((row) => row.event_type === 'charge');
  const lines = (charge?.payload as { lines?: unknown } | undefined)?.lines;
  return Array.isArray(lines) ? lines : [];
}
