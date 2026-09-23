import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/sqlite.js';
import {
  checkSdeFreshness,
  getLastSdeCheck,
  getSdeRefreshState,
  readLocalSdeSnapshot,
  startSdeRefresh,
} from '../eve/sde-refresh.js';
import { isOperatorSession } from './operator-access.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';

/**
 * Operator-only static-data controls under /api/web/settings/sde. Access is
 * the allowlist in operator-access.ts: non-operators are told `admin: false`
 * and see no panel, and the mutations answer 403 regardless of what the client
 * chose to render.
 */

type SdeStatusPayload = ReturnType<typeof buildStatusPayload>;

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
    if (!isOperatorSession(db, session.userId)) return { ok: true, admin: false };
    return buildStatusPayload(db);
  });

  app.post('/api/web/settings/sde/check', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    if (!isOperatorSession(db, session.userId)) {
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
    if (!isOperatorSession(db, session.userId)) {
      return reply.status(403).send({ error: 'operator_required' });
    }
    const { started } = startSdeRefresh(db);
    if (!started) return reply.status(409).send({ error: 'refresh_in_progress', ...buildStatusPayload(db) });
    return reply.status(202).send(buildStatusPayload(db));
  });
}
