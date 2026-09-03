import type {
  HistoryEntry,
  PolicyConfig,
  PolicyMandate,
  PolicyQuote,
  PolicyQuoteLine,
} from '../../src/policy/types.js';

/** Fixed evaluation instant, so every window boundary is exact. */
export const NOW = new Date('2026-09-03T12:00:00.000Z');

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;

/** The same numbers as policy.yaml, restated so a test never depends on the file. */
export const POLICY: PolicyConfig = {
  per_txn_max_paise: 50_000,
  daily_max_paise: 200_000,
  velocity_max_per_hour: 5,
  gate_above_paise: 30_000,
  category_denylist: ['alcohol', 'tobacco'],
  require_mandate_headroom: true,
};

export function quote(totalPaise: number, lines?: Partial<PolicyQuoteLine>[]): PolicyQuote {
  const built: PolicyQuoteLine[] = (lines ?? [{}]).map((line, i) => ({
    sku: line.sku ?? `SKU-${i}`,
    category: line.category ?? 'snacks',
    qty: line.qty ?? 1,
    line_total_paise: line.line_total_paise ?? totalPaise,
  }));
  return { quote_id: 'qt_test', total_paise: totalPaise, lines: built };
}

export function mandate(overrides: Partial<PolicyMandate> = {}): PolicyMandate {
  return {
    id: 'mnd_test',
    status: 'active',
    max_amount_paise: 1_000_000,
    used_paise: 0,
    expires_at: new Date(NOW.getTime() + 30 * 24 * HOUR).toISOString(),
    ...overrides,
  };
}

/** `count` charges of `amountPaise`, spaced `spacingMs` apart, ending `endsAgoMs` before NOW. */
export function history(
  count: number,
  amountPaise: number,
  spacingMs = MINUTE,
  endsAgoMs = MINUTE,
): HistoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(NOW.getTime() - endsAgoMs - i * spacingMs).toISOString(),
    amount_paise: amountPaise,
  }));
}
