import { useState } from 'react';
import { ApiRequestError, webApi } from '../api';
import { useI18n } from '../i18n';

type Props = {
  action: 'market' | 'info';
  id: number;
  csrfToken: string;
};

type OpenInClientErrorKey =
  | 'openInClientNoCharacter'
  | 'openInClientNoScope'
  | 'openInClientUnavailable'
  | 'openInClientRefused';

const ERROR_LABELS: Record<string, OpenInClientErrorKey> = {
  character_required: 'openInClientNoCharacter',
  scope_required: 'openInClientNoScope',
  client_unavailable: 'openInClientUnavailable',
  esi_refused: 'openInClientRefused',
};

/**
 * Hands one action to the running EVE client through ESI.
 *
 * The result is reported in place and briefly: the interesting outcome is
 * "nothing happened", and the pilot needs to know whether that was the client
 * being closed, a missing permission, or no linked character at all.
 */
export function OpenInClientButton({ action, id, csrfToken }: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const send = async () => {
    setBusy(true); setNotice(null); setFailed(false);
    try {
      await webApi.openInClient(action, id, csrfToken);
      setNotice(t('openInClientDone'));
      setFailed(false);
    } catch (reason) {
      const code = reason instanceof ApiRequestError ? reason.code : undefined;
      setNotice(code && ERROR_LABELS[code]
        ? t(ERROR_LABELS[code]!)
        : reason instanceof Error ? reason.message : t('requestFailed'));
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return <span className="open-in-client">
    <button className="button open-in-client__button" type="button" disabled={busy} onClick={() => void send()}>
      {busy ? t('openInClientBusy') : t('openInClient')}
    </button>
    {notice ? (
      <small className={failed ? 'open-in-client__note open-in-client__note--error' : 'open-in-client__note'} role="status">
        {notice}
      </small>
    ) : null}
  </span>;
}
