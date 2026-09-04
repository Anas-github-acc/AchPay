/**
 * Types shared by the API and the dashboard.
 *
 * Types only: this package has no runtime code, no dependencies and nothing to
 * build. Anything with behaviour lives in apps/api. Every import of it is an
 * `import type`, so nothing here survives compilation into either app's bundle.
 */
export type {
  LedgerActor,
  LedgerDecision,
  LedgerEventInput,
  LedgerEventType,
  LedgerRow,
  VerifyChainResult,
} from './ledger.js';
export type { Decision, PolicyDecision, RuleId } from './policy.js';
export type { Product, ProductSource, RawProduct } from './catalog.js';
export type { QuoteLine, SignedQuote, UnsignedQuote } from './quote.js';
export type { MandateRecord, MandateStatus } from './mandate.js';
export type { AdversarialReport, AttackResult } from './adversarial.js';
export type {
  AttackCatalog,
  AttackCatalogEntry,
  DefenceLayer,
  SecurityAttack,
  SecurityReport,
  Severity,
} from './security.js';
