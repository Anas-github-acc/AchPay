import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { checkout } from '../../src/checkout/checkout.js';
import { pool } from '../../src/db/pool.js';
import { verifyChain } from '../../src/ledger/ledger.js';
import { createMandate, getMandate } from '../../src/mandates/repo.js';
import { getPayment } from '../../src/payments/repo.js';
import { FakeAdapter } from '../../src/payments/fake.js';
import { reclaimStaleReservations } from '../../src/payments/reclaim.js';
import type { PaymentAdapter, SettlementView } from '../../src/payments/types.js';
import type { SignedQuote } from '../../src/quotes/types.js';
import { resetAll } from '../helpers/db.js';

/**
 * The gap these cover: a payment nobody ever settles.
 *
 * checkout books used_paise when the rail accepts a charge, and a webhook
 * normally releases or confirms that booking. A UPI mandate order nobody
 * authorises is never attempted, so it is never captured and never declined —
 * no webhook of any kind arrives, and without the sweep the reservation
 * behind it is held forever.
 */

let app: FastifyInstance;

/** An adapter that charges like the fake one but answers a scripted verdict. */
function reconciler(view: SettlementView): PaymentAdapter {
  const fake = new FakeAdapter();
  return {
    name: fake.name,
    charge: (req) => fake.charge(req),
    async reconcile() {
      return view;
    },
  };
}

async function quoteFor(items: { sku: string; qty: number }[]): Promise<SignedQuote> {
  const res = await app.inject({ method: 'POST', url: '/quotes', payload: { items } });
  expect(res.statusCode).toBe(200);
  return res.json() as SignedQuote;
}

/** A charge sitting at 'created', with the reservation it took. */
async function pendingCharge(): Promise<{ orderRef: string; mandateId: string }> {
  const mandate = await createMandate({
    user_ref: 'user_reclaim',
    max_amount_paise: 500_000,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
  const result = await checkout(
    { quote_id: quote.quote_id, mandate_id: mandate.id },
    { quotes: app.quotes, quoteStore: app.quoteStore, adapter: new FakeAdapter() },
  );
  expect(result).toMatchObject({ status: 'charged' });
  expect((await getMandate(mandate.id))!.used_paise).toBe(4_000);
  return { orderRef: (result as { order_ref: string }).order_ref, mandateId: mandate.id };
}

/** Backdates a payment so the sweep's age filter selects it. */
async function age(orderRef: string, minutes: number): Promise<void> {
  await pool.query(
    `update payments set created_at = now() - make_interval(mins => $2) where order_ref = $1`,
    [orderRef, minutes],
  );
}

describe('reclaiming stale reservations', () => {
  beforeEach(async () => {
    await resetAll();
    app = await buildApp({ adapter: new FakeAdapter() });
  });

  // No pool.end() here: isolate is off and fileParallelism is false, so the
  // Postgres pool is shared with every file that runs after this one.
  afterAll(async () => {
    await app?.close();
  });

  it('releases the headroom held by an order that was never attempted', async () => {
    const { orderRef, mandateId } = await pendingCharge();
    await age(orderRef, 20);

    const summary = await reclaimStaleReservations(
      reconciler({ status: 'abandoned', paymentRef: null, detail: 'never attempted' }),
    );

    expect(summary.examined).toBe(1);
    expect(summary.released).toMatchObject([{ order_ref: orderRef, released_paise: 4_000 }]);
    expect((await getPayment(orderRef))!.status).toBe('abandoned');
    expect((await getMandate(mandateId))!.used_paise).toBe(0);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('leaves a reservation younger than the window alone', async () => {
    const { orderRef, mandateId } = await pendingCharge();
    await age(orderRef, 5);

    const summary = await reclaimStaleReservations(
      reconciler({ status: 'abandoned', paymentRef: null, detail: 'never attempted' }),
    );

    expect(summary.examined).toBe(0);
    expect((await getPayment(orderRef))!.status).toBe('created');
    expect((await getMandate(mandateId))!.used_paise).toBe(4_000);
  });

  it('settles a capture whose webhook never arrived, and keeps the reservation', async () => {
    // The dangerous direction. Money moved; the sweep must record that rather
    // than hand the headroom back because no webhook showed up.
    const { orderRef, mandateId } = await pendingCharge();
    await age(orderRef, 20);

    const summary = await reclaimStaleReservations(
      reconciler({ status: 'captured', paymentRef: 'pay_LOSTHOOK', detail: 'order is paid' }),
    );

    expect(summary.released).toEqual([]);
    expect(summary.settled).toMatchObject([{ order_ref: orderRef, status: 'captured' }]);
    const payment = await getPayment(orderRef);
    expect(payment!.status).toBe('captured');
    expect(payment!.payment_ref).toBe('pay_LOSTHOOK');
    expect((await getMandate(mandateId))!.used_paise).toBe(4_000);
  });

  it('does nothing for an order the provider still calls in flight', async () => {
    const { orderRef, mandateId } = await pendingCharge();
    await age(orderRef, 20);

    const summary = await reclaimStaleReservations(
      reconciler({ status: 'created', paymentRef: null, detail: 'attempted, 1 attempt(s)' }),
    );

    expect(summary.examined).toBe(1);
    expect(summary.released).toEqual([]);
    expect(summary.unchanged).toHaveLength(1);
    expect((await getPayment(orderRef))!.status).toBe('created');
    expect((await getMandate(mandateId))!.used_paise).toBe(4_000);
  });

  it('releases once, however many times the sweep runs', async () => {
    const { orderRef, mandateId } = await pendingCharge();
    await age(orderRef, 20);
    const adapter = reconciler({ status: 'abandoned', paymentRef: null, detail: 'never attempted' });

    await reclaimStaleReservations(adapter);
    const second = await reclaimStaleReservations(adapter);

    // The row left 'created', so it is no longer selected at all.
    expect(second.examined).toBe(0);
    expect((await getMandate(mandateId))!.used_paise).toBe(0);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('will not act at all for an adapter that cannot reconcile', async () => {
    const { orderRef, mandateId } = await pendingCharge();
    await age(orderRef, 20);

    // No evidence available, so no release. Releasing on the clock alone would
    // mean guessing that a missing webhook implies a missing payment.
    const summary = await reclaimStaleReservations(new FakeAdapter());

    expect(summary).toMatchObject({ examined: 0, released: [], settled: [] });
    expect((await getPayment(orderRef))!.status).toBe('created');
    expect((await getMandate(mandateId))!.used_paise).toBe(4_000);
  });

  it('carries on past an order the provider cannot answer for', async () => {
    const { orderRef, mandateId } = await pendingCharge();
    await age(orderRef, 20);
    const fake = new FakeAdapter();
    const adapter: PaymentAdapter = {
      name: fake.name,
      charge: (req) => fake.charge(req),
      async reconcile() {
        throw new Error('razorpay unreachable');
      },
    };

    const summary = await reclaimStaleReservations(adapter);

    expect(summary.errors).toMatchObject([{ order_ref: orderRef }]);
    // Still reserved, still 'created': the next sweep asks again.
    expect((await getPayment(orderRef))!.status).toBe('created');
    expect((await getMandate(mandateId))!.used_paise).toBe(4_000);
  });
});
