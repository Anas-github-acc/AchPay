import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports ok with both backing services up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      catalog_items: 37,
      catalog_flagged: 1,
      catalog_quarantined: 1,
      postgres: 'up',
      redis: 'up',
    });
  });

  it('serves the catalog over GET /products with a price filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/products?q=chai&max_price_paise=20000' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { price_paise: number }[]; count: number };
    expect(body.count).toBeGreaterThan(0);
    expect(body.items.every((i) => i.price_paise <= 20000)).toBe(true);
  });

  it('round-trips a quote through POST /quotes and back through verify', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      payload: { items: [{ sku: 'CHAI-MSL-250', qty: 2 }] },
    });
    expect(created.statusCode).toBe(200);
    const quote = created.json();

    const ok = await app.inject({ method: 'POST', url: '/quotes/verify', payload: quote });
    expect(ok.statusCode).toBe(200);

    const tampered = { ...quote, total_paise: quote.total_paise - 100 };
    const bad = await app.inject({ method: 'POST', url: '/quotes/verify', payload: tampered });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'QUOTE_SIGNATURE_INVALID' });
  });

  it('stores the quote in Redis under its quote_id', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      payload: { items: [{ sku: 'BSC-PRL-300', qty: 1 }] },
    });
    const quote = created.json();
    const stored = await app.quoteStore.get(quote.quote_id);
    expect(stored?.signature).toBe(quote.signature);
  });
});
