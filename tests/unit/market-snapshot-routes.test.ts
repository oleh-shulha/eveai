import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';

const startForcedMarketSnapshotSweep = vi.fn();
const isMarketSnapshotSweepInFlight = vi.fn(() => false);
const getForcedMarketSweepState = vi.fn(() => ({
  status: 'idle' as const,
  startedAt: null,
  finishedAt: null,
  rowsLoaded: null,
  regionsFetched: null,
  error: null,
}));

vi.mock('../../src/eve/market-snapshot.js', () => ({
  startForcedMarketSnapshotSweep,
  isMarketSnapshotSweepInFlight,
  getForcedMarketSweepState,
}));

const { SCHEMA_SQL } = await import('../../src/db/schema.js');
const { runMigrations } = await import('../../src/db/migrations.js');
const { config } = await import('../../src/config.js');
const { registerMarketSnapshotAdminRoutes } = await import('../../src/web/market-snapshot-routes.js');
const {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} = await import('../../src/web/web-session.js');

const ORIGIN = 'http://localhost:3000';
const STATUS_URL = '/api/web/settings/market-snapshot';
const REFRESH_URL = `${STATUS_URL}/refresh`;
const OPERATOR_CHARACTER_ID = 95_465_510;

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  config.web.adminCharacterIds = [];
  startForcedMarketSnapshotSweep.mockReset();
  isMarketSnapshotSweepInFlight.mockReturnValue(false);
  startForcedMarketSnapshotSweep.mockReturnValue({
    started: true,
    state: { status: 'running', startedAt: '2026-09-23T10:00:00.000Z', finishedAt: null, rowsLoaded: null, regionsFetched: null, error: null },
  });
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerMarketSnapshotAdminRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
  config.web.adminCharacterIds = [];
});

function browserSession() {
  const created = createWebSession(db);
  return {
    cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
    csrf: created.csrfToken,
    userId: created.userId,
  };
}

function mutationHeaders(session: ReturnType<typeof browserSession>) {
  return { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrf };
}

function linkCharacter(userId: number, characterId: number) {
  db.prepare(`
    INSERT INTO eve_accounts (
      character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
    ) VALUES (?, 'Pilot', 'enc:a', 'enc:r', datetime('now', '+1 hour'), '[]', ?)
  `).run(characterId, userId);
}

function asOperator() {
  const session = browserSession();
  linkCharacter(session.userId, OPERATOR_CHARACTER_ID);
  config.web.adminCharacterIds = [OPERATOR_CHARACTER_ID];
  return session;
}

/**
 * A committed snapshot: served rows plus the state the sweep records. The sweep
 * stores instants as ISO-8601 UTC (`now.toISOString()`), so the seed does too —
 * SQLite's own `datetime()` format would be read as local time and shift the age.
 */
function seedSnapshot(options: { staleRegion?: boolean } = {}) {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  db.prepare(`
    INSERT INTO market_orders (
      order_id, type_id, region_id, location_id, system_id, is_buy_order,
      price, volume_remain, volume_total, min_volume, duration, issued, range
    ) VALUES (1, 34, 10000002, 60003760, 30000142, 0, 100.5, 10, 20, 1, 90, ?, 'region')
  `).run(minutesAgo(4));
  db.prepare(`
    INSERT INTO market_snapshot_state (feed_key, status, snapshot_time, rows_loaded, loaded_at)
    VALUES ('global', 'idle', ?, 1600000, ?)
  `).run(minutesAgo(4), minutesAgo(4));
  db.prepare(`
    INSERT INTO market_snapshot_regions (region_id, pages, rows_loaded, fetched_at, expires_at, last_error)
    VALUES (10000002, 410, 900000, ?, ?, NULL)
  `).run(minutesAgo(options.staleRegion ? 360 : 4), new Date(Date.now() + 60_000).toISOString());
}

describe('market snapshot admin routes: access', () => {
  it('requires a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: STATUS_URL });
    expect(response.statusCode).toBe(401);
  });

  it('hides the panel from a signed-in non-operator', async () => {
    const session = browserSession();
    linkCharacter(session.userId, 90_000_001);
    config.web.adminCharacterIds = [OPERATOR_CHARACTER_ID];

    const status = await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } });
    const refresh = await app.inject({ method: 'POST', url: REFRESH_URL, headers: mutationHeaders(session) });

    expect(status.json()).toEqual({ ok: true, admin: false });
    expect(refresh.statusCode).toBe(403);
    expect(refresh.json()).toEqual({ error: 'operator_required' });
    expect(startForcedMarketSnapshotSweep).not.toHaveBeenCalled();
  });

  it('rejects a sweep that fails origin/CSRF verification', async () => {
    const session = asOperator();

    const response = await app.inject({
      method: 'POST',
      url: REFRESH_URL,
      headers: { origin: 'https://evil.example', cookie: session.cookie, 'x-csrf-token': session.csrf },
    });

    expect(response.statusCode).toBe(403);
    expect(startForcedMarketSnapshotSweep).not.toHaveBeenCalled();
  });
});

describe('market snapshot admin routes: status', () => {
  it('reports a never-loaded snapshot without pretending it is fresh', async () => {
    const session = asOperator();

    const body = (await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } })).json();

    expect(body.admin).toBe(true);
    expect(body.snapshot.loaded).toBe(false);
    expect(body.snapshot.snapshotTime).toBeNull();
    expect(body.snapshot.ageMinutes).toBeNull();
    expect(body.snapshot.stale).toBe(true);
    expect(body.snapshot.regions).toEqual({ total: 0, stale: 0, withErrors: 0 });
    expect(body.workerEnabled).toBe(config.marketSnapshot.enabled);
    expect(body.sweepInFlight).toBe(false);
  });

  it('summarizes a loaded snapshot and its regions', async () => {
    const session = asOperator();
    seedSnapshot();

    const body = (await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } })).json();

    expect(body.snapshot.loaded).toBe(true);
    expect(body.snapshot.rowsLoaded).toBe(1_600_000);
    expect(body.snapshot.ageMinutes).toBe(4);
    expect(body.snapshot.stale).toBe(false);
    expect(body.snapshot.regions).toEqual({ total: 1, stale: 0, withErrors: 0 });
  });

  it('marks a region left behind by the sweep as stale', async () => {
    const session = asOperator();
    seedSnapshot({ staleRegion: true });

    const body = (await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } })).json();

    expect(body.snapshot.stale).toBe(true);
    expect(body.snapshot.regions.stale).toBe(1);
  });

  it('shows a scheduled sweep as in progress', async () => {
    const session = asOperator();
    isMarketSnapshotSweepInFlight.mockReturnValue(true);

    const body = (await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } })).json();

    expect(body.sweepInFlight).toBe(true);
  });
});

describe('market snapshot admin routes: forced sweep', () => {
  it('starts one and answers with the running state', async () => {
    const session = asOperator();

    const response = await app.inject({ method: 'POST', url: REFRESH_URL, headers: mutationHeaders(session) });

    expect(response.statusCode).toBe(202);
    expect(startForcedMarketSnapshotSweep).toHaveBeenCalledWith(db);
    expect(response.json().admin).toBe(true);
  });

  it('answers 409 when a sweep is already walking ESI', async () => {
    const session = asOperator();
    startForcedMarketSnapshotSweep.mockReturnValue({
      started: false,
      state: { status: 'running', startedAt: '2026-09-23T10:00:00.000Z', finishedAt: null, rowsLoaded: null, regionsFetched: null, error: null },
    });
    isMarketSnapshotSweepInFlight.mockReturnValue(true);

    const response = await app.inject({ method: 'POST', url: REFRESH_URL, headers: mutationHeaders(session) });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('sweep_in_progress');
    expect(response.json().sweepInFlight).toBe(true);
  });
});
