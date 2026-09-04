import { createHash } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { append } from '../ledger/ledger.js';
import { getPayment, settlePayment } from '../payments/repo.js';
import type { PaymentRecord } from '../payments/repo.js';
import { rebookUsed, releaseUsed } from '../mandates/repo.js';
import type { ChargeStatus } from '../payments/types.js';

const UNIQUE_VIOLATION = '23505';

/** The events this endpoint acts on. Anything else is recorded, not acted on. */
const TERMINAL: Record<string, Exclude<ChargeStatus, 'created'>> = {
  'payment.captured': 'captured',
  'payment.failed': 'failed',
};

export interface WebhookDelivery {
  /** Razorpay's `x-razorpay-event-id`. The replay key. */
  eventId: string | undefined;
  /** The exact bytes that arrived, already signature-verified. */
  body: Buffer;
}

export type WebhookOutcome =
  | { status: 'processed'; event: string; order_ref: string; payment_status: ChargeStatus; ledger_seq: number }
  | { status: 'duplicate'; event_id: string; ledger_seq: number | null }
  | { status: 'unmatched'; event: string; order_ref: string | null; ledger_seq: number }
  | { status: 'ignored'; event: string; ledger_seq: number }
  | { status: 'malformed'; reason: string };

interface ParsedEvent {
  event: string;
  orderRef: string | null;
  paymentRef: string | null;
  amountPaise: number | null;
}

/**
 * Applies one verified webhook delivery.
 *
 * The whole thing is a single transaction whose first statement claims the
 * event id. A redelivery loses that insert on the primary key and returns
 * before anything else happens, so replaying a webhook appends no second
 * ledger row and moves no status. That is the property this phase exists for:
 * Razorpay redelivers as a matter of course, and an audit trail that
 * double-counts on redelivery is not an audit trail.
 */
export async function processWebhook(delivery: WebhookDelivery): Promise<WebhookOutcome> {
  const parsed = parse(delivery.body);
  if (!parsed) return { status: 'malformed', reason: 'body is not a Razorpay event envelope' };

  // Razorpay always sends the header; hashing the body is a fallback so a
  // delivery without one still dedupes on its content rather than not at all.
  const eventId = delivery.eventId ?? `sha256:${createHash('sha256').update(delivery.body).digest('hex')}`;

  try {
    return await withTransaction(async (tx) => {
      // 1. Claim the delivery. A replay stops here.
      await tx.query('insert into webhook_events (event_id, event, order_ref) values ($1, $2, $3)', [
        eventId,
        parsed.event,
        parsed.orderRef,
      ]);

      const payment = parsed.orderRef ? await getPayment(parsed.orderRef, tx) : undefined;
      const terminal = TERMINAL[parsed.event];

      // 2. Move the payment, if this event is one that settles anything.
      //    settlePayment only touches a row still at 'created', so a late
      //    delivery for an already-settled payment reports rather than rewrites.
      const settled = payment && terminal
        ? await settlePayment(parsed.orderRef!, terminal, parsed.paymentRef, tx)
        : undefined;

      // 2b. Keep the mandate's headroom in step with the payment. checkout
      //     books used_paise when the charge is submitted, so a settlement
      //     that contradicts that booking has to move it back. Gated on
      //     `settled`, which is only truthy when this delivery is the one that
      //     actually moved the row — a redelivery adjusts nothing.
      const adjustment = payment && settled ? await reconcileMandate(payment, settled.status, tx) : undefined;

      // 3. Append the row. Every delivery that gets this far leaves a trace,
      //    including ones we could not match, because "a webhook arrived for an
      //    order we do not know" is exactly what an auditor needs to see.
      const row = await append(
        {
          actor: 'system',
          event_type: 'webhook',
          quote_id: payment?.quote_id ?? null,
          amount_paise: parsed.amountPaise ?? payment?.amount_paise ?? null,
          razorpay_ref: parsed.orderRef,
          payload: {
            event: parsed.event,
            event_id: eventId,
            order_ref: parsed.orderRef,
            payment_ref: parsed.paymentRef,
            mandate_id: payment?.mandate_id ?? null,
            matched: Boolean(payment),
            // What the payment moved to, or why it did not move.
            status: settled?.status ?? payment?.status ?? null,
            applied: Boolean(settled),
            ...(adjustment ?? {}),
            ...(payment && terminal && !settled
              ? { note: `payment already ${payment.status}; not reapplied` }
              : {}),
          },
        },
        tx,
      );

      await tx.query('update webhook_events set ledger_seq = $2 where event_id = $1', [
        eventId,
        row.seq,
      ]);

      if (!payment) {
        return { status: 'unmatched', event: parsed.event, order_ref: parsed.orderRef, ledger_seq: row.seq };
      }
      if (!terminal) {
        return { status: 'ignored', event: parsed.event, ledger_seq: row.seq };
      }
      return {
        status: 'processed',
        event: parsed.event,
        order_ref: parsed.orderRef!,
        payment_status: settled?.status ?? payment.status,
        ledger_seq: row.seq,
      };
    });
  } catch (err) {
    if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
    // Already delivered. Report the row the first delivery wrote, so a replay
    // is traceable to the event it duplicates.
    return { status: 'duplicate', event_id: eventId, ledger_seq: await seqOf(eventId) };
  }
}

/**
 * Moves used_paise to match what the rail finally said.
 *
 * Three cases, and only two of them write:
 *   created -> failed:    the booking was for a payment that never happened,
 *                         so give the headroom back.
 *   failed  -> captured:  a retry on the same order succeeded after we had
 *                         already released it. Book it again. Same for a
 *                         capture landing on an order the sweep had already
 *                         called abandoned — the provider's later word wins.
 *   created -> captured:  the booking was right the first time. Nothing to do.
 *
 * The prior status comes from the row read before settlePayment ran, which is
 * what makes the second case distinguishable from the third.
 */
async function reconcileMandate(
  before: PaymentRecord,
  after: ChargeStatus,
  db: Db,
): Promise<Record<string, number | null> | undefined> {
  if (after === 'failed') {
    const mandate = await releaseUsed(before.mandate_id, before.amount_paise, db);
    return {
      released_paise: before.amount_paise,
      mandate_used_paise: mandate?.used_paise ?? null,
    };
  }
  if (after === 'captured' && (before.status === 'failed' || before.status === 'abandoned')) {
    const mandate = await rebookUsed(before.mandate_id, before.amount_paise, db);
    return {
      rebooked_paise: before.amount_paise,
      mandate_used_paise: mandate?.used_paise ?? null,
    };
  }
  return undefined;
}

async function seqOf(eventId: string): Promise<number | null> {
  const { pool } = await import('../db/pool.js');
  const { rows } = await pool.query<{ ledger_seq: number | null }>(
    'select ledger_seq from webhook_events where event_id = $1',
    [eventId],
  );
  return rows[0]?.ledger_seq ?? null;
}

/** Pulls the few fields we act on out of the event envelope. */
function parse(body: Buffer): ParsedEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  const envelope = json as {
    event?: unknown;
    payload?: { payment?: { entity?: Record<string, unknown> } };
  };
  if (typeof envelope?.event !== 'string') return undefined;

  const entity = envelope.payload?.payment?.entity;
  const orderId = entity?.order_id;
  const paymentId = entity?.id;
  const amount = entity?.amount;

  return {
    event: envelope.event,
    orderRef: typeof orderId === 'string' ? orderId : null,
    paymentRef: typeof paymentId === 'string' ? paymentId : null,
    amountPaise: Number.isSafeInteger(amount) ? (amount as number) : null,
  };
}
