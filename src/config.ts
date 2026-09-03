import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

const ADAPTERS = ['fake', 'flaky-fake', 'always-failing', 'razorpay', 'reserve-pay'] as const;
type AdapterName = (typeof ADAPTERS)[number];

/**
 * Which payment rail is live. A config value, never a code change: switching
 * from fake money to Razorpay is `PAYMENT_ADAPTER=razorpay` and a restart.
 *
 * The test suite reads the same value, on purpose: proving the Phase 4 suite
 * passes against the real adapter means running it with PAYMENT_ADAPTER set,
 * not with a test-only override that would defeat the exercise.
 */
function paymentAdapter(): AdapterName {
  const raw = process.env.PAYMENT_ADAPTER?.trim();
  if (!raw) return 'fake';
  if (!(ADAPTERS as readonly string[]).includes(raw)) {
    throw new Error(
      `PAYMENT_ADAPTER must be one of ${ADAPTERS.join(', ')}; got ${JSON.stringify(raw)}`,
    );
  }
  return raw as AdapterName;
}

const FREQUENCIES = ['as_presented', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;
type Frequency = (typeof FREQUENCIES)[number];

function mandateFrequency(): Frequency {
  const raw = process.env.RAZORPAY_MANDATE_FREQUENCY?.trim();
  if (!raw) return 'as_presented';
  if (!(FREQUENCIES as readonly string[]).includes(raw)) {
    throw new Error(
      `RAZORPAY_MANDATE_FREQUENCY must be one of ${FREQUENCIES.join(', ')}; got ${JSON.stringify(raw)}`,
    );
  }
  return raw as Frequency;
}

export const config = {
  isTest,
  port: Number(process.env.PORT ?? 3000),
  /** Tests get their own database so a run never clobbers dev data. */
  databaseUrl: isTest
    ? (process.env.TEST_DATABASE_URL ?? required('DATABASE_URL'))
    : required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  /** Tests namespace their Redis keys so a run never clobbers dev quotes. */
  redisPrefix: isTest ? 'test:' : '',
  quoteSigningSecret: required('QUOTE_SIGNING_SECRET'),
  quoteTtlSeconds: 120,
  paymentAdapter: paymentAdapter(),
  razorpay: {
    // Not `required()`: the keys only have to exist when the razorpay adapter
    // is actually selected, and the adapter says so itself if they are not.
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    frequency: mandateFrequency(),
    /**
     * Sends token.type = 'single_block_multiple_debit' on mandate orders.
     * Requires UPI Reserve Pay activation on the account; off until then.
     */
    singleBlockMultipleDebit: process.env.RAZORPAY_SBMD === 'true',
  },
} as const;
