import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, webApi } from '../../api';
import { formatDateTime } from '../../dates';
import { useI18n } from '../../i18n';
import { parseSqlUtcDate } from '../../sql-utc';
import type { MarketSnapshotAdminPayload } from '../../types';

type Props = { csrfToken: string };

type MarketAdminErrorKey = 'sdeErrorOperator' | 'marketAdminErrorInProgress';

const MARKET_ADMIN_ERROR_LABELS: Record<string, MarketAdminErrorKey> = {
  operator_required: 'sdeErrorOperator',
  sweep_in_progress: 'marketAdminErrorInProgress',
};

const POLL_INTERVAL_MS = 5_000;

/**
 * Operator-only market snapshot controls: how old the local order book is, and
 * a manual sweep for when waiting for the next scheduled tick is not an option.
 *
 * A whole-New-Eden walk takes minutes, so the button only starts it and the
 * panel polls; a sweep the scheduler started shows up here too, which is why
 * the button reports "already running" instead of starting a second one.
 */
export function MarketSnapshotPanel({ csrfToken }: Props) {
  const { t, locale } = useI18n();
  const [payload, setPayload] = useState<MarketSnapshotAdminPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const describeError = useCallback((reason: unknown): string => {
    if (reason instanceof ApiRequestError && reason.code && MARKET_ADMIN_ERROR_LABELS[reason.code]) {
      return t(MARKET_ADMIN_ERROR_LABELS[reason.code]!);
    }
    return reason instanceof Error ? reason.message : t('requestFailed');
  }, [t]);

  const load = useCallback(async () => {
    try { setPayload(await webApi.getMarketSnapshotAdmin()); }
    catch { /* a status read failure must not blank the settings screen */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const running = payload?.sweepInFlight === true || payload?.job?.status === 'running';

  useEffect(() => {
    if (!running) {
      if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = window.setInterval(() => { void load(); }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [running, load]);

  if (!payload?.admin) return null;
  const snapshot = payload.snapshot;
  const job = payload.job;

  const refresh = async () => {
    setBusy(true); setError(null);
    try { setPayload(await webApi.refreshMarketSnapshot(csrfToken)); }
    catch (reason) { setError(describeError(reason)); void load(); }
    finally { setBusy(false); }
  };

  return <section className="support-panel">
    <header className="support-panel__head">
      <h2>{t('marketAdminTitle')}</h2>
      <em className="support-badge">{t('sdeOperatorBadge')}</em>
    </header>
    <p className="settings-note">{t('marketAdminLead')}</p>

    {snapshot?.loaded ? <>
      <dl className="sde-facts">
        <dt>{t('marketAdminSnapshotTime')}</dt>
        <dd>
          {snapshot.snapshotTime
            ? formatDateTime(parseSqlUtcDate(snapshot.snapshotTime).toISOString(), locale)
            : t('marketAdminAgeUnknown')}
          {' '}
          <em className="support-badge">{snapshot.stale ? t('marketAdminStale') : t('marketAdminFresh')}</em>
        </dd>
        {snapshot.ageMinutes !== null ? <>
          <dt>{t('marketAdminAgeLabel')}</dt>
          <dd>{t('marketAdminAge', { age: String(snapshot.ageMinutes) })}</dd>
        </> : null}
      </dl>
      <p className="support-note">{t('marketAdminRows', {
        rows: String(snapshot.rowsLoaded ?? 0),
        regions: String(snapshot.regions.total),
        stale: String(snapshot.regions.stale),
      })}</p>
      {snapshot.regions.withErrors > 0 ? <p className="support-note">
        {t('marketAdminRegionErrors', { count: String(snapshot.regions.withErrors) })}
      </p> : null}
      {snapshot.lastError ? <p className="support-note support-note--warn">
        {t('marketAdminLastError', { error: snapshot.lastError })}
      </p> : null}
    </> : <p className="settings-note">{t('marketAdminNever')}</p>}

    {payload.workerEnabled === false ? <p className="support-note support-note--warn">
      {t('marketAdminWorkerOff')}
    </p> : null}

    {running ? <p className="settings-note" role="status">{t('marketAdminSweepRunning')}</p> : null}
    {!running && job?.status === 'committed' ? <p className="settings-saved" role="status">
      {t('marketAdminJobCommitted', {
        rows: String(job.rowsLoaded ?? 0),
        regions: String(job.regionsFetched ?? 0),
      })}
    </p> : null}
    {!running && job?.status === 'not_due' ? <p className="settings-note" role="status">
      {t('marketAdminJobNotDue')}
    </p> : null}
    {!running && job?.status === 'failed' ? <p className="workspace-error" role="alert">
      {t('marketAdminJobFailed', { error: job.error ?? '' })}
    </p> : null}
    {error ? <p className="workspace-error" role="alert">{error}</p> : null}

    <p className="support-note">{t('marketAdminForcedNote')}</p>
    <div className="settings-actions">
      <button
        className="button button--primary"
        type="button"
        disabled={busy || running}
        onClick={() => void refresh()}
      >{running ? t('marketAdminSweepRunning') : t('marketAdminRefresh')}</button>
    </div>
  </section>;
}
