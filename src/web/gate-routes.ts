import type { FastifyInstance } from 'fastify';
import {
  checkPrivatePassword,
  clearGateCookie,
  clearGateFailures,
  evaluateGateAttempt,
  isPrivateInstance,
  isUnlocked,
  registerGateFailure,
  setGateCookie,
} from './private-gate.js';

/**
 * The only endpoint a locked visitor may call: /api/web/gate.
 *
 * GET reports whether this instance is private and whether this browser is
 * already unlocked — no secret, so the SPA can decide what to render. POST
 * takes the password and, on success, sets the unlock cookie. Wrong attempts
 * are budgeted per client address; the answer never distinguishes "no password
 * configured" from "wrong password" beyond what GET already says.
 */

type GateBody = { password?: unknown };

export function registerGateRoutes(app: FastifyInstance): void {
  app.get('/api/web/gate', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ok: true, private: isPrivateInstance(), unlocked: isUnlocked(request) };
  });

  app.post<{ Body: GateBody }>('/api/web/gate', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isPrivateInstance()) {
      return { ok: true, private: false, unlocked: true };
    }
    const verdict = evaluateGateAttempt(request);
    if (!verdict.allowed) {
      reply.header('Retry-After', String(verdict.retryAfterSeconds));
      return reply.status(429).send({
        error: 'too_many_attempts',
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    }
    if (!checkPrivatePassword(request.body?.password)) {
      registerGateFailure(request);
      return reply.status(401).send({ error: 'invalid_password' });
    }
    clearGateFailures(request);
    setGateCookie(reply);
    return { ok: true, private: true, unlocked: true };
  });

  // Locking this browser again is deliberately unauthenticated: it only drops
  // the caller's own cookie, and a visitor who wants out should not need to be
  // unlocked to do it.
  app.delete('/api/web/gate', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    clearGateCookie(reply);
    return { ok: true, private: isPrivateInstance(), unlocked: false };
  });
}
