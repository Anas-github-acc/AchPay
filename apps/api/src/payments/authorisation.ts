import { config } from '../config.js';

/**
 * Where a person goes to authorise a mandate.
 *
 * The page lives in apps/web, so this points at the dashboard's origin rather
 * than the API's. Built server-side from configuration for the same reason
 * approvalUrl is: a Host header is caller-supplied, and this link is handed to
 * an agent that must not be able to influence where a user is sent.
 *
 * The order ref is the capability. It is provider-generated and unguessable,
 * and it is the only thing the page needs — everything else it renders comes
 * from the payment row it names. Nothing here authorises anything by itself:
 * the actual authorisation happens in Razorpay's own flow, and this system
 * learns of it only from a signature-verified webhook.
 */
export function authorisationUrl(orderRef: string): string {
  return `${config.publicWebUrl}/authorise/${encodeURIComponent(orderRef)}`;
}
