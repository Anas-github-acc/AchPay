/**
 * Proves the webhook endpoint against an event Razorpay actually sent.
 *
 * Run: pnpm test:webhook-live   (needs `ngrok http 3000` and `pnpm dev` up)
 *
 * Everything else in this phase was verified with payloads we signed ourselves.
 * That cannot tell us whether Razorpay's real envelope matches the fields the
 * handler reads, which is the one failure that would look like success: a 200
 * with `unmatched`, reconciling nothing.
 *
 * A mandate order cannot be paid without a human approving it in a UPI app, so
 * this uses a plain order paid through Checkout with a test card. The order is
 * different; the event envelope is identical, and the envelope is the point.
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';
import { createMandate } from '../src/mandates/repo.js';
import { getPayment, recordCharge } from '../src/payments/repo.js';
import { pool } from '../src/db/pool.js';

const PORT = 8081;
const AMOUNT_PAISE = 4_000;

async function main(): Promise<void> {
  await migrate();

  const keyId = config.razorpay.keyId;
  const keySecret = config.razorpay.keySecret;
  if (!keyId || !keySecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set');
  if (!config.razorpay.webhookSecret) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET is not set; the endpoint will refuse deliveries');
  }

  // A plain order: no token object, so Razorpay creates exactly one, and it can
  // be paid by card rather than needing a UPI mandate approval.
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({
      amount: AMOUNT_PAISE,
      currency: 'INR',
      receipt: `live-webhook-${Date.now()}`,
      notes: { purpose: 'phase 6 webhook validation' },
    }),
  });
  const order = (await res.json()) as { id?: string; error?: unknown };
  if (!order.id) throw new Error(`Order create failed: ${JSON.stringify(order)}`);

  // Book it the way a charge would, so the delivery has something to match.
  const mandate = await createMandate({
    user_ref: `live_webhook_${Date.now()}`,
    max_amount_paise: 500_000,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await recordCharge({
    order_ref: order.id,
    mandate_id: mandate.id,
    quote_id: null,
    amount_paise: AMOUNT_PAISE,
    adapter: 'live-webhook-test',
  });

  console.log(`\n  order          ${order.id}`);
  console.log(`  amount_paise   ${AMOUNT_PAISE}`);
  console.log(`  payment status ${(await getPayment(order.id))!.status}`);
  console.log(`\n  Open  http://localhost:${PORT}  and pay.`);
  console.log('    Card: 4111 1111 1111 1111, any future expiry, any CVV, OTP 1234');
  console.log('    UPI : success@razorpay  (or failure@razorpay to test the other path)');
  console.log('\n  Waiting for Razorpay to deliver the webhook...\n');

  const server = createServer((_req, reply) => {
    reply.writeHead(200, { 'content-type': 'text/html' });
    reply.end(checkoutPage(keyId, order.id!));
  });
  server.listen(PORT);

  const settled = await waitForSettlement(order.id);
  server.close();

  if (!settled) {
    console.log('  Timed out. Nothing arrived; the payment may not have completed.');
    return;
  }

  console.log(`  payment status -> ${settled}`);
  const { rows } = await pool.query(
    `select seq, payload ->> 'event' as event, payload ->> 'matched' as matched,
            payload ->> 'applied' as applied, payload ->> 'payment_ref' as payment_ref
       from ledger where event_type = 'webhook' and razorpay_ref = $1 order by seq`,
    [order.id],
  );
  console.log('  ledger webhook rows:', JSON.stringify(rows));

  const { rows: evt } = await pool.query(
    'select event_id, event from webhook_events where order_ref = $1',
    [order.id],
  );
  console.log('  webhook_events     :', JSON.stringify(evt));
  console.log(
    rows.length === 1 && rows[0].matched === 'true'
      ? '\n  PASS: a real Razorpay event matched and settled the payment.'
      : '\n  CHECK: the event arrived but did not match. Compare the envelope against src/webhooks/process.ts.',
  );
}

/** Polls until a webhook moves the payment off `created`, or gives up. */
async function waitForSettlement(orderRef: string, timeoutMs = 300_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payment = await getPayment(orderRef);
    if (payment && payment.status !== 'created') return payment.status;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

function checkoutPage(keyId: string, orderId: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Phase 6 webhook test</title>
<body style="font:14px system-ui;padding:2rem;max-width:32rem">
<h2>Pay this order to fire a real webhook</h2>
<p><code>${orderId}</code> &mdash; &#8377;40.00</p>
<p>Card <code>4111 1111 1111 1111</code>, any future expiry, any CVV, OTP <code>1234</code>.<br>
Or UPI <code>success@razorpay</code> / <code>failure@razorpay</code>.</p>
<button id="pay" style="padding:.6rem 1.2rem;font-size:1rem">Pay &#8377;40</button>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
document.getElementById('pay').onclick = function () {
  new Razorpay({
    key: ${JSON.stringify(keyId)},
    order_id: ${JSON.stringify(orderId)},
    amount: ${AMOUNT_PAISE},
    currency: 'INR',
    name: 'Agent storefront',
    description: 'Phase 6 webhook validation',
    handler: function (r) {
      document.body.insertAdjacentHTML('beforeend',
        '<p><b>Paid.</b> ' + r.razorpay_payment_id + ' &mdash; check the terminal.</p>');
    },
  }).open();
};
</script>`;
}

main()
  .catch((err) => {
    console.error('\nlive webhook test failed:', err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
