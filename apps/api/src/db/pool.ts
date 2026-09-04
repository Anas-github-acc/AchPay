import pg from 'pg';
import { config } from '../config.js';

// bigint (int8) arrives as a string by default so precision is never lost.
// Every int8 column here is money in paise or a sequence number, both well
// inside Number.MAX_SAFE_INTEGER, so parsing to number is safe and keeps
// callers from having to string-compare amounts.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export type Db = pg.Pool | pg.PoolClient;

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
