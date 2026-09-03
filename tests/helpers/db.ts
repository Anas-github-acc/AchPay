import { pool } from '../../src/db/pool.js';

/** Empties the ledger and resets seq to 1, so seq assertions are stable. */
export async function resetLedger(): Promise<void> {
  await pool.query('truncate ledger restart identity');
}

/** Full reset between checkout tests: ledger, mandates and claimed keys. */
export async function resetAll(): Promise<void> {
  await pool.query('truncate ledger restart identity');
  await pool.query('truncate idempotency');
  await pool.query('truncate mandates');
  await pool.query('truncate payments');
  await pool.query('truncate webhook_events');
}

export async function countLedger(where: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from ledger where ${where}`,
    params,
  );
  return Number(rows[0]!.n);
}
