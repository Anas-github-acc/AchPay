import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { checkout } from '../../src/checkout/checkout.js';
import { pool } from '../../src/db/pool.js';
import { verifyChain } from '../../src/ledger/ledger.js';
import { createMandate, getMandate } from '../../src/mandates/repo.js';
import { RazorpayMandateAdapter } from '../../src/payments/razorpay.js';
import type { MandateOrderCreateBody, RazorpayClient } from '../../src/payments/razorpay-client.js';
import type { SignedQuote } from '../../src/quotes/types.js';
import { resetAll } from '../helpers/db.js';

/**
 * The adapter's unit tests stub the database. These run it against a real one,
 * inside the real checkout transaction, because the interesting failure only
 * exists there: checkout holds `select ... for update` on the mandate row for
 * the whole charge, so an adapter that writes to that row from the pool waits
 * on a lock its own caller is holding and neither side ever finishes.
 *
 * Every case here has a timeout for that reason. A deadlock is a hang, not an
 * assertion failure, so without one the suite would stall rather than fail.
 */

let app: FastifyInstance;

const orders: MandateOrderCreateBody[] = [];

function fakeClient(): RazorpayClient {
  return {
    customers: {
      async create(body) {
        return { id: `cust_${Math.random().toString(36).slice(2, 12)}`, entity: 'customer', ...body };
      },
    },
    orders: {
      async create(body) {
        orders.push(body as MandateOrderCreateBody);
        return {
          id: `order_${Math.random().toString(36).slice(2, 12)}`,
          entity: 'order',
          amount: body.amount,
          currency: 'INR',
          status: 'created',
        };
      },
      async fetch(orderId: string) {
        return { id: orderId, entity: 'order', amount: 0, currency: 'INR', status: 'created', attempts: 0 };
      },
      async fetchPayments() {
        return { items: [] };
      },
    },
    payments: {
      async createRecurringPayment() {
        return { razorpay_payment_id: 'pay_stub' };
      },
    },
  };
}

async function quoteFor(items: { sku: string; qty: number }[]): Promise<SignedQuote> {
  const res = await app.inject({ method: 'POST', url: '/quotes', payload: { items } });
  expect(res.statusCode).toBe(200);
  return res.json() as SignedQuote;
}

function deps(adapter: RazorpayMandateAdapter) {
  return { quotes: app.quotes, quoteStore: app.quoteStore, adapter };
}

describe('RazorpayMandateAdapter against a real database', () => {
  beforeEach(async () => {
    await resetAll();
    await pool.query('truncate provider_customers');
    orders.length = 0;
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('completes a checkout without deadlocking on the mandate row lock', { timeout: 15_000 }, async () => {
    const mandate = await createMandate({
      user_ref: 'user_rzp',
      max_amount_paise: 500_000,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
    const adapter = new RazorpayMandateAdapter({ client: fakeClient() });

    const result = await checkout(
      { quote_id: quote.quote_id, mandate_id: mandate.id },
      deps(adapter),
    );

    expect(result).toMatchObject({ status: 'charged', amount_paise: 4_000 });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.amount).toBe(4_000);
    expect((await getMandate(mandate.id))!.used_paise).toBe(4_000);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('creates one customer per user across several charges', { timeout: 15_000 }, async () => {
    const mandate = await createMandate({
      user_ref: 'user_repeat',
      max_amount_paise: 500_000,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const adapter = new RazorpayMandateAdapter({ client: fakeClient() });

    for (let i = 0; i < 3; i += 1) {
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
      const result = await checkout(
        { quote_id: quote.quote_id, mandate_id: mandate.id },
        deps(adapter),
      );
      expect(result.status).toBe('charged');
    }

    const { rows } = await pool.query(
      'select customer_id from provider_customers where user_ref = $1',
      ['user_repeat'],
    );
    expect(rows).toHaveLength(1);
    // Every order went to that same customer.
    expect(new Set(orders.map((o) => o.customer_id)).size).toBe(1);
    expect(orders[0]!.customer_id).toBe(rows[0]!.customer_id);
  });

  it('survives concurrent first-time charges for the same new user', { timeout: 20_000 }, async () => {
    const mandate = await createMandate({
      user_ref: 'user_race',
      max_amount_paise: 500_000,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const adapter = new RazorpayMandateAdapter({ client: fakeClient() });

    const quotes = await Promise.all(
      Array.from({ length: 4 }, () => quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }])),
    );
    const results = await Promise.all(
      quotes.map((q) => checkout({ quote_id: q.quote_id, mandate_id: mandate.id }, deps(adapter))),
    );

    expect(results.every((r) => r.status === 'charged')).toBe(true);
    // Racing charges may each create a customer upstream, but exactly one id
    // is remembered, and from then on every charge agrees on it.
    const { rows } = await pool.query(
      'select customer_id from provider_customers where user_ref = $1',
      ['user_race'],
    );
    expect(rows).toHaveLength(1);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });
});
