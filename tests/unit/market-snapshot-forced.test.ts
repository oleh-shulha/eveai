import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const loadMarketSnapshotFromEsi = vi.fn();
const createEsiOrdersPageFetcher = vi.fn(() => async () => ({ orders: [], pages: 1, expires: null, lastModified: null }));
const recordSnapshotError = vi.fn();
const loadTradeRegions = vi.fn(() => [{ region_id: 10000002, name: 'The Forge' }]);

vi.mock('../../src/eve/market-snapshot-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/eve/market-snapshot-loader.js')>();
  return { ...actual, loadMarketSnapshotFromEsi, createEsiOrdersPageFetcher, recordSnapshotError };
});
vi.mock('../../src/eve/market-wide-summary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/eve/market-wide-summary.js')>();
  return { ...actual, loadTradeRegions };
});

const { SCHEMA_SQL } = await import('../../src/db/schema.js');
const {
  getForcedMarketSweepState,
  isMarketSnapshotSweepInFlight,
  resetForcedMarketSweepStateForTests,
  runMarketSnapshotTick,
  startForcedMarketSnapshotSweep,
} = await import('../../src/eve/market-snapshot.js');
type Db = import('../../src/db/sqlite.js').Db;

let db: Database.Database;

const COMMITTED = {
  swept: true,
  rowsLoaded: 1_600_000,
  malformedRows: 0,
  regionsFetched: 60,
  regionsCarriedOver: 2,
  regionErrors: [],
};

async function settled(): Promise<void> {
  for (let i = 0; i < 100 && getForcedMarketSweepState().status === 'running'; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  resetForcedMarketSweepStateForTests();
  loadMarketSnapshotFromEsi.mockReset();
  loadTradeRegions.mockClear();
  recordSnapshotError.mockReset();
  loadMarketSnapshotFromEsi.mockResolvedValue(COMMITTED);
});

afterEach(() => {
  db.close();
});

describe('operator-forced market snapshot sweep', () => {
  it('treats every region as due by zeroing the tier intervals', async () => {
    startForcedMarketSnapshotSweep(db as Db);
    await settled();

    expect(loadMarketSnapshotFromEsi).toHaveBeenCalledWith(db, expect.objectContaining({
      regions: [{ region_id: 10000002, name: 'The Forge' }],
      majorIntervalMinutes: 0,
      minorIntervalMinutes: 0,
    }));
  });

  it('reports what the committed sweep actually loaded', async () => {
    const started = startForcedMarketSnapshotSweep(db as Db);
    expect(started.started).toBe(true);
    expect(started.state.status).toBe('running');
    await settled();

    const state = getForcedMarketSweepState();
    expect(state.status).toBe('committed');
    expect(state.rowsLoaded).toBe(1_600_000);
    expect(state.regionsFetched).toBe(60);
    expect(state.finishedAt).not.toBeNull();
    expect(state.error).toBeNull();
  });

  it('says nothing was due instead of claiming a refresh', async () => {
    // ESI caches the order book for five minutes; the loader answers swept:false.
    loadMarketSnapshotFromEsi.mockResolvedValue({
      swept: false,
      rowsLoaded: 0,
      malformedRows: 0,
      regionsFetched: 0,
      regionsCarriedOver: 0,
      regionErrors: [],
    });

    startForcedMarketSnapshotSweep(db as Db);
    await settled();

    expect(getForcedMarketSweepState().status).toBe('not_due');
  });

  it('keeps a failed sweep out of "committed" and carries the reason', async () => {
    loadMarketSnapshotFromEsi.mockRejectedValue(new Error('ESI 503 for region 10000002'));

    startForcedMarketSnapshotSweep(db as Db);
    await settled();

    const state = getForcedMarketSweepState();
    expect(state.status).toBe('failed');
    expect(state.error).toContain('ESI 503');
    // The previous snapshot keeps serving; the failure is recorded for the UI.
    expect(recordSnapshotError).toHaveBeenCalled();
  });

  it('fails with a named reason when the local SDE has no trade regions', async () => {
    loadTradeRegions.mockReturnValueOnce([]);

    startForcedMarketSnapshotSweep(db as Db);
    await settled();

    const state = getForcedMarketSweepState();
    expect(state.status).toBe('failed');
    expect(state.error).toContain('no k-space trade regions');
    expect(loadMarketSnapshotFromEsi).not.toHaveBeenCalled();
  });

  it('refuses to start while a scheduled sweep is already walking ESI', async () => {
    let release = (): void => {};
    loadMarketSnapshotFromEsi.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(COMMITTED);
    }));

    const scheduled = runMarketSnapshotTick(db as Db, {
      regions: [{ region_id: 10000002, name: 'The Forge' }],
      fetchPage: async () => ({ orders: [], pages: 1, expires: null, lastModified: null }),
    });
    expect(isMarketSnapshotSweepInFlight()).toBe(true);

    const forced = startForcedMarketSnapshotSweep(db as Db);

    expect(forced.started).toBe(false);
    expect(loadMarketSnapshotFromEsi).toHaveBeenCalledTimes(1);

    release();
    await scheduled;
    expect(isMarketSnapshotSweepInFlight()).toBe(false);
  });

  it('runs one forced sweep at a time', async () => {
    let release = (): void => {};
    loadMarketSnapshotFromEsi.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(COMMITTED);
    }));

    const first = startForcedMarketSnapshotSweep(db as Db);
    const second = startForcedMarketSnapshotSweep(db as Db);

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.state.status).toBe('running');

    release();
    await settled();
    expect(getForcedMarketSweepState().status).toBe('committed');
  });
});
