import type { VerifyChainResult } from './ledger.js';

/** One attack's outcome, as written by `pnpm test:adversarial`. */
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

/**
 * The whole of data/adversarial-results.json.
 *
 * Written by the adversarial suite and read by the dashboard, which is why it
 * lives here rather than beside the test that produces it.
 */
export interface AdversarialReport {
  generated_at: string;
  suite: 'adversarial';
  total: number;
  held: number;
  broken: number;
  duration_ms: number;
  ledger_chain: VerifyChainResult;
  attacks: AttackResult[];
}
