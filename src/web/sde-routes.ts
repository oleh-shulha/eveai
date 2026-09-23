import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import {
  checkSdeFreshness,
  getLastSdeCheck,
  getSdeRefreshState,
  readLocalSdeSnapshot,
  startSdeRefresh,
} from '../eve/sde-refresh.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';

/**
 * Operator-only static-data controls under /api/web/settings/sde.
 *
 * The browser has no general admin role, so access is an explicit allowlist of
 * EVE character ids (WEB_ADMIN_CHARACTER_IDS) matched against the characters
 * linked to the session's user. An empty allowlist means nobody: a ~100 MB
 * download plus a full table reload is not something a signed-in stranger gets
 * to trigger. Non-operators are told `admin: false` and see no panel; the
 * mutations answer 403 regardless of what the client renders.
 */

type SdeStatusPayload = ReturnType<typeof buildStatusPayload>;

function isAdminSession(db: Db, userId: number): boolean {
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

function countRows(db: Db, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

function buildStatusPayload(db: Db) {
  const snapshot = readLocalSdeSnapshot(db);
  return {
    ok: true as const,
    admin: true as const,
    local: {
      buildNumber: snapshot?.buildNumber ?? null,
      loadedAt: snapshot?.loadedAt ?? null,
      sourceLastModified: snapshot?.sourceLastModified ?? null,
      sourceBytes: snapshot?.sourceBytes ?? null,
      systems: countRows(db, 'sde_systems'),
      types: countRows(db, 'sde_types'),
      mapSystems: countRows(db, 'map_systems'),
    },
    lastCheck: getLastSdeCheck(),
    job: getSdeRefreshState(),
  };
}

export function registerSdeRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/web/settings/sde', async (request, reply): Promise<SdeStatusPayload | { ok: true; admin: false }> => {
    const session = requireSession(db, request, reply);
    if (!session) return undefined as never;
    if (!isAdminSession(db, session.userId)) return { ok: true, admin: false };
    return buildStatusPayload(db);
  });

  app.post('/api/web/settings/sde/check', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    if (!isAdminSession(db, session.userId)) {
      return reply.status(403).send({ error: 'operator_required' });
    }
    try {
      await checkSdeFreshness(db);
    } catch {
      // The upstream message can carry the URL and CDN detail; the operator
      // needs the verdict, and the reason is in the process log.
      return reply.status(502).send({ error: 'upstream_unavailable' });
    }
    return buildStatusPayload(db);
  });

  app.post('/api/web/settings/sde/refresh', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    if (!isAdminSession(db, session.userId)) {
      return reply.status(403).send({ error: 'operator_required' });
    }
    const { started } = startSdeRefresh(db);
    if (!started) return reply.status(409).send({ error: 'refresh_in_progress', ...buildStatusPayload(db) });
    return reply.status(202).send(buildStatusPayload(db));
  });
}
