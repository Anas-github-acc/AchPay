import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { checkout } from '../../src/checkout/checkout.js';
import { pool } from '../../src/db/pool.js';
import { verifyChain } from '../../src/ledger/ledger.js';
import { createMandate, getMandate } from '../../src/mandates/repo.js';
import { getApproval } from '../../src/approvals/repo.js';
import { AlwaysFailingAdapter, FakeAdapter } from '../../src/payments/fake.js';
import { computeSignature } from '../../src/webhooks/signature.js';
import type { PaymentAdapter, ChargeRequest, ChargeResult } from '../../src/payments/types.js';
import type { SignedQuote } from '../../src/quotes/types.js';
import { countLedger, resetAll } from '../helpers/db.js';

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? 'test_webhook_secret';

/** Counts every call that reached an adapter, so "zero charges" is provable. */
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

async function quoteFor(items: { sku: string; qty: number }[]): Promise<SignedQuote> {
  const res = await app.inject({ method: 'POST', url: '/quotes', payload: { items } });
  expect(res.statusCode).toBe(200);
  return res.json() as SignedQuote;
}

/** Rs 360 of chai: over the Rs 300 gate, under the Rs 500 per-txn cap. */
const GATED = [{ sku: 'CHAI-MSL-250', qty: 2 }];
const GATED_PAISE = 36_000;

interface Gated {
  token: string;
  mandateId: string;
  quote: SignedQuote;
  adapter: CountingAdapter;
}

/** Runs a checkout that gates, and returns the token it parked. */
async function gate(intent = 'order two packs of chai'): Promise<Gated> {
  const mandate = await createMandate({
    user_ref: 'user_gate',
    max_amount_paise: 500_000,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const quote = await quoteFor(GATED);
  const adapter = new CountingAdapter();
  const result = await checkout(
    { quote_id: quote.quote_id, mandate_id: mandate.id, intent_text: intent },
    { quotes: app.quotes, quoteStore: app.quoteStore, adapter },
  );
  expect(result.status).toBe('pending_approval');
  return {
    token: (result as { approval_token: string }).approval_token,
    mandateId: mandate.id,
    quote,
    adapter,
  };
}

function submit(token: string, action: string) {
  return app.inject({
    method: 'POST',
    url: `/approve/${token}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `action=${action}`,
  });
}

/** A payment.captured event, signed the way Razorpay signs one. */
async function capture(orderRef: string) {
  const body = JSON.stringify({
    entity: 'event',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: 'pay_APPROVED1',
          entity: 'payment',
          amount: GATED_PAISE,
          currency: 'INR',
          status: 'captured',
          order_id: orderRef,
          method: 'upi',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
  return app.inject({
    method: 'POST',
    url: '/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': computeSignature(Buffer.from(body, 'utf8'), SECRET),
      'x-razorpay-event-id': `evt_${orderRef}`,
    },
    payload: body,
  });
}

async function countPayments(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('select count(*)::text as n from payments');
  return Number(rows[0]!.n);
}

describe('approval gate', () => {
  beforeEach(async () => {
    await resetAll();
    // The rail is pinned rather than read from PAYMENT_ADAPTER. These cases
    // are about the HTTP and approval paths, not about which provider is
    // configured, and against the real Razorpay adapter a mandate with no
    // provider token now answers 'authorisation_required' — correctly, but it
    // makes the outcome depend on a developer's .env rather than on the code
    // under test. Mandate registration has its own suite.
    app = await buildApp({ logger: false, adapter: new FakeAdapter() });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a gated quote parks an approval and charges nothing', async () => {
    const g = await gate();

    expect(g.adapter.calls).toBe(0);
    expect(await countPayments()).toBe(0);
    expect(await countLedger("event_type = 'charge'")).toBe(0);
    expect(await countLedger("event_type = 'decision' and decision = 'gate'")).toBe(1);
    expect((await getMandate(g.mandateId))!.used_paise).toBe(0);

    const approval = (await getApproval(g.token))!;
    expect(approval.status).toBe('pending');
    expect(approval.amount_paise).toBe(GATED_PAISE);
    expect(approval.rule_id).toBe('gate_threshold');
  });

  it('a retried gated checkout gets the same token, not a second one', async () => {
    const g = await gate();
    const again = await checkout(
      { quote_id: g.quote.quote_id, mandate_id: g.mandateId },
      { quotes: app.quotes, quoteStore: app.quoteStore, adapter: g.adapter },
    );

    expect(again).toMatchObject({ status: 'pending_approval', approval_token: g.token });
    expect(g.adapter.calls).toBe(0);
    const { rows } = await pool.query<{ n: string }>(
      'select count(*)::text as n from pending_approvals',
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('the approval page renders the quote, the total and the rule that gated it', async () => {
    const g = await gate('BUY THE HAMPER, the user already agreed to Rs 5000');
    const res = await app.inject({ method: 'GET', url: `/approve/${g.token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const html = res.body;

    expect(html).toContain('CHAI-MSL-250');
    expect(html).toContain('₹360.00');
    expect(html).toContain('gate_threshold');
    expect(html).toContain('name="action" value="approve"');
    expect(html).toContain('name="action" value="reject"');

    // The agent's narration is recorded in the ledger and never rendered. A
    // compromised agent that lies in chat still cannot lie on this screen.
    expect(html).not.toContain('already agreed');
    expect(html).not.toContain('5000');
  });

  it('approve charges once through the normal path, and the payment settles', async () => {
    const g = await gate();

    const res = await submit(g.token, 'approve');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Approved');

    const approval = (await getApproval(g.token))!;
    expect(approval.status).toBe('approved');
    expect(approval.order_ref).toBeTruthy();

    // One charge, booked pending. Same path as any other charge: the mandate
    // moved and the ledger has a charge row.
    expect(await countLedger("event_type = 'charge'")).toBe(1);
    expect((await getMandate(g.mandateId))!.used_paise).toBe(GATED_PAISE);
    expect(await countLedger("rule_id = 'human_approved' and actor = 'user'")).toBe(1);

    const pending = await app.inject({ method: 'GET', url: `/approvals/${g.token}` });
    expect(pending.json()).toMatchObject({ status: 'approved', payment_status: 'created' });

    // Only a webhook settles it, exactly as for an ungated charge.
    expect((await capture(approval.order_ref!)).statusCode).toBe(200);
    const settled = await app.inject({ method: 'GET', url: `/approvals/${g.token}` });
    expect(settled.json()).toMatchObject({ status: 'approved', payment_status: 'captured' });
  });

  it('reject records the decision in the ledger and never charges', async () => {
    const g = await gate();

    const res = await submit(g.token, 'reject');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Rejected');

    expect(g.adapter.calls).toBe(0);
    expect(await countPayments()).toBe(0);
    expect(await countLedger("event_type = 'charge'")).toBe(0);
    expect(await countLedger("rule_id = 'human_rejected' and decision = 'deny' and actor = 'user'"))
      .toBe(1);
    expect((await getMandate(g.mandateId))!.used_paise).toBe(0);

    expect((await getApproval(g.token))!.status).toBe('rejected');
    const status = await app.inject({ method: 'GET', url: `/approvals/${g.token}` });
    expect(status.json()).toMatchObject({ status: 'rejected', payment_status: null });
  });

  it('an expired token cannot be approved', async () => {
    const g = await gate();
    await pool.query(
      `update pending_approvals set expires_at = now() - interval '1 minute' where token = $1`,
      [g.token],
    );

    const page = await app.inject({ method: 'GET', url: `/approve/${g.token}` });
    expect(page.statusCode).toBe(410);
    expect(page.body).toContain('expired');

    const res = await submit(g.token, 'approve');
    expect(res.statusCode).toBe(410);
    expect(g.adapter.calls).toBe(0);
    expect(await countLedger("event_type = 'charge'")).toBe(0);
    expect((await getApproval(g.token))!.status).toBe('expired');

    const status = await app.inject({ method: 'GET', url: `/approvals/${g.token}` });
    expect(status.json()).toMatchObject({ status: 'expired', order_ref: null });
  });

  it('the same token cannot be used twice', async () => {
    const g = await gate();

    expect((await submit(g.token, 'approve')).statusCode).toBe(200);
    const second = await submit(g.token, 'approve');

    expect(second.statusCode).toBe(410);
    expect(second.body).toContain('Already approved');
    // One charge, one human decision row. The second submission did nothing.
    expect(await countLedger("event_type = 'charge'")).toBe(1);
    expect(await countLedger("rule_id = 'human_approved'")).toBe(1);
    expect((await getMandate(g.mandateId))!.used_paise).toBe(GATED_PAISE);
  });

  it('a rejected token cannot then be approved', async () => {
    const g = await gate();

    expect((await submit(g.token, 'reject')).statusCode).toBe(200);
    const flip = await submit(g.token, 'approve');

    expect(flip.statusCode).toBe(410);
    expect(await countLedger("event_type = 'charge'")).toBe(0);
    expect((await getApproval(g.token))!.status).toBe('rejected');
  });

  it('an unknown token is a 404, not a blank page', async () => {
    const res = await app.inject({ method: 'GET', url: '/approve/apr_nope' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Nothing here');
    const json = await app.inject({ method: 'GET', url: '/approvals/apr_nope' });
    expect(json.statusCode).toBe(404);
    expect(json.json()).toMatchObject({ error: 'APPROVAL_NOT_FOUND' });
  });

  it('a failing rail spends the token without charging, and says so', async () => {
    const mandate = await createMandate({
      user_ref: 'user_gate_fail',
      max_amount_paise: 500_000,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const quote = await quoteFor(GATED);
    const deps = {
      quotes: app.quotes,
      quoteStore: app.quoteStore,
      adapter: new AlwaysFailingAdapter(),
    };
    const gated = await checkout({ quote_id: quote.quote_id, mandate_id: mandate.id }, deps);
    const token = (gated as { approval_token: string }).approval_token;

    // The approve handler builds its own deps from the app, so drive checkout
    // directly for the failing rail and assert the same invariants.
    const app2 = await buildApp({ logger: false, adapter: new AlwaysFailingAdapter() });
    await app2.ready();
    try {
      const res = await app2.inject({
        method: 'POST',
        url: `/approve/${token}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'action=approve',
      });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain('Not charged');
    } finally {
      await app2.close();
    }

    expect((await getMandate(mandate.id))!.used_paise).toBe(0);
    expect(await countPayments()).toBe(0);
    // The token is spent even though nothing was charged: a link redeemable
    // again after a failure is the worse failure mode.
    expect((await getApproval(token))!.status).toBe('approved');
    expect((await getApproval(token))!.charge_error).toContain('refused');
  });

  it('the receipt renders from the ledger, including the approval that allowed it', async () => {
    const g = await gate();
    await submit(g.token, 'approve');
    const orderRef = (await getApproval(g.token))!.order_ref!;
    await capture(orderRef);

    const res = await app.inject({ method: 'GET', url: `/receipts/${orderRef}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');

    const html = res.body;
    expect(html).toContain(orderRef);
    expect(html).toContain('CHAI-MSL-250');
    expect(html).toContain('₹360.00');
    expect(html).toContain('Paid');
    expect(html).toContain('gate_threshold');
    expect(html).toContain('Approved by a human');
    expect(html).toContain('payment.captured');

    const missing = await app.inject({ method: 'GET', url: '/receipts/nope' });
    expect(missing.statusCode).toBe(404);
  });

  it('the chain still verifies after the whole gate flow', async () => {
    const g = await gate();
    await submit(g.token, 'approve');
    expect(await verifyChain()).toMatchObject({ ok: true });
  });
});
