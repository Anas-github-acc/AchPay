import { config } from '../config.js';
import { AlwaysFailingAdapter, FakeAdapter, FlakyFakeAdapter } from './fake.js';
import { RazorpayMandateAdapter } from './razorpay.js';
import { ReservePayAdapter } from './reserve-pay.js';
import type { PaymentAdapter } from './types.js';

export { AlwaysFailingAdapter, FakeAdapter, FlakyFakeAdapter } from './fake.js';
export { NotYetAvailableError, ProviderError } from './errors.js';
export { RazorpayMandateAdapter } from './razorpay.js';
export { ReservePayAdapter } from './reserve-pay.js';
export type { ChargeRequest, ChargeResult, ChargeStatus, PaymentAdapter } from './types.js';
export type { RazorpayClient, TokenFrequency } from './razorpay-client.js';

export const ADAPTER_NAMES = ['fake', 'flaky-fake', 'always-failing', 'razorpay', 'reserve-pay'] as const;

export type AdapterName = (typeof ADAPTER_NAMES)[number];

export function isAdapterName(value: string): value is AdapterName {
  return (ADAPTER_NAMES as readonly string[]).includes(value);
}

/**
 * Which rail moves the money, chosen by configuration rather than by editing
 * code. Every branch here returns the same interface, so nothing upstream of
 * this function can tell them apart — which is the point.
 */
export async function createAdapter(name: AdapterName = config.paymentAdapter): Promise<PaymentAdapter> {
  switch (name) {
    case 'fake':
      return new FakeAdapter();
    case 'flaky-fake':
      return new FlakyFakeAdapter();
    case 'always-failing':
      return new AlwaysFailingAdapter();
    case 'razorpay':
      return RazorpayMandateAdapter.fromKeys(config.razorpay.keyId, config.razorpay.keySecret, {
        frequency: config.razorpay.frequency,
        singleBlockMultipleDebit: config.razorpay.singleBlockMultipleDebit,
      });
    case 'reserve-pay':
      return new ReservePayAdapter();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown payment adapter: ${String(exhaustive)}`);
    }
  }
}
