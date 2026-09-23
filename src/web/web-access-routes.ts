import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { getWebAccessState, setWebAccessAllowed } from '../agent/web-access.js';
import { isOperatorSession } from './operator-access.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';

/**
 * Operator-only web-access switch under /api/web/settings/web-access.
 *
 * `.env` decides whether web access exists (FIRECRAWL_URL + FIRECRAWL_API_KEY);
 * this route decides whether the configured access is currently allowed, so an
 * operator can cut the agent off from the open web without a restart. The
 * switch is stored, applies from the next turn, and only the endpoint's host is
 * ever reported — the full URL and the key stay operator infrastructure.
 */

type WebAccessBody = { allowed?: unknown };

export function registerWebAccessRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/web/settings/web-access', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    if (!isOperatorSession(db, session.userId)) return { ok: true, admin: false };
    return { ok: true, admin: true, state: getWebAccessState() };
  });

  app.put<{ Body: WebAccessBody }>('/api/web/settings/web-access', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    if (!isOperatorSession(db, session.userId)) {
      return reply.status(403).send({ error: 'operator_required' });
    }
    const allowed = request.body?.allowed;
    if (typeof allowed !== 'boolean') {
      return reply.status(400).send({ error: 'invalid_state' });
    }
    // Storing the switch while nothing is configured is allowed on purpose: the
    // operator can pre-arm "off" before adding the credentials.
    setWebAccessAllowed(db, allowed);
    return { ok: true, admin: true, state: getWebAccessState() };
  });
}
