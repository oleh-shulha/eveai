import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import {
  compareSdeIdentity,
  deriveSdeBuildNumber,
  fetchSdeUpstreamIdentity,
  identityFromHeaders,
  readSdeSnapshot,
  writeSdeSnapshot,
  type SdeUpstreamIdentity,
} from '../../src/eve/sde-source.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

const IDENTITY: SdeUpstreamIdentity = {
  lastModified: 'Tue, 01 Sep 2026 10:00:00 GMT',
  etag: 'aaa111',
  bytes: 104_857_600,
};

describe('SDE upstream identity', () => {
  it('reads and normalizes the archive validators', () => {
    const identity = identityFromHeaders(new Headers({
      'last-modified': 'Tue, 01 Sep 2026 10:00:00 GMT',
      etag: 'W/"aaa111"',
      'content-length': '104857600',
    }));

    expect(identity).toEqual(IDENTITY);
  });

  it('keeps unusable header values null instead of guessing', () => {
    const identity = identityFromHeaders(new Headers({ 'content-length': 'chunked' }));

    expect(identity).toEqual({ lastModified: null, etag: null, bytes: null });
  });

  it('falls back to a one-byte range when the CDN refuses HEAD', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 405 });
      expect((init?.headers as Record<string, string>).Range).toBe('bytes=0-0');
      return new Response('x', { status: 206, headers: { etag: '"bbb222"', 'content-length': '1' } });
    }) as unknown as typeof fetch;

    const identity = await fetchSdeUpstreamIdentity(fetchImpl);

    // The slice's length says nothing about the archive, so it is not kept.
    expect(identity).toEqual({ lastModified: null, etag: 'bbb222', bytes: null });
  });

  it('reports a failed check instead of answering "current"', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

    await expect(fetchSdeUpstreamIdentity(fetchImpl)).rejects.toThrow('HTTP 503');
  });
});

describe('SDE freshness comparison', () => {
  it('treats a never-loaded snapshot as an update', () => {
    expect(compareSdeIdentity(null, IDENTITY)).toBe('update_available');
  });

  it('prefers the etag over the date', () => {
    writeSdeSnapshot(db, 'etag:aaa111', IDENTITY);
    const local = readSdeSnapshot(db)!;

    expect(compareSdeIdentity(local, IDENTITY)).toBe('up_to_date');
    expect(compareSdeIdentity(local, { ...IDENTITY, etag: 'ccc333' })).toBe('update_available');
    // A changed date with a matching etag is the same archive.
    expect(compareSdeIdentity(local, { ...IDENTITY, lastModified: 'Wed, 02 Sep 2026 10:00:00 GMT' }))
      .toBe('up_to_date');
  });

  it('compares dates when neither side has an etag', () => {
    writeSdeSnapshot(db, 'mtime:x', { ...IDENTITY, etag: null });
    const local = readSdeSnapshot(db)!;

    expect(compareSdeIdentity(local, { ...IDENTITY, etag: null })).toBe('up_to_date');
    expect(compareSdeIdentity(local, { lastModified: 'Wed, 02 Sep 2026 10:00:00 GMT', etag: null, bytes: 1 }))
      .toBe('update_available');
  });

  it('never calls a size match "current"', () => {
    writeSdeSnapshot(db, 'bytes:1', { lastModified: null, etag: null, bytes: 104_857_600 });
    const local = readSdeSnapshot(db)!;

    expect(compareSdeIdentity(local, { lastModified: null, etag: null, bytes: 104_857_600 }))
      .toBe('unknown');
    expect(compareSdeIdentity(local, { lastModified: null, etag: null, bytes: 99 }))
      .toBe('update_available');
  });
});

describe('SDE snapshot row', () => {
  it('derives a build number that changes with the archive, not with the day', () => {
    expect(deriveSdeBuildNumber(IDENTITY)).toBe('etag:aaa111');
    expect(deriveSdeBuildNumber({ ...IDENTITY, etag: null }))
      .toBe('mtime:2026-09-01T10:00:00.000Z');
    expect(deriveSdeBuildNumber({ lastModified: null, etag: null, bytes: 7 })).toMatch(/^bytes:7:/);
    expect(deriveSdeBuildNumber({ lastModified: null, etag: null, bytes: null })).toMatch(/^manual:/);
  });

  it('keeps exactly one row so the loaded build is never ambiguous', () => {
    writeSdeSnapshot(db, 'etag:first', IDENTITY);
    writeSdeSnapshot(db, 'etag:second', { ...IDENTITY, etag: 'second' });

    const rows = db.prepare('SELECT build_number FROM sde_meta').all() as Array<{ build_number: string }>;
    expect(rows).toHaveLength(1);
    expect(readSdeSnapshot(db)?.buildNumber).toBe('etag:second');
  });

  it('reports no snapshot when the table is empty', () => {
    expect(readSdeSnapshot(db)).toBeNull();
  });
});
