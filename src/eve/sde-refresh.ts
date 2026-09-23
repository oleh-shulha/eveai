/**
 * Operator-triggered SDE refresh: download the archive CCP publishes, reload
 * the static tables, and rebuild the Perimeter map graph from them.
 *
 * The three steps belong together because a reload alone leaves the map on the
 * previous universe: `map_systems`/`map_edges` are derived tables, and their
 * rebuild is what makes a new system or a moved gate visible.
 *
 * One refresh runs at a time, process-wide. It deliberately does not take the
 * runtime lock: the operator asked to be able to refresh a live service, and
 * SQLite's WAL keeps each table swap consistent. During the load the agent can
 * still see a partially reloaded table.
 */
import type { Db } from '../db/sqlite.js';
import { createLogger } from '../observability/logger.js';
import { buildMapGraph } from './map-graph.js';
import { downloadSdeArchive } from './sde-downloader.js';
import { loadSdeIntoDb } from './sde-loader.js';
import {
  compareSdeIdentity,
  fetchSdeUpstreamIdentity,
  readSdeSnapshot,
  type SdeFreshness,
  type SdeSnapshot,
  type SdeUpstreamIdentity,
} from './sde-source.js';

const log = createLogger('sde');

export type SdeRefreshStep = 'download' | 'load' | 'map';

export type SdeRefreshState = {
  status: 'idle' | 'running' | 'done' | 'failed';
  step: SdeRefreshStep | null;
  startedAt: string | null;
  finishedAt: string | null;
  records: number | null;
  mapSystems: number | null;
  buildNumber: string | null;
  error: string | null;
};

export type SdeCheckResult = {
  freshness: SdeFreshness;
  checkedAt: string;
  upstream: SdeUpstreamIdentity;
};

const IDLE_STATE: SdeRefreshState = {
  status: 'idle',
  step: null,
  startedAt: null,
  finishedAt: null,
  records: null,
  mapSystems: null,
  buildNumber: null,
  error: null,
};

let state: SdeRefreshState = { ...IDLE_STATE };
let inFlight: Promise<void> | null = null;
let lastCheck: SdeCheckResult | null = null;

/** Test seam: the job and last-check state are process-wide singletons. */
export function resetSdeRefreshStateForTests(): void {
  state = { ...IDLE_STATE };
  inFlight = null;
  lastCheck = null;
}

export function getSdeRefreshState(): SdeRefreshState {
  return { ...state };
}

export function getLastSdeCheck(): SdeCheckResult | null {
  return lastCheck ? { ...lastCheck } : null;
}

export async function checkSdeFreshness(
  db: Db,
  fetchImpl: typeof fetch = fetch,
): Promise<SdeCheckResult> {
  const upstream = await fetchSdeUpstreamIdentity(fetchImpl);
  const result: SdeCheckResult = {
    freshness: compareSdeIdentity(readSdeSnapshot(db), upstream),
    checkedAt: new Date().toISOString(),
    upstream,
  };
  lastCheck = result;
  return result;
}

export function startSdeRefresh(db: Db): { started: boolean; state: SdeRefreshState } {
  if (inFlight) return { started: false, state: getSdeRefreshState() };

  state = {
    ...IDLE_STATE,
    status: 'running',
    step: 'download',
    startedAt: new Date().toISOString(),
  };
  inFlight = runRefresh(db)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.error('SDE refresh failed during %s: %s', state.step ?? 'start', message);
      state = { ...state, status: 'failed', error: message, finishedAt: new Date().toISOString() };
    })
    .finally(() => {
      inFlight = null;
    });

  return { started: true, state: getSdeRefreshState() };
}

async function runRefresh(db: Db): Promise<void> {
  const toLog = (message: string): void => log.info('%s', message);

  state = { ...state, step: 'download' };
  const download = await downloadSdeArchive({ log: toLog });

  state = { ...state, step: 'load' };
  const loaded = await loadSdeIntoDb(db, download.dataDir, {
    identity: download.identity,
    log: toLog,
  });
  if (loaded.emptyCriticalTables.length > 0) {
    throw new Error(
      `critical tables empty after load: ${loaded.emptyCriticalTables.join(', ')}`,
    );
  }

  state = { ...state, step: 'map', records: loaded.totalRecords, buildNumber: loaded.buildNumber };
  const graph = buildMapGraph(db, { force: true });

  // The archive we just installed is by definition what upstream serves now.
  lastCheck = {
    freshness: 'up_to_date',
    checkedAt: new Date().toISOString(),
    upstream: download.identity,
  };
  state = {
    ...state,
    status: 'done',
    step: null,
    finishedAt: new Date().toISOString(),
    mapSystems: graph.meta.systemCount,
  };
  log.info(
    'SDE refresh done: %d records, build %s, map %d systems / %d links',
    loaded.totalRecords, loaded.buildNumber, graph.meta.systemCount, graph.meta.edgeCount,
  );
}

export function readLocalSdeSnapshot(db: Db): SdeSnapshot | null {
  return readSdeSnapshot(db);
}
