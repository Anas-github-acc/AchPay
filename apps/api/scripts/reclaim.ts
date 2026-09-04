/**
 * Runs the reclaim sweep once and prints what it did.
 *
 * The server runs this on a timer; this is the same code on demand, for when
 * you want the headroom back now rather than at the next tick.
 *
 *   pnpm reclaim            release reservations older than 15 minutes
 *   pnpm reclaim 0          release every unsettled reservation it can prove
 */
import { createAdapter } from '../src/payments/index.js';
import { RECLAIM_AFTER_MS, reclaimStaleReservations } from '../src/payments/reclaim.js';
import { pool } from '../src/db/pool.js';

const arg = process.argv[2];
const olderThanMs = arg === undefined ? RECLAIM_AFTER_MS : Number(arg) * 60_000;
if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
  console.error('Usage: pnpm reclaim [minutes]');
  process.exit(1);
}

const adapter = await createAdapter();
const summary = await reclaimStaleReservations(adapter, Math.trunc(olderThanMs));

console.log(JSON.stringify(summary, null, 2));
await pool.end();
