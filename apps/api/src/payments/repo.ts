import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import type { ChargeStatus } from './types.js';

export interface PaymentRecord {
  order_ref: string;
  payment_ref: string | null;
  mandate_id: string;
  quote_id: string | null;
  amount_paise: number;
  status: ChargeStatus;
  adapter: string;
  created_at: string;
  updated_at: string;
}

type RawPayment = Omit<PaymentRecord, 'amount_paise' | 'created_at' | 'updated_at'> & {
  amount_paise: number | string;
  created_at: Date | string;
  updated_at: Date | string;
};

export interface RecordChargeInput {
  order_ref: string;
  mandate_id: string;
  quote_id: string | null;
  amount_paise: number;
  adapter: string;
}

/**
 * Books a charge as pending.
 *
 * Always `created`, never `captured`, whatever the adapter's response said. A
 * synchronous API response is the rail acknowledging the request, not the money
 * having moved; only a webhook can say the latter.
 *
 * `on conflict do nothing` because a retry of the same purchase can legitimately
 * arrive at the same order_ref, and the first row already says what we know.
 */
export async function recordCharge(
  input: RecordChargeInput,
  db: Db = pool,
): Promise<void> {
  await db.query(
    `insert into payments
       (order_ref, mandate_id, quote_id, amount_paise, status, adapter)
     values ($1, $2, $3, $4, 'created', $5)
     on conflict (order_ref) do nothing`,
    [input.order_ref, input.mandate_id, input.quote_id, input.amount_paise, input.adapter],
  );
}

export async function getPayment(
  orderRef: string,
  db: Db = pool,
): Promise<PaymentRecord | undefined> {
  const { rows } = await db.query<RawPayment>(
    'select * from payments where order_ref = $1',
    [orderRef],
  );
  return rows[0] ? toPayment(rows[0]) : undefined;
}

/**
 * Moves a payment towards its terminal status.
 *
 * Only a capture is terminal. A failed attempt is not: Razorpay lets a customer
 * retry on the same order, so `payment.failed` followed by `payment.captured`
 * is an ordinary sequence, not a contradiction. Treating failure as final left
 * a payment reading `failed` while the money had actually moved.
 *
 *   created -> captured    yes
 *   created -> failed      yes, provisionally
 *   failed  -> captured    yes, a retry succeeded
 *   captured -> failed     no, money has moved
 *   captured -> captured   no, already settled
 *
 * Returns undefined when nothing moved, which the caller records rather than
 * treating as success.
 */
export async function settlePayment(
  orderRef: string,
  status: Exclude<ChargeStatus, 'created'>,
  paymentRef: string | null,
  db: Db = pool,
): Promise<PaymentRecord | undefined> {
  // A capture supersedes a previous failure; a failure never supersedes a
  // capture. Expressed in the where clause so it holds under concurrent
  // deliveries rather than depending on the order they arrive in.
  const allowedFrom =
    status === 'captured'
      ? // A capture supersedes anything short of a capture, including an
        // abandonment: reconciliation can only ever have been working from
        // what the provider knew at the time it was asked.
        ['created', 'failed', 'abandoned']
      : status === 'abandoned'
        ? ['created']
        : ['created'];
  const { rows } = await db.query<RawPayment>(
    `update payments
        set status = $2, payment_ref = coalesce($3, payment_ref), updated_at = now()
      where order_ref = $1
        and status = any($4)
      returning *`,
    [orderRef, status, paymentRef, allowedFrom],
  );
  return rows[0] ? toPayment(rows[0]) : undefined;
}

/**
 * Payments still holding a reservation long after they were submitted.
 *
 * These are the rows the reclaim sweep asks the provider about. Ordered oldest
 * first so a sweep that hits its limit makes progress on the worst offenders
 * rather than the same recent ones every time.
 */
export async function staleReservations(
  olderThanMs: number,
  limit: number,
  db: Db = pool,
): Promise<PaymentRecord[]> {
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
    throw new Error('olderThanMs must be a non-negative integer');
  }
  const { rows } = await db.query<RawPayment>(
    `select * from payments
      where status = 'created'
        and created_at < now() - make_interval(secs => $1)
      order by created_at asc
      limit $2`,
    [olderThanMs / 1000, limit],
  );
  return rows.map(toPayment);
}

function toPayment(raw: RawPayment): PaymentRecord {
  return {
    ...raw,
    amount_paise: Number(raw.amount_paise),
    created_at: toIso(raw.created_at),
    updated_at: toIso(raw.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
