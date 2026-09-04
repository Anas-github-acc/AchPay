/**
 * Agent Lab — continuous testing.
 *
 * Nothing on this page reads live data, and it must not look as though it does.
 * A reader who takes this for a running red-team result and later discovers it
 * is a design will discount the twenty real results on the attack log too. So:
 * no green, no counts, no timestamps, dashed borders, and the words "coming
 * soon" in the heading itself.
 */

const INVARIANTS = [
  'Money is only ever an integer number of paise. No float touches a currency value anywhere in the system.',
  'A price can only come from the catalog. No endpoint and no tool accepts an amount — the only handle on money is a quote_id.',
  'The policy engine is a pure function of its arguments, and every decision it returns names a rule_id, including allow.',
  'The ledger is insert-only and hash-chained: no row is ever updated or deleted, and each row commits to the one before it.',
  'One intent charges at most once, enforced by a unique constraint inside the charge transaction rather than by a prior check.',
  'No sequence of allowed purchases can exceed a mandate’s headroom or any cap in policy.yaml.',
];

const LOOP = [
  'A red agent is given a budget and an objective, and no knowledge of the defences.',
  'It runs against a scratch copy of the system, on a schedule rather than by hand.',
  'An independent checker reads the ledger and mandate rows after every attempt.',
  'Any invariant that reads false opens a case, with the seq it first read false at.',
];

export const metadata = {
  title: 'Agent Lab — AchPay',
  description: 'Continuous adversarial testing and the six invariants an independent checker will read.',
};

export default function LabPage() {
  return (
    <main className="page" id="main">
      <div className="page-head">
        <div>
          <p className="eyebrow">Agent Lab</p>
          <h1>Continuous testing</h1>
          <p>
            The attack log is a suite someone runs. This is the part that runs itself: a red agent on
            a schedule, and an independent checker that reads the database rather than the attacker’s
            own account of what happened.
          </p>
        </div>
        <span className="soon">Coming soon</span>
      </div>

      <div className="lab-hero">
        <div>
          <h2 style={{ fontSize: 'var(--text-26)', marginBottom: 'var(--space-3)' }}>
            Why an independent checker is the oracle
          </h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '62ch' }}>
            An adversarial agent scoring its own attempts is grading its own homework: it reports
            failure only when it noticed it failed, so anything it did not think to check comes back
            clean. An invariant checker reads the ledger and the mandate rows directly and asks a
            different question — not “did the attack work?” but “is any of these six statements false
            right now?” — which catches breakage the attacker never aimed at.
          </p>
        </div>

        <div className="lab-panel">
          <h3>The intended loop</h3>
          <ol className="lab-steps">
            {LOOP.map((step, i) => (
              <li key={step}>
                <span>{String(i + 1).padStart(2, '0')}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <section aria-labelledby="invariants">
        <div className="layer-head">
          <h2 id="invariants">The six invariants</h2>
          <span className="layer-count">read after every attempt</span>
          <p className="layer-claim">
            Each is a statement about the whole system rather than about one request, which is what
            makes it worth checking on a schedule.
          </p>
        </div>
        <ol className="invariants">
          {INVARIANTS.map((invariant) => (
            <li key={invariant}>{invariant}</li>
          ))}
        </ol>
      </section>

      <p className="status-line">
        This page describes intended work. There is no red agent running against this system, and no
        invariant checker on a schedule. The results on the attack log come from{' '}
        <span className="mono">pnpm test:adversarial</span>, run by hand.
      </p>
    </main>
  );
}
