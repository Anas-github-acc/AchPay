import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { GENESIS_HASH, append, readAll, tip, verifyChain } from '../../src/ledger/ledger.js';
import { resetLedger } from '../helpers/db.js';

function decision(amountPaise: number, n: number) {
  return {
    actor: 'agent' as const,
    event_type: 'decision' as const,
    intent_text: `order number ${n}`,
    quote_id: `qt_${n}`,
    decision: 'allow' as const,
    rule_id: 'all_checks_passed',
    amount_paise: amountPaise,
    payload: { n },
  };
}

describe('ledger', () => {
  beforeEach(async () => {
    await resetLedger();
  });

  afterAll(async () => {
    await resetLedger();
  });

  it('chains the first row to the genesis hash', async () => {
    const row = await append(decision(18000, 1));
    expect(row.seq).toBe(1);
    expect(row.prev_hash).toBe(GENESIS_HASH);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyChain()).toEqual({ ok: true, rows_checked: 1 });
  });

  it('appends 100 events and verifyChain returns ok', async () => {
    for (let i = 1; i <= 100; i += 1) await append(decision(i * 100, i));
    const rows = await readAll();
    expect(rows).toHaveLength(100);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
    }
    expect(await verifyChain()).toEqual({ ok: true, rows_checked: 100 });
  });

  it('serialises concurrent appends so no two rows share a prev_hash', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => append(decision(1000 + i, i))),
    );
    const rows = await readAll();
    expect(rows).toHaveLength(40);
    expect(new Set(rows.map((r) => r.prev_hash)).size).toBe(40);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(40);
    expect(await verifyChain()).toEqual({ ok: true, rows_checked: 40 });
  });

  it('detects a row tampered with directly in SQL and names that exact seq', async () => {
    for (let i = 1; i <= 100; i += 1) await append(decision(i * 100, i));
    expect(await verifyChain()).toMatchObject({ ok: true });

    // The tamper the plan calls for, run as raw SQL outside the append path.
    await pool.query('update ledger set amount_paise = 1 where seq = 50');

    const result = await verifyChain();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.broken_at_seq).toBe(50);
    expect(result.reason).toBe('hash_mismatch');
  });

  it('detects a tampered payload, rule_id or decision on any row', async () => {
    for (let i = 1; i <= 10; i += 1) await append(decision(i * 100, i));
    await pool.query("update ledger set decision = 'allow', rule_id = 'per_txn_max' where seq = 3");
    expect(await verifyChain()).toMatchObject({ ok: false, broken_at_seq: 3 });
  });

  it('detects a deleted middle row at the row after it', async () => {
    for (let i = 1; i <= 10; i += 1) await append(decision(i * 100, i));
    await pool.query('delete from ledger where seq = 5');

    const result = await verifyChain();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.broken_at_seq).toBe(6);
    expect(result.reason).toBe('prev_hash_mismatch');
  });

  it('reports the first break when several rows are corrupted', async () => {
    for (let i = 1; i <= 20; i += 1) await append(decision(i * 100, i));
    await pool.query('update ledger set amount_paise = 7 where seq in (4, 11, 19)');
    expect(await verifyChain()).toMatchObject({ ok: false, broken_at_seq: 4 });
  });

  it('keeps appending correctly after a truncate, and tip() tracks the head', async () => {
    expect(await tip()).toBeUndefined();
    const first = await append(decision(500, 1));
    const second = await append(decision(600, 2));
    expect((await tip())?.seq).toBe(second.seq);
    expect(second.prev_hash).toBe(first.hash);
  });

  it('rejects an invalid actor or event_type before writing anything', async () => {
    await expect(
      append({ actor: 'hacker' as never, event_type: 'decision' }),
    ).rejects.toThrow(/actor/);
    await expect(
      append({ actor: 'agent', event_type: 'refund' as never }),
    ).rejects.toThrow(/event_type/);
    expect(await readAll()).toHaveLength(0);
  });

  it('rejects a non-integer amount_paise', async () => {
    await expect(
      append({ actor: 'agent', event_type: 'charge', amount_paise: 10.5 }),
    ).rejects.toThrow(/integer/);
  });
});
