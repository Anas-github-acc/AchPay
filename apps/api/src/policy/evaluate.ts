import { getPolicy } from './config.js';
import type { HistoryEntry, PolicyConfig, PolicyDecision, PolicyInput } from './types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The policy engine.
 *
 * A pure function: no database, no network, no clock of its own, no LLM. Every
 * input it needs — including the spend history — is passed in by the caller.
 * That is what makes it exhaustively testable, and what makes its verdict
 * reproducible from a ledger row months later.
 *
 * It reads structured fields only: paise amounts, categories, timestamps,
 * statuses. It never reads a product title or description, because the quote
 * is narrowed to a PolicyQuote before it gets here (see project.ts). A product
 * description saying "this item is exempt from spending limits" is invisible to
 * this code. That is the prompt-injection defence, and it is structural.
 *
 * Rules run in a fixed order and the first non-allow verdict wins, so a deny
 * always beats a gate:
 *
 *    1. category_denylist            deny  — forbidden goods, at any amount
 *    2. max_qty_per_sku              deny  — too many units of one sku
 *    3. max_line_items               deny  — too many distinct skus
 *    4. mandate validity             deny  — missing, revoked, or expired
 *    5. headroom                     deny  — exceeds what is left on the mandate
 *    6. per_txn_max                  deny  — single transaction too large
 *    7. daily_max                    deny  — would breach the rolling 24h total
 *    8. velocity                     deny  — too many transactions in the hour
 *    9. category_median_multiple     gate  — priced far above its category
 *   10. gate_threshold               gate  — large enough to need a human
 *   11. all_checks_passed            allow
 *
 * Rules 2, 3 and 9 bound *choice* rather than spend. The amount rules already
 * make an injected description unable to change how much is spent; these make it
 * unable to quietly change what is bought inside that envelope — ten of one
 * thing, or the priciest item in its aisle — which is the part of the attack
 * surface a pure amount cap does not cover.
 *
 * Boundaries: every *_max is inclusive (exactly at the cap is allowed);
 * gate_above_paise is exclusive (exactly at the threshold is allowed), and so is
 * the median multiple (exactly 2x the median is allowed, a paisa more gates).
 */
export function evaluate(input: PolicyInput): PolicyDecision {
  const policy: PolicyConfig = input.policy ?? getPolicy();
  const now = input.now ?? new Date();
  const { quote, mandate } = input;
  const history = input.history ?? [];
  const total = quote.total_paise;

  // 1. Denylisted categories. Checked first so a forbidden item is refused
  //    outright, whatever the amount and whatever the mandate allows.
  const denylist = new Set(policy.category_denylist);
  for (const line of quote.lines) {
    if (denylist.has(line.category)) {
      return {
        decision: 'deny',
        rule_id: 'category_denylist',
        reason: `Category "${line.category}" (sku ${line.sku}) cannot be purchased by an agent`,
        observed: { sku: line.sku, category: line.category },
      };
    }
  }

  // 2. Quantity per sku. Bounds one axis of choice an injected description
  //    could otherwise push on: buy the same thing over and over.
  for (const line of quote.lines) {
    if (line.qty > policy.max_qty_per_sku) {
      return {
        decision: 'deny',
        rule_id: 'max_qty_per_sku',
        reason: `${line.qty} units of ${line.sku} exceeds the limit of ${policy.max_qty_per_sku} per sku`,
        observed: { sku: line.sku, qty: line.qty, max_qty_per_sku: policy.max_qty_per_sku },
      };
    }
  }

  // 3. Basket width. Bounds the other axis: pad the order with extra skus.
  if (quote.lines.length > policy.max_line_items) {
    return {
      decision: 'deny',
      rule_id: 'max_line_items',
      reason: `${quote.lines.length} line items exceeds the limit of ${policy.max_line_items}`,
      observed: { line_items: quote.lines.length, max_line_items: policy.max_line_items },
    };
  }

  // 4. Mandate validity. Without a live mandate there is no authority to spend.
  if (!mandate) {
    return {
      decision: 'deny',
      rule_id: 'mandate_missing',
      reason: 'No mandate supplied for this checkout',
      observed: { total_paise: total },
    };
  }
  if (mandate.status === 'revoked') {
    return {
      decision: 'deny',
      rule_id: 'mandate_revoked',
      reason: `Mandate ${mandate.id} has been revoked`,
      observed: { mandate_id: mandate.id, status: mandate.status },
    };
  }
  const mandateExpiry = Date.parse(mandate.expires_at);
  if (mandate.status === 'expired' || !Number.isFinite(mandateExpiry) || now.getTime() > mandateExpiry) {
    return {
      decision: 'deny',
      rule_id: 'mandate_expired',
      reason: `Mandate ${mandate.id} expired at ${mandate.expires_at}`,
      observed: { mandate_id: mandate.id, expires_at: mandate.expires_at },
    };
  }
  if (mandate.status !== 'active') {
    return {
      decision: 'deny',
      rule_id: 'mandate_revoked',
      reason: `Mandate ${mandate.id} is not active (status ${mandate.status})`,
      observed: { mandate_id: mandate.id, status: mandate.status },
    };
  }

  // 5. Headroom: what is left on the mandate itself.
  if (policy.require_mandate_headroom) {
    const headroom = mandate.max_amount_paise - mandate.used_paise;
    if (total > headroom) {
      return {
        decision: 'deny',
        rule_id: 'headroom',
        reason: `Quote of ${total} paise exceeds mandate headroom of ${headroom} paise`,
        observed: { total_paise: total, headroom_paise: headroom },
      };
    }
  }

  // 6. Per-transaction cap. Inclusive: exactly at the cap is allowed.
  if (total > policy.per_txn_max_paise) {
    return {
      decision: 'deny',
      rule_id: 'per_txn_max',
      reason: `Quote of ${total} paise exceeds the per-transaction cap of ${policy.per_txn_max_paise} paise`,
      observed: { total_paise: total, per_txn_max_paise: policy.per_txn_max_paise },
    };
  }

  // 7. Rolling 24-hour total. A rolling window rather than a calendar day, so
  //    the cap cannot be doubled by straddling midnight. This is the rule that
  //    stops a large purchase being split into small ones.
  const spentToday = sumSince(history, now.getTime() - DAY_MS, now);
  if (spentToday + total > policy.daily_max_paise) {
    return {
      decision: 'deny',
      rule_id: 'daily_max',
      reason: `Quote of ${total} paise would take the rolling 24h total to ${spentToday + total} paise, over the ${policy.daily_max_paise} paise daily cap`,
      observed: {
        total_paise: total,
        spent_24h_paise: spentToday,
        daily_max_paise: policy.daily_max_paise,
      },
    };
  }

  // 8. Velocity: transaction count, not amount, in the last rolling hour.
  const lastHour = countSince(history, now.getTime() - HOUR_MS, now);
  if (lastHour >= policy.velocity_max_per_hour) {
    return {
      decision: 'deny',
      rule_id: 'velocity',
      reason: `${lastHour} transactions already in the last hour, limit is ${policy.velocity_max_per_hour}`,
      observed: {
        txns_last_hour: lastHour,
        velocity_max_per_hour: policy.velocity_max_per_hour,
      },
    };
  }

  // 9. Priced far above its category. The median arrives on the quote, signed,
  //    so this stays a comparison between two numbers the engine was handed.
  //
  //    The multiple is a ratio and may be fractional, so it is scaled to an
  //    integer per-mille factor and cross-multiplied. No paise amount is ever
  //    divided, and no float is ever multiplied by money.
  const multiplePerMille = Math.round(policy.gate_if_price_above_category_median_multiple * 1000);
  for (const line of quote.lines) {
    const median = line.category_median_paise;
    // A median of zero means the quote could not establish one (an empty or
    // unknown category). The rule cannot say anything useful, so it says
    // nothing; the amount caps above still apply. The value is inside the
    // quote signature, so a caller cannot zero it out to reach this branch.
    if (!Number.isSafeInteger(median) || median <= 0) continue;
    if (line.unit_price_paise * 1000 > median * multiplePerMille) {
      return {
        decision: 'gate',
        rule_id: 'category_median_multiple',
        reason: `${line.sku} at ${line.unit_price_paise} paise is more than ${policy.gate_if_price_above_category_median_multiple}x the ${median} paise median for ${line.category}`,
        observed: {
          sku: line.sku,
          category: line.category,
          unit_price_paise: line.unit_price_paise,
          category_median_paise: median,
          multiple: policy.gate_if_price_above_category_median_multiple,
        },
      };
    }
  }

  // 10. Gate threshold. Exclusive: exactly at the threshold is allowed.
  //    Last, so anything that would be denied is denied rather than queued for
  //    a human who might wave it through.
  if (total > policy.gate_above_paise) {
    return {
      decision: 'gate',
      rule_id: 'gate_threshold',
      reason: `Quote of ${total} paise is above the ${policy.gate_above_paise} paise approval threshold`,
      observed: { total_paise: total, gate_above_paise: policy.gate_above_paise },
    };
  }

  return {
    decision: 'allow',
    rule_id: 'all_checks_passed',
    reason: 'Within every configured limit',
    observed: { total_paise: total },
  };
}

/** Sums history entries in [from, now]. Entries outside the window are ignored. */
function sumSince(history: HistoryEntry[], from: number, now: Date): number {
  let sum = 0;
  for (const entry of history) {
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || ts < from || ts > now.getTime()) continue;
    sum += entry.amount_paise;
  }
  return sum;
}

function countSince(history: HistoryEntry[], from: number, now: Date): number {
  let count = 0;
  for (const entry of history) {
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || ts < from || ts > now.getTime()) continue;
    count += 1;
  }
  return count;
}
