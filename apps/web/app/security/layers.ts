import type { DefenceLayer } from '@storefront/shared';

/**
 * The page is grouped by defence layer rather than by test number so that it
 * reads as an argument about the architecture instead of a list of tests. A
 * judge scanning it should come away with six sentences about how the system is
 * built, and the attacks underneath each one as the evidence for it.
 *
 * The order is the order a purchase moves through the system: price, then the
 * text around the price, then the rules, then the write, then the human, then
 * the record.
 */
export interface LayerCopy {
  id: DefenceLayer;
  title: string;
  /** The claim the attacks below it are evidence for. */
  claim: string;
}

export const LAYERS: LayerCopy[] = [
  {
    id: 'quote_signature',
    title: 'Signed quotes',
    claim:
      'Prices come from the catalog and are sealed with an HMAC. No endpoint and no tool accepts an amount — the only handle an agent has on money is a quote_id.',
  },
  {
    id: 'ingest_sanitiser',
    title: 'Ingest sanitiser',
    claim:
      'Product prose is untrusted input. It is flagged at ingest, absent from the route agents actually call, and never read by the code that decides anything.',
  },
  {
    id: 'policy_rule',
    title: 'Policy engine',
    claim:
      'A pure function over structured fields — no database, no network, no free text. Every decision names the rule that made it, including allow.',
  },
  {
    id: 'idempotency_constraint',
    title: 'Idempotency constraint',
    claim:
      'One intent, one charge. Enforced by a unique index inside the charge transaction, so a retry or a race loses to the database rather than to a check that ran first.',
  },
  {
    id: 'server_rendered_confirmation',
    title: 'Human approval',
    claim:
      'A gated purchase stops and waits for a person. The token is consumed on use, and one approval authorises exactly one purchase.',
  },
  {
    id: 'hash_chained_ledger',
    title: 'Hash-chained ledger',
    claim:
      'Insert-only, and every row commits to the hash of the row before it. Tampering does not just get noticed — verifyChain names the seq it happened at.',
  },
];

/** Attacks whose catalog entry is missing land here rather than disappearing. */
export const UNCATALOGUED: LayerCopy = {
  id: 'quote_signature',
  title: 'Not yet catalogued',
  claim: 'These tests ran, but data/attack-catalog.json has no entry for them yet.',
};
