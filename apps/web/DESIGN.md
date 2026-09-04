# AchPay — brand and design system

**AchPay** — Agentic Commerce Hub for secure AI payments.

The product gives an AI agent a wallet it cannot misuse. The brand should read
the way the system behaves: considered, unhurried, willing to show its working.
Warm editorial, not tech-startup sterile.

## Voice

Full sentences with periods, including in microcopy. Concrete over abstract:
"the only handle an agent has on money is a quote_id", not "enterprise-grade
security". Never claim more than the system does — the attack log shows the
open attack, and the Agent Lab page says in its own heading that it is not
running yet. Mood words: calm, earnest, tactile, deliberate, patient.

The landing headline is **Buy me chai.** — the smallest honest transaction the
system handles, and the shortest way to explain why it is hard.

## Mark

`app/brand-mark.tsx`. A coin-sized ring — the payment — crossed by a chain of
links, which is the hash chain the ledger is built on. Stroked, one colour,
inherits `currentColor` so the inverse footer needs no second asset. It is
legible at 22px, which is the only size it is used at.

## Colour

Cream page, ink type, one terracotta moment per viewport. Terracotta never
competes with itself, and body text is never tinted with the accent.

| Token | Value | Role |
| --- | --- | --- |
| `--bg-primary` | `#f4f3ee` | page |
| `--bg-secondary` | `#eeede6` | surface lift — cards, receipt, zebra rows |
| `--bg-inverse` | `#191817` | the evidence band |
| `--text-primary` | `#191817` | ink |
| `--text-secondary` | `#5a554e` | body copy in supporting positions |
| `--text-muted` | `#726c63` | labels, timestamps, evidence lines |
| `--border` | `#d8d3c8` | every rule on the page |
| `--accent` | `#c96442` | brand terracotta — rules, mark, focus ring |
| `--accent-ink` | `#a84f31` | accent as *text*, and the primary button fill |

Semantic colours split the same way: `--success` / `--warning` / `--danger`
tint borders and meters, and only the `-ink` variants carry words.

**Why the split.** The brand terracotta on cream is 3.5:1 — fine for a rule or
an icon, which need 3:1, and short of the 4.5:1 that text needs. Rather than
give up the colour, `--accent-ink` is the same hue darkened until both cream on
it and it on cream clear 4.5:1. `--success` and `--warning` needed the same
treatment; `--danger` already passed. `--text-muted` was darkened from `#8a847a`
(3.3:1) for the same reason — it labels things at 13px, which is body text.

Colour is never the only signal. Severity chips say "critical" in words and tint
only their border; prose links are underlined as well as coloured.

## Type

- **Display** — serif. `Tiempos Headline`, `Iowan Old Style`, `Source Serif 4`,
  Georgia. Weight 500, tracking −1.5% at large sizes. Headlines, figures,
  headroom amounts, pull-quotes.
- **Body** — humanist sans. `Styrene A`, Inter. Weight 400, line-height 1.6,
  measure 65–72 characters.
- **UI labels** — the same sans at 500, +2% tracking, uppercase for eyebrows.
- **Mono** — `GT America Mono`, `JetBrains Mono`. Anything the machine wrote:
  rule ids, quote ids, seqs, amounts in a table, table headers.

Scale: 13 / 15 / 17 / 21 / 26 / 32 / 40 / 50 / 62. Headlines balance, body
reflows. Two font families per page, never three.

## Surfaces

Flat. Depth comes from a surface shift, a 1px rule, or type weight — never a
shadow, and never a transform on hover. A card's hover state is a border
appearing, nothing more. Radius 6px for controls, 8px for cards.

Anything that describes intended rather than shipped work is drawn with a dashed
border and no semantic colour, so it cannot be mistaken for a live reading.

## Layout

680px for long-form, 1180px for the app shell, 8px baseline, 96px section
breaks. Long-form columns hang off the shell's left edge rather than centring on
the viewport, so every page shares one left margin. Asymmetry is fine — the
pull-quote and the receipt both hang out of the text column.

## Responsive

Single column below 900px. Nav shows all four links, scrolling horizontally
rather than collapsing into a hamburger. Body type goes *up* to 18px on mobile,
not down. The ledger table becomes stacked cards below 640px, each cell labelled
from its `data-label`.

## Reject

Purple or pink gradients, glassmorphism, neon glows, emoji in chrome, scale or
lift on hover, one duration for every transition, card-heavy layouts where every
element is a rounded box, and the generic hero + three-column-features + CTA
template.
