/**
 * Server-rendered HTML for the two screens a human actually looks at.
 *
 * Three rules hold everywhere in this file:
 *
 * 1. Everything on screen is derived server-side — from the signed quote, the
 *    policy engine's own rule_id, the catalog, and the ledger. Nothing an agent
 *    typed is rendered. The agent's `intent_text` is recorded in the ledger and
 *    deliberately not shown here: an agent that lies in chat must not get to
 *    put its version of events on the screen where the money is approved.
 *
 * 2. Every interpolated value goes through `esc`. There is no raw-HTML escape
 *    hatch, so a catalog title cannot become markup.
 *
 * 3. No external requests. The CSS is inline and there are no scripts, images
 *    or fonts, because this page has to load on conference wifi from a phone
 *    that has never seen it before.
 *
 * Money is formatted by integer division. No float touches a paise amount.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Integer paise to a rupee string. Never a float, never a rounding surprise. */
export function rupees(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.trunc(abs / 100);
  const rest = abs % 100;
  const grouped = groupIndian(whole);
  return `${negative ? '-' : ''}₹${grouped}.${String(rest).padStart(2, '0')}`;
}

/** 1,23,456 rather than 123,456 — the reader is standing in India. */
function groupIndian(n: number): string {
  const s = String(n);
  if (s.length <= 3) return s;
  const head = s.slice(0, -3);
  const tail = s.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
}

export function relativeMinutes(iso: string, from: Date = new Date()): string {
  const ms = Date.parse(iso) - from.getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  const mins = Math.round(Math.abs(ms) / 60_000);
  const unit = mins === 1 ? 'minute' : 'minutes';
  return ms >= 0 ? `in ${mins} ${unit}` : `${mins} ${unit} ago`;
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 20px 16px 48px;
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #f6f6f4; color: #16161a;
  -webkit-text-size-adjust: 100%;
}
main { max-width: 34rem; margin: 0 auto; }
.card {
  background: #fff; border: 1px solid #e2e2dd; border-radius: 14px;
  padding: 20px 18px; margin-bottom: 16px;
}
h1 { font-size: 1.35rem; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em;
     color: #6b6b70; margin: 0 0 10px; font-weight: 600; }
p { margin: 0 0 10px; }
.sub { color: #6b6b70; font-size: 0.9rem; margin: 0 0 18px; }
table { width: 100%; border-collapse: collapse; }
td, th { text-align: left; padding: 9px 0; vertical-align: top;
         border-bottom: 1px solid #eeeeea; font-size: 0.95rem; }
th { font-weight: 600; }
td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: none; }
.qty { color: #6b6b70; font-size: 0.85rem; }
.total { display: flex; justify-content: space-between; align-items: baseline;
         margin-top: 14px; padding-top: 14px; border-top: 2px solid #16161a; }
.total .amount { font-size: 1.7rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.rule { background: #fff8e6; border: 1px solid #f0dfae; border-radius: 10px;
        padding: 14px; margin-bottom: 16px; }
.rule code { background: #f3e8c6; padding: 1px 6px; border-radius: 5px;
             font-size: 0.85rem; }
form { display: flex; gap: 10px; margin: 0; }
button {
  flex: 1; padding: 16px 12px; font-size: 1.05rem; font-weight: 600;
  border-radius: 11px; border: 1px solid transparent; cursor: pointer;
  font-family: inherit; -webkit-appearance: none;
}
button.approve { background: #106b3f; color: #fff; }
button.reject { background: #fff; color: #a11a1a; border-color: #e4bcbc; }
a.action {
  display: block; text-align: center; text-decoration: none;
  padding: 16px 12px; font-size: 1.05rem; font-weight: 600;
  border-radius: 11px; background: #106b3f; color: #fff;
}
.banner { border-radius: 12px; padding: 16px 18px; margin-bottom: 16px;
          border: 1px solid; font-weight: 550; }
.banner.ok { background: #e9f6ee; border-color: #b6ddc5; color: #0d5c36; }
.banner.bad { background: #fdeeee; border-color: #edc4c4; color: #8f1d1d; }
.banner.warn { background: #fff8e6; border-color: #f0dfae; color: #7a5a10; }
.banner .detail { font-weight: 400; font-size: 0.92rem; margin-top: 6px; }
dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 7px 14px; }
dt { color: #6b6b70; font-size: 0.9rem; }
dd { margin: 0; font-size: 0.9rem; word-break: break-all; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
footer { color: #85858a; font-size: 0.78rem; text-align: center; margin-top: 22px;
         line-height: 1.6; }
@media (prefers-color-scheme: dark) {
  body { background: #131316; color: #ececef; }
  .card { background: #1c1c20; border-color: #2e2e34; }
  td, th { border-color: #2a2a30; }
  .total { border-top-color: #ececef; }
  h2, .sub, .qty, dt, footer { color: #9a9aa2; }
  .rule { background: #2a2413; border-color: #4d431f; }
  .rule code { background: #3b3319; }
  .banner.ok { background: #12291d; border-color: #2c5740; color: #8fd7ae; }
  .banner.bad { background: #2b1717; border-color: #5a2c2c; color: #eda4a4; }
  .banner.warn { background: #2a2413; border-color: #4d431f; color: #e3c98a; }
  button.reject { background: #1c1c20; color: #eda4a4; border-color: #5a2c2c; }
}
`;

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body><main>
${body}
</main></body></html>`;
}

export interface LineView {
  sku: string;
  title: string;
  qty: number;
  unit_price_paise: number;
  line_total_paise: number;
}

/** The basket, priced. Identical markup on the approval page and the receipt. */
export function lineTable(lines: LineView[], totalPaise: number): string {
  const rows = lines
    .map(
      (line) => `<tr>
  <td>${esc(line.title)}<br><span class="qty">${esc(line.sku)} &middot; ${esc(line.qty)} × ${esc(rupees(line.unit_price_paise))}</span></td>
  <td class="num">${esc(rupees(line.line_total_paise))}</td>
</tr>`,
    )
    .join('\n');
  return `<table><tbody>
${rows}
</tbody></table>
<div class="total"><span>Total</span><span class="amount">${esc(rupees(totalPaise))}</span></div>`;
}

export function definitions(pairs: [string, string][]): string {
  return `<dl>${pairs
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`)
    .join('')}</dl>`;
}

export const LEDGER_FOOTER =
  'Rendered from the audit ledger and the signed quote.<br>The agent narrates; this page is the record.';
