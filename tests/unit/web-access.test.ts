import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { config } from '../../src/config.js';
import type { Db } from '../../src/db/sqlite.js';
import {
  getWebAccessState,
  isWebAccessEnabled,
  loadWebAccessFlag,
  resetWebAccessCacheForTests,
  setWebAccessAllowed,
} from '../../src/agent/web-access.js';
import { buildNativeAgentTools, getToolPolicy } from '../../src/agent/tools.js';

let db: Database.Database;
const originalTavily = config.tavily.apiKey;

function toolNames(tools: Awaited<ReturnType<typeof buildNativeAgentTools>>): string[] {
  return tools.flatMap((tool) => tool.type === 'function' ? [tool.name] : []);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebAccessCacheForTests();
  config.firecrawl.baseUrl = 'https://firecrawl.test';
  config.firecrawl.apiKey = 'fc-key';
  config.tavily.apiKey = '';
});

afterEach(() => {
  db.close();
  resetWebAccessCacheForTests();
  config.firecrawl.baseUrl = '';
  config.firecrawl.apiKey = '';
  config.tavily.apiKey = originalTavily;
});

describe('web access switch', () => {
  it('is on by default once Firecrawl is configured', () => {
    loadWebAccessFlag(db as Db);

    expect(isWebAccessEnabled()).toBe(true);
    expect(getWebAccessState()).toEqual({
      configured: true,
      allowed: true,
      enabled: true,
      endpointHost: 'firecrawl.test',
    });
  });

  it('stays off across a restart once the operator switched it off', () => {
    setWebAccessAllowed(db as Db, false);
    expect(isWebAccessEnabled()).toBe(false);

    // A fresh process reads the stored flag instead of defaulting to on.
    resetWebAccessCacheForTests();
    loadWebAccessFlag(db as Db);

    expect(isWebAccessEnabled()).toBe(false);
    expect(getWebAccessState().allowed).toBe(false);
    expect(getWebAccessState().configured).toBe(true);
  });

  it('comes back on when the operator switches it back', () => {
    setWebAccessAllowed(db as Db, false);
    setWebAccessAllowed(db as Db, true);
    resetWebAccessCacheForTests();
    loadWebAccessFlag(db as Db);

    expect(isWebAccessEnabled()).toBe(true);
  });

  it('stays off while nothing is configured, whatever the switch says', () => {
    config.firecrawl.apiKey = '';
    loadWebAccessFlag(db as Db);

    const state = getWebAccessState();
    expect(state.configured).toBe(false);
    expect(state.allowed).toBe(true);
    expect(state.enabled).toBe(false);
    expect(state.endpointHost).toBeNull();
    expect(isWebAccessEnabled()).toBe(false);
  });
});

describe('web tools exposure', () => {
  it('offers page reading and search when web access is on', async () => {
    loadWebAccessFlag(db as Db);

    const names = toolNames(await buildNativeAgentTools('full'));

    expect(names).toContain('fetch_web_page');
    expect(names).toContain('web_search');
  });

  it('withdraws both tools while the operator switch is off', async () => {
    setWebAccessAllowed(db as Db, false);

    const names = toolNames(await buildNativeAgentTools('full'));

    expect(names).not.toContain('fetch_web_page');
    // No Tavily key either, so search has no backend left.
    expect(names).not.toContain('web_search');
  });

  it('keeps search on a Tavily key alone, but not page reading', async () => {
    config.firecrawl.baseUrl = '';
    config.firecrawl.apiKey = '';
    config.tavily.apiKey = 'tvly-key';

    const names = toolNames(await buildNativeAgentTools('full'));

    expect(names).toContain('web_search');
    expect(names).not.toContain('fetch_web_page');
  });

  it('treats reading a page as a read-only tool', async () => {
    await expect(getToolPolicy('fetch_web_page')).resolves.toBe('read');
  });
});
