import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { readWebSession } from './web-session.js';

/**
 * Character allowlist: who the browser app is for.
 *
 * `PRIVATE_PASSWORD` decides who may reach the app; this decides whose EVE
 * characters may use it. With `WEB_ALLOWED_CHARACTER_IDS` set, the browser app
 * works only for a session that has one of those characters linked, and EVE SSO
 * refuses to attach any other character to a browser login.
 *
 * Three paths stay open so an allowed pilot can actually get in: the private
 * gate, the session endpoint the app boots from, and the SSO start. Everything
 * else answers `character_not_allowed`, which the app turns into a plain
 * "this instance is limited to its owner's characters" screen instead of a
 * string of failing requests.
 *
 * This is a browser-lane rule. Telegram, Discord and the CLI keep their own
 * allowlists and are unaffected.
 */

const OPEN_PATHS = new Set([
  '/api/web/gate',
  '/api/web/session',
  '/api/web/eve/login',
]);

export function isCharacterAllowlistEnabled(): boolean {
  return config.web.allowedCharacterIds.length > 0;
}

export function isCharacterAllowed(characterId: number): boolean {
  if (!isCharacterAllowlistEnabled()) return true;
  return config.web.allowedCharacterIds.includes(characterId);
}

export function userHasAllowedCharacter(db: Db, userId: number): boolean {
  if (!isCharacterAllowlistEnabled()) return true;
  const ids = config.web.allowedCharacterIds;
  const placeholders = ids.map(() => '?').join(', ');
  const owned = db.prepare(
    `SELECT 1 FROM eve_accounts WHERE user_id = ? AND character_id IN (${placeholders}) LIMIT 1`,
  ).get(userId, ...ids);
  if (owned) return true;
  return Boolean(db.prepare(
    `SELECT 1 FROM eve_character_links WHERE user_id = ? AND character_id IN (${placeholders}) LIMIT 1`,
  ).get(userId, ...ids));
}

export function registerCharacterAllowlistGate(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isCharacterAllowlistEnabled()) return;
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/web/')) return;
    if (OPEN_PATHS.has(path)) return;
    const session = readWebSession(db, request);
    // No session at all is the session guard's business, not this one: it
    // answers 401 with the wording the client already knows.
    if (!session || userHasAllowedCharacter(db, session.userId)) return;
    await reply.status(403).send({ error: 'character_not_allowed' });
  });
}
