/**
 * Walks the ledger chain and exits non-zero if it does not hold up.
 * Run after the test suite, or against a live database at any time.
 */
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { verifyChain } from '../src/ledger/ledger.js';

await migrate();
const result = await verifyChain();
await pool.end();

if (result.ok) {
  console.log(`ledger ok — ${result.rows_checked} rows verified`);
  process.exit(0);
}
console.error(
  `ledger BROKEN at seq ${result.broken_at_seq} (${result.reason}) — ${result.detail}`,
);
process.exit(1);
