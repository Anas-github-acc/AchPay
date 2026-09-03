import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { checkout } from '../../src/checkout/checkout.js';
import { idempotencyKey } from '../../src/checkout/idempotency.js';
import { pool } from '../../src/db/pool.js';
import { verifyChain } from '../../src/ledger/ledger.js';
import { createMandate, getMandate, revokeMandate } from '../../src/mandates/repo.js';
import { AlwaysFailingAdapter, FakeAdapter, FlakyFakeAdapter } from '../../src/payments/fake.js';
import { getPolicy, setPolicy } from '../../src/policy/config.js';
import { canonicalJson } from '../../src/lib/canonical.js';
import type { PaymentAdapter, ChargeRequest, ChargeResult } from '../../src/payments/types.js';
import type { SignedQuote } from '../../src/quotes/types.js';
import { countLedger, resetAll } from '../helpers/db.js';

/** Counts every call that reached an adapter, so "one charge" is provable. */
class CountingAdapter implements PaymentAdapter {
  readonly name = 'counting';
  calls = 0;
  constructor(private readonly inner: PaymentAdapter = new FakeAdapter()) {}
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    this.calls += 1;
    return this.inner.charge(req);
  }
}

let app: FastifyInstance;

async function mandateFor(maxPaise: number, ttlHours = 24) {
  return createMandate({
    user_ref: 'user_test',
    max_amount_paise: maxPaise,
    expires_at: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
  });
}

async function quoteFor(items: { sku: string; qty: number }[]): Promise<SignedQuote> {
  const res = await app.inject({ method: 'POST', url: '/quotes', payload: { items } });
  expect(res.statusCode).toBe(200);
  return res.json() as SignedQuote;
}

function deps(adapter: PaymentAdapter) {
  return { quotes: app.quotes, quoteStore: app.quoteStore, adapter };
}

describe('checkout', () => {
  beforeEach(async () => {
    await resetAll();
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    // Deliberately no truncate: the rows this file wrote are what the
    // post-suite `pnpm verify:ledger` walks.
  });

  it('happy path: one charge and two ledger rows, decision then charge', async () => {
    const mandate = await mandateFor(500_000);
    // Rs 40 total — under the Rs 300 gate, so it charges outright.
    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
    const adapter = new CountingAdapter();

    const result = await checkout(
      { quote_id: quote.quote_id, mandate_id: mandate.id, intent_text: 'order biscuits' },
      deps(adapter),
    );

    expect(result).toMatchObject({
      status: 'charged',
      amount_paise: 4_000,
      rule_id: 'all_checks_passed',
      charge_status: 'captured',
    });
    expect(adapter.calls).toBe(1);

    const rows = (await app.inject({ method: 'GET', url: '/ledger' })).json().rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      event_type: 'decision',
      decision: 'allow',
      rule_id: 'all_checks_passed',
      intent_text: 'order biscuits',
      amount_paise: 4_000,
    });
    expect(rows[1]).toMatchObject({ event_type: 'charge', amount_paise: 4_000 });

    const after = await getMandate(mandate.id);
    expect(after!.used_paise).toBe(4_000);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('sending the same request twice charges once and answers identically', async () => {
    const mandate = await mandateFor(500_000);
    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
    const adapter = new CountingAdapter();

    const first = await checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter));
    const second = await checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter));

    expect(second).toEqual(first);
    expect(adapter.calls).toBe(1);
    expect(await countLedger("event_type = 'charge'")).toBe(1);
    expect((await getMandate(mandate.id))!.used_paise).toBe(4_000);
  });

  it('five identical concurrent checkouts produce exactly one charge row', async () => {
    const mandate = await mandateFor(500_000);
    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 2 }]);
    const adapter = new CountingAdapter();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter)),
      ),
    );

    expect(adapter.calls).toBe(1);
    expect(await countLedger("event_type = 'charge'")).toBe(1);
    // Every caller gets the same answer, not an error. Compared canonically
    // because a replayed result comes back through jsonb, which does not
    // preserve key order.
    expect(results.every((r) => r.status === 'charged')).toBe(true);
    expect(new Set(results.map((r) => canonicalJson(r))).size).toBe(1);
    expect((await getMandate(mandate.id))!.used_paise).toBe(8_000);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('a quote over the per-txn cap charges nothing and writes one deny row', async () => {
    const mandate = await mandateFor(5_000_000);
    // Rs 1200 hamper, over the Rs 500 per-transaction cap.
    const quote = await quoteFor([{ sku: 'SNK-HAM-DLX', qty: 1 }]);
    const adapter = new CountingAdapter();

    const result = await checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter));

    expect(result).toMatchObject({
      status: 'denied',
      rule_id: 'per_txn_max',
      quote_id: quote.quote_id,
    });
    expect(adapter.calls).toBe(0);
    expect(await countLedger("event_type = 'charge'")).toBe(0);

    const rows = (await app.inject({ method: 'GET', url: '/ledger' })).json().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'decision',
      decision: 'deny',
      rule_id: 'per_txn_max',
      amount_paise: 120_000,
    });
    expect((await getMandate(mandate.id))!.used_paise).toBe(0);
  });

  it('a gated quote writes a gate row and charges nothing', async () => {
    const mandate = await mandateFor(5_000_000);
    // Rs 360 — over the Rs 300 gate, under the Rs 500 cap.
    const quote = await quoteFor([{ sku: 'CHAI-MSL-250', qty: 2 }]);
    const adapter = new CountingAdapter();

    const result = await checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter));

    expect(result).toMatchObject({
      status: 'pending_approval',
      rule_id: 'gate_threshold',
      amount_paise: 36_000,
    });
    expect(adapter.calls).toBe(0);
    expect(await countLedger("event_type = 'decision' and decision = 'gate'")).toBe(1);
    expect((await getMandate(mandate.id))!.used_paise).toBe(0);
  });

  it('a mandate revoked between quote and checkout is denied', async () => {
    const mandate = await mandateFor(500_000);
    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
    await revokeMandate(mandate.id);
    const adapter = new CountingAdapter();

    const result = await checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter));

    expect(result).toMatchObject({ status: 'denied', rule_id: 'mandate_revoked' });
    expect(adapter.calls).toBe(0);
    expect(await countLedger("event_type = 'charge'")).toBe(0);
  });

  it('an unknown mandate is denied through the policy engine, with a ledger row', async () => {
    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
    const result = await checkout(
      { quote_id: quote.quote_id, mandate_id: 'mnd_does_not_exist' },
      deps(new CountingAdapter()),
    );
    expect(result).toMatchObject({ status: 'denied', rule_id: 'mandate_missing' });
    expect(await countLedger("decision = 'deny'")).toBe(1);
  });

  it('a failed charge leaves no used_paise increment but does record the failure', async () => {
    const mandate = await mandateFor(500_000);
    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);

    const result = await checkout(
      { quote_id: quote.quote_id, mandate_id: mandate.id },
      deps(new AlwaysFailingAdapter()),
    );

    expect(result).toMatchObject({ status: 'charge_failed', amount_paise: 4_000 });
    expect((await getMandate(mandate.id))!.used_paise).toBe(0);
    expect(await countLedger("event_type = 'charge' and payload ->> 'status' = 'failed'")).toBe(1);
    expect(await countLedger("event_type = 'decision' and decision = 'allow'")).toBe(1);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('a retry after a failed charge is allowed to succeed', async () => {
    const mandate = await mandateFor(500_000);
    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);

    const failed = await checkout(
      { quote_id: quote.quote_id, mandate_id: mandate.id },
      deps(new AlwaysFailingAdapter()),
    );
    expect(failed.status).toBe('charge_failed');

    const retried = await checkout(
      { quote_id: quote.quote_id, mandate_id: mandate.id },
      deps(new FakeAdapter()),
    );
    expect(retried.status).toBe('charged');
    expect((await getMandate(mandate.id))!.used_paise).toBe(4_000);
  });

  it('the flaky adapter never books money for a charge it failed', async () => {
    const adapter = new FlakyFakeAdapter(0.3);
    let failures = 0;
    let successes = 0;

    for (let i = 0; i < 12; i += 1) {
      const mandate = await mandateFor(500_000);
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
      const result = await checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter));
      const after = await getMandate(mandate.id);
      if (result.status === 'charge_failed') {
        failures += 1;
        expect(after!.used_paise).toBe(0);
      } else {
        successes += 1;
        expect(result.status).toBe('charged');
        expect(after!.used_paise).toBe(4_000);
      }
    }

    expect(failures + successes).toBe(12);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('a tampered quote submitted directly is rejected before any policy check', async () => {
    const mandate = await mandateFor(5_000_000);
    const quote = await quoteFor([{ sku: 'SNK-HAM-DLX', qty: 1 }]);
    const cheapened = { ...quote, total_paise: 100, lines: [{ ...quote.lines[0]!, line_total_paise: 100 }] };

    const result = await checkout(
      { quote: cheapened, mandate_id: mandate.id },
      deps(new CountingAdapter()),
    );

    expect(result).toMatchObject({ status: 'quote_invalid', error: 'QUOTE_SIGNATURE_INVALID' });
    expect(await countLedger('true')).toBe(0);
  });

  it('an unknown quote_id is reported rather than charged', async () => {
    const mandate = await mandateFor(500_000);
    const result = await checkout(
      { quote_id: 'qt_nope', mandate_id: mandate.id },
      deps(new CountingAdapter()),
    );
    expect(result).toMatchObject({ status: 'quote_invalid', error: 'QUOTE_NOT_FOUND' });
  });

  it('gated purchases charge nothing and never accrue towards the daily total', async () => {
    const mandate = await mandateFor(5_000_000);
    const adapter = new CountingAdapter();

    // Rs 400 each: over the Rs 300 gate, under the Rs 500 per-txn cap.
    const spend = async () => {
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 10 }]); // Rs 400
      return checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter));
    };

    const outcomes = [];
    for (let i = 0; i < 6; i += 1) outcomes.push(await spend());

    // The first five gate (Rs 400 is over the Rs 300 threshold) so none charge;
    // gates do not add to spend, so the daily cap is never reached here.
    expect(outcomes.every((o) => o.status === 'pending_approval')).toBe(true);
    expect(adapter.calls).toBe(0);
    expect(await countLedger("decision = 'gate'")).toBe(6);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('denies the sixth charge inside an hour on velocity', async () => {
    const mandate = await mandateFor(5_000_000);
    const adapter = new CountingAdapter();

    // Rs 280 per go: under the Rs 300 gate, so each one actually charges.
    const spend = async () => {
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 7 }]); // Rs 280
      return checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter));
    };

    const outcomes = [];
    for (let i = 0; i < 6; i += 1) outcomes.push(await spend());

    expect(outcomes.slice(0, 5).every((o) => o.status === 'charged')).toBe(true);
    expect(outcomes[5]).toMatchObject({ status: 'denied', rule_id: 'velocity' });
    expect(adapter.calls).toBe(5);
    expect((await getMandate(mandate.id))!.used_paise).toBe(140_000);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('spends up to the daily cap and denies the transaction that would breach it', async () => {
    // Velocity is raised for this case only, so the daily cap is what fires
    // rather than the hourly transaction count. Under the shipped policy the
    // two interact: five charges an hour at the Rs 300 gate is Rs 1500, so
    // the Rs 2000 daily cap is only ever reached across more than one hour.
    const base = getPolicy();
    setPolicy({ ...base, velocity_max_per_hour: 50 });
    try {
      const mandate = await mandateFor(5_000_000);
      const adapter = new CountingAdapter();

      // Rs 280 per go, under the Rs 300 gate. The daily cap is Rs 2000, so
      // the eighth (which would reach Rs 2240) must be denied.
      const spend = async () => {
        const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 7 }]);
        return checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter));
      };

      const outcomes = [];
      for (let i = 0; i < 8; i += 1) outcomes.push(await spend());

      const charged = outcomes.filter((o) => o.status === 'charged');
      const denied = outcomes.filter((o) => o.status === 'denied');
      expect(charged).toHaveLength(7); // 7 x Rs 280 = Rs 1960, inside the cap
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({ rule_id: 'daily_max' });
      expect(adapter.calls).toBe(7);
      expect((await getMandate(mandate.id))!.used_paise).toBe(196_000);
      expect(await verifyChain()).toMatchObject({ ok: true });
    } finally {
      setPolicy(base);
    }
  });

  it('denies once mandate headroom is exhausted, and never oversubscribes it', async () => {
    // Headroom Rs 100 against a Rs 40 basket: two fit, the third does not.
    const mandate = await mandateFor(10_000);
    const adapter = new CountingAdapter();

    const spend = async () => {
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
      return checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps(adapter));
    };

    expect((await spend()).status).toBe('charged');
    expect((await spend()).status).toBe('charged');
    const third = await spend();
    expect(third).toMatchObject({ status: 'denied', rule_id: 'headroom' });

    const after = await getMandate(mandate.id);
    expect(after!.used_paise).toBe(8_000);
    expect(after!.used_paise).toBeLessThanOrEqual(after!.max_amount_paise);
  });

  it('concurrent checkouts of different baskets cannot oversubscribe headroom', async () => {
    // Rs 100 of headroom, five concurrent Rs 40 baskets. At most two can fit.
    const mandate = await mandateFor(10_000);
    const adapter = new CountingAdapter();

    const quotes = await Promise.all(
      Array.from({ length: 5 }, (_, i) => quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]).then((q) => q)),
    );
    // Distinct quote_ids => distinct idempotency keys, so nothing dedupes here.
    expect(new Set(quotes.map((q) => q.quote_id)).size).toBe(5);

    const results = await Promise.all(
      quotes.map((q) => checkout({ quote_id: q.quote_id, mandate_id: mandate.id }, deps(adapter))),
    );

    const charged = results.filter((r) => r.status === 'charged');
    expect(charged.length).toBe(2);
    expect(adapter.calls).toBe(2);
    const after = await getMandate(mandate.id);
    expect(after!.used_paise).toBe(8_000);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('derives the same idempotency key regardless of line order', async () => {
    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }, { sku: 'CHAI-MSL-250', qty: 1 }]);
    const reversed = { ...quote, lines: [...quote.lines].reverse() };
    expect(idempotencyKey('mnd_x', reversed)).toBe(idempotencyKey('mnd_x', quote));
    expect(idempotencyKey('mnd_y', quote)).not.toBe(idempotencyKey('mnd_x', quote));
  });

  it('serves the flow over HTTP end to end', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/mandates',
      payload: { user_ref: 'user_http', max_amount_paise: 500_000, ttl_hours: 24 },
    });
    expect(created.statusCode).toBe(201);
    const mandate = created.json();

    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
    const res = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { quote_id: quote.quote_id, mandate_id: mandate.id, intent_text: 'buy biscuits' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'charged', amount_paise: 4_000 });

    const denied = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { quote_id: (await quoteFor([{ sku: 'SNK-HAM-DLX', qty: 1 }])).quote_id, mandate_id: mandate.id },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({ status: 'denied', rule_id: 'per_txn_max' });

    const stale = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { quote_id: 'qt_missing', mandate_id: mandate.id },
    });
    expect(stale.statusCode).toBe(409);

    expect((await app.inject({ method: 'GET', url: '/ledger/verify' })).json()).toMatchObject({
      ok: true,
    });
  });

  it('POST /checkout has no way to accept an amount', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/mandates',
      payload: { user_ref: 'user_amount', max_amount_paise: 500_000, ttl_hours: 24 },
    });
    const mandate = created.json();
    const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);

    const res = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: {
        quote_id: quote.quote_id,
        mandate_id: mandate.id,
        amount_paise: 1,
        total_paise: 1,
      },
    });
    // The injected amounts are ignored; the charge is the quote's real total.
    expect(res.json()).toMatchObject({ status: 'charged', amount_paise: 4_000 });
  });

  it('leaves the chain intact after every case in this file', async () => {
    expect(await verifyChain()).toMatchObject({ ok: true });
    const { rows } = await pool.query('select 1');
    expect(rows).toHaveLength(1);
  });
});
