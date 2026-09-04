/**
 * The slice of the `razorpay` SDK this codebase actually uses.
 *
 * Declared structurally for two reasons. It keeps the adapter unit-testable
 * without a network or a key, and it lets us send fields the shipped typings
 * do not know about — SDK 2.9.8 types an order's `token` as card/emandate/nach
 * only, with no UPI variant and no `type`, while the live API documents a UPI
 * token object. The typings lag the API, so the request shape is pinned here
 * against the docs rather than against the package.
 */

export type TokenFrequency =
  | 'as_presented'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly';

export interface CustomerCreateBody {
  name: string;
  email?: string;
  contact?: string;
  /** 0 returns the existing customer instead of erroring on a repeat. */
  fail_existing: 0 | 1;
  notes?: Record<string, string>;
}

export interface RazorpayCustomer {
  id: string;
  entity: string;
  name?: string;
  email?: string;
  contact?: string;
}

export interface MandateOrderToken {
  /** Integer paise. The provider's ceiling for any single debit. */
  max_amount: number;
  frequency: TokenFrequency;
  /** Unix timestamp in seconds. */
  expire_at?: number;
  /**
   * NPCI's Single Block Multi Debit. Undocumented for a standard AutoPay
   * order and gated on account activation, so it is only sent when the
   * adapter is configured to. See RazorpayMandateAdapter.
   */
  type?: 'single_block_multiple_debit';
  notes?: Record<string, string>;
}

export interface MandateOrderCreateBody {
  /** Integer paise. */
  amount: number;
  currency: 'INR';
  customer_id: string;
  method: 'upi';
  token: MandateOrderToken;
  receipt?: string;
  notes?: Record<string, string>;
}

export interface PlainOrderCreateBody {
  amount: number;
  currency: 'INR';
  customer_id?: string;
  receipt?: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string | null;
}

export interface RecurringPaymentCreateBody {
  email?: string;
  contact?: string;
  amount: number;
  currency: 'INR';
  order_id: string;
  customer_id: string;
  /** The token_id produced when the customer authorised the mandate. */
  token: string;
  recurring: true;
  description?: string;
}

export interface RazorpayRecurringPayment {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
}

export interface RazorpayClient {
  customers: {
    create(body: CustomerCreateBody): Promise<RazorpayCustomer>;
  };
  orders: {
    create(body: MandateOrderCreateBody | PlainOrderCreateBody): Promise<RazorpayOrder>;
  };
  payments: {
    createRecurringPayment(body: RecurringPaymentCreateBody): Promise<RazorpayRecurringPayment>;
  };
}

/**
 * Builds a real SDK client. Imported lazily so nothing outside the Razorpay
 * adapter pays for the dependency, and so a missing key is an error at
 * adapter construction rather than at module load.
 */
export async function createSdkClient(
  keyId: string,
  keySecret: string,
): Promise<RazorpayClient> {
  const { default: Razorpay } = await import('razorpay');
  return new Razorpay({ key_id: keyId, key_secret: keySecret }) as unknown as RazorpayClient;
}
