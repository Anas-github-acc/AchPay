import { LedgerView } from './ledger-view';
import { requireWebAuth } from '../../lib/auth';

export const dynamic = 'force-dynamic';

export default async function LedgerPage() {
  await requireWebAuth('/ledger');
  return (
    <main className="page" id="main">
      <div className="page-head">
        <div>
          <p className="eyebrow">The record</p>
          <h1>Audit ledger</h1>
          <p>
            Every decision and every charge, in the order they happened. Each row commits to the hash
            of the row before it, so the chain itself is the evidence that none of them changed
            afterwards.
          </p>
        </div>
      </div>
      <LedgerView />
    </main>
  );
}
