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
  max_qty_per_sku: 3,
  max_line_items: 10,
  gate_if_price_above_category_median_multiple: 2.0,
};

/**
 * A PolicyQuote fixture.
 *
 * `category_median_paise` defaults to 0, which the median rule reads as "no
 * median available" and skips — so a fixture only exercises that rule when it
 * says so explicitly. Every amount-rule test below therefore keeps the verdict
 * it had before the rule existed.
 */
export function quote(totalPaise: number, lines?: Partial<PolicyQuoteLine>[]): PolicyQuote {
  const built: PolicyQuoteLine[] = (lines ?? [{}]).map((line, i) => {
    const qty = line.qty ?? 1;
    const lineTotal = line.line_total_paise ?? totalPaise;
    return {
      sku: line.sku ?? `SKU-${i}`,
      category: line.category ?? 'snacks',
      qty,
      unit_price_paise: line.unit_price_paise ?? Math.floor(lineTotal / qty),
      line_total_paise: lineTotal,
      category_median_paise: line.category_median_paise ?? 0,
    };
  });
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
