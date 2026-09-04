import { describe, expect, it, vi } from 'vitest';
import { RazorpayMandateAdapter } from '../../src/payments/razorpay.js';
import { ReservePayAdapter } from '../../src/payments/reserve-pay.js';
import { NotYetAvailableError } from '../../src/payments/errors.js';
import type {
  CustomerCreateBody,
  MandateOrderCreateBody,
  PlainOrderCreateBody,
  RazorpayClient,
  RecurringPaymentCreateBody,
} from '../../src/payments/razorpay-client.js';
import type { MandateRecord } from '../../src/mandates/types.js';

/**
 * Records every request that would have gone over the wire, so the payload
 * shape can be asserted against the API reference without a key or a network.
 */
function recordingClient(overrides: Partial<RazorpayClient> = {}) {
  const customers: CustomerCreateBody[] = [];
  const orders: (MandateOrderCreateBody | PlainOrderCreateBody)[] = [];
  const recurring: RecurringPaymentCreateBody[] = [];

  const client: RazorpayClient = {
    customers: {
      async create(body) {
        customers.push(body);
        return { id: 'cust_TESTCUSTOMER01', entity: 'customer', ...body };
      },
    },
    orders: {
      async create(body) {
        orders.push(body);
        return {
          id: `order_TEST${orders.length}`,
          entity: 'order',
          amount: body.amount,
          currency: 'INR',
          status: 'created',
        };
      },
      async fetch(orderId: string) {
        return { id: orderId, entity: 'order', amount: 0, currency: 'INR', status: 'created', attempts: 0 };
      },
      async fetchPayments() {
        return { items: [] };
      },
    },
    payments: {
      async createRecurringPayment(body) {
        recurring.push(body);
        return { razorpay_payment_id: 'pay_TESTPAYMENT01' };
      },
    },
    ...overrides,
  };
  return { client, customers, orders, recurring };
}

/** An in-memory stand-in for the provider_customers table. */
function fakeDb(state: { customerId: string | null }) {
  return {
    async query(sql: string, params: unknown[]) {
      if (sql.includes('select customer_id from provider_customers')) {
        return { rows: state.customerId ? [{ customer_id: state.customerId }] : [] };
      }
      if (sql.includes('insert into provider_customers')) {
        if (state.customerId === null) state.customerId = params[2] as string;
        return { rows: [{ customer_id: state.customerId }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as never;
}

function mandate(over: Partial<MandateRecord> = {}): MandateRecord {
  return {
    id: 'mnd_test',
    user_ref: 'user_test',
    max_amount_paise: 500_000,
    used_paise: 0,
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    status: 'active',
    provider_token: null,
    provider_customer_id: null,
    created_at: new Date().toISOString(),
    ...over,
  };
}

function chargeReq(over: Partial<Parameters<RazorpayMandateAdapter['charge']>[0]> = {}) {
  return {
    amountPaise: 4_000,
    mandate: mandate(),
    idempotencyKey: 'a'.repeat(64),
    note: 'quote qt_test',
    ...over,
  };
}

describe('RazorpayMandateAdapter', () => {
  it('creates a customer, then a upi mandate order in the documented shape', async () => {
    const { client, customers, orders } = recordingClient();
    const state = { customerId: null as string | null };
    const adapter = new RazorpayMandateAdapter({ client, db: fakeDb(state) });

    const result = await adapter.charge(chargeReq());

    // Not 'created': an order is a request for a payment, and this mandate has
    // never been authorised. checkout turns this into an authorisation link.
    expect(result).toMatchObject({
      ref: 'order_TEST1',
      status: 'authorisation_required',
      provider_customer_id: 'cust_TESTCUSTOMER01',
    });

    expect(customers).toHaveLength(1);
    // A contact is required: Razorpay rejects recurring orders without one, and
    // a customer with no phone cannot be debited automatically later.
    // The string '0', not the number: the API rejects the numeric form with
    // the very error the flag exists to avoid.
    expect(customers[0]).toMatchObject({ name: 'user_test', fail_existing: '0' });
    expect(customers[0]!.contact).toBeTruthy();
    expect(customers[0]!.email).toBeTruthy();

    expect(orders).toHaveLength(1);
    const order = orders[0] as MandateOrderCreateBody;
    expect(order.amount).toBe(4_000);
    expect(order.currency).toBe('INR');
    expect(order.method).toBe('upi');
    expect(order.customer_id).toBe('cust_TESTCUSTOMER01');
    expect(order.token.max_amount).toBe(500_000);
    expect(order.token.frequency).toBe('as_presented');
    expect(typeof order.token.expire_at).toBe('number');
    expect(order.notes).toMatchObject({ mandate_id: 'mnd_test', user_ref: 'user_test' });
    // Razorpay caps receipt at 40 characters.
    expect(order.receipt!.length).toBeLessThanOrEqual(40);
  });

  it('omits token.type by default and sends it only when SBMD is switched on', async () => {
    const off = recordingClient();
    await new RazorpayMandateAdapter({
      client: off.client,
      db: fakeDb({ customerId: null }),
    }).charge(chargeReq());
    expect((off.orders[0] as MandateOrderCreateBody).token).not.toHaveProperty('type');

    const on = recordingClient();
    await new RazorpayMandateAdapter({
      client: on.client,
      db: fakeDb({ customerId: null }),
      singleBlockMultipleDebit: true,
    }).charge(chargeReq());
    expect((on.orders[0] as MandateOrderCreateBody).token.type).toBe('single_block_multiple_debit');
  });

  it('never writes to the mandate row, which its caller holds locked', async () => {
    const { client } = recordingClient();
    const seen: string[] = [];
    const db = {
      async query(sql: string, params: unknown[]) {
        seen.push(sql);
        if (sql.includes('select customer_id')) return { rows: [] };
        return { rows: [{ customer_id: params[2] }] };
      },
    } as never;

    await new RazorpayMandateAdapter({ client, db }).charge(chargeReq());

    expect(seen.length).toBeGreaterThan(0);
    // Touching `mandates` here deadlocks against checkout's `for update` lock.
    for (const sql of seen) expect(sql).not.toMatch(/\bmandates\b/);
  });

  it('reuses an existing customer instead of creating a second one', async () => {
    const { client, customers, orders } = recordingClient();
    const adapter = new RazorpayMandateAdapter({
      client,
      db: fakeDb({ customerId: 'cust_ALREADYTHERE1' }),
    });

    await adapter.charge(chargeReq());

    expect(customers).toHaveLength(0);
    expect((orders[0] as MandateOrderCreateBody).customer_id).toBe('cust_ALREADYTHERE1');
  });

  it('skips the lookup entirely when the mandate already carries a customer id', async () => {
    const { client, customers, orders } = recordingClient();
    const db = { query: vi.fn() } as never;
    const adapter = new RazorpayMandateAdapter({ client, db });

    await adapter.charge(chargeReq({ mandate: mandate({ provider_customer_id: 'cust_ONFILE0001' }) }));

    expect(customers).toHaveLength(0);
    expect((orders[0] as MandateOrderCreateBody).customer_id).toBe('cust_ONFILE0001');
  });

  it('sends the exact paise amount, never a rounded or token amount', async () => {
    const { client, orders } = recordingClient();
    const adapter = new RazorpayMandateAdapter({ client, db: fakeDb({ customerId: null }) });

    await adapter.charge(chargeReq({ amountPaise: 36_007 }));

    expect(orders[0]!.amount).toBe(36_007);
  });

  it('clamps token.max_amount into the band the API accepts', async () => {
    const low = recordingClient();
    await new RazorpayMandateAdapter({ client: low.client, db: fakeDb({ customerId: null }) })
      .charge(chargeReq({ amountPaise: 100, mandate: mandate({ max_amount_paise: 100 }) }));
    expect((low.orders[0] as MandateOrderCreateBody).token.max_amount).toBe(500);

    const high = recordingClient();
    await new RazorpayMandateAdapter({ client: high.client, db: fakeDb({ customerId: null }) })
      .charge(chargeReq({ mandate: mandate({ max_amount_paise: 900_000_000 }) }));
    expect((high.orders[0] as MandateOrderCreateBody).token.max_amount).toBe(100_000_000);
  });

  it('refuses a charge above the provider ceiling without calling the API', async () => {
    const { client, orders } = recordingClient();
    const adapter = new RazorpayMandateAdapter({ client, db: fakeDb({ customerId: null }) });

    const result = await adapter.charge(
      chargeReq({ amountPaise: 200_000_000, mandate: mandate({ max_amount_paise: 900_000_000 }) }),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/exceeds the mandate's provider ceiling/);
    expect(orders).toHaveLength(0);
  });

  it('turns a provider rejection into a failed charge, not a throw', async () => {
    const { client } = recordingClient({
      orders: {
        async create() {
          throw {
            statusCode: 400,
            error: { code: 'BAD_REQUEST_ERROR', description: 'The token type is invalid' },
          };
        },
      async fetch(orderId: string) {
        return { id: orderId, entity: 'order', amount: 0, currency: 'INR', status: 'created', attempts: 0 };
      },
      async fetchPayments() {
        return { items: [] };
      },
      },
    });
    const adapter = new RazorpayMandateAdapter({ client, db: fakeDb({ customerId: null }) });

    const result = await adapter.charge(chargeReq());

    expect(result.status).toBe('failed');
    expect(result.error).toBe('The token type is invalid (BAD_REQUEST_ERROR)');
  });

  it('refuses to report success if the created order amount drifts', async () => {
    const { client } = recordingClient({
      orders: {
        async create(body) {
          return {
            id: 'order_DRIFT',
            entity: 'order',
            amount: body.amount + 1,
            currency: 'INR',
            status: 'created',
          };
        },
      async fetch(orderId: string) {
        return { id: orderId, entity: 'order', amount: 0, currency: 'INR', status: 'created', attempts: 0 };
      },
      async fetchPayments() {
        return { items: [] };
      },
      },
    });
    const adapter = new RazorpayMandateAdapter({ client, db: fakeDb({ customerId: null }) });

    const result = await adapter.charge(chargeReq());

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/4001 paise, not 4000/);
  });

  it('debits an already-registered mandate instead of opening a second one', async () => {
    const { client, orders, recurring } = recordingClient();
    const adapter = new RazorpayMandateAdapter({ client, db: fakeDb({ customerId: null }) });

    const result = await adapter.charge(
      chargeReq({
        mandate: mandate({ provider_token: 'token_ABC', provider_customer_id: 'cust_ONFILE0001' }),
      }),
    );

    // A registered mandate really was submitted to the rail, so this one is
    // 'created' — the distinction the authorisation state exists to make.
    expect(result).toMatchObject({ ref: 'pay_TESTPAYMENT01', status: 'created' });
    expect(orders[0]).not.toHaveProperty('token');
    expect(recurring[0]).toMatchObject({
      amount: 4_000,
      currency: 'INR',
      order_id: 'order_TEST1',
      customer_id: 'cust_ONFILE0001',
      token: 'token_ABC',
      recurring: true,
    });
  });

  it('explains an endpoint the account is not enabled for', async () => {
    const { client } = recordingClient({
      orders: {
        async create() {
          throw {
            statusCode: 400,
            error: {
              code: 'BAD_REQUEST_ERROR',
              description: 'The requested URL was not found on the server.',
            },
          };
        },
      async fetch(orderId: string) {
        return { id: orderId, entity: 'order', amount: 0, currency: 'INR', status: 'created', attempts: 0 };
      },
      async fetchPayments() {
        return { items: [] };
      },
      },
    });
    const adapter = new RazorpayMandateAdapter({ client, db: fakeDb({ customerId: null }) });

    const result = await adapter.charge(chargeReq());

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/enable recurring \/ S2S payments/);
  });

  it('rejects a non-integer or non-positive amount before anything is sent', async () => {
    const { client, orders } = recordingClient();
    const adapter = new RazorpayMandateAdapter({ client, db: fakeDb({ customerId: null }) });

    await expect(adapter.charge(chargeReq({ amountPaise: 40.5 }))).rejects.toThrow(/integer/);
    await expect(adapter.charge(chargeReq({ amountPaise: 0 }))).rejects.toThrow(/positive/);
    expect(orders).toHaveLength(0);
  });
});

describe('ReservePayAdapter', () => {
  it('throws NotYetAvailableError rather than reporting a decline', async () => {
    const adapter = new ReservePayAdapter();
    expect(adapter.name).toBe('reserve-pay');
    await expect(
      adapter.charge({
        amountPaise: 4_000,
        mandate: mandate(),
        idempotencyKey: 'k',
        note: 'n',
      }),
    ).rejects.toBeInstanceOf(NotYetAvailableError);
  });

  it('satisfies the same interface as every other adapter', () => {
    const adapter = new ReservePayAdapter();
    expect(typeof adapter.charge).toBe('function');
    expect(typeof adapter.name).toBe('string');
  });

  it('falls back to a payer-confirmed order when the account cannot debit', async () => {
    // Razorpay answers "the requested URL was not found" for endpoints an
    // account is not enabled for. The purchase is still good — basket, policy
    // and mandate all pass — so the adapter opens an order a person confirms
    // rather than reporting a dead charge.
    const orders: (MandateOrderCreateBody | PlainOrderCreateBody)[] = [];
    const { client } = recordingClient({
      orders: {
        async create(body) {
          orders.push(body);
          return {
            id: 'order_FALLBACK',
            entity: 'order',
            amount: body.amount,
            currency: 'INR',
            status: 'created',
          };
        },
        async fetch(orderId: string) {
          return { id: orderId, entity: 'order', amount: 0, currency: 'INR', status: 'created', attempts: 0 };
        },
        async fetchPayments() {
          return { items: [] };
        },
      },
      payments: {
        async createRecurringPayment() {
          throw {
            statusCode: 400,
            error: {
              code: 'BAD_REQUEST_ERROR',
              description: 'The requested URL was not found on the server.',
            },
          };
        },
      },
    });
    const adapter = new RazorpayMandateAdapter({
      client,
      db: fakeDb({ customerId: 'cust_ONFILE0001' }),
    });

    const result = await adapter.charge(
      chargeReq({
        mandate: mandate({ provider_token: 'token_ABC', provider_customer_id: 'cust_ONFILE0001' }),
      }),
    );

    expect(result).toMatchObject({
      ref: 'order_FALLBACK',
      status: 'authorisation_required',
      provider_customer_id: 'cust_ONFILE0001',
    });
    // Never silent: the reason travels with the result into the ledger.
    expect(result.provider_note).toMatch(/requested URL was not found/i);
    // A plain order. The mandate is already registered and re-registering it
    // is not what was asked for.
    expect(orders.at(-1)).not.toHaveProperty('token');
    expect(orders.at(-1)!.amount).toBe(4_000);
  });

  it('does not fall back for an ordinary provider refusal', async () => {
    // The fallback exists for a disabled endpoint, not for a decline. Widening
    // it would turn real failures into a person being asked to pay by hand.
    const { client } = recordingClient({
      payments: {
        async createRecurringPayment() {
          throw {
            statusCode: 400,
            error: { code: 'BAD_REQUEST_ERROR', description: 'Token is not valid' },
          };
        },
      },
    });
    const adapter = new RazorpayMandateAdapter({
      client,
      db: fakeDb({ customerId: 'cust_ONFILE0001' }),
    });

    const result = await adapter.charge(
      chargeReq({
        mandate: mandate({ provider_token: 'token_ABC', provider_customer_id: 'cust_ONFILE0001' }),
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Token is not valid');
  });
});
