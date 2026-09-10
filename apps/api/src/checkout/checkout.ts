import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { append } from '../ledger/ledger.js';
import { recordCharge } from '../payments/repo.js';
import { chargeHistory, getMandateForUpdate, incrementUsed } from '../mandates/repo.js';
import type { MandateRecord } from '../mandates/types.js';
import { evaluate } from '../policy/evaluate.js';
import { toPolicyQuote } from '../policy/project.js';
import type { PolicyMandate } from '../policy/types.js';
import type { PaymentAdapter } from '../payments/types.js';
import type { QuoteService } from '../quotes/service.js';
import type { QuoteStore } from '../quotes/store.js';
import type { SignedQuote } from '../quotes/types.js';
import { approvalUrl, openApproval } from '../approvals/repo.js';
import { authorisationUrl } from '../payments/authorisation.js';
import type { PendingApproval } from '../approvals/types.js';
import { idempotencyKey } from './idempotency.js';
import type { CheckoutRequest, CheckoutResult } from './types.js';

const UNIQUE_VIOLATION = '23505';

export interface CheckoutDeps {
  quotes: QuoteService;
  quoteStore: QuoteStore;
  adapter: PaymentAdapter;
}

/**
 * The whole purchase flow, in the order the flow has to happen:
 *
 *   1. resolve and verify the quote — prices are re-derived, never trusted
 *   2. claim the idempotency key inside the charge transaction
 *   3. lock the mandate and read its recent history
 *   4. evaluate the policy
 *   5. append the decision to the ledger, whatever it is
 *   6. charge only on allow
 *   7. increment used_paise, record the charge, store the idempotent result
 *
 * Step 6 has one outcome that is neither success nor failure: the first charge
 * on a mandate the provider has never seen authorised comes back as
 * `authorisation_required`, with an order but no payment. That is a real
 * result, not an error — see the branch below.
 *
 * Steps 2 through 7 are one Postgres transaction. The idempotency key is
 * claimed by inserting its primary key *before* any money moves, so a second
 * concurrent checkout for the same purchase blocks on the uncommitted row and
 * then loses to a unique violation rather than charging again.
 *
 * `options.approval` is how an approved gate gets paid, and it is deliberately
 * a third argument rather than a field on the request: CheckoutRequest is what
 * arrives over HTTP from an agent, and nothing an agent sends may authorise a
 * gated purchase. Only src/http/approval-routes.ts constructs one, and only
 * after consuming the token. There is no second charge path — an approved
 * purchase walks through this same function, under the same idempotency key,
 * past the same policy evaluation.
 */
export async function checkout(
  request: CheckoutRequest,
  deps: CheckoutDeps,
  options: { approval?: PendingApproval } = {},
): Promise<CheckoutResult> {
  const { quotes, quoteStore, adapter } = deps;
  const approval = options.approval;

  // --- 1. resolve and verify the quote ---------------------------------
  const candidate = request.quote ?? (request.quote_id
    ? await quoteStore.get(request.quote_id)
    : undefined);

  if (!candidate) {
    return {
      status: 'quote_invalid',
      error: 'QUOTE_NOT_FOUND',
      reason: request.quote_id
        ? `No quote ${request.quote_id}; it may have expired`
        : 'Supply either quote_id or quote',
    };
  }

  // An approved quote is past its two-minute window by construction — a human
  // was walking to their phone. The re-price still runs, so a catalog change
  // between gate and approval refuses instead of charging a total the approver
  // never saw. See QuoteService.verify.
  const verified = quotes.verify(candidate, undefined, { allowExpired: Boolean(approval) });
  if (verified.ok === false) {
    return {
      status: 'quote_invalid',
      error: verified.code,
      reason: verified.reason,
      ...(verified.deltas ? { deltas: verified.deltas } : {}),
      ...(verified.total_delta_paise !== undefined
        ? { total_delta_paise: verified.total_delta_paise }
        : {}),
      // A stale or expired quote is recoverable, so hand back a fresh one
      // rather than making the agent guess what to do next.
      ...(await reQuote(candidate, quotes, quoteStore)),
    };
  }

  const quote = verified.quote;
  const key = idempotencyKey(request.mandate_id, quote);

  // --- 2..7, one transaction -------------------------------------------
  try {
    return await withTransaction((tx) => runCharge(tx, { request, quote, key, adapter, approval }));
  } catch (err) {
    if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;

    // Someone else already completed this exact purchase. Replay their result
    // verbatim: identical response, no second charge.
    const stored = await readStoredResult(key);
    if (stored) return stored;
    // The holder released the key without storing a result (a deny, a gate, or
    // a failed charge). Retrying is legitimate, so run it again.
    return withTransaction((tx) => runCharge(tx, { request, quote, key, adapter, approval }));
  }
}

interface ChargeContext {
  request: CheckoutRequest;
  quote: SignedQuote;
  key: string;
  adapter: PaymentAdapter;
  /** Present only when a human has already consumed a token for this purchase. */
  approval?: PendingApproval;
}

async function runCharge(tx: pg.PoolClient, ctx: ChargeContext): Promise<CheckoutResult> {
  const { request, quote, key, adapter, approval } = ctx;
  const mandateId = request.mandate_id;
  const total = quote.total_paise;

  // 2. Claim the key. A concurrent duplicate blocks here until this
  //    transaction commits or rolls back, then either replays the stored
  //    result or proceeds if this attempt released the key.
  await tx.query('insert into idempotency (key) values ($1)', [key]);

  // 3. Lock the mandate for the rest of the transaction, then read history.
  const mandate = await getMandateForUpdate(mandateId, tx);
  const history = await chargeHistory(mandateId, 24, tx);

  // 4. Evaluate. Pure function: everything it needs is on this call.
  const decision = evaluate({
    quote: toPolicyQuote(quote),
    mandate: mandate ? toPolicyMandate(mandate) : null,
    history,
  });

  // 5. The decision goes to the ledger whatever it is. Denies and gates are
  //    the rows an auditor actually wants; they are a deliverable, not a
  //    debugging aid.
  const decisionRow = await append(
    {
      actor: 'agent',
      event_type: 'decision',
      intent_text: request.intent_text ?? null,
      quote_id: quote.quote_id,
      decision: decision.decision,
      rule_id: decision.rule_id,
      amount_paise: total,
      payload: {
        mandate_id: mandateId,
        reason: decision.reason,
        observed: decision.observed,
        idempotency_key: key,
        // A gate a human has already cleared still evaluates to `gate` here:
        // nothing about the basket changed, and the engine is pure, so it
        // gives the same answer it gave the first time. The grant is recorded
        // alongside that answer rather than folded into it, because without
        // it these rows read as a gate followed immediately by a charge —
        // which is exactly what a bypass looks like in an audit log.
        ...(approval
          ? {
              authorised_by: 'human_approved',
              approval_token: approval.token,
              gate_seq: approval.gate_seq,
            }
          : {}),
      },
    },
    tx,
  );

  if (decision.decision === 'deny') {
    // Release the key: a deny can become an allow once a window rolls over or
    // a mandate is topped up, so it must not be cached forever.
    await releaseKey(tx, key);
    return {
      status: 'denied',
      quote_id: quote.quote_id,
      mandate_id: mandateId,
      rule_id: decision.rule_id,
      reason: decision.reason,
      ledger_seq: decisionRow.seq,
    };
  }

  if (decision.decision === 'gate' && !approval) {
    // Park it. The key is released because a gate is not an outcome: the same
    // purchase will come back through here once a human has said yes, and it
    // has to be able to claim the same key then.
    await releaseKey(tx, key);
    const pending = await openApproval(
      {
        quote,
        mandate_id: mandateId,
        rule_id: decision.rule_id,
        reason: decision.reason,
        gate_seq: decisionRow.seq,
      },
      tx,
    );
    return {
      status: 'pending_approval',
      quote_id: quote.quote_id,
      mandate_id: mandateId,
      amount_paise: total,
      rule_id: decision.rule_id,
      reason: decision.reason,
      approval_token: pending.token,
      approval_url: approvalUrl(pending.token),
      approval_expires_at: pending.expires_at,
      ledger_seq: decisionRow.seq,
    };
  }

  // An approval authorises exactly one purchase. The token was consumed and
  // recorded in the ledger before this ran; all that is left is to refuse a
  // grant that does not match the basket in hand.
  if (approval && (approval.quote_id !== quote.quote_id || approval.mandate_id !== mandateId)) {
    throw new Error(`Approval ${approval.token} does not authorise ${mandateId}/${quote.quote_id}`);
  }

  // 6. Only now does anything charge. The amount comes from the verified
  //    quote; there is no path by which a caller-supplied number reaches here.
  const charged = await adapter.charge({
    amountPaise: total,
    mandate: mandate!,
    idempotencyKey: key,
    note: `quote ${quote.quote_id}`,
  });

  if (charged.status === 'authorisation_required') {
    // An order exists and a person has to authorise it. Everything below is
    // deliberately the same as the charged path except what it is called and
    // what the payment row says:
    //
    //  - the reservation is taken, because an authorised mandate order really
    //    does debit this amount, and a second checkout must not be able to
    //    spend it twice while this one waits;
    //  - the idempotency key is kept, so asking again returns this same
    //    authorisation link rather than opening a second mandate order —
    //    the same property a gated quote has;
    //  - the payment is 'awaiting_authorisation', never 'created', because
    //    nothing has been submitted to the rail.
    //
    // If nobody ever authorises it, no webhook will ever arrive. The reclaim
    // sweep is what gives the reservation back. See payments/reclaim.ts.
    const reserved = await incrementUsed(mandateId, total, tx);
    if (!reserved) {
      throw new Error(
        `Mandate ${mandateId} could not absorb ${total} paise; rolling back the authorisation`,
      );
    }

    await recordCharge(
      {
        order_ref: charged.ref,
        mandate_id: mandateId,
        quote_id: quote.quote_id,
        amount_paise: total,
        adapter: adapter.name,
        status: 'awaiting_authorisation',
        provider_customer_id: charged.provider_customer_id ?? null,
      },
      tx,
    );

    const authRow = await append(
      {
        actor: 'system',
        event_type: 'charge',
        quote_id: quote.quote_id,
        amount_paise: total,
        razorpay_ref: charged.ref,
        payload: {
          mandate_id: mandateId,
          status: 'awaiting_authorisation',
          adapter: adapter.name,
          idempotency_key: key,
          authorisation_url: authorisationUrl(charged.ref),
          // Why a human is in this loop at all, when the mandate may already
          // be registered. Kept on the row so the ledger explains itself.
          ...(charged.provider_note ? { provider_note: charged.provider_note } : {}),
          lines: quote.lines.map((line) => ({
            sku: line.sku,
            title: line.title,
            qty: line.qty,
            unit_price_paise: line.unit_price_paise,
            line_total_paise: line.line_total_paise,
          })),
          ...(approval ? { approval_token: approval.token } : {}),
        },
      },
      tx,
    );

    const pendingResult: CheckoutResult = {
      status: 'authorisation_required',
      quote_id: quote.quote_id,
      mandate_id: mandateId,
      amount_paise: total,
      rule_id: decision.rule_id,
      order_ref: charged.ref,
      authorisation_url: authorisationUrl(charged.ref),
      ledger_seq: authRow.seq,
    };

    await tx.query('update idempotency set result = $2 where key = $1', [
      key,
      JSON.stringify(pendingResult),
    ]);
    return pendingResult;
  }

  if (charged.status === 'failed') {
    const failureRow = await append(
      {
        actor: 'system',
        event_type: 'charge',
        quote_id: quote.quote_id,
        amount_paise: total,
        razorpay_ref: charged.ref,
        payload: {
          mandate_id: mandateId,
          status: 'failed',
          adapter: adapter.name,
          idempotency_key: key,
          error: charged.error ?? 'charge failed',
        },
      },
      tx,
    );
    // No used_paise increment, and the key is released so a retry can proceed.
    // The ledger still records that the attempt happened.
    await releaseKey(tx, key);
    return {
      status: 'charge_failed',
      quote_id: quote.quote_id,
      mandate_id: mandateId,
      amount_paise: total,
      rule_id: decision.rule_id,
      error: charged.error ?? 'charge failed',
      ledger_seq: failureRow.seq,
    };
  }

  // 7. Money moved: book it against the mandate, record it, keep the key.
  const updated = await incrementUsed(mandateId, total, tx);
  if (!updated) {
    // The database ceiling refused the increment. Roll everything back rather
    // than book a charge the mandate cannot cover.
    throw new Error(
      `Mandate ${mandateId} could not absorb ${total} paise; rolling back the charge`,
    );
  }

  // The payment is booked as pending, whatever the adapter's response said.
  //
  // An API response is the rail acknowledging the request; it is not the money
  // having moved. Recording 'captured' here would mean the ledger's payment
  // status came from what Razorpay said rather than from what happened, and
  // those are not the same thing. Only a webhook moves it past 'created'.
  await recordCharge(
    {
      order_ref: charged.ref,
      mandate_id: mandateId,
      quote_id: quote.quote_id,
      amount_paise: total,
      adapter: adapter.name,
    },
    tx,
  );

  const chargeRow = await append(
    {
      actor: 'system',
      event_type: 'charge',
      quote_id: quote.quote_id,
      amount_paise: total,
      razorpay_ref: charged.ref,
      payload: {
        mandate_id: mandateId,
        status: 'created',
        // What the rail answered synchronously, kept for reconciliation but
        // never treated as the payment's status.
        provider_status: charged.status,
        adapter: adapter.name,
        idempotency_key: key,
        // The basket, copied onto the row that records the money moving.
        //
        // A quote lives in Redis for a few minutes; a receipt has to be
        // renderable years later. Carrying the lines here is what lets
        // GET /receipts/:id read the ledger and nothing else — and because the
        // row is hashed, the receipt cannot be edited after the fact either.
        lines: quote.lines.map((line) => ({
          sku: line.sku,
          title: line.title,
          qty: line.qty,
          unit_price_paise: line.unit_price_paise,
          line_total_paise: line.line_total_paise,
        })),
        ...(approval ? { approval_token: approval.token } : {}),
      },
    },
    tx,
  );

  const result: CheckoutResult = {
    status: 'charged',
    quote_id: quote.quote_id,
    mandate_id: mandateId,
    amount_paise: total,
    rule_id: decision.rule_id,
    order_ref: charged.ref,
    charge_status: 'created',
    ledger_seq: chargeRow.seq,
  };

  await tx.query('update idempotency set result = $2 where key = $1', [
    key,
    JSON.stringify(result),
  ]);
  return result;
}

/** Frees a claimed key so a later, legitimate attempt is not blocked by it. */
async function releaseKey(tx: pg.PoolClient, key: string): Promise<void> {
  await tx.query('delete from idempotency where key = $1', [key]);
}

async function readStoredResult(key: string): Promise<CheckoutResult | undefined> {
  const { rows } = await pool.query<{ result: CheckoutResult | null }>(
    'select result from idempotency where key = $1',
    [key],
  );
  return rows[0]?.result ?? undefined;
}

function toPolicyMandate(mandate: MandateRecord): PolicyMandate {
  return {
    id: mandate.id,
    status: mandate.status,
    max_amount_paise: mandate.max_amount_paise,
    used_paise: mandate.used_paise,
    expires_at: mandate.expires_at,
  };
}

/** Re-prices the same basket at current catalog prices and stores the result. */
async function reQuote(
  candidate: unknown,
  quotes: QuoteService,
  store: QuoteStore,
): Promise<{ new_quote?: SignedQuote }> {
  const lines = (candidate as SignedQuote | undefined)?.lines;
  if (!Array.isArray(lines) || lines.length === 0) return {};
  try {
    const fresh = quotes.create(lines.map((line) => ({ sku: line.sku, qty: line.qty })));
    await store.put(fresh);
    return { new_quote: fresh };
  } catch {
    // A sku that no longer exists cannot be re-quoted. The original failure is
    // still reported; the agent just does not get a one-hop recovery.
    return {};
  }
}
