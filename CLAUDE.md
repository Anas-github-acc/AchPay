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
- Commit changes when needed, help me to keep track of changes you did.
- commit should be short and pin-point.
- Never commit .env or any secret.

## Working style
- Do not start the next phase without being asked.
- If a test fails, fix the system, not the test. If a test seems genuinely
  wrong, say so and wait.
- If a constraint above seems to block a correct implementation, stop and
  explain rather than working around it.
- Never mention phase names or numbers in folder name and any file, they are just to divide my work loads.

## Layout

A pnpm workspace. `pnpm -r` is the only orchestration; there is no Turborepo,
and nothing here is slow enough to want one yet.

```
apps/
  api/            everything that runs: catalog, quotes, policy, ledger,
                  payments, mandates, approvals, webhooks, HTTP, MCP,
                  plus src/db/migrations and the whole test suite
  web/            dashboard: /security (the attack log), /ledger, /mandates
packages/
  shared/         types only, no runtime code. Imported by both apps as
                  @storefront/shared, always with `import type`.
data/             catalog.json, attack-catalog.json, and the reports the app writes
policy.yaml       the spending policy
.env              not committed; every script below runs from the repo root,
                  which is why this file stays here
```

`packages/shared` holds exactly the types both apps need: the ledger row and
its event_type union, PolicyDecision and its rule_id union, Product, the quote
and its lines, the mandate and its status, the shape of
data/adversarial-results.json, and the attack log the dashboard reads. Anything with behaviour lives in apps/api, and
each app-side types file re-exports its shared types so imports stay local to
the code that uses them.

Note on paths: `data/` and `policy.yaml` sit at the repo root, so every script
runs with the repo root as the working directory. `pnpm --filter` on a runtime
script would move the working directory and lose `.env`.

## Commands

Run from the repo root.

```
pnpm dev               API on :3000, watching
pnpm start             API once, no watch
pnpm dev:web           dashboard on :3001
pnpm test              every test, from apps/api
pnpm test:adversarial  the attack grid, writes data/adversarial-results.json
pnpm typecheck         every package
pnpm build             every package
pnpm verify:ledger     walk the hash chain
pnpm mcp               the MCP server over stdio
```
