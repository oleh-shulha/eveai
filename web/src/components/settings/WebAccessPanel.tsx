import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { WebAccessPayload } from '../../types';

type Props = { csrfToken: string };

type WebAccessErrorKey = 'sdeErrorOperator' | 'webAccessErrorInvalid';

const WEB_ACCESS_ERROR_LABELS: Record<string, WebAccessErrorKey> = {
  operator_required: 'sdeErrorOperator',
  invalid_state: 'webAccessErrorInvalid',
};

/**
 * Operator-only kill switch for the agent's web access. The panel exists only
 * when Firecrawl is configured in the environment — there is nothing to switch
 * otherwise — and it states what the model gains, because the same switch
 * decides whether untrusted page text can enter a turn at all.
 */
export function WebAccessPanel({ csrfToken }: Props) {
  const { t } = useI18n();
  const [payload, setPayload] = useState<WebAccessPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const describeError = useCallback((reason: unknown): string => {
    if (reason instanceof ApiRequestError && reason.code && WEB_ACCESS_ERROR_LABELS[reason.code]) {
      return t(WEB_ACCESS_ERROR_LABELS[reason.code]!);
    }
    return reason instanceof Error ? reason.message : t('requestFailed');
  }, [t]);

  const load = useCallback(async () => {
    try { setPayload(await webApi.getWebAccess()); }
    catch { /* a status read failure must not blank the settings screen */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const state = payload?.state;
  if (!payload?.admin || !state?.configured) return null;

  const toggle = async () => {
    setBusy(true); setError(null);
    try { setPayload(await webApi.setWebAccess(!state.allowed, csrfToken)); }
    catch (reason) { setError(describeError(reason)); }
    finally { setBusy(false); }
  };

  return <section className="support-panel">
    <header className="support-panel__head">
      <h2>{t('webAccessTitle')}</h2>
      <em className="support-badge">{t('sdeOperatorBadge')}</em>
    </header>
    <p className="settings-note">{t('webAccessLead')}</p>

    <dl className="sde-facts">
      <dt>{t('webAccessEndpointLabel')}</dt>
      <dd>
        <code>{state.endpointHost}</code>
        {' '}
        <em className="support-badge">{state.enabled ? t('webAccessOn') : t('webAccessOff')}</em>
      </dd>
    </dl>

    <p className="support-note">
      {state.enabled ? t('webAccessEnabledNote') : t('webAccessDisabledNote')}
    </p>
    {error ? <p className="workspace-error" role="alert">{error}</p> : null}

    <div className="settings-actions">
      <button
        className={state.allowed ? 'button' : 'button button--primary'}
        type="button"
        disabled={busy}
        onClick={() => void toggle()}
      >{state.allowed ? t('webAccessDisable') : t('webAccessEnable')}</button>
    </div>
  </section>;
}
