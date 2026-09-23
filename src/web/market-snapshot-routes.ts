import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { getMarketSnapshotMeta } from '../eve/market-snapshot-loader.js';
import {
  getForcedMarketSweepState,
  isMarketSnapshotSweepInFlight,
  startForcedMarketSnapshotSweep,
} from '../eve/market-snapshot.js';
import { isOperatorSession } from './operator-access.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';

/**
 * Operator-only market-snapshot controls under
 * /api/web/settings/market-snapshot. Access is the allowlist in
 * operator-access.ts; non-operators are told `admin: false` and the mutation
 * answers 403 regardless of what the client renders.
 *
 * The status is deliberately a summary, not the per-region table the market
 * screen already serves: an operator needs the snapshot's age, its size, and
 * whether a sweep is running right now.
 */

function snapshotPayload(db: Db) {
  const meta = getMarketSnapshotMeta(db, {
    staleMinutes: config.marketSnapshot.staleMinutes,
    majorMinPages: config.marketSnapshot.majorMinPages,
    majorIntervalMinutes: config.marketSnapshot.majorIntervalMinutes,
    minorIntervalMinutes: config.marketSnapshot.minorIntervalMinutes,
  });
  return {
    ok: true as const,
    admin: true as const,
    snapshot: {
      loaded: meta.loaded,
      status: meta.status,
      snapshotTime: meta.snapshot_time,
      ageMinutes: meta.age_minutes,
      stale: meta.stale,
      rowsLoaded: meta.rows_loaded,
      lastError: meta.last_error,
      regions: {
        total: meta.regions.length,
        stale: meta.regions.filter((region) => region.stale).length,
        withErrors: meta.regions.filter((region) => region.last_error).length,
      },
    },
    // A disabled worker still allows a manual sweep; the panel says which is which.
    workerEnabled: config.marketSnapshot.enabled,
    sweepInFlight: isMarketSnapshotSweepInFlight(),
    job: getForcedMarketSweepState(),
  };
}

export function registerMarketSnapshotAdminRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/web/settings/market-snapshot', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    if (!isOperatorSession(db, session.userId)) return { ok: true, admin: false };
    return snapshotPayload(db);
  });

  app.post('/api/web/settings/market-snapshot/refresh', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    if (!isOperatorSession(db, session.userId)) {
      return reply.status(403).send({ error: 'operator_required' });
    }
    const { started } = startForcedMarketSnapshotSweep(db);
    // A scheduled tick already walking ESI counts as in progress: a second
    // sweep would drop and refill the same staging table under the first.
    if (!started) return reply.status(409).send({ error: 'sweep_in_progress', ...snapshotPayload(db) });
    return reply.status(202).send(snapshotPayload(db));
  });
}
