import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';

/**
 * Who may run the operator-only browser controls (static-data refresh, market
 * snapshot sweep).
 *
 * The browser has no general admin role, so access is an explicit allowlist of
 * EVE character ids (WEB_ADMIN_CHARACTER_IDS) matched against the characters
 * linked to the session's user. An empty allowlist means nobody: these buttons
 * spend the operator's bandwidth and ESI budget and rewrite shared tables, so
 * they are not something a signed-in stranger gets to trigger.
 */
export function isOperatorSession(db: Db, userId: number): boolean {
  const ids = config.web.adminCharacterIds;
  if (ids.length === 0) return false;
  const placeholders = ids.map(() => '?').join(', ');
  const owned = db.prepare(
    `SELECT 1 FROM eve_accounts WHERE user_id = ? AND character_id IN (${placeholders}) LIMIT 1`,
  ).get(userId, ...ids);
  if (owned) return true;
  return Boolean(db.prepare(
    `SELECT 1 FROM eve_character_links WHERE user_id = ? AND character_id IN (${placeholders}) LIMIT 1`,
  ).get(userId, ...ids));
}
