import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { firecrawlScrape, firecrawlSearch, isFirecrawlConfigured } from '../../src/agent/firecrawl.js';

const BASE_URL = 'https://firecrawl.test';
const API_KEY = 'fc-secret-key';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  config.firecrawl.baseUrl = BASE_URL;
  config.firecrawl.apiKey = API_KEY;
  config.firecrawl.maxContentChars = 100;
  config.firecrawl.maxSearchResults = 3;
});

afterEach(() => {
  config.firecrawl.baseUrl = '';
  config.firecrawl.apiKey = '';
  config.firecrawl.maxContentChars = 12_000;
  config.firecrawl.maxSearchResults = 5;
  vi.restoreAllMocks();
});

describe('firecrawl configuration', () => {
  it('needs both the endpoint and the key', () => {
    expect(isFirecrawlConfigured()).toBe(true);
    config.firecrawl.apiKey = '';
    expect(isFirecrawlConfigured()).toBe(false);
    config.firecrawl.apiKey = API_KEY;
    config.firecrawl.baseUrl = '';
    expect(isFirecrawlConfigured()).toBe(false);
  });

  it('refuses to work unconfigured instead of calling an empty host', async () => {
    config.firecrawl.baseUrl = '';
    const fetchImpl = vi.fn();

    const page = await firecrawlScrape('https://example.com', { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(page).toEqual({ ok: false, error: 'Web access is not configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('firecrawl scrape', () => {
  it('sends the documented v2 request and returns the page text', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true,
      data: {
        markdown: '# Patch notes\n\nShips got faster.',
        metadata: { title: 'Patch notes', sourceURL: 'https://www.eveonline.com/news/patch', statusCode: 200 },
      },
    })) as unknown as typeof fetch;

    const page = await firecrawlScrape('https://www.eveonline.com/news/patch', { fetchImpl });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/v2/scrape`);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      url: 'https://www.eveonline.com/news/patch',
      formats: ['markdown'],
      onlyMainContent: true,
    });
    expect(page).toMatchObject({
      ok: true,
      title: 'Patch notes',
      status_code: 200,
      url: 'https://www.eveonline.com/news/patch',
      truncated: false,
    });
  });

  it('truncates a long page to the configured budget', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true,
      data: { markdown: 'x'.repeat(5_000), metadata: { sourceURL: 'https://example.com/long' } },
    })) as unknown as typeof fetch;

    const page = await firecrawlScrape('https://example.com/long', { fetchImpl });

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.truncated).toBe(true);
    expect(page.content.length).toBeLessThan(200);
    expect(page.content.endsWith('[truncated]')).toBe(true);
  });

  it('reports an unreadable page instead of an empty article', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true,
      data: { markdown: '   ', metadata: { statusCode: 403 } },
    })) as unknown as typeof fetch;

    const page = await firecrawlScrape('https://example.com/paywall', { fetchImpl });

    expect(page).toEqual({ ok: false, error: 'The page returned no readable text (HTTP 403)' });
  });

  it('keeps the provider body and the key out of the error handed to the model', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      `unauthorized for key ${API_KEY} at ${BASE_URL}`,
      { status: 401 },
    )) as unknown as typeof fetch;

    const page = await firecrawlScrape('https://example.com', { fetchImpl });

    expect(page.ok).toBe(false);
    if (page.ok) return;
    expect(page.error).toBe('Web service rejected the configured credentials');
    expect(page.error).not.toContain(API_KEY);
    expect(page.error).not.toContain(BASE_URL);
  });

  it('maps the quota and rate-limit answers to their own reasons', async () => {
    for (const [status, expected] of [
      [402, 'Web service quota is exhausted'],
      [429, 'Web service rate limit reached; try again later'],
      [503, 'Web service failed (HTTP 503)'],
    ] as Array<[number, string]>) {
      const fetchImpl = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch;
      const page = await firecrawlScrape('https://example.com', { fetchImpl });
      expect(page).toEqual({ ok: false, error: expected });
    }
  });

  it('survives a malformed provider response', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;

    const page = await firecrawlScrape('https://example.com', { fetchImpl });

    expect(page).toEqual({ ok: false, error: 'Web service returned a malformed response' });
  });

  it('never points the fetcher at the host network or a non-http scheme', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const blocked = [
      'http://localhost:8080/admin',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.16.0.9/',
      'http://router.local/',
      'https://user:pass@example.com/',
      'file:///etc/passwd',
      'not-a-url',
    ];

    for (const url of blocked) {
      const page = await firecrawlScrape(url, { fetchImpl });
      expect(page.ok, url).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('firecrawl search', () => {
  it('reads the v2 shape where results are grouped by source', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true,
      data: {
        web: [
          { title: 'Wormhole', url: 'https://wiki.example/wh', description: 'Wormhole basics' },
          { url: 'https://wiki.example/second', metadata: { title: 'From metadata' } },
        ],
      },
    })) as unknown as typeof fetch;

    const result = await firecrawlSearch('wormhole', { fetchImpl });

    expect(result.error).toBeNull();
    expect(result.results).toEqual([
      { title: 'Wormhole', url: 'https://wiki.example/wh', snippet: 'Wormhole basics', source: 'Firecrawl' },
      { title: 'From metadata', url: 'https://wiki.example/second', snippet: '', source: 'Firecrawl' },
    ]);
  });

  it('also reads a flat result array', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true,
      data: [{ title: 'Flat', url: 'https://example.com/flat', description: 'older shape' }],
    })) as unknown as typeof fetch;

    const result = await firecrawlSearch('flat', { fetchImpl });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toBe('https://example.com/flat');
  });

  it('caps the result count and drops entries without a URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: { web: [
        { title: 'no url' },
        ...Array.from({ length: 6 }, (_, i) => ({ title: `r${i}`, url: `https://example.com/${i}` })),
      ] },
    })) as unknown as typeof fetch;

    const result = await firecrawlSearch('many', { fetchImpl });

    expect(result.results).toHaveLength(3);
    expect(JSON.parse(String(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body)))
      .toEqual({ query: 'many', limit: 3, sources: ['web'] });
  });

  it('says so when the service returns nothing usable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: { web: [] } })) as unknown as typeof fetch;

    const result = await firecrawlSearch('nothing', { fetchImpl });

    expect(result.results).toEqual([]);
    expect(result.error).toBe('No results');
  });
});
