import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiRequestError, webApi } from '../api';
import { useI18n } from '../i18n';

type SystemLinkValue = {
  /** System name exactly as the SDE stores it → its id. */
  systems: ReadonlyMap<string, number>;
  csrfToken: string;
};

const SystemLinkContext = createContext<SystemLinkValue | null>(null);

const RESOLVE_DEBOUNCE_MS = 400;

/**
 * Makes the solar systems an answer names clickable.
 *
 * The names are resolved on the server against the local SDE — the browser
 * never guesses — and only exact, standalone, case-sensitive matches come back,
 * so prose is not peppered with links. A click sets the pilot's autopilot
 * destination through ESI, which is the one system action the client actually
 * accepts from outside.
 */
export function SystemLinkProvider({
  text,
  csrfToken,
  enabled,
  children,
}: {
  text: string;
  csrfToken: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const [systems, setSystems] = useState<ReadonlyMap<string, number>>(new Map());

  useEffect(() => {
    if (!enabled || !text.trim()) {
      setSystems(new Map());
      return;
    }
    let cancelled = false;
    // Debounced: a streaming answer changes on every chunk, and this is a
    // convenience, not something worth a request per frame.
    const timer = window.setTimeout(() => {
      void webApi.resolveSystems(text)
        .then((payload) => {
          if (cancelled) return;
          setSystems(new Map(payload.systems.map((entry) => [entry.name, entry.systemId])));
        })
        .catch(() => { /* no links is a fine outcome; the answer still reads */ });
    }, RESOLVE_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [text, enabled]);

  return <SystemLinkContext.Provider value={{ systems, csrfToken }}>
    {children}
  </SystemLinkContext.Provider>;
}

/**
 * Plain text from the markdown renderer, with known system names turned into
 * buttons. Without a provider — or with nothing resolved — it is the string it
 * was given.
 */
export function SystemMentionText({ value, keyPrefix }: { value: string; keyPrefix: string }): ReactNode {
  const context = useContext(SystemLinkContext);
  if (!context || context.systems.size === 0 || !value) return value;

  const pattern = buildPattern([...context.systems.keys()]);
  if (!pattern) return value;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const prefix = match[1] ?? '';
    const name = match[2] ?? '';
    const start = match.index + prefix.length;
    if (start > cursor) nodes.push(value.slice(cursor, start));
    nodes.push(<SystemChip key={`${keyPrefix}-sys-${start}`} name={name} systemId={context.systems.get(name)!} />);
    cursor = start + name.length;
    // The prefix character was consumed by the match; keep scanning from the
    // name's end so two adjacent mentions both land.
    pattern.lastIndex = cursor;
  }
  if (nodes.length === 0) return value;
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function SystemChip({ name, systemId }: { name: string; systemId: number }) {
  const { t } = useI18n();
  const context = useContext(SystemLinkContext);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const [note, setNote] = useState<string | null>(null);

  const send = useCallback(async () => {
    if (!context || state === 'busy') return;
    setState('busy'); setNote(null);
    try {
      await webApi.openInClient('waypoint', systemId, context.csrfToken);
      setState('done');
      setNote(t('systemRouteDone', { name }));
    } catch (reason) {
      setState('failed');
      const code = reason instanceof ApiRequestError ? reason.code : undefined;
      setNote(code === 'character_required'
        ? t('openInClientNoCharacter')
        : code === 'scope_required'
          ? t('systemRouteNoScope')
          : code === 'client_unavailable'
            ? t('openInClientUnavailable')
            : reason instanceof Error ? reason.message : t('requestFailed'));
    }
  }, [context, name, state, systemId, t]);

  return <>
    <button
      className={`system-chip${state === 'failed' ? ' system-chip--failed' : ''}`}
      type="button"
      title={t('systemRouteHint', { name })}
      disabled={state === 'busy'}
      onClick={() => void send()}
    >{name}</button>
    {note ? <small className="system-chip__note" role="status">{note}</small> : null}
  </>;
}

/**
 * `([^\w-]|^)(A|B)(?![\w-])`: a name only counts standing alone. The prefix is
 * captured rather than looked behind so the pattern needs no lookbehind.
 */
function buildPattern(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const alternatives = [...names]
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`([^\\w-]|^)(${alternatives})(?![\\w-])`, 'g');
}
