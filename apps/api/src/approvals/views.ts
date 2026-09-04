import type { LedgerRow } from '../ledger/types.js';
import type { PaymentRecord } from '../payments/repo.js';
import {
  definitions,
  esc,
  LEDGER_FOOTER,
  layout,
  lineTable,
  relativeMinutes,
  rupees,
  type LineView,
} from './page.js';
import type { PendingApproval } from './types.js';

/** Human-readable text for each rule the engine can gate on. */
const RULE_TEXT: Record<string, string> = {
  gate_threshold: 'This is larger than the amount the agent may spend on its own.',
  category_median_multiple:
    'An item here costs far more than others in its category, so it needs a look.',
};

function linesOf(approval: PendingApproval): LineView[] {
  return approval.quote.lines.map((line) => ({
    sku: line.sku,
    title: line.title,
    qty: line.qty,
    unit_price_paise: line.unit_price_paise,
    line_total_paise: line.line_total_paise,
  }));
}

/**
 * The decision screen.
 *
 * Everything here comes off the stored row: the lines and total from the quote
 * this storefront signed against catalog prices, the rule and reason from the
 * policy engine. The agent's account of what it is buying appears nowhere.
 */
export function approvalPage(approval: PendingApproval, now = new Date()): string {
  const body = `
<h1>Approve this purchase?</h1>
<p class="sub">An agent is asking to spend from your mandate. Nothing has been charged.</p>

<div class="card">
  <h2>What it wants to buy</h2>
  ${lineTable(linesOf(approval), approval.quote.total_paise)}
</div>

<div class="rule">
  <strong>Why you are being asked</strong>
  <p style="margin:8px 0 0">${esc(RULE_TEXT[approval.rule_id] ?? 'A spending rule stopped this for review.')}</p>
  <p style="margin:8px 0 0">Rule <code>${esc(approval.rule_id)}</code> — ${esc(approval.reason)}</p>
</div>

<div class="card">
  <form method="POST" action="/approve/${esc(approval.token)}">
    <button class="approve" type="submit" name="action" value="approve">Approve ${esc(rupees(approval.amount_paise))}</button>
    <button class="reject" type="submit" name="action" value="reject">Reject</button>
  </form>
  <p class="sub" style="margin:14px 0 0">
    This link works once and expires ${esc(relativeMinutes(approval.expires_at, now))}.
  </p>
</div>

<div class="card">
  <h2>Details</h2>
  ${definitions([
    ['Mandate', approval.mandate_id],
    ['Quote', approval.quote_id],
    ['Requested', approval.created_at],
    ['Expires', approval.expires_at],
  ])}
</div>

<footer>${LEDGER_FOOTER}</footer>`;
  return layout('Approve this purchase?', body);
}

export interface OutcomeBanner {
  tone: 'ok' | 'bad' | 'warn';
  heading: string;
  detail?: string;
  /**
   * A next step the person has to take, rendered as a button.
   *
   * Only ever a URL this server built — never one that arrived in a request —
   * for the same reason the approval link itself is built from configuration.
   */
  action?: { label: string; href: string };
}

/**
 * What the approver sees after deciding, and what a spent, expired or unknown
 * link shows. Same page for every terminal state, so there is one place where
 * the outcome of a token is described.
 */
export function outcomePage(
  banner: OutcomeBanner,
  approval?: PendingApproval,
  extra: [string, string][] = [],
): string {
  const detail = banner.detail ? `<div class="detail">${esc(banner.detail)}</div>` : '';
  const action = banner.action
    ? `<div class="card"><a class="action" href="${esc(banner.action.href)}">${esc(
        banner.action.label,
      )}</a></div>`
    : '';
  const basket = approval
    ? `<div class="card">
  <h2>The purchase</h2>
  ${lineTable(linesOf(approval), approval.quote.total_paise)}
</div>`
    : '';
  const details = approval
    ? `<div class="card">
  <h2>Details</h2>
  ${definitions([
    ['Status', approval.status],
    ['Mandate', approval.mandate_id],
    ['Quote', approval.quote_id],
    ...(approval.decided_at ? ([['Decided', approval.decided_at]] as [string, string][]) : []),
    ...(approval.order_ref ? ([['Order', approval.order_ref]] as [string, string][]) : []),
    ...extra,
  ])}
</div>`
    : extra.length > 0
      ? `<div class="card"><h2>Details</h2>${definitions(extra)}</div>`
      : '';

  return layout(
    banner.heading,
    `<div class="banner ${esc(banner.tone)}">${esc(banner.heading)}${detail}</div>
${action}
${basket}
${details}
<footer>${LEDGER_FOOTER}</footer>`,
  );
}

const STATUS_BANNER: Record<string, OutcomeBanner['tone']> = {
  captured: 'ok',
  created: 'warn',
  failed: 'bad',
};

const STATUS_TEXT: Record<string, string> = {
  captured: 'Paid',
  created: 'Submitted, not yet settled',
  failed: 'Payment failed',
};

/**
 * GET /receipts/:id.
 *
 * Rendered from ledger rows and nothing else. The charge row carries the
 * basket it paid for and each webhook row carries what the rail later said, so
 * this page is a reading of the hash-chained record rather than a summary
 * somebody wrote about it. Where a payments row exists it is shown beside the
 * ledger's own view, not in place of it.
 */
export function receiptPage(
  orderRef: string,
  rows: LedgerRow[],
  decisions: LedgerRow[],
  payment: PaymentRecord | undefined,
): string {
  const charge = rows.find((row) => row.event_type === 'charge');
  const webhooks = rows.filter((row) => row.event_type === 'webhook');
  const payload = (charge?.payload ?? {}) as {
    lines?: LineView[];
    mandate_id?: string;
    adapter?: string;
    status?: string;
    approval_token?: string;
  };

  // The ledger's own last word on this payment: the latest webhook that was
  // actually applied, falling back to what the charge row recorded.
  const applied = [...webhooks]
    .reverse()
    .find((row) => (row.payload as { applied?: boolean })?.applied)?.payload as
    | { status?: string }
    | undefined;
  const status = applied?.status ?? payload.status ?? 'created';

  const lines = payload.lines ?? [];
  const total = charge?.amount_paise ?? 0;

  const timeline = [...rows]
    .map((row) => {
      const p = (row.payload ?? {}) as { event?: string; status?: string; applied?: boolean };
      const what =
        row.event_type === 'charge'
          ? `Charge submitted (${esc(p.status ?? 'created')})`
          : `${esc(p.event ?? 'webhook')}${p.applied ? '' : ' — recorded, not applied'}`;
      return `<tr><td>${what}<br><span class="qty">seq ${esc(row.seq)} &middot; ${esc(row.ts)}</span></td></tr>`;
    })
    .join('\n');

  const gate = decisions.find((row) => row.decision === 'gate');
  const approved = decisions.find((row) => row.rule_id === 'human_approved');

  const body = `
<h1>Receipt</h1>
<p class="sub">${esc(orderRef)}</p>

<div class="banner ${esc(STATUS_BANNER[status] ?? 'warn')}">
  ${esc(STATUS_TEXT[status] ?? status)}
  <div class="detail">${esc(rupees(total))}${
    status === 'created'
      ? ' — the rail has the request; only a webhook can say the money moved.'
      : ''
  }</div>
</div>

${
  lines.length > 0
    ? `<div class="card"><h2>What was bought</h2>${lineTable(lines, total)}</div>`
    : ''
}

<div class="card">
  <h2>What happened</h2>
  <table><tbody>
${timeline}
  </tbody></table>
</div>

${
  gate
    ? `<div class="card"><h2>Approval</h2>
  <p>Held by rule <code>${esc(gate.rule_id ?? '')}</code> at seq ${esc(gate.seq)}.</p>
  <p>${approved ? `Approved by a human at ${esc(approved.ts)} (seq ${esc(approved.seq)}).` : 'Not approved.'}</p>
</div>`
    : ''
}

<div class="card">
  <h2>Provenance</h2>
  ${definitions([
    ['Quote', charge?.quote_id ?? '—'],
    ['Mandate', payload.mandate_id ?? '—'],
    ['Rail', payload.adapter ?? '—'],
    ['Ledger seq', String(charge?.seq ?? '—')],
    ['Row hash', charge?.hash ?? '—'],
    ...(payment
      ? ([
          ['Projection status', payment.status],
          ['Payment ref', payment.payment_ref ?? '—'],
        ] as [string, string][])
      : []),
  ])}
</div>

<footer>${LEDGER_FOOTER}</footer>`;
  return layout(`Receipt ${orderRef}`, body);
}

export function notFoundPage(what: string): string {
  return outcomePage({
    tone: 'bad',
    heading: 'Nothing here',
    detail: `${what} does not exist, or never did.`,
  });
}
