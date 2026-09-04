import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Catalog, defaultCatalogPath, getCatalog, setCatalog } from '../../src/catalog/catalog.js';
import { sanitiseCatalog } from '../../src/catalog/sanitise.js';
import type { RawProduct } from '../../src/catalog/types.js';
import { createMandate } from '../../src/mandates/repo.js';
import type { MandateRecord } from '../../src/mandates/types.js';
import type { ChargeRequest, ChargeResult, PaymentAdapter } from '../../src/payments/types.js';
import { FakeAdapter } from '../../src/payments/fake.js';
import type { SignedQuote } from '../../src/quotes/types.js';
import { pool } from '../../src/db/pool.js';

/**
 * The one and only substitution the suite makes.
 *
 * It counts every call that reached the rail, which is what turns "the attack
 * was refused" into "no money moved" — a rule_id in a response is a claim, and
 * `calls === 0` is the evidence behind it.
 */
export class CountingAdapter implements PaymentAdapter {
  readonly name = 'counting';
  calls = 0;
  constructor(private readonly inner: PaymentAdapter = new FakeAdapter()) {}
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    this.calls += 1;
    return this.inner.charge(req);
  }
}

/** The exact injection string that ships in data/catalog.json, read from it. */
export function injectionStringFromCatalog(sku = 'SNK-HAM-DLX'): string {
  const raw = JSON.parse(readFileSync(defaultCatalogPath, 'utf8')) as RawProduct[];
  const item = raw.find((p) => p.sku === sku);
  if (!item?.description) throw new Error(`No injected description on ${sku} in data/catalog.json`);
  return item.description;
}

/** data/catalog.json exactly as it sits on disk, for tests that mutate a copy. */
export function rawCatalogItems(): RawProduct[] {
  return JSON.parse(readFileSync(defaultCatalogPath, 'utf8')) as RawProduct[];
}

/**
 * Runs `fn` against an app whose catalog is `items`, then puts the real one
 * back.
 *
 * The items go through the genuine ingest sanitiser first, so an injected
 * description in a fixture is flagged by exactly the code that flags the one in
 * data/catalog.json. Nothing about the catalog is faked except its contents.
 */
export async function withCatalog<T>(
  items: RawProduct[],
  adapter: PaymentAdapter,
  fn: (app: FastifyInstance) => Promise<T>,
): Promise<T> {
  const real = getCatalog();
  const { items: clean, report } = sanitiseCatalog(items, { source: 'adversarial-fixture' });
  setCatalog(new Catalog(clean, report));
  const app = await buildApp({ logger: false, adapter });
  await app.ready();
  try {
    return await fn(app);
  } finally {
    await app.close();
    setCatalog(real);
  }
}

export async function mandateFor(maxPaise: number, ttlHours = 24): Promise<MandateRecord> {
  return createMandate({
    user_ref: 'user_adversary',
    max_amount_paise: maxPaise,
    expires_at: new Date(Date.now() + ttlHours * 3_600_000).toISOString(),
  });
}

/** A quote minted the way an agent mints one: over HTTP, sku and qty only. */
export async function quoteFor(
  app: FastifyInstance,
  items: { sku: string; qty: number }[],
): Promise<SignedQuote> {
  const res = await app.inject({ method: 'POST', url: '/quotes', payload: { items } });
  expect(res.statusCode).toBe(200);
  return res.json() as SignedQuote;
}

export function deps(app: FastifyInstance, adapter: PaymentAdapter) {
  return { quotes: app.quotes, quoteStore: app.quoteStore, adapter };
}

/** How many charge rows the ledger holds for one quote. Zero means no money. */
export async function chargeRowsFor(quoteId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from ledger
      where event_type = 'charge' and quote_id = $1
        and coalesce(payload ->> 'status', '') <> 'failed'`,
    [quoteId],
  );
  return Number(rows[0]!.n);
}

/** Every string anywhere in a value, for proving a description never leaked. */
export function containsText(value: unknown, needle: string): boolean {
  return JSON.stringify(value ?? null).includes(needle);
}

/** Rupees, for evidence lines a non-engineer reads off a screen. */
export function rs(paise: number): string {
  return `Rs ${(paise / 100).toFixed(2).replace(/\.00$/, '')}`;
}
