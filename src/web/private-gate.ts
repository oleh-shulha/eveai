import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { buildWebClientIpKey } from './web-session.js';

/**
 * Private instance gate: a shared password in front of the browser API.
 *
 * Set PRIVATE_PASSWORD and every /api/web/* route answers `unlock_required`
 * until the visitor enters it once. The unlock is a signed cookie, so the
 * browser keeps it and the app then behaves exactly as before.
 *
 * What stays open on purpose:
 * - the SPA shell and its assets, so the unlock form can render;
 * - /health, for the operator's own probes;
 * - the whole /auth/eve/* SSO flow and its /callback, because CCP redirects
 *   there and a Telegram or CLI login opens it in a browser that was never
 *   unlocked. Those endpoints are already bound to a one-time state token
 *   issued from an authorized lane, so they are not a way in.
 *
 * The cookie carries no password: it is an expiry plus an HMAC over that expiry
 * and a fingerprint of the configured password, keyed by AUTH_SECRET_KEY.
 * Changing PRIVATE_PASSWORD therefore locks every browser out again.
 */

export const GATE_COOKIE = 'eveai_gate';

const TOKEN_VERSION = 'v1';
const FINGERPRINT_CHARS = 16;

/** Failure budget per client address: a shared password must not be brute-forceable. */
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60_000;
const LOCKOUT_MS = 15 * 60_000;
const MAX_TRACKED_CLIENTS = 10_000;

type AttemptRecord = { failures: number; firstFailureAt: number; lockedUntil: number };

const attempts = new Map<string, AttemptRecord>();

export function isPrivateInstance(): boolean {
  return config.web.privatePassword.length > 0;
}

export function isUnlocked(request: FastifyRequest): boolean {
  if (!isPrivateInstance()) return true;
  return verifyGateToken(request.cookies[GATE_COOKIE]);
}

export function checkPrivatePassword(candidate: unknown): boolean {
  if (!isPrivateInstance() || typeof candidate !== 'string') return false;
  // Digests, so the comparison never leaks the password's length.
  const expected = sha256(config.web.privatePassword);
  const given = sha256(candidate);
  return timingSafeEqual(expected, given);
}

export function setGateCookie(reply: FastifyReply): void {
  const ttlSeconds = config.web.privateUnlockTtlHours * 60 * 60;
  reply.setCookie(GATE_COOKIE, mintGateToken(Date.now() + ttlSeconds * 1000), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.web.baseUrl.startsWith('https://'),
    maxAge: ttlSeconds,
  });
}

export function clearGateCookie(reply: FastifyReply): void {
  reply.clearCookie(GATE_COOKIE, {
    path: '/',
    secure: config.web.baseUrl.startsWith('https://'),
  });
}

export type GateAttemptVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export function registerGateFailure(request: FastifyRequest, now = Date.now()): void {
  const key = buildWebClientIpKey(request.ip);
  const record = attempts.get(key);
  if (!record || now - record.firstFailureAt > FAILURE_WINDOW_MS) {
    pruneAttempts(now);
    attempts.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
    return;
  }
  record.failures += 1;
  if (record.failures >= MAX_FAILURES) {
    record.lockedUntil = now + LOCKOUT_MS;
    record.failures = 0;
    record.firstFailureAt = now;
  }
}

export function evaluateGateAttempt(request: FastifyRequest, now = Date.now()): GateAttemptVerdict {
  const record = attempts.get(buildWebClientIpKey(request.ip));
  if (!record || record.lockedUntil <= now) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.ceil((record.lockedUntil - now) / 1000) };
}

export function clearGateFailures(request: FastifyRequest): void {
  attempts.delete(buildWebClientIpKey(request.ip));
}

/** Test seam: the failure budget is process-wide. */
export function resetGateAttemptsForTests(): void {
  attempts.clear();
}

/**
 * Guards the browser API only. Static assets, /health and the SSO flow stay
 * reachable; everything the app actually does lives under /api/web/.
 */
export function registerPrivateGate(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isPrivateInstance()) return;
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/web/')) return;
    if (path === '/api/web/gate') return;
    if (isUnlocked(request)) return;
    await reply.status(403).send({ error: 'unlock_required' });
  });
}

function mintGateToken(expiresAtMs: number): string {
  const expiry = String(Math.floor(expiresAtMs));
  return `${TOKEN_VERSION}.${expiry}.${signGatePayload(expiry)}`;
}

function verifyGateToken(raw: string | undefined): boolean {
  if (!raw) return false;
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return false;
  const [, expiry, signature] = parts as [string, string, string];
  if (!/^\d+$/.test(expiry) || Number(expiry) <= Date.now()) return false;
  const expected = Buffer.from(signGatePayload(expiry), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

function signGatePayload(expiry: string): string {
  const secret = config.auth.secretKey.trim() || config.web.privatePassword;
  return createHmac('sha256', secret)
    .update(`gate:${TOKEN_VERSION}:${passwordFingerprint()}:${expiry}`)
    .digest('base64url');
}

function passwordFingerprint(): string {
  return sha256(config.web.privatePassword).toString('base64url').slice(0, FINGERPRINT_CHARS);
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function pruneAttempts(now: number): void {
  if (attempts.size < MAX_TRACKED_CLIENTS) return;
  for (const [key, record] of attempts) {
    if (record.lockedUntil <= now && now - record.firstFailureAt > FAILURE_WINDOW_MS) {
      attempts.delete(key);
    }
  }
}
