import type { MandateRecord } from '@storefront/shared';
import { apiGet, ApiError } from '../../lib/api';
import { formatPaise, formatDateTime, relativeTo } from '../../lib/format';

export const dynamic = 'force-dynamic';

interface MandateView extends MandateRecord {
  headroom_paise: number;
}

interface MandatesResponse {
  mandates: MandateView[];
  count: number;
}

/** Green while there is room, amber under a fifth left, red at nothing. */
function meterClass(headroom: number, ceiling: number): string {
  if (headroom <= 0) return 'meter meter--spent';
  if (ceiling > 0 && headroom * 5 <= ceiling) return 'meter meter--low';
  return 'meter';
}

export default async function MandatesPage() {
  let data: MandatesResponse | null = null;
  let error: string | null = null;
  try {
    data = await apiGet<MandatesResponse>('/mandates?limit=50');
  } catch (err) {
    error = err instanceof ApiError ? err.message : String(err);
  }

  const mandates = data?.mandates ?? [];
  const active = mandates.filter((m) => m.status === 'active');

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Mandates</h1>
          <p>
            What each agent is permitted to spend, and how much of it is left. Headroom is the
            ceiling minus what has already been charged; the policy engine refuses anything larger
            before the payment rail is called.
          </p>
        </div>
        <span className="chip">
          {active.length} active · {mandates.length} total
        </span>
      </div>

      {error !== null && <div className="error-banner">{error}</div>}

      {mandates.length === 0 && error === null ? (
        <p className="empty">No mandates yet.</p>
      ) : (
        <div className="mandate-grid">
          {mandates.map((mandate) => {
            const headroom = Math.max(0, mandate.headroom_paise);
            const pct =
              mandate.max_amount_paise > 0
                ? Math.round((headroom / mandate.max_amount_paise) * 100)
                : 0;
            return (
              <article key={mandate.id} className="card mandate-card">
                <header>
                  <div>
                    <div className="user-ref">{mandate.user_ref}</div>
                    <div className="mono dim">{mandate.id}</div>
                  </div>
                  <span className={`chip status--${mandate.status}`}>{mandate.status}</span>
                </header>

                <div className="headroom-figure">{formatPaise(headroom)}</div>
                <div className="headroom-of">
                  headroom of {formatPaise(mandate.max_amount_paise)} · {formatPaise(mandate.used_paise)}{' '}
                  spent
                </div>

                <div
                  className={meterClass(headroom, mandate.max_amount_paise)}
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  aria-label={`${pct}% of the mandate remains`}
                >
                  <span style={{ width: `${pct}%` }} />
                </div>

                <div className="mandate-meta">
                  <span>
                    Expires {relativeTo(mandate.expires_at)}{' '}
                    <span className="dim">({formatDateTime(mandate.expires_at)})</span>
                  </span>
                  <span className="dim">
                    {mandate.provider_token ? 'token registered' : 'no provider token'}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
