import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { canonicalJson } from '../lib/canonical.js';
import { sha256Hex } from '../lib/hash.js';
import { pool, withTransaction } from '../db/pool.js';
import type { LedgerEventInput, LedgerRow, VerifyChainResult } from './types.js';

/** prev_hash of the very first row. 64 zeros, so it is obviously synthetic. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Advisory lock key for ledger appends. Arbitrary but fixed; taken with
 * pg_advisory_xact_lock so it releases on commit or rollback without any
 * unlock bookkeeping. This is what stops two concurrent appends from reading
 * the same prev_hash and forking the chain.
 */
const LEDGER_LOCK_KEY = 0x1ed6e21n;

/** The exact column set that goes into the hash, in a fixed shape. */
interface HashableEvent {
  seq: number;
  event_id: string;
  ts: string;
  actor: string;
  event_type: string;
  intent_text: string | null;
  quote_id: string | null;
  decision: string | null;
  rule_id: string | null;
  amount_paise: number | null;
  razorpay_ref: string | null;
  payload: unknown;
}

/** hash = sha256(prev_hash + canonical_json(event)). */
export function computeHash(prevHash: string, event: HashableEvent): string {
  return sha256Hex(prevHash + canonicalJson(event));
}

/**
 * Appends one row to the ledger.
 *
 * Everything happens inside a single transaction that first takes the append
 * advisory lock, so reading the tip and writing the new row are atomic with
 * respect to other appends.
 */
export async function append(
  event: LedgerEventInput,
  client?: pg.PoolClient,
): Promise<LedgerRow> {
  if (client) return appendWith(client, event);
  return withTransaction((tx) => appendWith(tx, event));
}

async function appendWith(client: pg.PoolClient, event: LedgerEventInput): Promise<LedgerRow> {
  validate(event);
  await client.query('select pg_advisory_xact_lock($1)', [LEDGER_LOCK_KEY.toString()]);

  const tip = await client.query<{ hash: string }>(
    'select hash from ledger order by seq desc limit 1',
  );
  const prevHash = tip.rows[0]?.hash ?? GENESIS_HASH;

  // seq is claimed up front so it can be part of the hash. Taking it from the
  // same sequence the column defaults to keeps the two in step.
  const seqRow = await client.query<{ seq: number }>("select nextval('ledger_seq_seq') as seq");
  const seq = Number(seqRow.rows[0]!.seq);

  const hashable: HashableEvent = {
    seq,
    event_id: event.event_id ?? randomUUID(),
    // The timestamp is generated here rather than by the database default,
    // because the hash has to be computed before the row exists.
    ts: new Date().toISOString(),
    actor: event.actor,
    event_type: event.event_type,
    intent_text: event.intent_text ?? null,
    quote_id: event.quote_id ?? null,
    decision: event.decision ?? null,
    rule_id: event.rule_id ?? null,
    amount_paise: event.amount_paise ?? null,
    razorpay_ref: event.razorpay_ref ?? null,
    payload: event.payload ?? null,
  };
  const hash = computeHash(prevHash, hashable);

  const inserted = await client.query<RawLedgerRow>(
    `insert into ledger
       (seq, event_id, ts, actor, event_type, intent_text, quote_id, decision,
        rule_id, amount_paise, razorpay_ref, payload, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning *`,
    [
      hashable.seq,
      hashable.event_id,
      hashable.ts,
      hashable.actor,
      hashable.event_type,
      hashable.intent_text,
      hashable.quote_id,
      hashable.decision,
      hashable.rule_id,
      hashable.amount_paise,
      hashable.razorpay_ref,
      hashable.payload === null ? null : JSON.stringify(hashable.payload),
      prevHash,
      hash,
    ],
  );

  return toRow(inserted.rows[0]!);
}

const VERIFY_BATCH = 500;

/**
 * Walks the whole chain, recomputing each row's hash and checking each row's
 * prev_hash against the previous row's stored hash.
 *
 * Returns the seq of the first row that does not hold up, or ok.
 */
export async function verifyChain(): Promise<VerifyChainResult> {
  let afterSeq = 0;
  let expectedPrev = GENESIS_HASH;
  let checked = 0;

  for (;;) {
    const { rows } = await pool.query<RawLedgerRow>(
      'select * from ledger where seq > $1 order by seq asc limit $2',
      [afterSeq, VERIFY_BATCH],
    );
    if (rows.length === 0) break;

    for (const raw of rows) {
      const row = toRow(raw);
      checked += 1;

      if (row.prev_hash !== expectedPrev) {
        return {
          ok: false,
          broken_at_seq: row.seq,
          reason: 'prev_hash_mismatch',
          detail: `row ${row.seq} expected prev_hash ${expectedPrev}, found ${row.prev_hash}`,
          rows_checked: checked,
        };
      }

      const recomputed = computeHash(row.prev_hash, {
        seq: row.seq,
        event_id: row.event_id,
        ts: row.ts,
        actor: row.actor,
        event_type: row.event_type,
        intent_text: row.intent_text,
        quote_id: row.quote_id,
        decision: row.decision,
        rule_id: row.rule_id,
        amount_paise: row.amount_paise,
        razorpay_ref: row.razorpay_ref,
        payload: row.payload,
      });

      if (recomputed !== row.hash) {
        return {
          ok: false,
          broken_at_seq: row.seq,
          reason: 'hash_mismatch',
          detail: `row ${row.seq} contents do not match its stored hash`,
          rows_checked: checked,
        };
      }

      expectedPrev = row.hash;
      afterSeq = row.seq;
    }

    if (rows.length < VERIFY_BATCH) break;
  }

  return { ok: true, rows_checked: checked };
}

export async function readAll(limit = 1000): Promise<LedgerRow[]> {
  const { rows } = await pool.query<RawLedgerRow>(
    'select * from ledger order by seq asc limit $1',
    [limit],
  );
  return rows.map(toRow);
}

/**
 * Every row that mentions one order reference, oldest first.
 *
 * This is the receipt: the charge, and every webhook that later moved it. The
 * page reads these rows rather than the payments projection on purpose — the
 * projection is convenient, the ledger is the evidence.
 */
export async function readByOrderRef(orderRef: string): Promise<LedgerRow[]> {
  const { rows } = await pool.query<RawLedgerRow>(
    'select * from ledger where razorpay_ref = $1 order by seq asc',
    [orderRef],
  );
  return rows.map(toRow);
}

/** Every row for one quote, oldest first. The decisions behind a purchase. */
export async function readByQuoteId(quoteId: string): Promise<LedgerRow[]> {
  const { rows } = await pool.query<RawLedgerRow>(
    'select * from ledger where quote_id = $1 order by seq asc',
    [quoteId],
  );
  return rows.map(toRow);
}

export async function tip(): Promise<LedgerRow | undefined> {
  const { rows } = await pool.query<RawLedgerRow>(
    'select * from ledger order by seq desc limit 1',
  );
  return rows[0] ? toRow(rows[0]) : undefined;
}

/** A row exactly as node-postgres hands it back, before normalisation. */
type RawLedgerRow = Omit<LedgerRow, 'seq' | 'ts' | 'amount_paise'> & {
  seq: number | string;
  ts: Date | string;
  amount_paise: number | string | null;
};

/**
 * Normalises a driver row so a row read back hashes identically to the one
 * written: timestamptz comes back as a Date, and bigint columns can arrive as
 * strings depending on the parser in force.
 */
function toRow(raw: RawLedgerRow): LedgerRow {
  return {
    ...raw,
    seq: Number(raw.seq),
    ts: typeof raw.ts === 'string' ? new Date(raw.ts).toISOString() : raw.ts.toISOString(),
    amount_paise: raw.amount_paise === null ? null : Number(raw.amount_paise),
  };
}

function validate(event: LedgerEventInput): void {
  if (!['agent', 'user', 'system'].includes(event.actor)) {
    throw new Error(`Invalid ledger actor: ${event.actor}`);
  }
  if (!['decision', 'charge', 'webhook'].includes(event.event_type)) {
    throw new Error(`Invalid ledger event_type: ${event.event_type}`);
  }
  if (
    event.amount_paise !== undefined &&
    event.amount_paise !== null &&
    !Number.isSafeInteger(event.amount_paise)
  ) {
    throw new Error('amount_paise must be an integer number of paise');
  }
}
