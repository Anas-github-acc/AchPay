import { pool } from '../../src/db/pool.js';

/** Empties the ledger and resets seq to 1, so seq assertions are stable. */
export async function resetLedger(): Promise<void> {
  await pool.query('truncate ledger restart identity');
}
