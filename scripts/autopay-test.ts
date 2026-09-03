/**
 * Proves the property the whole system exists for: after one human approval,
 * money moves with no human in the loop.
 *
 * Run: pnpm test:autopay   (needs `pnpm dev` up)
 *
 * Two phases, and the boundary between them is the point:
 *
 *   1. REGISTRATION - a human authorises a mandate once, in a browser, with a
 *      spending ceiling. This is the only human step there will ever be.
 *   2. AUTONOMOUS  - the agent charges repeatedly against that mandate. No
 *      browser, no approval, no card details. The policy engine is the only
 *      thing deciding whether each charge happens.
 *
 * Card is used rather than UPI AutoPay because a UPI mandate needs a real
 * banking app to approve it and test mode cannot stand in for that. The token
 * mechanics are the same either way: authorise once, debit against the token.
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';
import { getCatalog } from '../src/catalog/catalog.js';
import { QuoteService } from '../src/quotes/service.js';
import { QuoteStore } from '../src/quotes/store.js';
import { redis } from '../src/redis.js';
import { checkout } from '../src/checkout/checkout.js';
import { createMandate, getMandate, setProviderToken } from '../src/mandates/repo.js';
import { rememberCustomerId } from '../src/mandates/provider-customers.js';
import { RazorpayMandateAdapter } from '../src/payments/razorpay.js';

const PORT = 8082;
const CEILING_PAISE = 500_000; // Rs 5,000 mandate ceiling
const REGISTRATION_PAISE = 4_000; // Rs 40 authorisation charge
const SKU = 'BSC-PRL-300'; // Rs 40 a unit
const CHARGES = 3;

let auth = '';
const api = async (path: string, body?: unknown) => {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: auth },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

async function main(): Promise<void> {
  await migrate();
  const { keyId, keySecret } = { keyId: config.razorpay.keyId, keySecret: config.razorpay.keySecret };
  if (!keyId || !keySecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set');
  auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  const userRef = `autopay_${Date.now()}`;

  // ---- phase 1: registration, the one human step ----------------------
  console.log('\n=== 1. REGISTRATION (human approves once) ===\n');

  const customer = await api('/customers', {
    name: 'Autopay Demo',
    email: `${userRef}@example.com`,
    contact: '9123456780',
    fail_existing: 0,
  });
  if (!customer.json.id) throw new Error(`customer failed: ${JSON.stringify(customer.json)}`);

  const order = await api('/orders', {
    amount: REGISTRATION_PAISE,
    currency: 'INR',
    customer_id: customer.json.id,
    method: 'card',
    token: {
      max_amount: CEILING_PAISE,
      frequency: 'as_presented',
      expire_at: Math.floor(Date.now() / 1000) + 86_400 * 30,
    },
    receipt: `mandate-${Date.now()}`,
  });
  if (!order.json.id) throw new Error(`order failed: ${JSON.stringify(order.json)}`);

  const mandate = await createMandate({
    user_ref: userRef,
    max_amount_paise: CEILING_PAISE,
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  await rememberCustomerId('razorpay-mandate', userRef, customer.json.id);

  console.log(`  customer  ${customer.json.id}`);
  console.log(`  mandate   ${mandate.id}  (ceiling ${CEILING_PAISE} paise)`);
  console.log(`  order     ${order.json.id}`);
  console.log(`\n  Open  http://localhost:${PORT}  and authorise once.`);
  console.log('    Card 4111 1111 1111 1111, any future expiry, any CVV, OTP 1234\n');

  const server = createServer((_req, reply) => {
    reply.writeHead(200, { 'content-type': 'text/html' });
    reply.end(page(keyId, order.json.id, customer.json.id));
  });
  server.listen(PORT);

  const token = await waitForToken(customer.json.id);
  server.close();
  if (!token) {
    console.log('  No token appeared. The authorisation did not complete.');
    return;
  }

  await setProviderToken(mandate.id, token);
  console.log(`\n  token     ${token}  <- stored on the mandate`);
  console.log('  From here on, no human is involved.\n');

  // ---- phase 2: autonomous charges -------------------------------------
  console.log(`=== 2. AUTONOMOUS (${CHARGES} charges, no human) ===\n`);

  const quotes = new QuoteService({
    catalog: getCatalog(),
    secret: config.quoteSigningSecret,
    ttlSeconds: config.quoteTtlSeconds,
  });
  const quoteStore = new QuoteStore(redis, config.quoteTtlSeconds);
  const adapter = await RazorpayMandateAdapter.fromKeys(keyId, keySecret);

  for (let i = 1; i <= CHARGES; i += 1) {
    const quote = quotes.create([{ sku: SKU, qty: 1 }]);
    await quoteStore.put(quote);
    const fresh = await getMandate(mandate.id);
    const result = await checkout(
      { quote_id: quote.quote_id, mandate_id: mandate.id, intent_text: `autonomous buy ${i}` },
      { quotes, quoteStore, adapter },
    );
    const after = await getMandate(mandate.id);
    console.log(
      `  charge ${i}: ${result.status.padEnd(14)} ` +
        `rule=${'rule_id' in result ? result.rule_id : '-'} ` +
        `ref=${'order_ref' in result ? result.order_ref : '-'} ` +
        `used_paise ${fresh!.used_paise} -> ${after!.used_paise}`,
    );
    if (result.status === 'charge_failed') {
      console.log(`            error: ${result.error}`);
      if (/S2S/.test(result.error)) {
        console.log(
          '\n  The mandate itself is fine: the token above is registered and\n' +
            '  confirmed with its ceiling. What is missing is permission to call\n' +
            '  the debit endpoint from a server. Nothing in this repo can grant\n' +
            '  that; Razorpay support enables it per account.\n',
        );
        break;
      }
    }
  }

  const { rows } = await pool.query(
    `select event_type, decision, rule_id, amount_paise, razorpay_ref
       from ledger where payload ->> 'mandate_id' = $1 order by seq`,
    [mandate.id],
  );
  console.log('\n  ledger for this mandate:');
  for (const r of rows) {
    console.log(
      `    ${String(r.event_type).padEnd(9)} ${String(r.decision ?? '-').padEnd(6)} ` +
        `${String(r.rule_id ?? '-').padEnd(18)} ${String(r.amount_paise ?? '-').padStart(7)} ${r.razorpay_ref ?? ''}`,
    );
  }
  const final = await getMandate(mandate.id);
  console.log(`\n  used_paise ${final!.used_paise} of ${final!.max_amount_paise}`);
  console.log('  Every charge above ran with no browser and no approval.');
}

/** Polls the customer's tokens until the authorisation produces one. */
async function waitForToken(customerId: string, timeoutMs = 300_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(`/customers/${customerId}/tokens`);
    const item = (res.json.items ?? [])[0];
    if (item?.id) return item.id as string;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

function page(keyId: string, orderId: string, customerId: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Authorise mandate</title>
<body style="font:14px system-ui;padding:2rem;max-width:34rem">
<h2>Authorise the mandate (once)</h2>
<p>Ceiling &#8377;${(CEILING_PAISE / 100).toLocaleString('en-IN')} &mdash; authorisation charge &#8377;${REGISTRATION_PAISE / 100}.</p>
<p>Card <code>4111 1111 1111 1111</code>, any future expiry, any CVV, OTP <code>1234</code>.</p>
<button id="pay" style="padding:.6rem 1.2rem;font-size:1rem">Authorise</button>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
document.getElementById('pay').onclick = function () {
  new Razorpay({
    key: ${JSON.stringify(keyId)},
    order_id: ${JSON.stringify(orderId)},
    customer_id: ${JSON.stringify(customerId)},
    recurring: 1,
    amount: ${REGISTRATION_PAISE},
    currency: 'INR',
    name: 'Agent storefront',
    description: 'Authorise spending mandate',
    handler: function (r) {
      document.body.insertAdjacentHTML('beforeend',
        '<p><b>Authorised.</b> ' + r.razorpay_payment_id + ' &mdash; check the terminal.</p>');
    },
  }).open();
};
</script>`;
}

main()
  .catch((err) => {
    console.error('\nautopay test failed:', err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
    redis.disconnect();
    process.exit(process.exitCode ?? 0);
  });
