import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';

/**
 * The map from a user to the customer created for them at a payment provider.
 *
 * Kept out of the `mandates` row on purpose. A charge runs inside the checkout
 * transaction, which holds a `for update` lock on that row until it commits.
 * An adapter that wrote to the same row from the pool would block on that lock
 * while the transaction blocked on the adapter — a deadlock neither side can
 * break. Writing here touches nothing the caller holds.
 *
 * Both functions are safe to call from outside the caller's transaction, which
 * is the point: if the checkout later rolls back, the customer created at the
 * provider still exists, so remembering it is correct rather than a leak.
 */

/** The customer already created for this user, if there is one. */
export async function findCustomerId(
  provider: string,
  userRef: string,
  db: Db = pool,
): Promise<string | undefined> {
  const { rows } = await db.query<{ customer_id: string }>(
    'select customer_id from provider_customers where provider = $1 and user_ref = $2',
    [provider, userRef],
  );
  return rows[0]?.customer_id;
}

/**
 * Records a customer id, keeping whichever one got there first.
 *
 * Two concurrent charges for a new user can both create a customer at the
 * provider. The insert settles which one this system uses from then on; the
 * loser's customer is simply never referenced again. Returns the winner, so a
 * caller always proceeds with the id that is actually stored.
 */
export async function rememberCustomerId(
  provider: string,
  userRef: string,
  customerId: string,
  db: Db = pool,
): Promise<string> {
  const { rows } = await db.query<{ customer_id: string }>(
    `insert into provider_customers (provider, user_ref, customer_id)
     values ($1, $2, $3)
     on conflict (provider, user_ref) do update
       set customer_id = provider_customers.customer_id
     returning customer_id`,
    [provider, userRef, customerId],
  );
  return rows[0]!.customer_id;
}
