import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';

const callEsiOperation = vi.fn();

vi.mock('../../src/eve/esi-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/eve/esi-client.js')>();
  return { ...actual, callEsiOperation };
});

const { SCHEMA_SQL } = await import('../../src/db/schema.js');
const { runMigrations } = await import('../../src/db/migrations.js');
const { registerEveUiRoutes } = await import('../../src/web/eve-ui-routes.js');
const {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} = await import('../../src/web/web-session.js');

const ORIGIN = 'http://localhost:3000';
const URL_PATH = '/api/web/eve/ui';
const CHARACTER_ID = 95_465_510;
const OPEN_WINDOW_SCOPE = 'esi-ui.open_window.v1';

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  callEsiOperation.mockReset();
  callEsiOperation.mockResolvedValue({ ok: true, status: 204, data: null });
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerEveUiRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
});

function browserSession() {
  const created = createWebSession(db);
  return {
    cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
    csrf: created.csrfToken,
    userId: created.userId,
    chatId: created.chatId,
  };
}

function headers(session: ReturnType<typeof browserSession>) {
  return { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrf };
}

function linkCharacter(session: ReturnType<typeof browserSession>, scopes: string[]) {
  db.prepare(`
    INSERT INTO eve_accounts (
      character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
    ) VALUES (?, 'Flexson', 'enc:a', 'enc:r', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify(scopes), session.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_ID, session.userId);
}

describe('open in client: access', () => {
  it('requires a browser session', async () => {
    const response = await app.inject({ method: 'POST', url: URL_PATH, payload: { action: 'market', id: 34 } });

    expect(response.statusCode).toBe(401);
    expect(callEsiOperation).not.toHaveBeenCalled();
  });

  it('requires the CSRF/origin check, because this writes to the pilot client', async () => {
    const session = browserSession();
    linkCharacter(session, [OPEN_WINDOW_SCOPE]);

    const response = await app.inject({
      method: 'POST',
      url: URL_PATH,
      headers: { origin: 'https://evil.example', cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { action: 'market', id: 34 },
    });

    expect(response.statusCode).toBe(403);
    expect(callEsiOperation).not.toHaveBeenCalled();
  });

  it('needs a linked character', async () => {
    const session = browserSession();

    const response = await app.inject({ method: 'POST', url: URL_PATH, headers: headers(session), payload: { action: 'market', id: 34 } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'character_required' });
    expect(callEsiOperation).not.toHaveBeenCalled();
  });

  it('needs the window scope that character actually granted', async () => {
    const session = browserSession();
    linkCharacter(session, ['esi-location.read_location.v1']);

    const response = await app.inject({ method: 'POST', url: URL_PATH, headers: headers(session), payload: { action: 'market', id: 34 } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'scope_required', scope: OPEN_WINDOW_SCOPE });
    expect(callEsiOperation).not.toHaveBeenCalled();
  });
});

describe('open in client: actions', () => {
  it('opens the market window for a type', async () => {
    const session = browserSession();
    linkCharacter(session, [OPEN_WINDOW_SCOPE]);

    const response = await app.inject({ method: 'POST', url: URL_PATH, headers: headers(session), payload: { action: 'market', id: 4246 } });

    expect(response.statusCode).toBe(200);
    expect(callEsiOperation).toHaveBeenCalledWith(
      db,
      'post_ui_openwindow_marketdetails',
      { type_id: 4246 },
      expect.objectContaining({ userId: session.userId }),
    );
    expect(response.json()).toMatchObject({ ok: true, action: 'market', id: 4246 });
  });

  it('opens the information window for an entity', async () => {
    const session = browserSession();
    linkCharacter(session, [OPEN_WINDOW_SCOPE]);

    await app.inject({ method: 'POST', url: URL_PATH, headers: headers(session), payload: { action: 'info', id: CHARACTER_ID } });

    expect(callEsiOperation).toHaveBeenCalledWith(
      db,
      'post_ui_openwindow_information',
      { target_id: CHARACTER_ID },
      expect.anything(),
    );
  });

  it('reports a closed client as its own state, not a generic failure', async () => {
    const session = browserSession();
    linkCharacter(session, [OPEN_WINDOW_SCOPE]);
    callEsiOperation.mockResolvedValue({ ok: false, status: 520, error: 'ESI had a problem' });

    const response = await app.inject({ method: 'POST', url: URL_PATH, headers: headers(session), payload: { action: 'market', id: 34 } });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: 'client_unavailable' });
  });

  it('sets a system as the autopilot destination', async () => {
    const session = browserSession();
    linkCharacter(session, ['esi-ui.write_waypoint.v1']);

    const response = await app.inject({
      method: 'POST', url: URL_PATH, headers: headers(session), payload: { action: 'waypoint', id: 30000142 },
    });

    expect(response.statusCode).toBe(200);
    expect(callEsiOperation).toHaveBeenCalledWith(
      db,
      'post_ui_autopilot_waypoint',
      { destination_id: 30000142, clear_other_waypoints: true, add_to_beginning: false },
      expect.anything(),
    );
  });

  it('asks for the waypoint scope, not the window scope, before routing', async () => {
    const session = browserSession();
    linkCharacter(session, [OPEN_WINDOW_SCOPE]);

    const response = await app.inject({
      method: 'POST', url: URL_PATH, headers: headers(session), payload: { action: 'waypoint', id: 30000142 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'scope_required', scope: 'esi-ui.write_waypoint.v1' });
    expect(callEsiOperation).not.toHaveBeenCalled();
  });

  it('rejects an unknown action and a junk id before calling ESI', async () => {
    const session = browserSession();
    linkCharacter(session, [OPEN_WINDOW_SCOPE]);

    for (const payload of [
      { action: 'delete_everything', id: 1 },
      { action: 'market', id: -3 },
      { action: 'market', id: 1.5 },
      { action: 'market' },
    ]) {
      const response = await app.inject({ method: 'POST', url: URL_PATH, headers: headers(session), payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(callEsiOperation).not.toHaveBeenCalled();
  });
});

describe('systems named in an answer', () => {
  it('resolves them from the local SDE for a signed-in reader', async () => {
    const session = browserSession();
    db.prepare("INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (30000142, 'Jita', 1, '{}')").run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/eve/systems/resolve',
      headers: { cookie: session.cookie },
      payload: { text: 'Маршрут Jita → Villore' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, systems: [{ systemId: 30000142, name: 'Jita' }] });
  });

  it('needs a session and a string', async () => {
    const session = browserSession();

    const anonymous = await app.inject({ method: 'POST', url: '/api/web/eve/systems/resolve', payload: { text: 'Jita' } });
    const junk = await app.inject({
      method: 'POST',
      url: '/api/web/eve/systems/resolve',
      headers: { cookie: session.cookie },
      payload: { text: 42 },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(junk.statusCode).toBe(400);
  });
});
