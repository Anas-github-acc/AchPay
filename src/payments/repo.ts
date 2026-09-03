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
 * Moves a pending payment to its terminal status.
 *
 * Only ever fires on a row still sitting at `created`, so a late or duplicate
 * delivery cannot flip a settled payment, and a `payment.captured` arriving
 * after a `payment.failed` for the same order does not quietly rewrite history.
 * Returns undefined when nothing moved, which the caller reports rather than
 * treating as success.
 */
export async function settlePayment(
  orderRef: string,
  status: Exclude<ChargeStatus, 'created'>,
  paymentRef: string | null,
  db: Db = pool,
): Promise<PaymentRecord | undefined> {
  const { rows } = await db.query<RawPayment>(
    `update payments
        set status = $2, payment_ref = coalesce($3, payment_ref), updated_at = now()
      where order_ref = $1
        and status = 'created'
      returning *`,
    [orderRef, status, paymentRef],
  );
  return rows[0] ? toPayment(rows[0]) : undefined;
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
