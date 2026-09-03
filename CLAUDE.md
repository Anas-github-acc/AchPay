# Agent-ready storefront

Build plan: see build-plan.md. Work one phase at a time.

## Non-negotiables
- All money is integer paise. No floats, no Number, for currency math anywhere.
- Prices come from the catalog, never from a request body. No endpoint or tool
  accepts an amount — only a quote_id.
- The policy engine is a pure function. No DB queries, no network, no free-text
  product fields. History is passed in as an argument.
- Every policy decision returns a rule_id, including allow.
- The ledger is insert-only. Never write UPDATE or DELETE against it.
- Charges are idempotent, enforced by a unique constraint inside the charge
  transaction.
- Commit changes when need helps me to keep track of changes you did.
- Never commit .env or any secret.

## Working style
- Do not start the next phase without being asked.
- If a test fails, fix the system, not the test. If a test seems genuinely
  wrong, say so and wait.
- If a constraint above seems to block a correct implementation, stop and
  explain rather than working around it.
- Never mention phase names or numbers in folder name and any file, they are just to divide my work loads.

## Commands
pnpm dev / pnpm test / pnpm test:adversarial
