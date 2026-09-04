import { randomUUID } from 'node:crypto';
import type { ChargeRequest, ChargeResult, PaymentAdapter } from './types.js';

/** Always succeeds. The baseline every integration test runs against. */
export class FakeAdapter implements PaymentAdapter {
  readonly name = 'fake';

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    assertChargeable(req);
    return { ref: `fake_${randomUUID().replaceAll('-', '')}`, status: 'captured' };
  }
}

/**
 * Fails roughly 30% of the time, to prove the checkout flow leaves no residue
 * behind a failed charge: no used_paise increment, no idempotency key held,
 * but a ledger row recording that it happened.
 *
 * The random source is injectable so a test can make failure deterministic
 * rather than flaky.
 */
export class FlakyFakeAdapter implements PaymentAdapter {
  readonly name = 'flaky-fake';

  constructor(
    private readonly failureRate = 0.3,
    private readonly random: () => number = Math.random,
  ) {}

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    assertChargeable(req);
    if (this.random() < this.failureRate) {
      return {
        ref: `fake_failed_${randomUUID().replaceAll('-', '')}`,
        status: 'failed',
        error: 'Simulated provider failure',
      };
    }
    return { ref: `fake_${randomUUID().replaceAll('-', '')}`, status: 'captured' };
  }
}

/** Always fails. Used to assert the failure path without relying on chance. */
export class AlwaysFailingAdapter implements PaymentAdapter {
  readonly name = 'always-failing';

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    assertChargeable(req);
    return { ref: `fake_failed_${Date.now()}`, status: 'failed', error: 'Simulated provider failure' };
  }
}

function assertChargeable(req: ChargeRequest): void {
  if (!Number.isSafeInteger(req.amountPaise) || req.amountPaise < 0) {
    throw new Error('amountPaise must be a non-negative integer number of paise');
  }
  if (!req.idempotencyKey) throw new Error('idempotencyKey is required');
}
