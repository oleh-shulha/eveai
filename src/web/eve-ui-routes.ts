import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { getLinkedCharacter } from '../eve/sso.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { findSystemMentions } from '../eve/system-mentions.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';

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
const WAYPOINT_SCOPE = 'esi-ui.write_waypoint.v1';
const MAX_RESOLVE_CHARS = 20_000;

type UiActionBody = {
  action?: unknown;
  id?: unknown;
};

const ACTIONS = {
  // A type: opens the market details window for it.
  market: {
    operation: 'post_ui_openwindow_marketdetails',
    scope: OPEN_WINDOW_SCOPE,
    body: (id: number) => ({ type_id: id }),
  },
  // A character, corporation or alliance: opens its information window.
  info: {
    operation: 'post_ui_openwindow_information',
    scope: OPEN_WINDOW_SCOPE,
    body: (id: number) => ({ target_id: id }),
  },
  // A solar system: makes it the autopilot destination, replacing the route
  // that was set. Same call the route planner makes for its final hop.
  waypoint: {
    operation: 'post_ui_autopilot_waypoint',
    scope: WAYPOINT_SCOPE,
    body: (id: number) => ({ destination_id: id, clear_other_waypoints: true, add_to_beginning: false }),
  },
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
    const { operation, scope, body } = ACTIONS[action];
    if (!linked.scopes.includes(scope)) {
      return reply.status(403).send({ error: 'scope_required', scope });
    }

    const result = await callEsiOperation(db, operation, body(id), ctx);
    if (!result.ok) {
      // ESI answers 5xx-ish when the client is not running or not logged in as
      // this character. That is an expected everyday state, not a fault.
      const code = result.status >= 500 || result.status === 0 ? 'client_unavailable' : 'esi_refused';
      return reply.status(result.status === 403 ? 403 : 502).send({ error: code, status: result.status });
    }
    return { ok: true, action, id, character: { id: linked.characterId, name: linked.characterName } };
  });

  /**
   * Which solar systems an answer names, so the chat can offer to act on them.
   * A read, and deliberately not a mutation: the text comes from the page, the
   * ids come from the local SDE, and nothing is sent to the client until the
   * pilot presses something.
   */
  app.post<{ Body: { text?: unknown } }>('/api/web/eve/systems/resolve', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    reply.header('Cache-Control', 'no-store');
    const text = request.body?.text;
    if (typeof text !== 'string') {
      return reply.status(400).send({ error: 'invalid_text' });
    }
    return { ok: true, systems: findSystemMentions(db, text.slice(0, MAX_RESOLVE_CHARS)) };
  });
}
