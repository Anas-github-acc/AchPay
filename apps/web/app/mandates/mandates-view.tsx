'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { MandateRecord } from '@storefront/shared';
import { apiGet, apiPost, ApiError } from '../../lib/api';
import { formatPaise, formatDateTime, relativeTo } from '../../lib/format';
import { readCached, writeCached } from '../../lib/cache';

export interface MandateView extends MandateRecord {
  headroom_paise: number;
}

export interface MandatesResponse {
  mandates: MandateView[];
  count: number;
}

interface MandatesViewProps {
  initialMandates: MandateView[];
  initialError: string | null;
}

/** Green while there is room, amber under a fifth left, red at nothing. */
function meterClass(headroom: number, ceiling: number): string {
  if (headroom <= 0) return 'meter meter--spent';
  if (ceiling > 0 && headroom * 5 <= ceiling) return 'meter meter--low';
  return 'meter';
}

export function MandatesView({ initialMandates, initialError }: MandatesViewProps) {
  const [mandates, setMandates] = useState<MandateView[]>(initialMandates);
  const [error, setError] = useState<string | null>(initialError);
  const [banner, setBanner] = useState<string | null>(null);

  // Active top panel: 'none' | 'create' | 'revoke'
  const [activePanel, setActivePanel] = useState<'none' | 'create' | 'revoke'>('none');

  // Create form state
  const [userRef, setUserRef] = useState('');
  const [amountRupees, setAmountRupees] = useState('500');
  const [ttlHours, setTtlHours] = useState(24);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Revoke toolbar panel state
  const [selectedRevokeId, setSelectedRevokeId] = useState('');
  const [revokingPanel, setRevokingPanel] = useState(false);
  const [revokePanelError, setRevokePanelError] = useState<string | null>(null);

  // Card-level revoke state
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revokingCardId, setRevokingCardId] = useState<string | null>(null);

  // Refreshing state
  const [refreshing, setRefreshing] = useState(false);

  const activeMandates = mandates.filter((m) => m.status === 'active');

  const calculatedPaise = Math.round(Number(amountRupees || 0) * 100);

  async function refreshList() {
    setRefreshing(true);
    try {
      const data = await apiGet<MandatesResponse>('/mandates?limit=50');
      setMandates(data.mandates ?? []);
      writeCached('mandates', data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const cached = readCached<MandatesResponse>('mandates');
    if (cached) setMandates(cached.mandates ?? []);
    void refreshList();
  }, []);

  async function handleCreateMandate(e: FormEvent) {
    e.preventDefault();
    const trimmedRef = userRef.trim();
    if (!trimmedRef) {
      setCreateError('Agent or user reference is required');
      return;
    }

    const paise = Math.round(Number(amountRupees) * 100);
    if (!Number.isSafeInteger(paise) || paise <= 0) {
      setCreateError('Spending ceiling must be a positive integer amount in paise');
      return;
    }

    setCreating(true);
    setCreateError(null);

    try {
      const created = await apiPost<MandateRecord>('/mandates', {
        user_ref: trimmedRef,
        max_amount_paise: paise,
        ttl_hours: Number(ttlHours),
      });

      const newView: MandateView = {
        ...created,
        headroom_paise: created.max_amount_paise - created.used_paise,
      };

      setMandates((prev) => [newView, ...prev]);
      writeCached('mandates', { mandates: [newView, ...mandates], count: mandates.length + 1 });
      setUserRef('');
      setAmountRupees('500');
      setTtlHours(24);
      setActivePanel('none');
      setBanner(`Mandate ${created.id} created for ${created.user_ref} with ${formatPaise(created.max_amount_paise)} ceiling.`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function executeRevoke(idToRevoke: string, fromPanel = false) {
    if (fromPanel) {
      setRevokingPanel(true);
      setRevokePanelError(null);
    } else {
      setRevokingCardId(idToRevoke);
    }

    try {
      const updated = await apiPost<MandateRecord>(`/mandates/${encodeURIComponent(idToRevoke)}/revoke`);
      setMandates((prev) =>
        prev.map((m) =>
          m.id === idToRevoke
            ? { ...m, status: updated.status }
            : m,
        ),
      );
      writeCached('mandates', { mandates: mandates.map((m) => m.id === idToRevoke ? { ...m, status: updated.status } : m), count: mandates.length });
      setBanner(`Mandate ${idToRevoke} revoked successfully.`);
      if (fromPanel) {
        setSelectedRevokeId('');
        setActivePanel('none');
      } else {
        setConfirmRevokeId(null);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      if (fromPanel) {
        setRevokePanelError(msg);
      } else {
        setError(msg);
      }
    } finally {
      if (fromPanel) {
        setRevokingPanel(false);
      } else {
        setRevokingCardId(null);
      }
    }
  }

  return (
    <main className="page" id="main">
      <div className="page-head">
        <div>
          <p className="eyebrow">Permissions</p>
          <h1>Mandates</h1>
          <p>
            What each agent is permitted to spend, and how much of it is left. Headroom is the
            ceiling minus what has already been charged; the policy engine refuses anything larger
            before the payment rail is called.
          </p>
        </div>
        <span className="chip">
          {activeMandates.length} active · {mandates.length} total
        </span>
      </div>

      {/* Mandate Action Toolbar */}
      <div className="mandates-tools">
        <button
          type="button"
          className="button button--compact"
          onClick={() => {
            setActivePanel((curr) => (curr === 'create' ? 'none' : 'create'));
            setCreateError(null);
          }}
        >
          {activePanel === 'create' ? 'Close form' : '+ Create mandate'}
        </button>

        <button
          type="button"
          className="button button--compact button--secondary"
          onClick={() => {
            setActivePanel((curr) => (curr === 'revoke' ? 'none' : 'revoke'));
            setRevokePanelError(null);
          }}
        >
          {activePanel === 'revoke' ? 'Close revoke' : 'Revoke mandate'}
        </button>

        <button
          type="button"
          className="button button--compact button--secondary"
          onClick={() => void refreshList()}
          disabled={refreshing}
          title="Refresh mandates list"
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>

        <span className="chip mandates-stats dim">
          {activeMandates.length} active permissions
        </span>
      </div>

      {banner !== null && (
        <div className="mandates-banner">
          <span>{banner}</span>
          <button
            type="button"
            className="mandates-banner-close"
            onClick={() => setBanner(null)}
            aria-label="Dismiss banner"
          >
            ✕
          </button>
        </div>
      )}

      {error !== null && <div className="error-banner">{error}</div>}

      {/* Panel 1: Create Mandate */}
      {activePanel === 'create' && (
        <form onSubmit={(e) => void handleCreateMandate(e)} className="mandate-panel">
          <div className="panel-head">
            <div>
              <h2>Create new mandate</h2>
              <p className="dim">Grant an agent an authorized spending ceiling and validity period.</p>
            </div>
            <button
              type="button"
              className="button button--compact button--secondary"
              onClick={() => setActivePanel('none')}
            >
              Cancel
            </button>
          </div>

          {createError !== null && <div className="error-banner">{createError}</div>}

          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="mandate-user-ref">Agent / User Reference</label>
              <input
                id="mandate-user-ref"
                type="text"
                value={userRef}
                onChange={(e) => setUserRef(e.target.value)}
                placeholder="e.g. agent_alice or usr_procure_bot"
                required
                className="form-input mono"
              />
              <span className="form-hint">Unique identifier for the buyer or autonomous agent.</span>
            </div>

            <div className="form-field">
              <label htmlFor="mandate-amount">Spending Ceiling (₹)</label>
              <div className="input-with-affix">
                <span className="input-affix">₹</span>
                <input
                  id="mandate-amount"
                  type="number"
                  step="1"
                  min="1"
                  value={amountRupees}
                  onChange={(e) => setAmountRupees(e.target.value)}
                  placeholder="500"
                  required
                  className="form-input form-input--affixed mono"
                />
              </div>
              <span className="form-hint">
                {calculatedPaise > 0 ? `${calculatedPaise.toLocaleString('en-IN')} paise` : '0 paise'}
              </span>
            </div>

            <div className="form-field">
              <label htmlFor="mandate-ttl">Validity Period</label>
              <select
                id="mandate-ttl"
                value={ttlHours}
                onChange={(e) => setTtlHours(Number(e.target.value))}
                className="form-select"
              >
                <option value={24}>24 hours (1 day)</option>
                <option value={72}>3 days</option>
                <option value={168}>7 days (1 week)</option>
                <option value={720}>30 days (1 month)</option>
                <option value={2160}>90 days</option>
              </select>
              <span className="form-hint">Mandate expires automatically after this window.</span>
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="button" disabled={creating}>
              {creating ? 'Creating mandate…' : 'Create mandate'}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setActivePanel('none')}
              disabled={creating}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Panel 2: Revoke Mandate (Toolbar action) */}
      {activePanel === 'revoke' && (
        <div className="mandate-panel">
          <div className="panel-head">
            <div>
              <h2>Revoke mandate</h2>
              <p className="dim">
                Immediately terminates an active mandate. The agent will no longer be permitted to charge.
              </p>
            </div>
            <button
              type="button"
              className="button button--compact button--secondary"
              onClick={() => setActivePanel('none')}
            >
              Cancel
            </button>
          </div>

          {revokePanelError !== null && <div className="error-banner">{revokePanelError}</div>}

          <div className="form-grid">
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="select-mandate-revoke">Select active mandate or enter mandate ID</label>
              {activeMandates.length > 0 ? (
                <select
                  id="select-mandate-revoke"
                  value={selectedRevokeId}
                  onChange={(e) => setSelectedRevokeId(e.target.value)}
                  className="form-select mono"
                >
                  <option value="">-- Choose active mandate --</option>
                  {activeMandates.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} · {m.user_ref} (headroom {formatPaise(Math.max(0, m.headroom_paise))})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="select-mandate-revoke"
                  type="text"
                  value={selectedRevokeId}
                  onChange={(e) => setSelectedRevokeId(e.target.value.trim())}
                  placeholder="e.g. mnd_..."
                  className="form-input mono"
                />
              )}
              <span className="form-hint">
                {activeMandates.length > 0
                  ? 'Pick an active mandate from the list above, or revoke directly from its card below.'
                  : 'No active mandates currently loaded. Enter a mandate ID to revoke.'}
              </span>
            </div>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="button button--danger"
              disabled={!selectedRevokeId || revokingPanel}
              onClick={() => void executeRevoke(selectedRevokeId, true)}
            >
              {revokingPanel ? 'Revoking…' : 'Revoke mandate'}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setActivePanel('none')}
              disabled={revokingPanel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Mandates List / Grid */}
      {mandates.length === 0 && error === null ? (
        <div className="empty-mandates-box">
          <p className="empty">No mandates yet.</p>
          <button
            type="button"
            className="button"
            onClick={() => setActivePanel('create')}
          >
            Create your first mandate
          </button>
        </div>
      ) : (
        <div className="mandate-grid">
          {mandates.map((mandate) => {
            const headroom = Math.max(0, mandate.headroom_paise);
            const pct =
              mandate.max_amount_paise > 0
                ? Math.round((headroom / mandate.max_amount_paise) * 100)
                : 0;
            const isConfirmingRevoke = confirmRevokeId === mandate.id;
            const isRevokingThis = revokingCardId === mandate.id;

            return (
              <article key={mandate.id} className="card mandate-card">
                <header>
                  <div>
                    <div className="user-ref">{mandate.user_ref}</div>
                    <div className="mono dim">{mandate.id}</div>
                  </div>
                  <div className="mandate-header-actions">
                    <span className={`chip status--${mandate.status}`}>{mandate.status}</span>
                    {mandate.status === 'active' && (
                      isConfirmingRevoke ? (
                        <div className="revoke-confirm-group">
                          <span className="revoke-confirm-text">Revoke?</span>
                          <button
                            type="button"
                            className="button button--compact button--danger"
                            onClick={() => void executeRevoke(mandate.id)}
                            disabled={isRevokingThis}
                          >
                            {isRevokingThis ? 'Revoking…' : 'Yes'}
                          </button>
                          <button
                            type="button"
                            className="button button--compact button--secondary"
                            onClick={() => setConfirmRevokeId(null)}
                            disabled={isRevokingThis}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="button button--compact button--danger-outline"
                          onClick={() => setConfirmRevokeId(mandate.id)}
                          title={`Revoke mandate ${mandate.id}`}
                        >
                          Revoke
                        </button>
                      )
                    )}
                  </div>
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
