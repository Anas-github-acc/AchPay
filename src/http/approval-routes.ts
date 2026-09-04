import type { FastifyInstance } from 'fastify';
import { checkout } from '../checkout/checkout.js';
import type { CheckoutDeps } from '../checkout/checkout.js';
import type { CheckoutResult } from '../checkout/types.js';
import { withTransaction } from '../db/pool.js';
import { append } from '../ledger/ledger.js';
import { readByOrderRef, readByQuoteId } from '../ledger/ledger.js';
import { getPayment } from '../payments/repo.js';
import {
  approvalUrl,
  claimApproval,
  getApproval,
  recordApprovalOutcome,
} from '../approvals/repo.js';
import type { ApprovalStatusView, PendingApproval } from '../approvals/types.js';
import { approvalPage, notFoundPage, outcomePage, receiptPage } from '../approvals/views.js';
import { rupees } from '../approvals/page.js';

/**
 * The human half of the system: two screens, rendered on the server.
 *
 * The agent has no route in here that advances anything. It may read
 * GET /approvals/:token to learn that it is still blocked, and that is all —
 * every state change on this path is a form submission from a browser, and the
 * token that authorises one is minted by the gate, not by the caller.
 *
 * Registered as its own encapsulated plugin so the form-body parser below is
 * scoped to these routes. Every other route keeps Fastify's JSON-only parsing,
 * which is one fewer body shape the API has to think about.
 */
export async function approvalRoutes(app: FastifyInstance, deps: CheckoutDeps): Promise<void> {
  await app.register(async (scope) => {
    // Browsers post forms as urlencoded and Fastify parses only JSON by
    // default. Parsed with URLSearchParams rather than a dependency: two
    // fields, one of which is an enum.
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    scope.get('/approve/:token', async (request, reply) => {
      const { token } = request.params as { token: string };
      const approval = await getApproval(token);
      reply.type('text/html; charset=utf-8');
      // Nothing about an approval link should be cached or prefetched into a
      // state that no longer matches the row.
      reply.header('cache-control', 'no-store');

      if (!approval) return reply.code(404).send(notFoundPage('That approval link'));
      if (approval.status === 'pending') return reply.send(approvalPage(approval));
      return reply.code(410).send(settledPage(approval));
    });

    scope.post('/approve/:token', async (request, reply) => {
      const { token } = request.params as { token: string };
      const action = (request.body as { action?: string } | undefined)?.action;
      reply.type('text/html; charset=utf-8');
      reply.header('cache-control', 'no-store');

      if (action !== 'approve' && action !== 'reject') {
        return reply.code(400).send(
          outcomePage({
            tone: 'bad',
            heading: 'That was not a decision',
            detail: 'Use the Approve or Reject button on the approval page.',
          }),
        );
      }

      // One statement decides it. Claiming and recording the human's decision
      // are the same transaction, so a token cannot be spent without the
      // ledger saying who spent it and on what.
      const claim = await withTransaction(async (tx) => {
        const result = await claimApproval(token, action === 'approve' ? 'approved' : 'rejected', tx);
        if (!result.ok) return result;
        await append(
          {
            actor: 'user',
            event_type: 'decision',
            quote_id: result.approval.quote_id,
            decision: action === 'approve' ? 'allow' : 'deny',
            rule_id: action === 'approve' ? 'human_approved' : 'human_rejected',
            amount_paise: result.approval.amount_paise,
            payload: {
              mandate_id: result.approval.mandate_id,
              approval_token: result.approval.token,
              gated_by: result.approval.rule_id,
              gate_seq: result.approval.gate_seq,
              reason: result.approval.reason,
            },
          },
          tx,
        );
        return result;
      });

      if (!claim.ok) {
        if (claim.code === 'NOT_FOUND') {
          return reply.code(404).send(notFoundPage('That approval link'));
        }
        // Spent or expired. Both are 410: the link existed and is over.
        return reply.code(410).send(settledPage(claim.approval!));
      }

      if (action === 'reject') {
        return reply.send(
          outcomePage(
            { tone: 'ok', heading: 'Rejected — nothing was charged', detail: 'The agent has been told it may not proceed.' },
            claim.approval,
          ),
        );
      }

      // Approved. The purchase goes back through the ordinary checkout path —
      // same idempotency key, same mandate lock, same policy evaluation. The
      // grant is the third argument, which no HTTP body can reach.
      const result = await checkout(
        { quote: claim.approval.quote, mandate_id: claim.approval.mandate_id },
        deps,
        { approval: claim.approval },
      );

      if (result.status === 'charged') {
        await recordApprovalOutcome(claim.approval.token, { order_ref: result.order_ref });
        return reply.send(
          outcomePage(
            {
              tone: 'ok',
              heading: `Approved — ${rupees(result.amount_paise)} submitted`,
              detail: 'It settles when the payment provider confirms it.',
            },
            { ...claim.approval, order_ref: result.order_ref },
            [['Receipt', `/receipts/${result.order_ref}`]],
          ),
        );
      }

      // Anything else means the purchase did not happen. The token is spent
      // either way: a link that can be redeemed a second time after a failure
      // is the worse failure mode, so this fails closed and the purchase has
      // to be started again.
      const detail = describeFailure(result);
      await recordApprovalOutcome(claim.approval.token, { charge_error: detail });
      return reply.code(409).send(
        outcomePage(
          { tone: 'bad', heading: 'Not charged', detail },
          claim.approval,
        ),
      );
    });

    /**
     * The agent's only view of an approval, and the only thing it can do here.
     *
     * Two statuses, kept apart: `status` is where the human is, `payment_status`
     * is where the money is. There is no field in this response, and no
     * parameter to this route, that moves either one.
     */
    scope.get('/approvals/:token', async (request, reply) => {
      const { token } = request.params as { token: string };
      const approval = await getApproval(token);
      if (!approval) {
        return reply.code(404).send({ error: 'APPROVAL_NOT_FOUND', approval_token: token });
      }
      return statusView(approval);
    });

    /**
     * GET /receipts/:id — the ledger, rendered.
     *
     * Server-side from hash-chained rows, for the same reason as the approval
     * page: an agent can say anything in chat, and this is the screen that does
     * not have to be believed.
     */
    scope.get('/receipts/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      reply.type('text/html; charset=utf-8');
      const rows = await readByOrderRef(id);
      const charge = rows.find((row) => row.event_type === 'charge');
      if (!charge) return reply.code(404).send(notFoundPage(`Receipt ${id}`));
      const decisions = charge.quote_id ? await readByQuoteId(charge.quote_id) : [];
      const payment = await getPayment(id);
      return reply.send(receiptPage(id, rows, decisions, payment));
    });
  });
}

async function statusView(approval: PendingApproval): Promise<ApprovalStatusView> {
  const payment = approval.order_ref ? await getPayment(approval.order_ref) : undefined;
  return {
    approval_token: approval.token,
    approval_url: approvalUrl(approval.token),
    status: approval.status,
    quote_id: approval.quote_id,
    mandate_id: approval.mandate_id,
    amount_paise: approval.amount_paise,
    rule_id: approval.rule_id,
    reason: approval.reason,
    expires_at: approval.expires_at,
    decided_at: approval.decided_at,
    order_ref: approval.order_ref,
    payment_status: payment?.status ?? null,
    charge_error: approval.charge_error,
  };
}

/** The page a link that is no longer live shows, whatever ended it. */
function settledPage(approval: PendingApproval) {
  switch (approval.status) {
    case 'approved':
      return outcomePage(
        {
          tone: approval.charge_error ? 'bad' : 'ok',
          heading: approval.charge_error ? 'Approved, but not charged' : 'Already approved',
          detail:
            approval.charge_error ??
            'This link has been used. Nothing further will happen from it.',
        },
        approval,
        approval.order_ref ? [['Receipt', `/receipts/${approval.order_ref}`]] : [],
      );
    case 'rejected':
      return outcomePage(
        { tone: 'warn', heading: 'Already rejected', detail: 'Nothing was charged, and this link is spent.' },
        approval,
      );
    default:
      return outcomePage(
        {
          tone: 'warn',
          heading: 'This request expired',
          detail: `It was not approved in time and cannot be approved now. Ask the agent to try again.`,
        },
        approval,
      );
  }
}

function describeFailure(result: Exclude<CheckoutResult, { status: 'charged' }>): string {
  switch (result.status) {
    case 'denied':
      return `A spending rule refused it after approval (${result.rule_id}): ${result.reason}`;
    case 'charge_failed':
      return `The payment provider refused it: ${result.error}`;
    case 'quote_invalid':
      return result.error === 'QUOTE_STALE'
        ? 'Catalog prices changed while this was waiting, so the total you approved is no longer the total. Nothing was charged; ask the agent to quote again.'
        : `The quote could not be used: ${result.reason}`;
    case 'pending_approval':
      return 'Still gated after approval, which should not happen. Nothing was charged.';
    default:
      return 'Nothing was charged.';
  }
}
