/**
 * Drives one real checkout through the Razorpay adapter and prints what to
 * compare against the dashboard, then attempts a payment on the failing test
 * UPI handle and re-reads used_paise.
 *
 * Run: pnpm smoke:razorpay
 *
 * Nothing here is a test. It exists so the paise figure in the ledger and the
 * paise figure in the Razorpay dashboard can be put side by side by hand.
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { pool, closePool } from '../src/db/pool.js';
import { redis } from '../src/redis.js';
import { getCatalog } from '../src/catalog/catalog.js';
import { QuoteService } from '../src/quotes/service.js';
import { QuoteStore } from '../src/quotes/store.js';
import { checkout } from '../src/checkout/checkout.js';
import { createMandate, getMandate } from '../src/mandates/repo.js';
import { RazorpayMandateAdapter } from '../src/payments/razorpay.js';

const SKU = process.env.SMOKE_SKU ?? 'BSC-PRL-300';
const FAILURE_VPA = 'failure@razorpay';

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${String(value)}`);
}

async function main(): Promise<void> {
  await migrate();

  const keyId = config.razorpay.keyId;
  const keySecret = config.razorpay.keySecret;
  if (!keyId || !keySecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set');
  if (/^x+$/i.test(keySecret)) {
    throw new Error(
      'RAZORPAY_KEY_SECRET is still the placeholder from .env.example. ' +
        'Paste the real test-mode secret into .env and re-run.',
    );
  }

  const adapter = await RazorpayMandateAdapter.fromKeys(keyId, keySecret, {
    frequency: config.razorpay.frequency,
    singleBlockMultipleDebit: config.razorpay.singleBlockMultipleDebit,
  });

  const catalog = getCatalog();
  const quotes = new QuoteService({
    catalog,
    secret: config.quoteSigningSecret,
    ttlSeconds: config.quoteTtlSeconds,
  });
  const quoteStore = new QuoteStore(redis, config.quoteTtlSeconds);

  // ---- happy path ------------------------------------------------------
  console.log('\n=== happy path ===');
  const mandate = await createMandate({
    user_ref: `smoke_${Date.now()}`,
    max_amount_paise: 500_000,
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });

  const quote = quotes.create([{ sku: SKU, qty: 1 }]);
  await quoteStore.put(quote);

  const result = await checkout(
    { quote_id: quote.quote_id, mandate_id: mandate.id, intent_text: 'phase 5 smoke' },
    { quotes, quoteStore, adapter },
  );

  line('adapter', adapter.name);
  line('mandate', mandate.id);
  line('quote', quote.quote_id);
  line('checkout status', result.status);

  if (result.status === 'charged') {
    line('ORDER ID', result.order_ref);
    line('amount_paise', result.amount_paise);
    line('charge_status', result.charge_status);
    line('ledger seq', result.ledger_seq);

    const { rows } = await pool.query(
      'select seq, event_type, amount_paise, razorpay_ref from ledger where seq = $1',
      [result.ledger_seq],
    );
    console.log('\n  ledger row:', JSON.stringify(rows[0]));
    const after = await getMandate(mandate.id);
    line('used_paise after', after!.used_paise);
    console.log(
      `\n  Compare in the dashboard (Test Mode) -> Transactions -> Orders:\n` +
        `    ${result.order_ref} should read ${result.amount_paise} paise.`,
    );
  } else {
    console.log('\n  full result:', JSON.stringify(result, null, 2));
  }

  // ---- failing test UPI handle ----------------------------------------
  console.log(`\n=== payment against ${FAILURE_VPA} ===`);
  const failMandate = await createMandate({
    user_ref: `smoke_fail_${Date.now()}`,
    max_amount_paise: 500_000,
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  const failQuote = quotes.create([{ sku: SKU, qty: 1 }]);
  await quoteStore.put(failQuote);

  const failCheckout = await checkout(
    { quote_id: failQuote.quote_id, mandate_id: failMandate.id, intent_text: 'phase 5 failure' },
    { quotes, quoteStore, adapter },
  );
  const orderId =
    failCheckout.status === 'charged' ? failCheckout.order_ref : undefined;
  line('order for failure run', orderId ?? `(none: ${failCheckout.status})`);

  const usedBefore = (await getMandate(failMandate.id))!.used_paise;
  line('used_paise before', usedBefore);

  if (orderId) {
    // S2S UPI payment creation. Needs UPI enabled on the account; if it is
    // not, the API says so and that is the useful output.
    const res = await fetch('https://api.razorpay.com/v1/payments/create/upi', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      },
      body: JSON.stringify({
        amount: failQuote.total_paise,
        currency: 'INR',
        order_id: orderId,
        email: 'smoke@example.com',
        contact: '9123456780',
        method: 'upi',
        upi: { flow: 'collect', vpa: FAILURE_VPA },
      }),
    });
    console.log(`  HTTP ${res.status}`);
    console.log('  body:', (await res.text()).slice(0, 600));
  }

  const usedAfter = (await getMandate(failMandate.id))!.used_paise;
  line('used_paise after', usedAfter);
  line('unchanged?', usedAfter === usedBefore ? 'YES' : `NO (${usedBefore} -> ${usedAfter})`);
}

main()
  .catch((err) => {
    console.error('\nsmoke failed:', err?.error ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
    redis.disconnect();
  });
