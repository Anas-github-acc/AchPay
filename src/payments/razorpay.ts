import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { findCustomerId, rememberCustomerId } from '../mandates/provider-customers.js';
import type { MandateRecord } from '../mandates/types.js';
import { ProviderError } from './errors.js';
import type {
  MandateOrderCreateBody,
  RazorpayClient,
  TokenFrequency,
} from './razorpay-client.js';
import { createSdkClient } from './razorpay-client.js';
import type { ChargeRequest, ChargeResult, PaymentAdapter } from './types.js';

/**
 * Documented bounds for a UPI mandate token's max_amount, in paise.
 * Rs 5 to Rs 10,00,000. Sending a value outside this range is a 400.
 */
const TOKEN_MAX_AMOUNT_FLOOR = 500;
const TOKEN_MAX_AMOUNT_CEILING = 100_000_000;

/** The furthest expiry the API accepts: 31-12-2099. */
const EXPIRE_AT_CEILING = 4_102_444_799;

/** Razorpay caps receipt at 40 characters. */
const RECEIPT_MAX = 40;

export interface RazorpayMandateAdapterOptions {
  client: RazorpayClient;
  /**
   * Debit cadence declared on the mandate. `as_presented` is the only value
   * that fits an agent storefront, where amounts and timing are both driven
   * by what the user asks for rather than by a schedule.
   */
  frequency?: TokenFrequency;
  /**
   * Sends `token.type: 'single_block_multiple_debit'` on the mandate order.
   *
   * Off by default, and deliberately so. See the note on the class.
   */
  singleBlockMultipleDebit?: boolean;
  /** Overrides how a user_ref becomes customer details. */
  customerFor?: (mandate: MandateRecord) => { name: string; email?: string; contact?: string };
  db?: Db;
}

/**
 * Charges against a UPI AutoPay mandate in Razorpay.
 *
 * The flow, in the order it has to happen:
 *
 *   1. one customer per user_ref, created on first use and reused after
 *   2. a mandate order carrying the token terms, which the user authorises
 *   3. once a token exists, subsequent debits against it
 *
 * ## On `token.type: 'single_block_multiple_debit'`
 *
 * The build plan calls for this field on every mandate order. The current API
 * reference does not: a UPI mandate order's token object is documented as
 * `{ max_amount, expire_at, frequency }`, with no `type`. Single Block Multi
 * Debit is NPCI's framework behind UPI Reserve Pay, which is a separate
 * product requiring per-account activation, not a flag on a standard AutoPay
 * order. Sending it on an account without that activation is rejected.
 *
 * So it is off by default and gated behind `singleBlockMultipleDebit`. Turn it
 * on once the account is enabled for it; nothing else about the payload moves.
 *
 * ## What `charge()` returns
 *
 * A mandate order comes back `created`, not `captured` — the money is
 * committed against the mandate but the payment has not reached a terminal
 * state. Terminal status arrives by webhook, which is the next phase. The
 * ledger records what the API said; reconciliation is what makes it true.
 */
export class RazorpayMandateAdapter implements PaymentAdapter {
  readonly name = 'razorpay-mandate';

  private readonly client: RazorpayClient;
  private readonly frequency: TokenFrequency;
  private readonly sbmd: boolean;
  private readonly customerFor: NonNullable<RazorpayMandateAdapterOptions['customerFor']>;
  private readonly db: Db;

  constructor(opts: RazorpayMandateAdapterOptions) {
    this.client = opts.client;
    this.frequency = opts.frequency ?? 'as_presented';
    this.sbmd = opts.singleBlockMultipleDebit ?? false;
    this.customerFor = opts.customerFor ?? defaultCustomerFor;
    this.db = opts.db ?? pool;
  }

  /** Builds an adapter around a real SDK client. Throws if keys are missing. */
  static async fromKeys(
    keyId: string | undefined,
    keySecret: string | undefined,
    opts: Omit<RazorpayMandateAdapterOptions, 'client'> = {},
  ): Promise<RazorpayMandateAdapter> {
    if (!keyId || !keySecret) {
      throw new Error(
        'RazorpayMandateAdapter needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET',
      );
    }
    return new RazorpayMandateAdapter({ ...opts, client: await createSdkClient(keyId, keySecret) });
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    assertChargeable(req);
    const { mandate, amountPaise } = req;

    // The provider's per-debit ceiling. A charge above it would create an order
    // that can never be debited, so refuse it here rather than book it.
    const tokenMax = tokenMaxAmount(mandate);
    if (amountPaise > tokenMax) {
      return {
        ref: `rzp_rejected_${req.idempotencyKey.slice(0, 16)}`,
        status: 'failed',
        error:
          `Charge of ${amountPaise} paise exceeds the mandate's provider ceiling ` +
          `of ${tokenMax} paise`,
      };
    }

    try {
      const customerId = await this.ensureCustomer(mandate);
      return mandate.provider_token
        ? await this.debitRegisteredMandate(req, customerId, mandate.provider_token)
        : await this.createMandateOrder(req, customerId, tokenMax);
    } catch (err) {
      // A provider rejection is an outcome, not a crash: checkout's failure
      // path leaves used_paise alone and still writes a ledger row.
      const normalised = normaliseError(err);
      return {
        ref: `rzp_failed_${req.idempotencyKey.slice(0, 16)}`,
        status: 'failed',
        error: normalised.message,
      };
    }
  }

  /**
   * One customer per user_ref.
   *
   * The lookup and the write both go to `provider_customers`, never to the
   * mandate row. The checkout transaction that called us is holding that row
   * under `for update` and cannot commit until this returns, so touching it
   * here would deadlock the two against each other.
   */
  private async ensureCustomer(mandate: MandateRecord): Promise<string> {
    // Set at mandate creation for a user whose customer is already known.
    if (mandate.provider_customer_id) return mandate.provider_customer_id;

    const existing = await findCustomerId(this.name, mandate.user_ref, this.db);
    if (existing) return existing;

    const details = this.customerFor(mandate);
    const customer = await this.client.customers.create({
      ...details,
      fail_existing: 0,
      notes: { user_ref: mandate.user_ref },
    });
    if (!customer?.id) throw new ProviderError('Razorpay returned a customer with no id');

    // Returns whichever id won the race, so every later charge agrees.
    return rememberCustomerId(this.name, mandate.user_ref, customer.id, this.db);
  }

  /**
   * Step 2: the mandate order the user authorises in their UPI app.
   *
   * The amount is the real basket total, not the Rs 1 token amount the docs
   * use for a pure registration. That is deliberate: it keeps the paise figure
   * in the dashboard identical to the paise figure in the ledger row, which is
   * the property this phase has to be able to demonstrate.
   */
  private async createMandateOrder(
    req: ChargeRequest,
    customerId: string,
    tokenMax: number,
  ): Promise<ChargeResult> {
    const { mandate, amountPaise, idempotencyKey, note } = req;

    const body: MandateOrderCreateBody = {
      amount: amountPaise,
      currency: 'INR',
      customer_id: customerId,
      method: 'upi',
      token: {
        max_amount: tokenMax,
        frequency: this.frequency,
        expire_at: tokenExpiry(mandate),
        ...(this.sbmd ? { type: 'single_block_multiple_debit' as const } : {}),
      },
      receipt: idempotencyKey.slice(0, RECEIPT_MAX),
      notes: {
        mandate_id: mandate.id,
        user_ref: mandate.user_ref,
        idempotency_key: idempotencyKey,
        note,
      },
    };

    const order = await this.client.orders.create(body);
    if (!order?.id) throw new ProviderError('Razorpay returned an order with no id');

    // Guard against the amount drifting between what we asked for and what was
    // created. The whole point of this phase is that these two numbers match.
    if (order.amount !== amountPaise) {
      throw new ProviderError(
        `Razorpay created order ${order.id} for ${order.amount} paise, not ${amountPaise}`,
      );
    }

    return { ref: order.id, status: 'created' };
  }

  /**
   * Step 3: a debit against a mandate the user has already authorised.
   *
   * Unexercised so far — test mode only hands back a token_id after a real
   * approval in a UPI app, so nothing automated reaches this branch yet. It is
   * here because the alternative is worse: without it, a charge against an
   * already-registered mandate would silently open a second mandate order.
   */
  private async debitRegisteredMandate(
    req: ChargeRequest,
    customerId: string,
    token: string,
  ): Promise<ChargeResult> {
    const { mandate, amountPaise, idempotencyKey, note } = req;

    const order = await this.client.orders.create({
      amount: amountPaise,
      currency: 'INR',
      customer_id: customerId,
      receipt: idempotencyKey.slice(0, RECEIPT_MAX),
      notes: { mandate_id: mandate.id, idempotency_key: idempotencyKey, note },
    });
    if (!order?.id) throw new ProviderError('Razorpay returned an order with no id');

    const details = this.customerFor(mandate);
    const payment = await this.client.payments.createRecurringPayment({
      ...(details.email ? { email: details.email } : {}),
      ...(details.contact ? { contact: details.contact } : {}),
      amount: amountPaise,
      currency: 'INR',
      order_id: order.id,
      customer_id: customerId,
      token,
      recurring: true,
      description: note,
    });

    const ref = payment?.razorpay_payment_id ?? order.id;
    return { ref, status: 'created' };
  }
}

/**
 * The provider ceiling for one debit, derived from the mandate's own ceiling
 * and clamped into the band the API accepts.
 */
function tokenMaxAmount(mandate: MandateRecord): number {
  return Math.min(
    Math.max(mandate.max_amount_paise, TOKEN_MAX_AMOUNT_FLOOR),
    TOKEN_MAX_AMOUNT_CEILING,
  );
}

/** The mandate's own expiry as a Unix timestamp in seconds, within API bounds. */
function tokenExpiry(mandate: MandateRecord): number {
  const seconds = Math.floor(new Date(mandate.expires_at).getTime() / 1000);
  const floor = Math.floor(Date.now() / 1000) + 60;
  return Math.min(Math.max(seconds, floor), EXPIRE_AT_CEILING);
}

/**
 * Customer details from a user_ref alone.
 *
 * The storefront holds no name, email or phone for a user_ref, so a stable
 * placeholder is synthesised on a reserved domain. Real deployments pass
 * `customerFor` and send the details they actually hold.
 */
function defaultCustomerFor(mandate: MandateRecord): { name: string; email: string } {
  const slug = mandate.user_ref.replace(/[^a-zA-Z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  return {
    name: mandate.user_ref.slice(0, 50),
    email: `${slug || 'user'}@example.com`,
  };
}

function assertChargeable(req: ChargeRequest): void {
  if (!Number.isSafeInteger(req.amountPaise) || req.amountPaise <= 0) {
    throw new Error('amountPaise must be a positive integer number of paise');
  }
  if (!req.idempotencyKey) throw new Error('idempotencyKey is required');
  if (!req.mandate) throw new Error('a mandate is required');
}

/** Flattens an SDK error into something safe to put in front of an agent. */
function normaliseError(err: unknown): { message: string } {
  const e = err as {
    error?: { description?: string; code?: string; reason?: string };
    statusCode?: number;
    message?: string;
  };
  const description = e?.error?.description;
  if (description) {
    const code = e.error?.code ? ` (${e.error.code})` : '';
    return { message: `${description}${code}` };
  }
  return { message: e?.message ?? 'Razorpay request failed' };
}
