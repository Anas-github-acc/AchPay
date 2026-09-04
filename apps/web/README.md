# web

The audit dashboard. `pnpm dev:web` from the repo root, then
<http://localhost:3001>.

Three pages:

- **/security** — the attack log. The adversarial suite's last run joined to
  `data/attack-catalog.json`, grouped by the defence layer that stops each
  attack rather than by test number, so it reads as an argument about the
  architecture. This is the page designed to be screenshotted.
- **/ledger** — the ledger, polled every three seconds, colour-coded by
  decision, with a verify button that walks the hash chain and reports either
  green or the exact seq where it breaks.
- **/mandates** — active mandates and the headroom left on each.

## What is not here

No business logic. Every number on every page is one the API already computed;
the only arithmetic in this app is the single division by 100 in `lib/format.ts`
that turns integer paise into a rupee string on the way to the screen. Types
come from `@storefront/shared`, always as `import type`.

Browser requests go to `/api/*`, which `next.config.mjs` rewrites onto
`API_BASE_URL`. That keeps every fetch same-origin, so the API needs no CORS
configuration and gains no browser-facing surface. Server components call the
API directly and skip the rewrite.

Design constraint: this is read off a projector from the back of a room. Base
type is 18px, colour is used only where it carries meaning, and the decision
palette uses the lighter tints because a beamer loses contrast a monitor keeps.
