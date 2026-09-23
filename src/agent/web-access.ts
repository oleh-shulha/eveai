/**
 * Whether the agent may read the open web this run.
 *
 * Two independent switches. The operator's `.env` decides whether web access
 * exists at all (FIRECRAWL_URL + FIRECRAWL_API_KEY); the operator kill switch
 * decides whether the configured access is currently allowed. The kill switch
 * lives in SQLite so it survives a restart, and is cached in memory because the
 * tool list is built on every turn and this app is single-process by design.
 *
 * Unset means allowed: a fresh install with Firecrawl configured has web access
 * on, and only an explicit "off" is stored.
 */
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { isFirecrawlConfigured } from './firecrawl.js';

const WEB_ACCESS_FLAG = 'web_access';

let operatorAllowed = true;

export type WebAccessState = {
  /** Both FIRECRAWL_URL and FIRECRAWL_API_KEY are set. */
  configured: boolean;
  /** The operator has not switched it off. */
  allowed: boolean;
  /** Configured and allowed: the tools exist this turn. */
  enabled: boolean;
  /** Host only — the full endpoint is operator infrastructure. */
  endpointHost: string | null;
};

export function loadWebAccessFlag(db: Db): void {
  const row = db.prepare('SELECT enabled FROM operator_flags WHERE flag_key = ?')
    .get(WEB_ACCESS_FLAG) as { enabled: number } | undefined;
  operatorAllowed = row === undefined ? true : row.enabled === 1;
}

export function setWebAccessAllowed(db: Db, allowed: boolean): void {
  db.prepare(`
    INSERT INTO operator_flags (flag_key, enabled, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(flag_key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(WEB_ACCESS_FLAG, allowed ? 1 : 0);
  operatorAllowed = allowed;
}

export function isWebAccessAllowed(): boolean {
  return operatorAllowed;
}

/** The single question the tool builder and the executor both ask. */
export function isWebAccessEnabled(): boolean {
  return isFirecrawlConfigured() && operatorAllowed;
}

export function getWebAccessState(): WebAccessState {
  const configured = isFirecrawlConfigured();
  return {
    configured,
    allowed: operatorAllowed,
    enabled: configured && operatorAllowed,
    endpointHost: configured ? safeHost(config.firecrawl.baseUrl) : null,
  };
}

/** Test seam: the cached flag is a process-wide singleton. */
export function resetWebAccessCacheForTests(): void {
  operatorAllowed = true;
}

function safeHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}
