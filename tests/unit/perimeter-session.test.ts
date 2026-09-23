import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { registerWebChatRoutes } from '../../src/web/chat-routes.js';
import { registerMapRoutes, __testables } from '../../src/web/map-routes.js';
import type { WebAgentRequestCoordinator } from '../../src/web/agent-requests.js';
import { createWebSession, WEB_SESSION_COOKIE } from '../../src/web/web-session.js';
import { getOrCreatePerimeterThread } from '../../src/eve-map/thread.js';

let db: Database.Database;
let app: ReturnType<typeof Fastify>;
const readActive = vi.fn();

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  app = Fastify();
  await app.register(fastifyCookie);
  registerWebChatRoutes(app, db);
  readActive.mockReset().mockReturnValue(null);
  registerMapRoutes(app, db, { readActive } as unknown as WebAgentRequestCoordinator);
});

afterEach(async () => {
  await app.close();
  db.close();
});

function session() {
  const created = createWebSession(db);
  const row = db.prepare('SELECT user_id, chat_id FROM web_sessions ORDER BY rowid DESC LIMIT 1')
    .get() as { user_id: number; chat_id: number };
  return {
    owner: { userId: row.user_id, chatId: row.chat_id, characterId: null },
    headers: {
      origin: 'http://localhost:3000',
      cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
      'x-csrf-token': created.csrfToken,
    },
  };
}

describe('stable Perimeter session', () => {
  it('keeps the fixed title after user messages and never reuses it for ordinary chats', async () => {
    const { headers } = session();
    const map = await app.inject({ url: '/api/web/map/chat', headers });
    const perimeterId = map.json().threadId as string;
    const ordinary = await app.inject({ method: 'POST', url: '/api/web/conversations', headers });
    expect(ordinary.statusCode).toBe(201);
    expect(ordinary.json().threadId).not.toBe(perimeterId);
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', ?)")
      .run(perimeterId, 'Привет, у тебя есть интернет?');
    const list = await app.inject({ url: '/api/web/conversations', headers });
    expect(list.json().conversations).toContainEqual(expect.objectContaining({
      id: perimeterId, kind: 'perimeter', title: 'Периметр',
    }));
    const again = await app.inject({ url: '/api/web/map/chat', headers });
    expect(again.json().threadId).toBe(perimeterId);
  });

  it('clears history and model context in the same session without touching another character', async () => {
    const { headers, owner } = session();
    const response = await app.inject({ url: '/api/web/map/chat', headers });
    const threadId = response.json().threadId as string;
    const otherId = getOrCreatePerimeterThread(db, owner.chatId, owner.userId, 90000001);
    const insert = db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', 'old')");
    const messageId = insert.run(threadId).lastInsertRowid;
    insert.run(otherId);
    db.prepare('INSERT INTO thread_summaries (thread_id, summary, last_message_id) VALUES (?, ?, ?)')
      .run(threadId, 'old summary', messageId);
    db.prepare('INSERT INTO thread_artifacts (thread_id, artifact_kind, content) VALUES (?, ?, ?)')
      .run(threadId, 'test', 'old artifact');
    db.prepare('UPDATE agent_threads SET last_response_id = ?, last_response_message_id = ?, total_tokens = 100 WHERE thread_id = ?')
      .run('old-response', messageId, threadId);

    for (let attempt = 0; attempt < 2; attempt++) {
      const reset = await app.inject({ method: 'POST', url: '/api/web/map/chat/reset', headers });
      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toEqual({ threadId, messages: [] });
    }
    expect(db.prepare('SELECT last_response_id, last_response_message_id, total_tokens FROM agent_threads WHERE thread_id = ?')
      .get(threadId)).toEqual({ last_response_id: null, last_response_message_id: null, total_tokens: 0 });
    expect(db.prepare('SELECT * FROM thread_summaries WHERE thread_id = ?').all(threadId)).toEqual([]);
    expect(db.prepare('SELECT * FROM thread_artifacts WHERE thread_id = ?').all(threadId)).toEqual([]);
    expect(db.prepare('SELECT thread_id FROM messages').all()).toEqual([{ thread_id: otherId }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_threads').get()).toEqual({ n: 2 });
  });

  it('refuses clearing without CSRF or while a request is active', async () => {
    const { headers, owner } = session();
    const response = await app.inject({ url: '/api/web/map/chat', headers });
    const threadId = response.json().threadId as string;
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', 'keep')").run(threadId);
    const forbidden = await app.inject({
      method: 'POST', url: '/api/web/map/chat/reset',
      headers: { origin: headers.origin, cookie: headers.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    readActive.mockReturnValue({ requestId: 'running' });
    const busy = await app.inject({ method: 'POST', url: '/api/web/map/chat/reset', headers });
    expect(busy.statusCode).toBe(409);
    expect(readActive).toHaveBeenCalledWith({ userId: owner.userId, chatId: owner.chatId }, threadId);
    expect(db.prepare('SELECT content FROM messages WHERE thread_id = ?').all(threadId)).toEqual([{ content: 'keep' }]);
  });

  it('recreates a deleted thread for live advisories and reuses that replacement for history', async () => {
    const { headers, owner } = session();
    const other = session();
    const otherId = getOrCreatePerimeterThread(db, other.owner.chatId, other.owner.userId, null);
    const response = await app.inject({ url: '/api/web/map/chat', headers });
    const oldId = response.json().threadId as string;
    const deleted = await app.inject({ method: 'DELETE', url: `/api/web/conversations/${oldId}`, headers });
    expect(deleted.statusCode).toBe(204);
    const send = vi.fn();
    const stream = { closed: false, send, close: vi.fn(), onClose: vi.fn(), abortBeforeStart: vi.fn() };
    for (let index = 0; index < 2; index++) {
      __testables.publishAdvisory(db, owner, {
        rule: 'camp_next_hop', severity: 'danger', text: { ru: 'Кемп', en: 'Camp' },
        systemId: 30000142, killmailId: null, repeats: 0, at: new Date().toISOString(),
      }, 'ru', stream);
    }
    expect(send).toHaveBeenCalledTimes(2);
    const history = await app.inject({ url: '/api/web/map/chat', headers });
    expect(history.json().threadId).not.toBe(oldId);
    expect(history.json().messages).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_threads WHERE chat_id = ?').get(owner.chatId)).toEqual({ n: 1 });
    expect(getOrCreatePerimeterThread(db, other.owner.chatId, other.owner.userId, null)).toBe(otherId);
  });
});
