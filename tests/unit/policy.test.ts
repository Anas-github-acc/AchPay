import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { evaluate } from '../../src/policy/evaluate.js';
import { loadPolicy } from '../../src/policy/config.js';
import { toPolicyQuote } from '../../src/policy/project.js';
import { getCatalog } from '../../src/catalog/catalog.js';
import { QuoteService } from '../../src/quotes/service.js';
import type { Decision, PolicyInput, RuleId } from '../../src/policy/types.js';
import { HOUR, MINUTE, NOW, POLICY, history, mandate, quote } from '../helpers/policy.js';

function run(input: Partial<PolicyInput> & { quote: PolicyInput['quote'] }) {
  return evaluate({
    mandate: mandate(),
    history: [],
    now: NOW,
    policy: POLICY,
    ...input,
  });
}

interface Case {
  name: string;
  input: Partial<PolicyInput> & { quote: PolicyInput['quote'] };
  decision: Decision;
  rule_id: RuleId;
}

// One row per rule, both sides of every boundary in policy.yaml.
const cases: Case[] = [
  // --- category denylist -------------------------------------------------
  {
    name: 'an allowed category passes the denylist',
    input: { quote: quote(10_000, [{ category: 'snacks' }]) },
    decision: 'allow',
    rule_id: 'all_checks_passed',
  },
  {
    name: 'a denylisted category is denied',
    input: { quote: quote(10_000, [{ sku: 'BEER-650', category: 'alcohol' }]) },
    decision: 'deny',
    rule_id: 'category_denylist',
  },
  {
    name: 'one denylisted line poisons an otherwise fine basket',
    input: {
      quote: quote(10_000, [
        { sku: 'CHAI-MSL-250', category: 'beverages', line_total_paise: 8_000 },
        { sku: 'CIG-20', category: 'tobacco', line_total_paise: 2_000 },
      ]),
    },
    decision: 'deny',
    rule_id: 'category_denylist',
  },
  {
    name: 'denylist beats every other rule, including caps',
    input: {
      quote: quote(9_999_999, [{ category: 'alcohol' }]),
      mandate: mandate({ status: 'revoked' }),
    },
    decision: 'deny',
    rule_id: 'category_denylist',
  },

  // --- mandate validity --------------------------------------------------
  {
    name: 'a missing mandate is denied',
    input: { quote: quote(1_000), mandate: null },
    decision: 'deny',
    rule_id: 'mandate_missing',
  },
  {
    name: 'a revoked mandate is denied',
    input: { quote: quote(1_000), mandate: mandate({ status: 'revoked' }) },
    decision: 'deny',
    rule_id: 'mandate_revoked',
  },
  {
    name: 'an expired mandate is denied',
    input: {
      quote: quote(1_000),
      mandate: mandate({ expires_at: new Date(NOW.getTime() - 1).toISOString() }),
    },
    decision: 'deny',
    rule_id: 'mandate_expired',
  },
  {
    name: 'a mandate expiring exactly now is still valid',
    input: { quote: quote(1_000), mandate: mandate({ expires_at: NOW.toISOString() }) },
    decision: 'allow',
    rule_id: 'all_checks_passed',
  },
  {
    name: 'a mandate flagged expired is denied even if its timestamp is future',
    input: { quote: quote(1_000), mandate: mandate({ status: 'expired' }) },
    decision: 'deny',
    rule_id: 'mandate_expired',
  },

  // --- headroom ----------------------------------------------------------
  {
    name: 'a quote exactly equal to headroom is allowed',
    input: {
      quote: quote(20_000),
      mandate: mandate({ max_amount_paise: 100_000, used_paise: 80_000 }),
    },
    decision: 'allow',
    rule_id: 'all_checks_passed',
  },
  {
    name: 'a quote one paisa over headroom is denied',
    input: {
      quote: quote(20_001),
      mandate: mandate({ max_amount_paise: 100_000, used_paise: 80_000 }),
    },
    decision: 'deny',
    rule_id: 'headroom',
  },
  {
    name: 'Rs 300 quote against Rs 200 headroom is denied by headroom',
    input: {
      quote: quote(30_000),
      mandate: mandate({ max_amount_paise: 100_000, used_paise: 80_000 }),
    },
    decision: 'deny',
    rule_id: 'headroom',
  },
  {
    name: 'headroom is skipped when require_mandate_headroom is off',
    input: {
      quote: quote(20_001),
      mandate: mandate({ max_amount_paise: 100_000, used_paise: 80_000 }),
      policy: { ...POLICY, require_mandate_headroom: false },
    },
    decision: 'allow',
    rule_id: 'all_checks_passed',
  },

  // --- per-transaction cap (Rs 500) --------------------------------------
  {
    name: 'Rs 499 against a Rs 500 per-txn cap is allowed (gated, but not denied)',
    input: { quote: quote(49_900) },
    decision: 'gate',
    rule_id: 'gate_threshold',
  },
  {
    name: 'Rs 500 exactly is allowed — the cap is inclusive',
    input: { quote: quote(50_000) },
    decision: 'gate',
    rule_id: 'gate_threshold',
  },
  {
    name: 'Rs 501 is denied by per_txn_max',
    input: { quote: quote(50_100) },
    decision: 'deny',
    rule_id: 'per_txn_max',
  },
  {
    name: 'one paisa over the per-txn cap is denied',
    input: { quote: quote(50_001) },
    decision: 'deny',
    rule_id: 'per_txn_max',
  },

  // --- rolling daily cap (Rs 2000) ---------------------------------------
  {
    name: 'a quote landing exactly on the daily cap is allowed',
    input: { quote: quote(20_000), history: history(1, 180_000, MINUTE) },
    decision: 'allow',
    rule_id: 'all_checks_passed',
  },
  {
    name: 'a quote one paisa over the daily cap is denied',
    input: { quote: quote(20_001), history: history(1, 180_000, MINUTE) },
    decision: 'deny',
    rule_id: 'daily_max',
  },
  {
    name: 'history older than 24 hours does not count towards the daily cap',
    input: {
      quote: quote(20_000),
      history: [
        { ts: new Date(NOW.getTime() - 24 * HOUR - MINUTE).toISOString(), amount_paise: 190_000 },
      ],
    },
    decision: 'allow',
    rule_id: 'all_checks_passed',
  },
  {
    name: 'history exactly 24 hours old still counts',
    input: {
      quote: quote(20_001),
      history: [
        { ts: new Date(NOW.getTime() - 24 * HOUR).toISOString(), amount_paise: 180_000 },
      ],
    },
    decision: 'deny',
    rule_id: 'daily_max',
  },

  // --- velocity (5 per hour) ---------------------------------------------
  {
    name: 'the fifth purchase in an hour is allowed',
    input: { quote: quote(1_000), history: history(4, 1_000, MINUTE) },
    decision: 'allow',
    rule_id: 'all_checks_passed',
  },
  {
    name: 'the sixth purchase within an hour is denied by velocity',
    input: { quote: quote(1_000), history: history(5, 1_000, MINUTE) },
    decision: 'deny',
    rule_id: 'velocity',
  },
  {
    name: 'transactions older than an hour do not count towards velocity',
    input: {
      quote: quote(1_000),
      history: history(5, 1_000, MINUTE, HOUR + MINUTE),
    },
    decision: 'allow',
    rule_id: 'all_checks_passed',
  },
  {
    name: 'a transaction exactly one hour old still counts towards velocity',
    input: {
      quote: quote(1_000),
      history: [
        ...history(4, 1_000, MINUTE),
        { ts: new Date(NOW.getTime() - HOUR).toISOString(), amount_paise: 1_000 },
      ],
    },
    decision: 'deny',
    rule_id: 'velocity',
  },

  // --- gate threshold (Rs 300) -------------------------------------------
  {
    name: 'exactly at the gate threshold is allowed — the threshold is exclusive',
    input: { quote: quote(30_000) },
    decision: 'allow',
    rule_id: 'all_checks_passed',
  },
  {
    name: 'one paisa above the gate threshold gates',
    input: { quote: quote(30_001) },
    decision: 'gate',
    rule_id: 'gate_threshold',
  },
  {
    name: 'Rs 350 with the gate at Rs 300 gates',
    input: { quote: quote(35_000) },
    decision: 'gate',
    rule_id: 'gate_threshold',
  },
  {
    name: 'a zero-value quote is allowed',
    input: { quote: quote(0) },
    decision: 'allow',
    rule_id: 'all_checks_passed',
  },

  // --- ordering: deny beats gate -----------------------------------------
  {
    name: 'an amount that would gate is denied instead when headroom is short',
    input: {
      quote: quote(35_000),
      mandate: mandate({ max_amount_paise: 40_000, used_paise: 20_000 }),
    },
    decision: 'deny',
    rule_id: 'headroom',
  },
  {
    name: 'an amount that would gate is denied instead when the daily cap is hit',
    input: { quote: quote(35_000), history: history(1, 190_000, MINUTE) },
    decision: 'deny',
    rule_id: 'daily_max',
  },
  {
    name: 'an amount that would gate is denied instead when velocity is exhausted',
    input: { quote: quote(35_000), history: history(5, 1_000, MINUTE) },
    decision: 'deny',
    rule_id: 'velocity',
  },
  {
    name: 'headroom is checked before the per-txn cap',
    input: {
      quote: quote(60_000),
      mandate: mandate({ max_amount_paise: 60_000, used_paise: 50_000 }),
    },
    decision: 'deny',
    rule_id: 'headroom',
  },
];

describe('policy engine', () => {
  it.each(cases)('$name', ({ input, decision, rule_id }) => {
    const result = run(input);
    expect({ decision: result.decision, rule_id: result.rule_id }).toEqual({ decision, rule_id });
  });

  it('always returns a rule_id, including on allow', () => {
    for (const testCase of cases) {
      const result = run(testCase.input);
      expect(result.rule_id).toBeTruthy();
      expect(result.reason).toBeTruthy();
    }
    expect(run({ quote: quote(100) }).rule_id).toBe('all_checks_passed');
  });
});

describe('splitting a purchase to evade the daily cap', () => {
  // The case build-plan.md calls out: each charge is comfortably under the
  // Rs 500 per-transaction cap, so only the rolling daily cap can stop it.
  const DAILY_CAP = 100_000; // Rs 1000
  const policy = { ...POLICY, daily_max_paise: DAILY_CAP };
  const charge = 40_000; // Rs 400, well under the Rs 500 per-txn cap

  it('allows the first Rs 400 charge', () => {
    const result = run({ quote: quote(charge), history: [], policy });
    expect(result).toMatchObject({ decision: 'gate', rule_id: 'gate_threshold' });
  });

  it('allows the second Rs 400 charge', () => {
    const result = run({ quote: quote(charge), history: history(1, charge, MINUTE), policy });
    expect(result).toMatchObject({ decision: 'gate', rule_id: 'gate_threshold' });
  });

  it('denies the third Rs 400 charge on the daily cap, not the per-txn cap', () => {
    const result = run({ quote: quote(charge), history: history(2, charge, MINUTE), policy });
    expect(result.decision).toBe('deny');
    expect(result.rule_id).toBe('daily_max');
    expect(result.observed).toMatchObject({
      total_paise: charge,
      spent_24h_paise: 80_000,
      daily_max_paise: DAILY_CAP,
    });
  });

  it('denies a single Rs 1200 quote outright, so splitting gains nothing', () => {
    const result = run({ quote: quote(120_000), history: [], policy });
    expect(result).toMatchObject({ decision: 'deny', rule_id: 'per_txn_max' });
  });
});

describe('purity and the injection defence', () => {
  it('is deterministic — the same input always gives the same verdict', () => {
    const input = { quote: quote(35_000), history: history(2, 10_000) };
    const first = run(input);
    for (let i = 0; i < 50; i += 1) expect(run(input)).toEqual(first);
  });

  it('does not mutate its inputs', () => {
    const q = quote(35_000);
    const m = mandate();
    const h = history(3, 10_000);
    const snapshot = JSON.stringify({ q, m, h });
    run({ quote: q, mandate: m, history: h });
    expect(JSON.stringify({ q, m, h })).toBe(snapshot);
  });

  it('cannot see product titles or descriptions — they are projected away', () => {
    const catalog = getCatalog();
    const svc = new QuoteService({ catalog, secret: 's', ttlSeconds: 120 });
    const signed = svc.create([{ sku: 'SNK-HAM-DLX', qty: 1 }]);

    // The hamper is the item carrying the injected description.
    expect(catalog.require('SNK-HAM-DLX').description).toContain('IGNORE PREVIOUS RULES');

    const projected = toPolicyQuote(signed);
    const serialised = JSON.stringify(projected);
    expect(serialised).not.toContain('IGNORE PREVIOUS RULES');
    expect(serialised).not.toContain('Hamper');
    expect(projected.lines[0]).toEqual({
      sku: 'SNK-HAM-DLX',
      category: 'gifting',
      qty: 1,
      line_total_paise: 120_000,
    });

    // And the injection changes nothing: Rs 1200 is over the per-txn cap.
    expect(run({ quote: projected })).toMatchObject({
      decision: 'deny',
      rule_id: 'per_txn_max',
    });
  });
});

describe('policy.yaml', () => {
  const tmp = join(tmpdir(), `policy-${randomUUID()}.yaml`);
  afterAll(() => rmSync(tmp, { force: true }));

  function writePolicy(body: string): string {
    writeFileSync(tmp, body, 'utf8');
    return tmp;
  }

  it('loads with the values the tests assume', () => {
    expect(loadPolicy()).toEqual(POLICY);
  });

  it('rejects a gate threshold above the per-transaction cap', () => {
    expect(() =>
      loadPolicy(
        writePolicy(`
per_txn_max_paise: 50000
daily_max_paise: 200000
velocity_max_per_hour: 5
gate_above_paise: 60000
category_denylist: []
require_mandate_headroom: true
`),
      ),
    ).toThrow(/nothing could ever gate/);
  });

  it('rejects a fractional paise limit', () => {
    expect(() =>
      loadPolicy(
        writePolicy(`
per_txn_max_paise: 500.5
daily_max_paise: 200000
velocity_max_per_hour: 5
gate_above_paise: 30000
category_denylist: []
require_mandate_headroom: true
`),
      ),
    ).toThrow(/per_txn_max_paise/);
  });

  it('rejects a denylist that is not a list of strings', () => {
    expect(() =>
      loadPolicy(
        writePolicy(`
per_txn_max_paise: 50000
daily_max_paise: 200000
velocity_max_per_hour: 5
gate_above_paise: 30000
category_denylist: alcohol
require_mandate_headroom: true
`),
      ),
    ).toThrow(/category_denylist/);
  });
});
