/**
 * Ledger row shapes.
 *
 * The row types themselves live in @storefront/shared because the dashboard
 * renders them; they are re-exported here so every caller in this app keeps
 * importing them from beside the code that writes them.
 */
export type {
  LedgerActor,
  LedgerDecision,
  LedgerEventInput,
  LedgerEventType,
  LedgerRow,
  VerifyChainResult,
} from '@storefront/shared';
