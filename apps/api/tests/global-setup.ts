import 'dotenv/config';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';

/**
 * Runs once for the whole suite: apply migrations, then hand every worker a
 * schema that is already up to date. Per-file setup only truncates.
 */
export async function setup(): Promise<void> {
  await migrate();
  await pool.query('truncate ledger restart identity');
  await pool.end();
}
