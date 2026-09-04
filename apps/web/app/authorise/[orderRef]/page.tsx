import { AuthoriseView } from './authorise-view';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Authorise mandate — AchPay',
};

/**
 * The one screen a person has to visit before an agent can spend on their
 * behalf. It replaces the throwaway server autopay-test.ts used to stand up on
 * :8082 — that script still works for debugging the raw Razorpay flow, but no
 * production path depends on it any more.
 *
 * The page renders nothing it was told by an agent: the basket, the amount and
 * the ceiling all come from the API, which reads them from the payment row and
 * the hashed ledger entry that recorded the order.
 */
export default async function AuthorisePage({
  params,
}: {
  params: Promise<{ orderRef: string }>;
}) {
  const { orderRef } = await params;
  return <AuthoriseView orderRef={orderRef} />;
}
