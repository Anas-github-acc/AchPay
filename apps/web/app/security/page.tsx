import type { SecurityAttack, SecurityReport } from '@storefront/shared';
import { apiGet, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { LAYERS, UNCATALOGUED } from './layers';
import { ContinuousTesting } from './continuous-testing';

export const dynamic = 'force-dynamic';

function AttackCard({ attack }: { attack: SecurityAttack }) {
  const entry = attack.catalog;
  return (
    <article className={`card attack${attack.held ? '' : ' attack--open'}`}>
      <header>
        <h3>{attack.name}</h3>
        <span className={`verdict verdict--${attack.held ? 'held' : 'open'}`}>
          {attack.held ? 'HELD' : 'OPEN'}
        </span>
      </header>

      <p className="attempts">{entry?.attempts ?? attack.attack}</p>

      <p className="stopped-by">
        <span className="stopped-label">{attack.held ? 'Stopped by' : 'Not yet closed'}</span>
        {entry?.defence ?? '—'}
      </p>

      <div className="attack-foot">
        {entry?.rule_id && <span className="chip mono">rule_id: {entry.rule_id}</span>}
        {entry && (
          <span className={`chip sev sev--${entry.severity}`}>
            {entry.severity} if it had worked
          </span>
        )}
        <span className="chip dim mono">#{attack.id}</span>
      </div>

      {attack.held && attack.evidence && <p className="evidence">{attack.evidence}</p>}
      {!attack.held && attack.error && <p className="evidence">{attack.error}</p>}
    </article>
  );
}

export default async function SecurityPage() {
  let report: SecurityReport | null = null;
  let error: string | null = null;
  try {
    report = await apiGet<SecurityReport>('/security/report');
  } catch (err) {
    error = err instanceof ApiError ? err.message : String(err);
  }

  if (report === null) {
    return (
      <main className="page">
        <div className="page-head">
          <h1>Attack log</h1>
        </div>
        <div className="error-banner">{error}</div>
        <p className="empty">
          Run <span className="mono">pnpm test:adversarial</span> to produce
          data/adversarial-results.json, then reload.
        </p>
      </main>
    );
  }

  const open = report.total - report.held;
  const groups = LAYERS.map((layer) => ({
    layer,
    attacks: report.attacks.filter((a) => a.catalog?.layer === layer.id),
  })).filter((group) => group.attacks.length > 0);

  const uncatalogued = report.attacks.filter((a) => a.catalog === null);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Attack log</h1>
          <p>
            Twenty attacks an agent, or someone using one, would actually try. Each is an automated
            test, grouped below by the layer of the system that stops it.
          </p>
        </div>
        <span className="chip">last run {formatDateTime(report.generated_at)}</span>
      </div>

      <section className="scoreboard" aria-label="Headline result">
        <div className="score">
          <div className="score-figure">{report.total}</div>
          <div className="score-label">attacks run</div>
        </div>
        <div className="score-rule" aria-hidden="true" />
        <div className="score score--held">
          <div className="score-figure">{report.held}</div>
          <div className="score-label">held</div>
        </div>
        {open > 0 && (
          <>
            <div className="score-rule" aria-hidden="true" />
            <div className="score score--open">
              <div className="score-figure">{open}</div>
              <div className="score-label">still open</div>
            </div>
          </>
        )}
        <div className="score-rule" aria-hidden="true" />
        <div className="score-note">
          <span>
            Ledger chain at the end of the run:{' '}
            <strong style={{ color: report.ledger_chain.ok ? 'var(--allow)' : 'var(--deny)' }}>
              {report.ledger_chain.ok
                ? `intact, ${report.ledger_chain.rows_checked} rows`
                : `broken at seq ${report.ledger_chain.broken_at_seq}`}
            </strong>
          </span>
          {open > 0 && (
            <span>
              The open one is on the page for the same reason the others are. A grid that only shows
              passes is a slide, not a result.
            </span>
          )}
        </div>
      </section>

      {groups.map(({ layer, attacks }) => (
        <section className="layer" key={layer.id} aria-labelledby={`layer-${layer.id}`}>
          <div className="layer-head">
            <h2 id={`layer-${layer.id}`}>{layer.title}</h2>
            <p className="layer-claim">{layer.claim}</p>
            <span className="layer-count">
              {attacks.filter((a) => a.held).length}/{attacks.length} held
            </span>
          </div>
          <div className="attack-grid">
            {attacks.map((attack) => (
              <AttackCard key={attack.id} attack={attack} />
            ))}
          </div>
        </section>
      ))}

      {uncatalogued.length > 0 && (
        <section className="layer" aria-labelledby="layer-uncatalogued">
          <div className="layer-head">
            <h2 id="layer-uncatalogued">{UNCATALOGUED.title}</h2>
            <p className="layer-claim">{UNCATALOGUED.claim}</p>
            <span className="layer-count">{uncatalogued.length} tests</span>
          </div>
          <div className="attack-grid">
            {uncatalogued.map((attack) => (
              <AttackCard key={attack.id} attack={attack} />
            ))}
          </div>
        </section>
      )}

      <ContinuousTesting />
    </main>
  );
}
