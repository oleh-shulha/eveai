/**
 * Identity of the upstream EVE static-data archive, and what the locally
 * loaded snapshot was built from.
 *
 * CCP publishes one moving "latest" archive with no version in the URL, so the
 * only way to answer "is my SDE current?" without downloading ~100 MB is to
 * compare the archive's HTTP validators with the ones recorded at load time.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/sqlite.js';

export const SDE_ARCHIVE_URL =
  'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip';

const UPSTREAM_CHECK_TIMEOUT_MS = 15_000;

export type SdeUpstreamIdentity = {
  lastModified: string | null;
  etag: string | null;
  bytes: number | null;
};

export type SdeSnapshot = {
  buildNumber: string;
  loadedAt: string;
  sourceLastModified: string | null;
  sourceEtag: string | null;
  sourceBytes: number | null;
};

export type SdeFreshness = 'up_to_date' | 'update_available' | 'unknown';

export function identityFromHeaders(headers: Headers): SdeUpstreamIdentity {
  const rawLength = headers.get('content-length');
  const bytes = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
  return {
    lastModified: headers.get('last-modified'),
    etag: normalizeEtag(headers.get('etag')),
    bytes: Number.isSafeInteger(bytes) ? bytes : null,
  };
}

export async function fetchSdeUpstreamIdentity(
  fetchImpl: typeof fetch = fetch,
): Promise<SdeUpstreamIdentity> {
  const response = await fetchImpl(SDE_ARCHIVE_URL, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(UPSTREAM_CHECK_TIMEOUT_MS),
  });
  // Some CDNs answer HEAD with 405. One byte is enough to read the validators.
  if (response.status === 405 || response.status === 501) {
    const ranged = await fetchImpl(SDE_ARCHIVE_URL, {
      method: 'GET',
      redirect: 'follow',
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(UPSTREAM_CHECK_TIMEOUT_MS),
    });
    if (!ranged.ok && ranged.status !== 206) {
      throw new Error(`SDE archive check failed: HTTP ${ranged.status}`);
    }
    await ranged.arrayBuffer();
    // A ranged response describes the slice, not the archive.
    return { ...identityFromHeaders(ranged.headers), bytes: null };
  }
  if (!response.ok) throw new Error(`SDE archive check failed: HTTP ${response.status}`);
  return identityFromHeaders(response.headers);
}

/**
 * Only a validator the server actually sent can prove sameness. Size alone
 * cannot: two different builds can weigh the same, so a size match answers
 * `unknown` rather than claiming the snapshot is current.
 */
export function compareSdeIdentity(
  local: SdeSnapshot | null,
  upstream: SdeUpstreamIdentity,
): SdeFreshness {
  if (!local) return 'update_available';
  if (local.sourceEtag && upstream.etag) {
    return local.sourceEtag === upstream.etag ? 'up_to_date' : 'update_available';
  }
  if (local.sourceLastModified && upstream.lastModified) {
    return local.sourceLastModified === upstream.lastModified ? 'up_to_date' : 'update_available';
  }
  if (local.sourceBytes !== null && upstream.bytes !== null && local.sourceBytes !== upstream.bytes) {
    return 'update_available';
  }
  return 'unknown';
}

/**
 * The build number is what the map graph compares to decide whether it must be
 * rebuilt, so it has to change exactly when the data does. An upstream
 * validator does that; the load date does not, because two loads on one day
 * would look identical.
 */
export function deriveSdeBuildNumber(identity: SdeUpstreamIdentity): string {
  if (identity.etag) return `etag:${identity.etag}`;
  if (identity.lastModified) {
    const millis = Date.parse(identity.lastModified);
    if (Number.isFinite(millis)) return `mtime:${new Date(millis).toISOString()}`;
  }
  if (identity.bytes !== null) return `bytes:${identity.bytes}:${new Date().toISOString()}`;
  return `manual:${new Date().toISOString()}`;
}

export function readSdeSnapshot(db: Db): SdeSnapshot | null {
  try {
    const row = db.prepare(`
      SELECT build_number, loaded_at, source_last_modified, source_etag, source_bytes
      FROM sde_meta ORDER BY loaded_at DESC LIMIT 1
    `).get() as {
      build_number: string | null;
      loaded_at: string | null;
      source_last_modified: string | null;
      source_etag: string | null;
      source_bytes: number | null;
    } | undefined;
    if (!row?.build_number || !row.loaded_at) return null;
    return {
      buildNumber: row.build_number,
      loadedAt: row.loaded_at,
      sourceLastModified: row.source_last_modified,
      sourceEtag: row.source_etag,
      sourceBytes: row.source_bytes,
    };
  } catch {
    return null;
  }
}

/** One row only: a second row would make "the loaded build" ambiguous. */
export function writeSdeSnapshot(
  db: Db,
  buildNumber: string,
  identity: SdeUpstreamIdentity,
): void {
  const write = db.transaction(() => {
    db.prepare('DELETE FROM sde_meta').run();
    db.prepare(`
      INSERT INTO sde_meta (build_number, loaded_at, source_last_modified, source_etag, source_bytes)
      VALUES (?, datetime('now'), ?, ?, ?)
    `).run(buildNumber, identity.lastModified, identity.etag, identity.bytes);
  });
  write();
}

function normalizeEtag(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return trimmed || null;
}

export const EMPTY_SDE_IDENTITY: SdeUpstreamIdentity = { lastModified: null, etag: null, bytes: null };

/** Where the downloader leaves the validators for a separate loader process. */
export function sdeIdentityPath(dataDir: string): string {
  return join(dataDir, 'sde-source.json');
}

export function readSdeIdentitySidecar(dataDir: string): SdeUpstreamIdentity {
  const path = sdeIdentityPath(dataDir);
  if (!existsSync(path)) return EMPTY_SDE_IDENTITY;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SdeUpstreamIdentity>;
    return {
      lastModified: typeof parsed.lastModified === 'string' ? parsed.lastModified : null,
      etag: typeof parsed.etag === 'string' ? parsed.etag : null,
      bytes: Number.isSafeInteger(parsed.bytes) ? Number(parsed.bytes) : null,
    };
  } catch {
    return EMPTY_SDE_IDENTITY;
  }
}
