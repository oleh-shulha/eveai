import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { config } from '../../src/config.js';
import { registerGateRoutes } from '../../src/web/gate-routes.js';
import { GATE_COOKIE, registerPrivateGate, resetGateAttemptsForTests } from '../../src/web/private-gate.js';

const PASSWORD = 'aincrad-secret';
const GATE_URL = '/api/web/gate';
const GUARDED_URL = '/api/web/session';

let app: ReturnType<typeof Fastify>;

/** The gate wraps the real route surface, so the probes stand in for it. */
async function buildApp() {
  const instance = Fastify({ bodyLimit: 64 * 1024 });
  await instance.register(fastifyCookie);
  registerPrivateGate(instance);
  registerGateRoutes(instance);
  instance.get(GUARDED_URL, async () => ({ ok: true, guarded: true }));
  instance.get('/api/web/market/status', async () => ({ ok: true }));
  instance.get('/health', async () => ({ status: 'ok' }));
  instance.get('/auth/eve/callback', async () => ({ ok: true, sso: true }));
  instance.get('/app', async () => 'spa shell');
  return instance;
}

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw ?? '')];
  const gate = values.find((value) => value.startsWith(`${GATE_COOKIE}=`)) ?? '';
  return gate.split(';')[0] ?? '';
}

async function unlockedCookie(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: GATE_URL, payload: { password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  return cookieFrom(response);
}

beforeEach(async () => {
  resetGateAttemptsForTests();
  config.web.privatePassword = PASSWORD;
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  config.web.privatePassword = '';
  resetGateAttemptsForTests();
});

describe('public instance', () => {
  beforeEach(() => {
    config.web.privatePassword = '';
  });

  it('guards nothing and says it is not private', async () => {
    const guarded = await app.inject({ method: 'GET', url: GUARDED_URL });
    const status = await app.inject({ method: 'GET', url: GATE_URL });

    expect(guarded.statusCode).toBe(200);
    expect(status.json()).toEqual({ ok: true, private: false, unlocked: true });
  });

  it('answers a posted password without pretending to lock anything', async () => {
    const response = await app.inject({ method: 'POST', url: GATE_URL, payload: { password: 'whatever' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, private: false, unlocked: true });
    expect(cookieFrom(response)).toBe('');
  });
});

describe('private instance', () => {
  it('locks the browser API until the password is entered', async () => {
    for (const url of [GUARDED_URL, '/api/web/market/status']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(403);
      expect(response.json()).toEqual({ error: 'unlock_required' });
    }

    const status = await app.inject({ method: 'GET', url: GATE_URL });
    expect(status.json()).toEqual({ ok: true, private: true, unlocked: false });
  });

  it('keeps the SSO flow, health and the app shell reachable', async () => {
    // CCP redirects to the callback, and a Telegram or CLI login opens it in a
    // browser that was never unlocked.
    for (const url of ['/auth/eve/callback', '/health', '/app']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it('refuses the wrong password and lets the right one in', async () => {
    const wrong = await app.inject({ method: 'POST', url: GATE_URL, payload: { password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'invalid_password' });
    expect(cookieFrom(wrong)).toBe('');

    const cookie = await unlockedCookie();
    const guarded = await app.inject({ method: 'GET', url: GUARDED_URL, headers: { cookie } });

    expect(guarded.statusCode).toBe(200);
    expect(guarded.json()).toEqual({ ok: true, guarded: true });
  });

  it('never puts the password in the cookie', async () => {
    const cookie = await unlockedCookie();

    expect(cookie).toContain(`${GATE_COOKIE}=`);
    expect(cookie).not.toContain(PASSWORD);
  });

  it('marks the unlock cookie HttpOnly and same-site', async () => {
    const response = await app.inject({ method: 'POST', url: GATE_URL, payload: { password: PASSWORD } });
    const raw = response.headers['set-cookie'];
    const header = (Array.isArray(raw) ? raw : [String(raw)]).find((value) => value.startsWith(`${GATE_COOKIE}=`))!;

    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
  });

  it('reports an unlocked browser back to the client', async () => {
    const cookie = await unlockedCookie();

    const status = await app.inject({ method: 'GET', url: GATE_URL, headers: { cookie } });

    expect(status.json()).toEqual({ ok: true, private: true, unlocked: true });
  });

  it('rejects a forged or tampered cookie', async () => {
    const cookie = await unlockedCookie();
    const tampered = cookie.replace(/.$/, 'x');

    for (const value of [`${GATE_COOKIE}=garbage`, `${GATE_COOKIE}=v1.9999999999999.forged`, tampered]) {
      const response = await app.inject({ method: 'GET', url: GUARDED_URL, headers: { cookie: value } });
      expect(response.statusCode, value).toBe(403);
    }
  });

  it('locks every browser out again when the password changes', async () => {
    const cookie = await unlockedCookie();
    expect((await app.inject({ method: 'GET', url: GUARDED_URL, headers: { cookie } })).statusCode).toBe(200);

    config.web.privatePassword = 'a-different-password';

    expect((await app.inject({ method: 'GET', url: GUARDED_URL, headers: { cookie } })).statusCode).toBe(403);
  });

  it('drops the cookie on request so a shared browser can be locked again', async () => {
    const response = await app.inject({ method: 'DELETE', url: GATE_URL });

    expect(response.json()).toEqual({ ok: true, private: true, unlocked: false });
    const raw = response.headers['set-cookie'];
    expect((Array.isArray(raw) ? raw.join(';') : String(raw))).toContain(`${GATE_COOKIE}=`);
  });

  it('budgets wrong attempts per client and then refuses even the right password', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await app.inject({ method: 'POST', url: GATE_URL, payload: { password: `guess-${attempt}` } });
      expect(response.statusCode).toBe(401);
    }

    const locked = await app.inject({ method: 'POST', url: GATE_URL, payload: { password: PASSWORD } });

    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toBe('too_many_attempts');
    expect(Number(locked.json().retryAfterSeconds)).toBeGreaterThan(0);
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it('rejects a missing or non-string password without counting it as a match', async () => {
    for (const payload of [{}, { password: 12345 }, { password: null }]) {
      const response = await app.inject({ method: 'POST', url: GATE_URL, payload });
      expect(response.statusCode).toBe(401);
    }
  });
});
