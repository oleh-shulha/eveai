import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { config } from '../../src/config.js';
import type { Db } from '../../src/db/sqlite.js';
import {
  isCharacterAllowed,
  isCharacterAllowlistEnabled,
  registerCharacterAllowlistGate,
  userHasAllowedCharacter,
} from '../../src/web/character-allowlist.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

const OWNER_CHARACTER_ID = 95_465_510;
const STRANGER_CHARACTER_ID = 90_000_001;
const GUARDED_URL = '/api/web/chat';

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

async function buildApp() {
  const instance = Fastify({ bodyLimit: 64 * 1024 });
  await instance.register(fastifyCookie);
  registerCharacterAllowlistGate(instance, db as Db);
  instance.get(GUARDED_URL, async () => ({ ok: true, guarded: true }));
  instance.get('/api/web/market/status', async () => ({ ok: true }));
  instance.get('/api/web/session', async () => ({ ok: true, bootstrap: true }));
  instance.post('/api/web/eve/login', async () => ({ ok: true, sso: true }));
  instance.get('/api/web/gate', async () => ({ ok: true }));
  instance.get('/health', async () => ({ status: 'ok' }));
  return instance;
}

function browserSession() {
  const created = createWebSession(db);
  return {
    cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
    userId: created.userId,
    chatId: created.chatId,
  };
}

function linkAccount(userId: number, characterId: number) {
  db.prepare(`
    INSERT INTO eve_accounts (
      character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
    ) VALUES (?, 'Pilot', 'enc:a', 'enc:r', datetime('now', '+1 hour'), '[]', ?)
  `).run(characterId, userId);
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  config.web.allowedCharacterIds = [OWNER_CHARACTER_ID];
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  db.close();
  config.web.allowedCharacterIds = [];
});

describe('no allowlist configured', () => {
  beforeEach(() => {
    config.web.allowedCharacterIds = [];
  });

  it('lets any character and any guest through', async () => {
    const session = browserSession();

    expect(isCharacterAllowlistEnabled()).toBe(false);
    expect(isCharacterAllowed(STRANGER_CHARACTER_ID)).toBe(true);
    expect(userHasAllowedCharacter(db as Db, session.userId)).toBe(true);
    expect((await app.inject({ method: 'GET', url: GUARDED_URL, headers: { cookie: session.cookie } })).statusCode)
      .toBe(200);
  });
});

describe('character allowlist', () => {
  it('knows which characters are allowed', () => {
    expect(isCharacterAllowlistEnabled()).toBe(true);
    expect(isCharacterAllowed(OWNER_CHARACTER_ID)).toBe(true);
    expect(isCharacterAllowed(STRANGER_CHARACTER_ID)).toBe(false);
  });

  it('refuses a guest session with nothing linked', async () => {
    const session = browserSession();

    const response = await app.inject({ method: 'GET', url: GUARDED_URL, headers: { cookie: session.cookie } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'character_not_allowed' });
  });

  it('refuses a session that linked some other character', async () => {
    const session = browserSession();
    linkAccount(session.userId, STRANGER_CHARACTER_ID);

    const response = await app.inject({ method: 'GET', url: '/api/web/market/status', headers: { cookie: session.cookie } });

    expect(response.statusCode).toBe(403);
    expect(userHasAllowedCharacter(db as Db, session.userId)).toBe(false);
  });

  it('lets the owner through once the allowed character is linked', async () => {
    const session = browserSession();
    linkAccount(session.userId, OWNER_CHARACTER_ID);

    const response = await app.inject({ method: 'GET', url: GUARDED_URL, headers: { cookie: session.cookie } });

    expect(response.statusCode).toBe(200);
    expect(userHasAllowedCharacter(db as Db, session.userId)).toBe(true);
  });

  it('also accepts a character attached through a chat lane link', async () => {
    const session = browserSession();
    linkAccount(999, OWNER_CHARACTER_ID);
    db.prepare(`
      INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)
    `).run(session.chatId, OWNER_CHARACTER_ID, session.userId);

    expect(userHasAllowedCharacter(db as Db, session.userId)).toBe(true);
  });

  it('keeps the way in open: session bootstrap, SSO start, and the private gate', async () => {
    const session = browserSession();

    const bootstrap = await app.inject({ method: 'GET', url: '/api/web/session', headers: { cookie: session.cookie } });
    const sso = await app.inject({ method: 'POST', url: '/api/web/eve/login', headers: { cookie: session.cookie } });
    const gate = await app.inject({ method: 'GET', url: '/api/web/gate' });
    const health = await app.inject({ method: 'GET', url: '/health' });

    expect(bootstrap.statusCode).toBe(200);
    expect(sso.statusCode).toBe(200);
    expect(gate.statusCode).toBe(200);
    expect(health.statusCode).toBe(200);
  });

  it('leaves a request without a session to the route guards', async () => {
    // No cookie at all: the route answers 401 in its own words rather than
    // this hook claiming the character is wrong.
    const response = await app.inject({ method: 'GET', url: GUARDED_URL });

    expect(response.statusCode).toBe(200);
  });
});
