import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { append } from '../ledger/ledger.js';
import { chargeHistory, getMandateForUpdate, incrementUsed } from '../mandates/repo.js';
import type { MandateRecord } from '../mandates/types.js';
import { evaluate } from '../policy/evaluate.js';
import { toPolicyQuote } from '../policy/project.js';
import type { PolicyMandate } from '../policy/types.js';
import type { PaymentAdapter } from '../payments/types.js';
import type { QuoteService } from '../quotes/service.js';
import type { QuoteStore } from '../quotes/store.js';
import type { SignedQuote } from '../quotes/types.js';
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
 * Steps 2 through 7 are one Postgres transaction. The idempotency key is
 * claimed by inserting its primary key *before* any money moves, so a second
 * concurrent checkout for the same purchase blocks on the uncommitted row and
 * then loses to a unique violation rather than charging again.
 */
export async function checkout(
  request: CheckoutRequest,
  deps: CheckoutDeps,
): Promise<CheckoutResult> {
  const { quotes, quoteStore, adapter } = deps;

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

  const verified = quotes.verify(candidate);
  if (!verified.ok) {
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
    return await withTransaction((tx) => runCharge(tx, { request, quote, key, adapter }));
  } catch (err) {
    if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;

    // Someone else already completed this exact purchase. Replay their result
    // verbatim: identical response, no second charge.
    const stored = await readStoredResult(key);
    if (stored) return stored;
    // The holder released the key without storing a result (a deny, a gate, or
    // a failed charge). Retrying is legitimate, so run it again.
    return withTransaction((tx) => runCharge(tx, { request, quote, key, adapter }));
  }
}

interface ChargeContext {
  request: CheckoutRequest;
  quote: SignedQuote;
  key: string;
  adapter: PaymentAdapter;
}

async function runCharge(tx: pg.PoolClient, ctx: ChargeContext): Promise<CheckoutResult> {
  const { request, quote, key, adapter } = ctx;
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

  if (decision.decision === 'gate') {
    await releaseKey(tx, key);
    return {
      status: 'pending_approval',
      quote_id: quote.quote_id,
      mandate_id: mandateId,
      amount_paise: total,
      rule_id: decision.rule_id,
      reason: decision.reason,
      ledger_seq: decisionRow.seq,
    };
  }

  // 6. Only now does anything charge. The amount comes from the verified
  //    quote; there is no path by which a caller-supplied number reaches here.
  const charged = await adapter.charge({
    amountPaise: total,
    mandate: mandate!,
    idempotencyKey: key,
    note: `quote ${quote.quote_id}`,
  });

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

  const chargeRow = await append(
    {
      actor: 'system',
      event_type: 'charge',
      quote_id: quote.quote_id,
      amount_paise: total,
      razorpay_ref: charged.ref,
      payload: {
        mandate_id: mandateId,
        status: charged.status,
        adapter: adapter.name,
        idempotency_key: key,
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
    charge_status: charged.status,
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
