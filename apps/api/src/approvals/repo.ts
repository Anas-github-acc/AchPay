import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import type { SignedQuote } from '../quotes/types.js';
import type { ApprovalStatus, PendingApproval } from './types.js';

type RawApproval = Omit<
  PendingApproval,
  'amount_paise' | 'quote' | 'expires_at' | 'created_at' | 'decided_at' | 'gate_seq'
> & {
  amount_paise: number | string;
  quote: SignedQuote;
  expires_at: Date | string;
  created_at: Date | string;
  decided_at: Date | string | null;
  gate_seq: number | string | null;
};

export function approvalUrl(token: string): string {
  return `${config.publicBaseUrl}/approve/${token}`;
}

export interface OpenApprovalInput {
  quote: SignedQuote;
  mandate_id: string;
  rule_id: string;
  reason: string;
  gate_seq: number;
}

/**
 * Parks a gated purchase, or hands back the one already parked for it.
 *
 * An agent that retries a gated checkout must not mint a second token — two
 * live ways to authorise the same purchase is one more than a human can
 * reasonably reason about on a phone screen. The partial unique index makes
 * that structural; this function is the cooperative half of it.
 */
export async function openApproval(
  input: OpenApprovalInput,
  db: Db = pool,
): Promise<PendingApproval> {
  const existing = await db.query<RawApproval>(
    `select * from pending_approvals
      where mandate_id = $1 and quote_id = $2 and status = 'pending' and expires_at > now()`,
    [input.mandate_id, input.quote.quote_id],
  );
  if (existing.rows[0]) return toApproval(existing.rows[0]);

  const { rows } = await db.query<RawApproval>(
    `insert into pending_approvals
       (token, quote_id, mandate_id, amount_paise, rule_id, reason, quote,
        status, expires_at, gate_seq)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending', now() + ($8 || ' seconds')::interval, $9)
     returning *`,
    [
      `apr_${randomUUID().replaceAll('-', '')}`,
      input.quote.quote_id,
      input.mandate_id,
      input.quote.total_paise,
      input.rule_id,
      input.reason,
      JSON.stringify(input.quote),
      String(config.approvalTtlSeconds),
      input.gate_seq,
    ],
  );
  return toApproval(rows[0]!);
}

/**
 * Reads one approval, first writing down any expiry that has already happened.
 *
 * Expiry is a fact about the clock, so it is derived rather than scheduled: no
 * sweeper job, nothing to forget to run. Materialising it on read just means a
 * later reader sees the same answer without recomputing it.
 */
export async function getApproval(
  token: string,
  db: Db = pool,
): Promise<PendingApproval | undefined> {
  await db.query(
    `update pending_approvals set status = 'expired'
      where token = $1 and status = 'pending' and expires_at <= now()`,
    [token],
  );
  const { rows } = await db.query<RawApproval>(
    'select * from pending_approvals where token = $1',
    [token],
  );
  return rows[0] ? toApproval(rows[0]) : undefined;
}

export type ClaimResult =
  | { ok: true; approval: PendingApproval }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_DECIDED' | 'EXPIRED'; approval?: PendingApproval };

/**
 * Consumes a token, once and only once.
 *
 * The whole decision is the one UPDATE: `status = 'pending'` in the where
 * clause is what makes a second submission — a double-tap on a phone, a
 * forwarded link, a replay — lose. Two concurrent approvals of the same token
 * serialise on the row and exactly one comes back with a row.
 *
 * A token is spent by the *decision*, not by the outcome of the charge. If the
 * charge then fails, the approval is over and the purchase has to be started
 * again; that is the conservative direction to fail in, because the other one
 * is a token that can be redeemed twice.
 */
export async function claimApproval(
  token: string,
  decision: Extract<ApprovalStatus, 'approved' | 'rejected'>,
  client: pg.PoolClient,
): Promise<ClaimResult> {
  const { rows } = await client.query<RawApproval>(
    `update pending_approvals
        set status = $2, decided_at = now()
      where token = $1 and status = 'pending' and expires_at > now()
      returning *`,
    [token, decision],
  );
  if (rows[0]) return { ok: true, approval: toApproval(rows[0]) };

  // Nothing moved. Say which of the three reasons it was, because "that link
  // no longer works" is not an answer anyone can act on.
  const current = await getApproval(token, client);
  if (!current) return { ok: false, code: 'NOT_FOUND' };
  if (current.status === 'pending' || current.status === 'expired') {
    return { ok: false, code: 'EXPIRED', approval: current };
  }
  return { ok: false, code: 'ALREADY_DECIDED', approval: current };
}

/** Records what became of an approved charge. Never changes `status`. */
export async function recordApprovalOutcome(
  token: string,
  outcome: { order_ref?: string | null; charge_error?: string | null },
  db: Db = pool,
): Promise<void> {
  await db.query(
    `update pending_approvals
        set order_ref = coalesce($2, order_ref), charge_error = coalesce($3, charge_error)
      where token = $1`,
    [token, outcome.order_ref ?? null, outcome.charge_error ?? null],
  );
}

/** The open approval for a purchase, if there is one. Used by the status view. */
export async function findOpenApproval(
  mandateId: string,
  quoteId: string,
  db: Db = pool,
): Promise<PendingApproval | undefined> {
  const { rows } = await db.query<RawApproval>(
    `select * from pending_approvals
      where mandate_id = $1 and quote_id = $2
      order by created_at desc limit 1`,
    [mandateId, quoteId],
  );
  return rows[0] ? toApproval(rows[0]) : undefined;
}

function toApproval(raw: RawApproval): PendingApproval {
  return {
    ...raw,
    amount_paise: Number(raw.amount_paise),
    expires_at: toIso(raw.expires_at),
    created_at: toIso(raw.created_at),
    decided_at: raw.decided_at === null ? null : toIso(raw.decided_at),
    gate_seq: raw.gate_seq === null ? null : Number(raw.gate_seq),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
