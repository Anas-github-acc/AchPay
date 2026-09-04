# web

AchPay's site and audit dashboard. `pnpm dev:web` from the repo root, then
<http://localhost:3001>. The brand and the design system it is built on are in
[DESIGN.md](DESIGN.md).

Five pages:

- **/** — the landing page. "Buy me chai." The argument for why one short
  sentence is hard to make safe, the six defence layers in the order a purchase
  moves through them, and three figures read off the last adversarial run rather
  than written into the copy. If the API is unreachable that band disappears
  rather than showing a number nobody ran.
- **/security** — the attack log. The adversarial suite's last run joined to
  `data/attack-catalog.json`, grouped by the defence layer that stops each
  attack rather than by test number, so it reads as an argument about the
  architecture. This is the page designed to be screenshotted.
- **/ledger** — the ledger, polled every three seconds, colour-coded by
  decision, with a verify button that walks the hash chain and reports either
  green or the exact seq where it breaks.
- **/mandates** — active mandates and the headroom left on each.
- **/lab** — Agent Lab. Continuous testing: a red agent on a schedule and the
  six invariants an independent checker would read. Not built yet, and drawn so
  it cannot be mistaken for a live reading — dashed borders, no semantic colour,
  no counts, and "coming soon" beside the heading.

## What is not here

No business logic. Every number on every page is one the API already computed;
the only arithmetic in this app is the single division by 100 in `lib/format.ts`
that turns integer paise into a rupee string on the way to the screen. Types
come from `@storefront/shared`, always as `import type`.

Browser requests go to `/api/*`, which `next.config.mjs` rewrites onto
`API_BASE_URL`. That keeps every fetch same-origin, so the API needs no CORS
configuration and gains no browser-facing surface. Server components call the
API directly and skip the rewrite.

Design constraint: this is read off a projector from the back of a room as often
as off a laptop. Body type is 18px on small screens, colour is used only where it
carries meaning, and every colour that carries a word clears 4.5:1 against the
cream — see the note on `--accent-ink` in DESIGN.md for why the brand terracotta
and the terracotta that text is set in are two different values.
