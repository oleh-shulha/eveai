import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, webApi } from '../../api';
import { formatDateTime } from '../../dates';
import { useI18n } from '../../i18n';
import { parseSqlUtcDate } from '../../sql-utc';
import type { SdeStatusPayload } from '../../types';

type Props = { csrfToken: string };

type SdeErrorKey = 'sdeErrorOperator' | 'sdeErrorInProgress' | 'sdeErrorUpstream';

const SDE_ERROR_LABELS: Record<string, SdeErrorKey> = {
  operator_required: 'sdeErrorOperator',
  refresh_in_progress: 'sdeErrorInProgress',
  upstream_unavailable: 'sdeErrorUpstream',
};

const FRESHNESS_LABELS = {
  up_to_date: 'sdeFresh',
  update_available: 'sdeUpdateAvailable',
  unknown: 'sdeUnknown',
} as const;

const STEP_LABELS = {
  download: 'sdeStepDownload',
  load: 'sdeStepLoad',
  map: 'sdeStepMap',
} as const;

const POLL_INTERVAL_MS = 3_000;

/**
 * Operator-only static-data controls. The panel renders nothing at all unless
 * the server says this session is an operator, so a normal user never sees a
 * button they cannot use.
 *
 * A refresh takes minutes, so the button only starts the job: progress comes
 * from polling the status, which also means a reload or a second tab shows the
 * same running job instead of offering to start another.
 */
export function SdePanel({ csrfToken }: Props) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<SdeStatusPayload | null>(null);
  const [busy, setBusy] = useState<'check' | 'refresh' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const describeError = useCallback((reason: unknown): string => {
    if (reason instanceof ApiRequestError && reason.code && SDE_ERROR_LABELS[reason.code]) {
      return t(SDE_ERROR_LABELS[reason.code]!);
    }
    return reason instanceof Error ? reason.message : t('requestFailed');
  }, [t]);

  const load = useCallback(async () => {
    try { setStatus(await webApi.getSdeStatus()); }
    catch { /* a status read failure must not blank the settings screen */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const running = status?.job?.status === 'running';

  // Poll only while a job is in flight, and stop as soon as it settles.
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

  if (!status?.admin) return null;
  const local = status.local;
  const job = status.job;

  const check = async () => {
    setBusy('check'); setError(null);
    try { setStatus(await webApi.checkSdeFreshness(csrfToken)); }
    catch (reason) { setError(describeError(reason)); }
    finally { setBusy(null); }
  };

  const refresh = async () => {
    setBusy('refresh'); setError(null);
    try { setStatus(await webApi.refreshSde(csrfToken)); }
    catch (reason) { setError(describeError(reason)); void load(); }
    finally { setBusy(null); }
  };

  return <section className="support-panel">
    <header className="support-panel__head">
      <h2>{t('sdeTitle')}</h2>
      <em className="support-badge">{t('sdeOperatorBadge')}</em>
    </header>
    <p className="settings-note">{t('sdeLead')}</p>

    <dl className="sde-facts">
      {local?.loadedAt ? <>
        <dt>{t('sdeLoadedAt')}</dt>
        <dd>{formatDateTime(parseSqlUtcDate(local.loadedAt).toISOString(), locale)}</dd>
        <dt>{t('sdeBuild')}</dt>
        <dd><code>{local.buildNumber}</code></dd>
      </> : <>
        <dt>{t('sdeLoadedAt')}</dt>
        <dd>{t('sdeNeverLoaded')}</dd>
      </>}
    </dl>
    {local ? <p className="support-note">{t('sdeCounts', {
      systems: String(local.systems),
      types: String(local.types),
      mapSystems: String(local.mapSystems),
    })}</p> : null}

    {status.lastCheck ? <p className="settings-note" role="status">
      {t(FRESHNESS_LABELS[status.lastCheck.freshness])}
      {' '}
      <small>{t('sdeCheckedAt', { time: formatDateTime(status.lastCheck.checkedAt, locale) })}</small>
      {status.lastCheck.upstream.lastModified ? <>
        {' '}
        <small>{t('sdeUpstreamDate', {
          date: formatDateTime(status.lastCheck.upstream.lastModified, locale),
        })}</small>
      </> : null}
    </p> : null}

    {job && job.status === 'running' ? <p className="settings-note" role="status">
      {job.step ? t(STEP_LABELS[job.step]) : t('sdeRefreshRunning')}
    </p> : null}
    {job && job.status === 'done' ? <p className="settings-saved" role="status">
      {t('sdeJobDone', {
        records: String(job.records ?? 0),
        systems: String(job.mapSystems ?? 0),
      })}
    </p> : null}
    {job && job.status === 'failed' ? <p className="workspace-error" role="alert">
      {t('sdeJobFailed', { error: job.error ?? '' })}
    </p> : null}
    {error ? <p className="workspace-error" role="alert">{error}</p> : null}

    <p className="support-note">{t('sdeLiveNote')}</p>
    <div className="settings-actions">
      <button
        className="button"
        type="button"
        disabled={busy !== null || running}
        onClick={() => void check()}
      >{busy === 'check' ? t('sdeChecking') : t('sdeCheck')}</button>
      <button
        className="button button--primary"
        type="button"
        disabled={busy !== null || running}
        onClick={() => void refresh()}
      >{running ? t('sdeRefreshRunning') : t('sdeRefresh')}</button>
    </div>
  </section>;
}
