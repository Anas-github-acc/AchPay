/**
 * Static content. Nothing on this component reads live data, and it must not
 * look as though it does.
 *
 * A reader who takes this for a running red-team result and later discovers it
 * is a design will discount the twenty real results above it too. So: no green,
 * no counts, no timestamps, a dashed border, reduced contrast, and the word
 * "designed" in the heading itself.
 */

const INVARIANTS = [
  'Money is only ever an integer number of paise. No float touches a currency value anywhere in the system.',
  'A price can only come from the catalog. No endpoint and no tool accepts an amount — the only handle on money is a quote_id.',
  'The policy engine is a pure function of its arguments, and every decision it returns names a rule_id, including allow.',
  'The ledger is insert-only and hash-chained: no row is ever updated or deleted, and each row commits to the one before it.',
  'One intent charges at most once, enforced by a unique constraint inside the charge transaction rather than by a prior check.',
  'No sequence of allowed purchases can exceed a mandate’s headroom or any cap in policy.yaml.',
];

export function ContinuousTesting() {
  return (
    <section className="forward" aria-labelledby="continuous-testing">
      <h2 id="continuous-testing">
        Continuous testing
        <span className="not-running">designed · not running</span>
      </h2>

      <div className="forward-body">
        <div>
          <h3>The six invariants</h3>
          <ol>
            {INVARIANTS.map((invariant) => (
              <li key={invariant}>{invariant}</li>
            ))}
          </ol>
        </div>

        <div>
          <h3>Why an independent checker is the oracle</h3>
          <p>
            An adversarial agent scoring its own attempts is grading its own homework: it reports
            failure only when it noticed it failed, so anything it did not think to check comes back
            clean. An invariant checker reads the ledger and the mandate rows directly and asks a
            different question — not “did the attack work?” but “is any of these six statements
            false right now?” — which catches breakage the attacker never aimed at.
          </p>
        </div>
      </div>

      <p className="status-line">
        This section describes intended work. There is no red agent running against this system, and
        no invariant checker on a schedule. The twenty results above come from{' '}
        <span className="mono">pnpm test:adversarial</span>, run by hand.
      </p>
    </section>
  );
}
