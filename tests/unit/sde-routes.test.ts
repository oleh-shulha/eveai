import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';

const downloadSdeArchive = vi.fn();
const loadSdeIntoDb = vi.fn();
const buildMapGraph = vi.fn();

vi.mock('../../src/eve/sde-downloader.js', () => ({ downloadSdeArchive }));
vi.mock('../../src/eve/sde-loader.js', () => ({ loadSdeIntoDb }));
vi.mock('../../src/eve/map-graph.js', () => ({
  buildMapGraph,
  MapGraphBuildError: class extends Error {},
}));

const { SCHEMA_SQL } = await import('../../src/db/schema.js');
const { runMigrations } = await import('../../src/db/migrations.js');
const { config } = await import('../../src/config.js');
const { registerSdeRoutes } = await import('../../src/web/sde-routes.js');
const { resetSdeRefreshStateForTests, getSdeRefreshState } = await import('../../src/eve/sde-refresh.js');
const {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} = await import('../../src/web/web-session.js');

const ORIGIN = 'http://localhost:3000';
const STATUS_URL = '/api/web/settings/sde';
const OPERATOR_CHARACTER_ID = 95_465_510;
const IDENTITY = { lastModified: 'Tue, 01 Sep 2026 10:00:00 GMT', etag: 'aaa111', bytes: 104_857_600 };

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  resetSdeRefreshStateForTests();
  config.web.adminCharacterIds = [];
  downloadSdeArchive.mockReset();
  loadSdeIntoDb.mockReset();
  buildMapGraph.mockReset();
  downloadSdeArchive.mockResolvedValue({ dataDir: './data/sde', zipPath: './data/sde/a.zip', identity: IDENTITY });
  loadSdeIntoDb.mockResolvedValue({ totalRecords: 42, buildNumber: 'etag:aaa111', emptyCriticalTables: [] });
  buildMapGraph.mockReturnValue({
    rebuilt: true,
    reason: 'forced',
    meta: { systemCount: 5, edgeCount: 8, geometrySource: 'position2D', sdeBuildNumber: 'etag:aaa111' },
  });
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerSdeRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
  config.web.adminCharacterIds = [];
  vi.unstubAllGlobals();
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

/** The refresh runs detached from the request; wait for it to settle. */
async function settled(): Promise<void> {
  for (let i = 0; i < 100 && getSdeRefreshState().status === 'running'; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('SDE routes: access', () => {
  it('requires a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: STATUS_URL });
    expect(response.statusCode).toBe(401);
  });

  it('tells a signed-in non-operator there is no panel, without leaking state', async () => {
    const session = browserSession();
    linkCharacter(session.userId, 90_000_001);

    const response = await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, admin: false });
  });

  it('refuses the mutations for a non-operator', async () => {
    const session = browserSession();
    linkCharacter(session.userId, 90_000_001);
    config.web.adminCharacterIds = [OPERATOR_CHARACTER_ID];

    for (const url of [`${STATUS_URL}/check`, `${STATUS_URL}/refresh`]) {
      const response = await app.inject({ method: 'POST', url, headers: mutationHeaders(session) });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'operator_required' });
    }
    expect(downloadSdeArchive).not.toHaveBeenCalled();
  });

  it('treats an empty allowlist as nobody, even for a linked character', async () => {
    const session = browserSession();
    linkCharacter(session.userId, OPERATOR_CHARACTER_ID);

    const status = await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } });
    const refresh = await app.inject({ method: 'POST', url: `${STATUS_URL}/refresh`, headers: mutationHeaders(session) });

    expect(status.json()).toEqual({ ok: true, admin: false });
    expect(refresh.statusCode).toBe(403);
  });

  it('rejects a mutation that fails origin/CSRF verification', async () => {
    const session = asOperator();

    const response = await app.inject({
      method: 'POST',
      url: `${STATUS_URL}/refresh`,
      headers: { origin: 'https://evil.example', cookie: session.cookie, 'x-csrf-token': session.csrf },
    });

    expect(response.statusCode).toBe(403);
    expect(downloadSdeArchive).not.toHaveBeenCalled();
  });
});

describe('SDE routes: operator controls', () => {
  it('reports the local snapshot and counts', async () => {
    const session = asOperator();
    db.prepare("INSERT INTO sde_systems (system_id, name, data_json) VALUES (30000142, 'Jita', '{}')").run();

    const response = await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } });
    const body = response.json();

    expect(body.admin).toBe(true);
    expect(body.local.systems).toBe(1);
    expect(body.local.loadedAt).toBeNull();
    expect(body.job.status).toBe('idle');
    expect(body.lastCheck).toBeNull();
  });

  it('answers the freshness check from the archive headers alone', async () => {
    const session = asOperator();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 200,
      headers: { etag: '"aaa111"', 'last-modified': IDENTITY.lastModified },
    })));

    const response = await app.inject({ method: 'POST', url: `${STATUS_URL}/check`, headers: mutationHeaders(session) });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    // Nothing is loaded locally yet, so a reachable archive means work to do.
    expect(body.lastCheck.freshness).toBe('update_available');
    expect(body.lastCheck.upstream.etag).toBe('aaa111');
    expect(downloadSdeArchive).not.toHaveBeenCalled();
  });

  it('reports an unreachable archive as a check failure, not as up to date', async () => {
    const session = asOperator();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));

    const response = await app.inject({ method: 'POST', url: `${STATUS_URL}/check`, headers: mutationHeaders(session) });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'upstream_unavailable' });
  });

  it('downloads, reloads, and rebuilds the map graph in one job', async () => {
    const session = asOperator();

    const accepted = await app.inject({ method: 'POST', url: `${STATUS_URL}/refresh`, headers: mutationHeaders(session) });
    expect(accepted.statusCode).toBe(202);
    await settled();

    expect(loadSdeIntoDb).toHaveBeenCalledWith(db, './data/sde', expect.objectContaining({ identity: IDENTITY }));
    // Forced: a derived map must never outlive the universe it was built from.
    expect(buildMapGraph).toHaveBeenCalledWith(db, { force: true });

    const body = (await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } })).json();
    expect(body.job.status).toBe('done');
    expect(body.job.records).toBe(42);
    expect(body.job.mapSystems).toBe(5);
    expect(body.lastCheck.freshness).toBe('up_to_date');
  });

  it('runs one refresh at a time', async () => {
    const session = asOperator();
    let release = (): void => {};
    downloadSdeArchive.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ dataDir: './data/sde', zipPath: './data/sde/a.zip', identity: IDENTITY });
    }));

    const first = await app.inject({ method: 'POST', url: `${STATUS_URL}/refresh`, headers: mutationHeaders(session) });
    const second = await app.inject({ method: 'POST', url: `${STATUS_URL}/refresh`, headers: mutationHeaders(session) });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('refresh_in_progress');
    expect(second.json().job.status).toBe('running');
    expect(downloadSdeArchive).toHaveBeenCalledTimes(1);

    release();
    await settled();
    expect(getSdeRefreshState().status).toBe('done');
  });

  it('keeps a partial load out of "done" and surfaces the reason', async () => {
    const session = asOperator();
    loadSdeIntoDb.mockResolvedValue({
      totalRecords: 3,
      buildNumber: 'etag:aaa111',
      emptyCriticalTables: ['sde_types', 'sde_systems'],
    });

    await app.inject({ method: 'POST', url: `${STATUS_URL}/refresh`, headers: mutationHeaders(session) });
    await settled();

    const body = (await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } })).json();
    expect(body.job.status).toBe('failed');
    expect(body.job.error).toContain('sde_types');
    expect(buildMapGraph).not.toHaveBeenCalled();
  });

  it('marks a failed download as failed instead of leaving the job running', async () => {
    const session = asOperator();
    downloadSdeArchive.mockRejectedValue(new Error('HTTP 503 from the archive host'));

    await app.inject({ method: 'POST', url: `${STATUS_URL}/refresh`, headers: mutationHeaders(session) });
    await settled();

    const body = (await app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie: session.cookie } })).json();
    expect(body.job.status).toBe('failed');
    expect(body.job.error).toContain('HTTP 503');
    expect(loadSdeIntoDb).not.toHaveBeenCalled();
  });
});
