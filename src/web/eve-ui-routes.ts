import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { getLinkedCharacter } from '../eve/sso.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { requireMutationSession } from './web-route-guards.js';

/**
 * "Open this in my EVE client" from the browser.
 *
 * The client has no URL scheme to hand a link to, so the supported channel is
 * ESI's own UI endpoints: the server asks CCP, CCP tells the running client.
 * Telegram and Discord have had this for a while as `/market` and `/info`; this
 * is the same two calls behind a browser session.
 *
 * Three properties this route keeps:
 * - it is a mutation of the pilot's client, so it needs the CSRF/origin check
 *   and a linked character with `esi-ui.open_window.v1` — never the model's
 *   decision, always a human click;
 * - the id is validated here, not trusted from the page;
 * - it answers with a machine-readable code, because "client not running" is
 *   the common case and deserves its own sentence in the UI rather than a raw
 *   ESI error.
 */

const OPEN_WINDOW_SCOPE = 'esi-ui.open_window.v1';

type UiActionBody = {
  action?: unknown;
  id?: unknown;
};

const ACTIONS = {
  // A type: opens the market details window for it.
  market: { operation: 'post_ui_openwindow_marketdetails', argument: 'type_id' },
  // A character, corporation or alliance: opens its information window.
  info: { operation: 'post_ui_openwindow_information', argument: 'target_id' },
} as const;

type UiActionName = keyof typeof ACTIONS;

function isUiAction(value: unknown): value is UiActionName {
  return typeof value === 'string' && Object.hasOwn(ACTIONS, value);
}

export function registerEveUiRoutes(app: FastifyInstance, db: Db): void {
  app.post<{ Body: UiActionBody }>('/api/web/eve/ui', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    reply.header('Cache-Control', 'no-store');

    const action = request.body?.action;
    const id = request.body?.id;
    if (!isUiAction(action)) {
      return reply.status(400).send({ error: 'unknown_action' });
    }
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'invalid_id' });
    }

    const ctx = { userId: session.userId, chatId: session.chatId, notificationCapability: 'web' as const };
    const linked = getLinkedCharacter(db, ctx);
    if (!linked) {
      return reply.status(403).send({ error: 'character_required' });
    }
    if (!linked.scopes.includes(OPEN_WINDOW_SCOPE)) {
      return reply.status(403).send({ error: 'scope_required', scope: OPEN_WINDOW_SCOPE });
    }

    const { operation, argument } = ACTIONS[action];
    const result = await callEsiOperation(db, operation, { [argument]: id }, ctx);
    if (!result.ok) {
      // ESI answers 5xx-ish when the client is not running or not logged in as
      // this character. That is an expected everyday state, not a fault.
      const code = result.status >= 500 || result.status === 0 ? 'client_unavailable' : 'esi_refused';
      return reply.status(result.status === 403 ? 403 : 502).send({ error: code, status: result.status });
    }
    return { ok: true, action, id, character: { id: linked.characterId, name: linked.characterName } };
  });
}
