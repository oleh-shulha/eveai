import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { config } from '../../src/config.js';
import type { Db } from '../../src/db/sqlite.js';
import {
  isWebAccessEnabled,
  loadWebAccessFlag,
  resetWebAccessCacheForTests,
} from '../../src/agent/web-access.js';
import { registerWebAccessRoutes } from '../../src/web/web-access-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

const ORIGIN = 'http://localhost:3000';
const URL_PATH = '/api/web/settings/web-access';
const OPERATOR_CHARACTER_ID = 95_465_510;

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  resetWebAccessCacheForTests();
  config.web.adminCharacterIds = [];
  config.firecrawl.baseUrl = 'https://firecrawl.test';
  config.firecrawl.apiKey = 'fc-key';
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerWebAccessRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
  config.web.adminCharacterIds = [];
  config.firecrawl.baseUrl = '';
  config.firecrawl.apiKey = '';
  resetWebAccessCacheForTests();
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

describe('web access routes: access', () => {
  it('requires a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: URL_PATH });
    expect(response.statusCode).toBe(401);
  });

  it('hides the switch from a signed-in non-operator', async () => {
    const session = browserSession();
    linkCharacter(session.userId, 90_000_001);
    config.web.adminCharacterIds = [OPERATOR_CHARACTER_ID];

    const status = await app.inject({ method: 'GET', url: URL_PATH, headers: { cookie: session.cookie } });
    const write = await app.inject({
      method: 'PUT', url: URL_PATH, headers: mutationHeaders(session), payload: { allowed: false },
    });

    expect(status.json()).toEqual({ ok: true, admin: false });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toEqual({ error: 'operator_required' });
    expect(isWebAccessEnabled()).toBe(true);
  });

  it('rejects a write that fails origin/CSRF verification', async () => {
    const session = asOperator();

    const response = await app.inject({
      method: 'PUT',
      url: URL_PATH,
      headers: { origin: 'https://evil.example', cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { allowed: false },
    });

    expect(response.statusCode).toBe(403);
    expect(isWebAccessEnabled()).toBe(true);
  });
});

describe('web access routes: the switch', () => {
  it('reports the configured endpoint by host only', async () => {
    const session = asOperator();

    const body = (await app.inject({ method: 'GET', url: URL_PATH, headers: { cookie: session.cookie } })).json();

    expect(body.admin).toBe(true);
    expect(body.state).toEqual({
      configured: true,
      allowed: true,
      enabled: true,
      endpointHost: 'firecrawl.test',
    });
    // The full endpoint and the key are operator infrastructure.
    expect(JSON.stringify(body)).not.toContain('fc-key');
    expect(JSON.stringify(body)).not.toContain('https://firecrawl.test');
  });

  it('switches web access off and keeps it off for the next process', async () => {
    const session = asOperator();

    const response = await app.inject({
      method: 'PUT', url: URL_PATH, headers: mutationHeaders(session), payload: { allowed: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toMatchObject({ allowed: false, enabled: false, configured: true });
    expect(isWebAccessEnabled()).toBe(false);

    resetWebAccessCacheForTests();
    loadWebAccessFlag(db as Db);
    expect(isWebAccessEnabled()).toBe(false);
  });

  it('switches it back on', async () => {
    const session = asOperator();
    await app.inject({ method: 'PUT', url: URL_PATH, headers: mutationHeaders(session), payload: { allowed: false } });

    const response = await app.inject({
      method: 'PUT', url: URL_PATH, headers: mutationHeaders(session), payload: { allowed: true },
    });

    expect(response.json().state.enabled).toBe(true);
    expect(isWebAccessEnabled()).toBe(true);
  });

  it('rejects anything but a boolean switch', async () => {
    const session = asOperator();

    for (const payload of [{ allowed: 'false' }, { allowed: 0 }, {}]) {
      const response = await app.inject({ method: 'PUT', url: URL_PATH, headers: mutationHeaders(session), payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_state' });
    }
    expect(isWebAccessEnabled()).toBe(true);
  });

  it('reports "not configured" while the environment has no endpoint', async () => {
    const session = asOperator();
    config.firecrawl.baseUrl = '';

    const body = (await app.inject({ method: 'GET', url: URL_PATH, headers: { cookie: session.cookie } })).json();

    expect(body.state).toMatchObject({ configured: false, enabled: false, endpointHost: null });
  });
});
