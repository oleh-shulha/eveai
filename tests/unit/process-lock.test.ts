import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  acquireRuntimeLock,
  acquireRuntimeLockWaiting,
  RuntimeLockError,
} from '../../src/runtime/process-lock.js';

let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('runtime process lock', () => {
  it('blocks a second live owner and releases for the next runtime', () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    const first = acquireRuntimeLock(dbPath, 'first');
    expect(() => acquireRuntimeLock(dbPath, 'second')).toThrow(RuntimeLockError);
    first.release();
    const second = acquireRuntimeLock(dbPath, 'second');
    second.release();
  });

  it('atomically reclaims a stale owner directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    const lockPath = `${dbPath}.runtime.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      pid: 999_999_999,
      token: 'stale',
      runtime: 'crashed',
      createdAt: '2026-01-01T00:00:00.000Z',
      processStartedAt: 1,
    }));

    const lock = acquireRuntimeLock(dbPath, 'replacement');
    expect(lock.path).toBe(lockPath);
    lock.release();
  });

  /** A lock left by another container: its pid means nothing in this namespace. */
  function seedForeignLock(
    dbPath: string,
    heartbeatAgeMs: number,
    host = 'other-container',
    processStartedAt = 1,
  ) {
    const lockPath = `${dbPath}.runtime.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      // Deliberately this process's own pid: the foreign branch must not look
      // at it, or a redeploying container reads its own liveness as the owner's.
      pid: process.pid,
      token: 'foreign',
      runtime: 'bot service',
      createdAt: new Date(Date.now() - heartbeatAgeMs).toISOString(),
      processStartedAt,
      host,
      heartbeatAt: new Date(Date.now() - heartbeatAgeMs).toISOString(),
    }));
    return lockPath;
  }

  it('records the host and a heartbeat so another container can judge it', () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');

    const lock = acquireRuntimeLock(dbPath, 'bot service');
    const owner = JSON.parse(readFileSync(join(lock.path, 'owner.json'), 'utf8')) as {
      host: string;
      heartbeatAt: string;
    };

    expect(owner.host).toBe(hostname());
    expect(Date.now() - Date.parse(owner.heartbeatAt)).toBeLessThan(5_000);
    lock.release();
  });

  it('refuses a lock another container is still heartbeating', () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    seedForeignLock(dbPath, 5_000);

    expect(() => acquireRuntimeLock(dbPath, 'bot service'))
      .toThrow(/already owned by bot service on other-container \(last heartbeat \d+s ago\)/);
  });

  it('reclaims a lock whose container stopped heartbeating', () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    // Two minutes of silence: that container is gone, whatever its pid looks
    // like here. This is the redeploy case that used to refuse to start.
    seedForeignLock(dbPath, 120_000);

    const lock = acquireRuntimeLock(dbPath, 'bot service');

    expect(lock.path).toBe(`${dbPath}.runtime.lock`);
    lock.release();
  });

  it('keeps pid identity authoritative for a lock from this host', () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    // Same host, silent for two minutes, but the recorded process really is
    // alive and really did start when the lock says: the pid check still wins,
    // so a busy bare-metal owner is never stolen from over a missed heartbeat.
    const selfStartedAt = Math.floor((Date.now() - process.uptime() * 1_000) / 1_000);
    seedForeignLock(dbPath, 120_000, hostname(), selfStartedAt);

    expect(() => acquireRuntimeLock(dbPath, 'bot service'))
      .toThrow(/already owned by bot service \(pid \d+\)/);
  });

  it('waits for a lock the previous owner is about to release', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    const first = acquireRuntimeLock(dbPath, 'bot service');
    setTimeout(() => first.release(), 1_200);

    const second = await acquireRuntimeLockWaiting(dbPath, 'bot service', 10_000);

    expect(second.path).toBe(`${dbPath}.runtime.lock`);
    second.release();
  });

  it('gives up once the wait window closes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    const first = acquireRuntimeLock(dbPath, 'bot service');

    await expect(acquireRuntimeLockWaiting(dbPath, 'bot service', 1_000))
      .rejects.toThrow(RuntimeLockError);

    first.release();
  });

  it('reclaims a crashed owner when its pid has been reused', () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    const lockPath = `${dbPath}.runtime.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'crashed-owner',
      runtime: 'crashed',
      createdAt: '2026-01-01T00:00:00.000Z',
      processStartedAt: 1,
    }));

    const lock = acquireRuntimeLock(dbPath, 'replacement');
    expect(lock.path).toBe(lockPath);
    lock.release();
  });
});
