import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { checkout } from '../../src/checkout/checkout.js';
import { pool } from '../../src/db/pool.js';
import { verifyChain } from '../../src/ledger/ledger.js';
import { createMandate, getMandate } from '../../src/mandates/repo.js';
import { getPayment } from '../../src/payments/repo.js';
import { FakeAdapter } from '../../src/payments/fake.js';
import { computeSignature } from '../../src/webhooks/signature.js';
import type { SignedQuote } from '../../src/quotes/types.js';
import { countLedger, resetAll } from '../helpers/db.js';

/**
 * The secret these tests sign with. config reads the env var once at import,
 * so it is set here before buildApp and matches what the route verifies against.
 */
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? 'test_webhook_secret';

let app: FastifyInstance;

async function quoteFor(items: { sku: string; qty: number }[]): Promise<SignedQuote> {
  const res = await app.inject({ method: 'POST', url: '/quotes', payload: { items } });
  expect(res.statusCode).toBe(200);
  return res.json() as SignedQuote;
}

/** Runs a real checkout and returns the order_ref it booked as pending. */
async function chargeOnce(amountSku = 'BSC-PRL-300'): Promise<{ orderRef: string; mandateId: string }> {
  const mandate = await createMandate({
    user_ref: 'user_wh',
    max_amount_paise: 500_000,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const quote = await quoteFor([{ sku: amountSku, qty: 1 }]);
  const result = await checkout(
    { quote_id: quote.quote_id, mandate_id: mandate.id },
    { quotes: app.quotes, quoteStore: app.quoteStore, adapter: new FakeAdapter() },
  );
  expect(result.status).toBe('charged');
  return { orderRef: (result as { order_ref: string }).order_ref, mandateId: mandate.id };
}

/** A Razorpay event envelope, shaped like the real thing. */
function event(name: string, orderRef: string, amountPaise = 4_000, paymentId = 'pay_TEST0001'): string {
  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_TEST',
    event: name,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: 'payment',
          amount: amountPaise,
          currency: 'INR',
          status: name === 'payment.captured' ? 'captured' : 'failed',
          order_id: orderRef,
          method: 'upi',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
}

/** Delivers a body exactly as Razorpay would, signing the bytes that are sent. */
async function deliver(
  body: string,
  opts: { eventId?: string; signature?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': opts.signature ?? computeSignature(Buffer.from(body, 'utf8'), SECRET),
      ...(opts.eventId === undefined ? {} : { 'x-razorpay-event-id': opts.eventId }),
    },
    payload: body,
  });
}

describe('POST /webhooks/razorpay', () => {
  beforeEach(async () => {
    await resetAll();
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('moves a payment from created to captured', async () => {
    const { orderRef } = await chargeOnce();
    expect((await getPayment(orderRef))!.status).toBe('created');

    const res = await deliver(event('payment.captured', orderRef), { eventId: 'evt_cap_1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'processed',
      event: 'payment.captured',
      order_ref: orderRef,
      payment_status: 'captured',
    });

    const payment = await getPayment(orderRef);
    expect(payment!.status).toBe('captured');
    expect(payment!.payment_ref).toBe('pay_TEST0001');
    expect(await countLedger("event_type = 'webhook'")).toBe(1);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('the same delivery twice writes exactly one ledger row', async () => {
    const { orderRef } = await chargeOnce();
    const body = event('payment.captured', orderRef);

    const first = await deliver(body, { eventId: 'evt_replay' });
    const second = await deliver(body, { eventId: 'evt_replay' });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'processed' });

    // A replay must be a 200 too, or Razorpay keeps redelivering it.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      status: 'duplicate',
      event_id: 'evt_replay',
      ledger_seq: first.json().ledger_seq,
    });

    expect(await countLedger("event_type = 'webhook'")).toBe(1);
    expect((await getPayment(orderRef))!.status).toBe('captured');
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('dedupes a redelivery even when it arrives many times over', async () => {
    const { orderRef } = await chargeOnce();
    const body = event('payment.captured', orderRef);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => deliver(body, { eventId: 'evt_storm' })),
    );

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().status === 'processed')).toHaveLength(1);
    expect(await countLedger("event_type = 'webhook'")).toBe(1);
  });

  it('dedupes on body content when no event id header is sent', async () => {
    const { orderRef } = await chargeOnce();
    const body = event('payment.captured', orderRef);

    await deliver(body);
    const second = await deliver(body);

    expect(second.json()).toMatchObject({ status: 'duplicate' });
    expect(await countLedger("event_type = 'webhook'")).toBe(1);
  });

  it('rejects a wrong signature with 400 and writes nothing', async () => {
    const { orderRef } = await chargeOnce();
    const before = await countLedger('true');

    const res = await deliver(event('payment.captured', orderRef), {
      eventId: 'evt_forged',
      signature: 'f'.repeat(64),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'INVALID_SIGNATURE' });
    expect(await countLedger('true')).toBe(before);
    expect(await countLedger("event_type = 'webhook'")).toBe(0);
    // The payment is untouched: an unverified body is not evidence of anything.
    expect((await getPayment(orderRef))!.status).toBe('created');
    const { rows } = await pool.query('select * from webhook_events');
    expect(rows).toHaveLength(0);
  });

  it('rejects a missing signature, and a body altered after signing', async () => {
    const { orderRef } = await chargeOnce();
    const body = event('payment.captured', orderRef);
    const goodSig = computeSignature(Buffer.from(body, 'utf8'), SECRET);

    const missing = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(missing.statusCode).toBe(400);

    // Same signature, one byte of the body changed.
    const tampered = await deliver(body.replace('"amount":4000', '"amount":1'), {
      signature: goodSig,
    });
    expect(tampered.statusCode).toBe(400);
    expect(await countLedger("event_type = 'webhook'")).toBe(0);
  });

  it('payment.failed records the failure and leaves used_paise unchanged', async () => {
    const { orderRef, mandateId } = await chargeOnce();
    const before = (await getMandate(mandateId))!.used_paise;
    expect(before).toBe(4_000);

    const res = await deliver(event('payment.failed', orderRef), { eventId: 'evt_fail_1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processed', payment_status: 'failed' });
    expect((await getPayment(orderRef))!.status).toBe('failed');
    expect(await countLedger("event_type = 'webhook' and payload ->> 'status' = 'failed'")).toBe(1);

    // The webhook never touches the mandate. Releasing headroom on a failure
    // is a decision for a human, not a side effect of a delivery.
    expect((await getMandate(mandateId))!.used_paise).toBe(before);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('lets a retry succeed: failed then captured settles as captured', async () => {
    // Exactly what a real card retry produced: the first attempt failed, the
    // customer tried again on the same order and it captured. A failed attempt
    // is not terminal for an order, so the capture has to win.
    const { orderRef } = await chargeOnce();

    await deliver(event('payment.failed', orderRef), { eventId: 'evt_a' });
    expect((await getPayment(orderRef))!.status).toBe('failed');

    const retry = await deliver(event('payment.captured', orderRef, 4_000, 'pay_RETRY'), {
      eventId: 'evt_b',
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'processed', payment_status: 'captured' });
    const payment = await getPayment(orderRef);
    expect(payment!.status).toBe('captured');
    expect(payment!.payment_ref).toBe('pay_RETRY');
    expect(await countLedger("event_type = 'webhook'")).toBe(2);
  });

  it('never lets a failure overwrite a capture', async () => {
    const { orderRef } = await chargeOnce();

    await deliver(event('payment.captured', orderRef), { eventId: 'evt_c' });
    const late = await deliver(event('payment.failed', orderRef), { eventId: 'evt_d' });

    expect(late.statusCode).toBe(200);
    // Money has moved. A later failure is recorded but never applied.
    expect((await getPayment(orderRef))!.status).toBe('captured');
    expect(await countLedger("event_type = 'webhook' and payload ->> 'applied' = 'false'")).toBe(1);
  });

  it('does not apply a second capture for an already captured payment', async () => {
    const { orderRef } = await chargeOnce();

    await deliver(event('payment.captured', orderRef), { eventId: 'evt_e' });
    const again = await deliver(event('payment.captured', orderRef, 4_000, 'pay_OTHER'), {
      eventId: 'evt_f',
    });

    expect(again.statusCode).toBe(200);
    const payment = await getPayment(orderRef);
    expect(payment!.status).toBe('captured');
    // The first capture's payment_ref stands.
    expect(payment!.payment_ref).toBe('pay_TEST0001');
  });

  it('records an event for an unknown order without failing the delivery', async () => {
    const res = await deliver(event('payment.captured', 'order_NOTOURS'), { eventId: 'evt_unknown' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'unmatched', order_ref: 'order_NOTOURS' });
    expect(await countLedger("event_type = 'webhook' and payload ->> 'matched' = 'false'")).toBe(1);
    expect(await verifyChain()).toMatchObject({ ok: true });
  });

  it('records an event it does not act on, without changing the payment', async () => {
    const { orderRef } = await chargeOnce();

    const res = await deliver(event('payment.authorized', orderRef), { eventId: 'evt_auth' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ignored', event: 'payment.authorized' });
    expect((await getPayment(orderRef))!.status).toBe('created');
  });

  it('rejects a malformed body that is nonetheless correctly signed', async () => {
    const body = 'not json at all';
    const res = await deliver(body, { eventId: 'evt_bad' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'MALFORMED_EVENT' });
    expect(await countLedger("event_type = 'webhook'")).toBe(0);
  });

  it('verifies against the raw bytes, not a re-serialisation of them', async () => {
    const { orderRef } = await chargeOnce();

    // Key order and number formatting that JSON.stringify would not reproduce.
    const body =
      `{"event":"payment.captured","payload":{"payment":{"entity":` +
      `{"order_id":"${orderRef}","id":"pay_RAW","amount":4000,"note":"caf\\u00e9"}}},"entity":"event"}`;
    expect(JSON.stringify(JSON.parse(body))).not.toBe(body);

    const res = await deliver(body, { eventId: 'evt_raw' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processed', payment_status: 'captured' });
  });

  it('leaves other routes parsing JSON normally', async () => {
    // The raw-body parser is scoped to the webhook plugin. If it leaked, this
    // route would receive a Buffer and fail to read items off the body.
    const res = await app.inject({
      method: 'POST',
      url: '/quotes',
      payload: { items: [{ sku: 'BSC-PRL-300', qty: 1 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total_paise: 4_000 });
  });
});
