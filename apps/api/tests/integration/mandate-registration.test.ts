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
import type { ChargeRequest, ChargeResult, PaymentAdapter } from '../../src/payments/types.js';
import type { CheckoutResult } from '../../src/checkout/types.js';
import type { SignedQuote } from '../../src/quotes/types.js';
import { countLedger, resetAll } from '../helpers/db.js';

/**
 * Registering a mandate: the one human step, and the states around it.
 *
 * The property under test throughout is that an *order* and a *payment* are
 * different things. A provider handing back an order id means a person has
 * been asked to authorise something; it does not mean money moved, and no path
 * here may let an agent claim otherwise or skip the person.
 */

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? 'test_webhook_secret';

let app: FastifyInstance;

/**
 * A stand-in for RazorpayMandateAdapter's two branches, with no network.
 *
 * It reproduces the only behaviour these tests care about: a mandate with no
 * provider token needs authorising; one with a token is debited directly.
 */
class RegisteringAdapter implements PaymentAdapter {
  readonly name = 'fake';
  readonly debits: string[] = [];
  readonly orders: string[] = [];

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    if (req.mandate.provider_token) {
      const ref = `pay_debit_${this.debits.length + 1}`;
      this.debits.push(req.mandate.provider_token);
      return { ref, status: 'created', provider_customer_id: 'cust_TEST' };
    }
    const ref = `order_auth_${this.orders.length + 1}`;
    this.orders.push(ref);
    return { ref, status: 'authorisation_required', provider_customer_id: 'cust_TEST' };
  }
}

async function quoteFor(items: { sku: string; qty: number }[]): Promise<SignedQuote> {
  const res = await app.inject({ method: 'POST', url: '/quotes', payload: { items } });
  expect(res.statusCode).toBe(200);
  return res.json() as SignedQuote;
}

async function mandateFor(userRef: string, providerToken: string | null = null) {
  return createMandate({
    user_ref: userRef,
    max_amount_paise: 500_000,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    provider_token: providerToken,
  });
}

/** A Razorpay event envelope, optionally carrying an authorisation token. */
function event(
  name: string,
  orderRef: string,
  opts: { tokenId?: string; paymentId?: string; amountPaise?: number } = {},
): string {
  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_TEST',
    event: name,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: opts.paymentId ?? 'pay_TEST0001',
          entity: 'payment',
          amount: opts.amountPaise ?? 4_000,
          currency: 'INR',
          status: name === 'payment.failed' ? 'failed' : 'captured',
          order_id: orderRef,
          method: 'upi',
          ...(opts.tokenId ? { token_id: opts.tokenId } : {}),
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
}

async function deliver(body: string, eventId: string) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': computeSignature(Buffer.from(body, 'utf8'), SECRET),
      'x-razorpay-event-id': eventId,
    },
    payload: body,
  });
}

describe('mandate registration', () => {
  let adapter: RegisteringAdapter;

  beforeEach(async () => {
    await resetAll();
    adapter = new RegisteringAdapter();
    app = await buildApp({ adapter });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('the first checkout on an unregistered mandate', () => {
    it('asks for authorisation instead of reporting a charge', async () => {
      const mandate = await mandateFor('user_first');
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);

      const result = await checkout(
        { quote_id: quote.quote_id, mandate_id: mandate.id },
        { quotes: app.quotes, quoteStore: app.quoteStore, adapter },
      );

      expect(result.status).toBe('authorisation_required');
      expect(result).toMatchObject({ amount_paise: 4_000, order_ref: 'order_auth_1' });
    });

    it('hands back a URL pointing at the authorisation page', async () => {
      const mandate = await mandateFor('user_url');
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);

      const result = (await checkout(
        { quote_id: quote.quote_id, mandate_id: mandate.id },
        { quotes: app.quotes, quoteStore: app.quoteStore, adapter },
      )) as Extract<CheckoutResult, { status: 'authorisation_required' }>;

      expect(result.authorisation_url).toContain('/authorise/');
      expect(result.authorisation_url).toContain(result.order_ref);
    });

    it('does not mark the payment captured just because an order exists', async () => {
      const mandate = await mandateFor('user_notcaptured');
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);

      await checkout(
        { quote_id: quote.quote_id, mandate_id: mandate.id },
        { quotes: app.quotes, quoteStore: app.quoteStore, adapter },
      );

      const payment = await getPayment('order_auth_1');
      expect(payment!.status).toBe('awaiting_authorisation');
      // Distinct from 'created', which would mean it had been submitted.
      expect(payment!.status).not.toBe('created');
      expect(payment!.status).not.toBe('captured');
      expect(await countLedger("event_type = 'charge' and payload ->> 'status' = 'captured'")).toBe(0);
    });

    it('reserves the headroom and records the order in the ledger', async () => {
      const mandate = await mandateFor('user_reserve');
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);

      await checkout(
        { quote_id: quote.quote_id, mandate_id: mandate.id },
        { quotes: app.quotes, quoteStore: app.quoteStore, adapter },
      );

      expect((await getMandate(mandate.id))!.used_paise).toBe(4_000);
      expect(
        await countLedger("event_type = 'charge' and payload ->> 'status' = 'awaiting_authorisation'"),
      ).toBe(1);
      expect(await verifyChain()).toMatchObject({ ok: true });
    });

    it('returns the same link rather than opening a second order', async () => {
      const mandate = await mandateFor('user_repeat');
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
      const deps = { quotes: app.quotes, quoteStore: app.quoteStore, adapter };

      const first = await checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps);
      const second = await checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps);

      expect(second).toEqual(first);
      expect(adapter.orders).toEqual(['order_auth_1']);
      // One reservation, not two.
      expect((await getMandate(mandate.id))!.used_paise).toBe(4_000);
    });

    it('serves the authorisation page data over HTTP', async () => {
      const mandate = await mandateFor('user_page');
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
      await checkout(
        { quote_id: quote.quote_id, mandate_id: mandate.id },
        { quotes: app.quotes, quoteStore: app.quoteStore, adapter },
      );

      const res = await app.inject({ method: 'GET', url: '/authorise/order_auth_1' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        order_ref: 'order_auth_1',
        status: 'awaiting_authorisation',
        amount_paise: 4_000,
        mandate_id: mandate.id,
        customer_id: 'cust_TEST',
        mandate_registered: false,
      });
      // The basket comes back so the payer sees what they are authorising.
      expect(res.json().lines).toHaveLength(1);
    });

    it('404s the authorisation page for an order that does not exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/authorise/order_nope' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('the authorising webhook', () => {
    async function pendingAuthorisation(userRef = 'user_wh') {
      const mandate = await mandateFor(userRef);
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
      const result = (await checkout(
        { quote_id: quote.quote_id, mandate_id: mandate.id },
        { quotes: app.quotes, quoteStore: app.quoteStore, adapter },
      )) as Extract<CheckoutResult, { status: 'authorisation_required' }>;
      return { mandateId: mandate.id, orderRef: result.order_ref };
    }

    it('stores the token on the mandate the order belongs to', async () => {
      const { mandateId, orderRef } = await pendingAuthorisation();

      const res = await deliver(
        event('payment.captured', orderRef, { tokenId: 'token_AUTH01' }),
        'evt_auth_1',
      );

      expect(res.statusCode).toBe(200);
      expect((await getMandate(mandateId))!.provider_token).toBe('token_AUTH01');
      expect((await getPayment(orderRef))!.status).toBe('captured');
      expect(await verifyChain()).toMatchObject({ ok: true });
    });

    it('registers from payment.authorized, which settles nothing by itself', async () => {
      const { mandateId, orderRef } = await pendingAuthorisation();

      await deliver(event('payment.authorized', orderRef, { tokenId: 'token_AUTH02' }), 'evt_auth_2');

      expect((await getMandate(mandateId))!.provider_token).toBe('token_AUTH02');
      // Authorised is not captured. Only a capture moves the payment.
      expect((await getPayment(orderRef))!.status).toBe('awaiting_authorisation');
    });

    it('replaying the same delivery changes nothing', async () => {
      const { mandateId, orderRef } = await pendingAuthorisation();
      const body = event('payment.captured', orderRef, { tokenId: 'token_REPLAY' });

      await deliver(body, 'evt_replay');
      const replay = await deliver(body, 'evt_replay');

      expect(replay.json()).toMatchObject({ status: 'duplicate' });
      expect(await countLedger("event_type = 'webhook'")).toBe(1);
      expect((await getMandate(mandateId))!.provider_token).toBe('token_REPLAY');
      expect((await getMandate(mandateId))!.used_paise).toBe(4_000);
    });

    it('redelivery under a new event id stores the same token once', async () => {
      // Razorpay's own dedupe key is the event id. A genuinely new delivery
      // carrying the same token must still be a no-op on the mandate.
      const { mandateId, orderRef } = await pendingAuthorisation();
      const body = event('payment.captured', orderRef, { tokenId: 'token_SAME' });

      await deliver(body, 'evt_one');
      await deliver(body, 'evt_two');

      expect((await getMandate(mandateId))!.provider_token).toBe('token_SAME');
      expect((await getMandate(mandateId))!.used_paise).toBe(4_000);
      expect(await verifyChain()).toMatchObject({ ok: true });
    });

    it('handles a webhook with no token_id exactly as before', async () => {
      const { mandateId, orderRef } = await pendingAuthorisation();

      const res = await deliver(event('payment.captured', orderRef), 'evt_notoken');

      expect(res.json()).toMatchObject({ status: 'processed', payment_status: 'captured' });
      expect((await getMandate(mandateId))!.provider_token).toBeNull();
      expect((await getMandate(mandateId))!.used_paise).toBe(4_000);
    });

    it('will not attach a token from an order this storefront never opened', async () => {
      const { mandateId } = await pendingAuthorisation();

      const res = await deliver(
        event('payment.captured', 'order_SOMEONE_ELSE', { tokenId: 'token_FOREIGN' }),
        'evt_foreign',
      );

      expect(res.json()).toMatchObject({ status: 'unmatched' });
      expect((await getMandate(mandateId))!.provider_token).toBeNull();
      // Recorded, though: an unmatched webhook is exactly what an auditor wants.
      expect(
        await countLedger("event_type = 'webhook' and payload ->> 'token_stored' = 'false'"),
      ).toBe(1);
    });

    it('will not rebind a mandate that already holds a different token', async () => {
      const { mandateId, orderRef } = await pendingAuthorisation();
      await deliver(event('payment.captured', orderRef, { tokenId: 'token_FIRST' }), 'evt_first');

      // A second authorisation on the same order, carrying a different token.
      await deliver(
        event('payment.captured', orderRef, { tokenId: 'token_SECOND', paymentId: 'pay_TWO' }),
        'evt_second',
      );

      expect((await getMandate(mandateId))!.provider_token).toBe('token_FIRST');
      expect(
        await countLedger(
          "event_type = 'webhook' and payload ->> 'token_note' like 'mandate already registered%'",
        ),
      ).toBe(1);
    });

    it('does not register a mandate from a failed authorisation', async () => {
      const { mandateId, orderRef } = await pendingAuthorisation();

      await deliver(
        event('payment.failed', orderRef, { tokenId: 'token_SHOULD_NOT_STICK' }),
        'evt_failed_auth',
      );

      expect((await getMandate(mandateId))!.provider_token).toBeNull();
      expect((await getPayment(orderRef))!.status).toBe('failed');
      // And the reservation goes back, as it does for any failed charge.
      expect((await getMandate(mandateId))!.used_paise).toBe(0);
    });
  });

  describe('once the mandate is registered', () => {
    it('debits the registered mandate instead of asking again', async () => {
      const mandate = await mandateFor('user_registered');
      const deps = { quotes: app.quotes, quoteStore: app.quoteStore, adapter };

      // First purchase: authorisation, then the webhook that registers it.
      const first = (await checkout(
        { quote_id: (await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }])).quote_id, mandate_id: mandate.id },
        deps,
      )) as Extract<CheckoutResult, { status: 'authorisation_required' }>;
      await deliver(
        event('payment.captured', first.order_ref, { tokenId: 'token_LIVE' }),
        'evt_register',
      );
      expect((await getMandate(mandate.id))!.provider_token).toBe('token_LIVE');

      // Second purchase: no human anywhere in it.
      const second = await checkout(
        { quote_id: (await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }])).quote_id, mandate_id: mandate.id },
        deps,
      );

      expect(second.status).toBe('charged');
      expect(second).toMatchObject({ charge_status: 'created', order_ref: 'pay_debit_1' });
      expect(adapter.debits).toEqual(['token_LIVE']);
      // Still one mandate order in total: registration happens once.
      expect(adapter.orders).toHaveLength(1);
      expect(await verifyChain()).toMatchObject({ ok: true });
    });

    it('a registered mandate never returns an authorisation link', async () => {
      const mandate = await mandateFor('user_already', 'token_PREEXISTING');
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);

      const result = await checkout(
        { quote_id: quote.quote_id, mandate_id: mandate.id },
        { quotes: app.quotes, quoteStore: app.quoteStore, adapter },
      );

      expect(result.status).toBe('charged');
      expect(adapter.orders).toHaveLength(0);
      expect(adapter.debits).toEqual(['token_PREEXISTING']);
    });
  });

  describe('what an agent cannot do', () => {
    it('has no HTTP path that registers a mandate', async () => {
      const mandate = await mandateFor('user_agent');
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
      const res = await app.inject({
        method: 'POST',
        url: '/checkout',
        payload: {
          quote_id: quote.quote_id,
          mandate_id: mandate.id,
          // None of this is read by anything.
          provider_token: 'token_INJECTED',
          authorised: true,
          status: 'charged',
        },
      });

      expect(res.json()).toMatchObject({ status: 'authorisation_required' });
      expect((await getMandate(mandate.id))!.provider_token).toBeNull();
    });

    it('cannot register a mandate by POSTing to the authorisation page route', async () => {
      const mandate = await mandateFor('user_post');
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
      await checkout(
        { quote_id: quote.quote_id, mandate_id: mandate.id },
        { quotes: app.quotes, quoteStore: app.quoteStore, adapter },
      );

      const res = await app.inject({
        method: 'POST',
        url: '/authorise/order_auth_1',
        payload: { provider_token: 'token_INJECTED' },
      });

      // The route is read-only; there is no POST handler at all.
      expect(res.statusCode).toBe(404);
      expect((await getMandate(mandate.id))!.provider_token).toBeNull();
    });

    it('an unsigned webhook registers nothing', async () => {
      const mandate = await mandateFor('user_unsigned');
      const quote = await quoteFor([{ sku: 'BSC-PRL-300', qty: 1 }]);
      const result = (await checkout(
        { quote_id: quote.quote_id, mandate_id: mandate.id },
        { quotes: app.quotes, quoteStore: app.quoteStore, adapter },
      )) as Extract<CheckoutResult, { status: 'authorisation_required' }>;

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/razorpay',
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': 'not-a-signature',
        },
        payload: event('payment.captured', result.order_ref, { tokenId: 'token_FORGED' }),
      });

      expect(res.statusCode).toBe(400);
      expect((await getMandate(mandate.id))!.provider_token).toBeNull();
    });
  });
});
