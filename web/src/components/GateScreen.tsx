import { useState } from 'react';
import { ApiRequestError, webApi } from '../api';
import { Brand } from './Brand';
import { LocaleSwitch, useI18n } from '../i18n';

type Props = { onUnlocked: () => void };

/**
 * The only screen a locked private instance shows. The password is sent once and
 * the server answers with a signed cookie, so nothing secret is kept in the
 * page: a reload after unlocking lands in the normal app.
 */
export function GateScreen({ onUnlocked }: Props) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      await webApi.unlock(password);
      onUnlocked();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === 'invalid_password') {
        setError(t('gateErrorInvalid'));
      } else if (reason instanceof ApiRequestError && reason.code === 'too_many_attempts') {
        setError(t('gateErrorTooMany'));
      } else {
        setError(reason instanceof Error ? reason.message : t('requestFailed'));
      }
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return <main className="login">
    <header className="login__header">
      <Brand />
      <LocaleSwitch />
    </header>
    <section className="login__content" aria-labelledby="gate-title">
      <div className="login__copy">
        <h1 id="gate-title">{t('gateTitle')}</h1>
        <p>{t('gateLead')}</p>
        <form className="login__actions" onSubmit={submit}>
          <label className="gate-field">
            <span>{t('gatePasswordLabel')}</span>
            <input
              type="password"
              name="private-password"
              autoComplete="current-password"
              autoFocus
              value={password}
              placeholder={t('gatePasswordPlaceholder')}
              disabled={busy}
              onChange={(event) => { setPassword(event.target.value); setError(null); }}
            />
          </label>
          <button
            className="button button--primary button--login"
            type="submit"
            disabled={busy || !password.trim()}
          >{busy ? t('gateChecking') : t('gateSubmit')}</button>
        </form>
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <p className="trust-note">{t('gateSavedNote')}</p>
      </div>
    </section>
  </main>;
}
