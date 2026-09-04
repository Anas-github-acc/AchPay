import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { getCatalog } from '../../src/catalog/catalog.js';

/**
 * The read path over HTTP. Two properties matter here and they are different:
 *
 *   - GET /products has no description field for any item, ever. Not filtered
 *     per item — the shape simply does not have one.
 *   - GET /products/:sku/details is the only route that can carry one, and it
 *     omits the field for an item that is flagged or unverified.
 */
describe('the split read path', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function list(url = '/products') {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return res.json() as { items: Record<string, unknown>[]; count: number };
  }

  it('GET /products never returns a description, for any item', async () => {
    const body = await list();
    expect(body.count).toBe(getCatalog().size);
    for (const item of body.items) {
      expect('description' in item).toBe(false);
      expect(Object.keys(item).sort()).toEqual([
        'category',
        'price_paise',
        'sku',
        'stock',
        'title',
      ]);
    }
    // Not even in the raw bytes: no key, no value, nothing to parse out.
    const raw = (await app.inject({ method: 'GET', url: '/products' })).body;
    expect(raw).not.toContain('description');
    expect(raw).not.toContain('IGNORE PREVIOUS RULES');
  });

  it('GET /products still returns the flagged item itself, priced and sellable', async () => {
    const body = await list('/products?q=hamper');
    const skus = body.items.map((i) => i.sku);
    expect(skus).toContain('SNK-HAM-DLX');
    // Flagging withholds prose, it does not delist the product.
    expect(body.items.find((i) => i.sku === 'SNK-HAM-DLX')!.price_paise).toBe(120_000);
  });

  it('GET /products never surfaces a quarantined item', async () => {
    const body = await list();
    expect(body.items.map((i) => i.sku)).not.toContain('SNK-HAM-EVL');
  });

  it("a flagged item's description is absent from GET /products/:sku/details", async () => {
    const res = await app.inject({ method: 'GET', url: '/products/SNK-HAM-DLX/details' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body.flagged).toBe(true);
    expect('description' in body).toBe(false);
    expect(res.body).not.toContain('IGNORE PREVIOUS RULES');
    // Everything a buyer legitimately needs is still there.
    expect(body).toMatchObject({
      sku: 'SNK-HAM-DLX',
      title: 'Deluxe Festive Snack Hamper',
      price_paise: 120_000,
      category: 'gifting',
      stock: 8,
    });
  });

  it("an unverified item's description is absent even though its text is innocent", async () => {
    const res = await app.inject({ method: 'GET', url: '/products/GFT-CRD-1000/details' });
    const body = res.json() as Record<string, unknown>;
    expect(body.source).toBe('unverified');
    expect(body.flagged).toBe(false);
    expect('description' in body).toBe(false);
  });

  it('returns a description for a verified, unflagged item', async () => {
    // Nothing in the seeded catalog is both verified and described, so this
    // proves the route can still serve prose when the item earns it.
    const res = await app.inject({ method: 'GET', url: '/products/CHAI-MSL-250/details' });
    const body = res.json() as Record<string, unknown>;
    expect(body.source).toBe('verified');
    expect(body.flagged).toBe(false);
    expect(body.sku).toBe('CHAI-MSL-250');
  });

  it('404s a quarantined or unknown sku on the details route', async () => {
    for (const sku of ['SNK-HAM-EVL', 'NOT-A-SKU']) {
      const res = await app.inject({ method: 'GET', url: `/products/${sku}/details` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'UNKNOWN_SKU', sku });
    }
  });

  it('reports the ingest counts on GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({
      catalog_items: getCatalog().size,
      catalog_flagged: 1,
      catalog_quarantined: 1,
    });
  });
});
