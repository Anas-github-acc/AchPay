import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { verifyChain } from '../../src/ledger/ledger.js';

/**
 * The adversarial suite's scoreboard.
 *
 * Each attack registers itself as an ordinary vitest case, so a broken defence
 * fails the run and `pnpm test:adversarial` exits non-zero. The harness only
 * adds two things on top: a human-readable grid for the terminal, and a JSON
 * file the dashboard renders.
 *
 * Nothing here mocks or stubs anything under src/. The only substitution the
 * whole suite makes is the payment adapter, so no money moves; every layer
 * above it — quotes, signatures, the policy engine, the ledger, approvals,
 * webhooks — is the code that runs in production.
 */

export interface AttackResult {
  id: string;
  /** The one-line name that goes on screen during the demo. */
  name: string;
  /** What the attacker tried, in a sentence a non-engineer can follow. */
  attack: string;
  /** True when the system held. */
  held: boolean;
  /** What actually stopped it, filled in by the test itself. */
  evidence: string;
  duration_ms: number;
  error: string | null;
}

const results: AttackResult[] = [];
const startedAt = Date.now();

/** Handed to each attack so it can say, in its own words, what stopped it. */
export type Evidence = (line: string) => void;

export interface AttackSpec {
  id: string;
  name: string;
  attack: string;
}

/**
 * Registers one attack.
 *
 * The body runs inside a normal `it`, and any assertion failure is recorded and
 * then rethrown — the grid must never be able to report green on a run that
 * vitest reports red.
 */
export function attack(spec: AttackSpec, fn: (evidence: Evidence) => Promise<void>): void {
  it(`${spec.id} - ${spec.name}`, async () => {
    const began = Date.now();
    let evidence = '';
    try {
      await fn((line) => {
        evidence = line;
      });
      results.push({ ...spec, held: true, evidence, duration_ms: Date.now() - began, error: null });
    } catch (err) {
      results.push({
        ...spec,
        held: false,
        evidence,
        duration_ms: Date.now() - began,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
}

const outputPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'adversarial-results.json',
);

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

/**
 * Prints the grid and writes the JSON. Called from the suite's afterAll, so it
 * runs whether the attacks held or not.
 */
export async function report(): Promise<void> {
  // The chain is walked after every attack has written its rows. A suite that
  // proves nineteen defences but leaves a forgeable audit trail has proved
  // nothing, so this is part of the result rather than a footnote.
  const chain = await verifyChain();

  const held = results.filter((r) => r.held).length;
  const width = Math.max(...results.map((r) => r.name.length), 10);
  const lines: string[] = [];

  lines.push('');
  lines.push(
    `${BOLD}  ADVERSARIAL SUITE${RESET}${DIM}  -  ${results.length} attacks, real code paths, fake money${RESET}`,
  );
  lines.push('');
  for (const r of results) {
    const mark = r.held ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const note = r.held ? r.evidence : (r.error ?? 'no defence fired').split('\n')[0]!;
    const colour = r.held ? DIM : RED;
    lines.push(`  ${mark}  ${r.id}  ${r.name.padEnd(width)}  ${colour}${note}${RESET}`);
  }
  lines.push('');
  const verdict =
    held === results.length
      ? `${GREEN}all ${held} attacks held${RESET}`
      : `${RED}${results.length - held} of ${results.length} attacks got through${RESET}`;
  const chainLine = chain.ok
    ? `${GREEN}ledger chain intact${RESET}${DIM} (${chain.rows_checked} rows)${RESET}`
    : `${RED}ledger chain broken at seq ${chain.broken_at_seq}${RESET}`;
  lines.push(`  ${verdict}${DIM}  -  ${RESET}${chainLine}`);
  lines.push('');

  process.stdout.write(`${lines.join('\n')}\n`);

  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        suite: 'adversarial',
        total: results.length,
        held,
        broken: results.length - held,
        duration_ms: Date.now() - startedAt,
        ledger_chain: chain,
        attacks: results,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.stdout.write(`${DIM}  results: ${outputPath}${RESET}\n\n`);
}
