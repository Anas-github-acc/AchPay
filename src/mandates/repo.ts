import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import type { HistoryEntry } from '../policy/types.js';
import type { CreateMandateInput, MandateRecord } from './types.js';

type RawMandate = Omit<MandateRecord, 'max_amount_paise' | 'used_paise' | 'expires_at' | 'created_at'> & {
  max_amount_paise: number | string;
  used_paise: number | string;
  expires_at: Date | string;
  created_at: Date | string;
};

export async function createMandate(
  input: CreateMandateInput,
  db: Db = pool,
): Promise<MandateRecord> {
  if (!Number.isSafeInteger(input.max_amount_paise) || input.max_amount_paise < 0) {
    throw new Error('max_amount_paise must be a non-negative integer number of paise');
  }
  const { rows } = await db.query<RawMandate>(
    `insert into mandates (id, user_ref, max_amount_paise, expires_at, status, provider_token)
     values ($1, $2, $3, $4, 'active', $5)
     returning *`,
    [
      `mnd_${randomUUID().replaceAll('-', '')}`,
      input.user_ref,
      input.max_amount_paise,
      new Date(input.expires_at).toISOString(),
      input.provider_token ?? null,
    ],
  );
  return toMandate(rows[0]!);
}

export async function getMandate(id: string, db: Db = pool): Promise<MandateRecord | undefined> {
  const { rows } = await db.query<RawMandate>('select * from mandates where id = $1', [id]);
  return rows[0] ? toMandate(rows[0]) : undefined;
}

/**
 * Loads a mandate and holds a row lock until the transaction ends.
 *
 * Two checkouts against the same mandate with *different* quotes have distinct
 * idempotency keys, so nothing else stops them both reading the same
 * used_paise and both passing the headroom check. This lock is what makes
 * headroom hold under concurrency.
 */
export async function getMandateForUpdate(
  id: string,
  client: pg.PoolClient,
): Promise<MandateRecord | undefined> {
  const { rows } = await client.query<RawMandate>(
    'select * from mandates where id = $1 for update',
    [id],
  );
  return rows[0] ? toMandate(rows[0]) : undefined;
}

/**
 * Adds to used_paise, refusing to go past the ceiling.
 *
 * Returns undefined if the increment would breach max_amount_paise — a
 * last-resort guard behind the policy engine and the row lock, not a
 * replacement for either.
 */
export async function incrementUsed(
  id: string,
  amountPaise: number,
  db: Db = pool,
): Promise<MandateRecord | undefined> {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw new Error('amountPaise must be a non-negative integer number of paise');
  }
  const { rows } = await db.query<RawMandate>(
    `update mandates
        set used_paise = used_paise + $2
      where id = $1
        and used_paise + $2 <= max_amount_paise
      returning *`,
    [id, amountPaise],
  );
  return rows[0] ? toMandate(rows[0]) : undefined;
}

export async function revokeMandate(id: string, db: Db = pool): Promise<MandateRecord | undefined> {
  const { rows } = await db.query<RawMandate>(
    `update mandates set status = 'revoked' where id = $1 returning *`,
    [id],
  );
  return rows[0] ? toMandate(rows[0]) : undefined;
}

/**
 * Successful charges against this mandate inside `windowHours`, newest first.
 *
 * This is the `history` argument the policy engine takes. It is read here and
 * passed in so the engine itself never touches a database.
 */
export async function chargeHistory(
  mandateId: string,
  windowHours = 24,
  db: Db = pool,
): Promise<HistoryEntry[]> {
  const { rows } = await db.query<{ ts: Date | string; amount_paise: number | string }>(
    `select ts, amount_paise
       from ledger
      where event_type = 'charge'
        and payload ->> 'mandate_id' = $1
        and payload ->> 'status' <> 'failed'
        and ts >= now() - ($2 || ' hours')::interval
      order by ts desc`,
    [mandateId, String(windowHours)],
  );
  return rows.map((row) => ({
    ts: row.ts instanceof Date ? row.ts.toISOString() : new Date(row.ts).toISOString(),
    amount_paise: Number(row.amount_paise),
  }));
}

function toMandate(raw: RawMandate): MandateRecord {
  return {
    ...raw,
    max_amount_paise: Number(raw.max_amount_paise),
    used_paise: Number(raw.used_paise),
    expires_at: toIso(raw.expires_at),
    created_at: toIso(raw.created_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
