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

const port = Number(process.env.PORT ?? 3000);

/**
 * The origin an approval link has to be reachable at.
 *
 * Not derived from the incoming request: the link is built server-side and
 * handed to an agent, and a Host header is caller-supplied. Point this at the
 * ngrok URL when demoing, so the phone in the room can open it.
 */
function publicBaseUrl(): string {
  const raw = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  return raw.replace(/\/webhooks(\/razorpay)?\/?$/, '');
}


function approvalTtlSeconds(): number {
  const raw = Number(process.env.APPROVAL_TTL_SECONDS ?? 900);
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error(`APPROVAL_TTL_SECONDS must be a positive integer; got ${raw}`);
  }
  return raw;
}

/**
 * Where the dashboard is served from.
 *
 * The mandate-authorisation page lives in apps/web, not in the API, so the
 * link handed to an agent has to point at that origin. Separate from
 * publicBaseUrl because the two are genuinely different services and, behind
 * ngrok, genuinely different hostnames.
 */
function publicWebUrl(): string {
  return (process.env.PUBLIC_WEB_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
}

/**
 * Merchant identity, as it appears in the ACP product feed. Env-overridable so
 * a deployment does not have to fork the code to put its own name on the feed.
 */
const merchant = {
  name: process.env.MERCHANT_NAME ?? 'Agent-ready storefront',
  url: process.env.MERCHANT_URL,
  privacyPolicyUrl: process.env.MERCHANT_PRIVACY_URL,
  termsUrl: process.env.MERCHANT_TERMS_URL,
} as const;

/**
 * The shared secret the HTTP MCP route requires. Unset means the route is not
 * mounted at all: it is the one surface that hands a remote client the payment
 * tools, so it opts in rather than out.
 */
function mcpHttpToken(): string | undefined {
  const raw = process.env.MCP_HTTP_TOKEN?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

export const config = {
  isTest,
  port,
  mcpHttpToken: mcpHttpToken(),
  merchant,
  publicBaseUrl: publicBaseUrl(),
  /** Origin of the dashboard, where the mandate-authorisation page lives. */
  publicWebUrl: publicWebUrl(),
  /** How long a human has to act on a gated purchase before the token dies. */
  approvalTtlSeconds: approvalTtlSeconds(),
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
    /** Signs webhook bodies. Without it the webhook route refuses to run. */
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    frequency: mandateFrequency(),
    /**
     * Sends token.type = 'single_block_multiple_debit' on mandate orders.
     * Requires UPI Reserve Pay activation on the account; off until then.
     */
    singleBlockMultipleDebit: process.env.RAZORPAY_SBMD === 'true',
  },
} as const;
