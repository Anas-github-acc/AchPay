import { LedgerView } from './ledger-view';

export const dynamic = 'force-dynamic';

export default function LedgerPage() {
  return (
    <main className="page">
      <div className="page-head">
        <div>
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
