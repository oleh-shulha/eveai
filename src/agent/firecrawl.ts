/**
 * Firecrawl client: the only way this app reads an arbitrary web page.
 *
 * Firecrawl is optional. It is configured when both FIRECRAWL_URL and
 * FIRECRAWL_API_KEY are set, and an operator can force it off at runtime (see
 * web-access.ts) without restarting or editing .env.
 *
 * Everything crossing this boundary is bounded and validated: the target URL
 * must be a public http(s) address, the response body is read under a byte
 * ceiling, the markdown is truncated to a configured character budget, and the
 * error text handed back to the model carries a status and a short reason —
 * never the API key, the configured endpoint, or a raw provider payload.
 */
import { config } from '../config.js';

export type FirecrawlSearchHit = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

export type FirecrawlPageResult =
  | {
      ok: true;
      url: string;
      title: string | null;
      status_code: number | null;
      content: string;
      truncated: boolean;
    }
  | { ok: false; error: string };

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SEARCH_SNIPPET_CHARS = 300;

/** Blocked scrape targets: a model-supplied URL must not reach the host's own network. */
const PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.localdomain'];

export function isFirecrawlConfigured(): boolean {
  return Boolean(config.firecrawl.baseUrl && config.firecrawl.apiKey);
}

export async function firecrawlSearch(
  query: string,
  options: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ results: FirecrawlSearchHit[]; error: string | null }> {
  if (!isFirecrawlConfigured()) return { results: [], error: 'Web access is not configured' };
  const limit = options.limit ?? config.firecrawl.maxSearchResults;

  const response = await postJson('/v2/search', {
    query,
    limit,
    sources: ['web'],
  }, options.fetchImpl);
  if (!response.ok) return { results: [], error: response.error };

  const hits = readSearchHits(response.body)
    .slice(0, limit)
    .map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet.slice(0, SEARCH_SNIPPET_CHARS),
      source: 'Firecrawl',
    }));
  return { results: hits, error: hits.length === 0 ? 'No results' : null };
}

export async function firecrawlScrape(
  url: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<FirecrawlPageResult> {
  if (!isFirecrawlConfigured()) return { ok: false, error: 'Web access is not configured' };
  const target = normalizeScrapeTarget(url);
  if (!target.ok) return { ok: false, error: target.error };

  const response = await postJson('/v2/scrape', {
    url: target.url,
    formats: ['markdown'],
    onlyMainContent: true,
  }, options.fetchImpl);
  if (!response.ok) return { ok: false, error: response.error };

  const document = readRecord(readRecord(response.body)?.data) ?? readRecord(response.body);
  const markdown = typeof document?.markdown === 'string' ? document.markdown : '';
  const metadata = readRecord(document?.metadata);
  const statusCode = typeof metadata?.statusCode === 'number' ? metadata.statusCode : null;
  if (!markdown.trim()) {
    // A page that fetched fine but yielded nothing readable (login wall, JS-only
    // app, PDF without text) must not look like an empty article.
    return {
      ok: false,
      error: statusCode !== null
        ? `The page returned no readable text (HTTP ${statusCode})`
        : 'The page returned no readable text',
    };
  }

  const budget = config.firecrawl.maxContentChars;
  const truncated = markdown.length > budget;
  return {
    ok: true,
    url: typeof metadata?.sourceURL === 'string' ? metadata.sourceURL : target.url,
    title: typeof metadata?.title === 'string' ? metadata.title : null,
    status_code: statusCode,
    content: truncated ? `${markdown.slice(0, budget)}\n\n[truncated]` : markdown,
    truncated,
  };
}

type PostResult =
  | { ok: true; body: unknown }
  | { ok: false; error: string };

async function postJson(
  path: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.firecrawl.timeoutMs);
  try {
    const response = await fetchImpl(`${config.firecrawl.baseUrl}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.firecrawl.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Status only: a provider body can quote the key, the endpoint, or an
      // upstream error page, and none of that belongs in a model prompt.
      return { ok: false, error: describeHttpFailure(response.status) };
    }
    const raw = await readBoundedText(response, MAX_RESPONSE_BYTES);
    if (raw === null) return { ok: false, error: 'Web service response was too large to read' };
    try {
      return { ok: true, body: JSON.parse(raw) };
    } catch {
      return { ok: false, error: 'Web service returned a malformed response' };
    }
  } catch (error) {
    const aborted = (error as Error | null)?.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? 'Web request timed out' : 'Web service is unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403) return 'Web service rejected the configured credentials';
  if (status === 402) return 'Web service quota is exhausted';
  if (status === 429) return 'Web service rate limit reached; try again later';
  if (status >= 500) return `Web service failed (HTTP ${status})`;
  return `Web request was refused (HTTP ${status})`;
}

function normalizeScrapeTarget(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) return { ok: false, error: 'No URL was given' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'Not an absolute http(s) URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Only http and https URLs can be read' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'URLs with embedded credentials are not read' };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, error: 'Private and loopback addresses are not read' };
  }
  return { ok: true, url: url.toString() };
}

/**
 * Keeps a model- or user-supplied URL from pointing the fetcher at the
 * operator's own network (cloud metadata endpoints, admin panels on the LAN).
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function readSearchHits(body: unknown): Array<{ title: string; url: string; snippet: string }> {
  const root = readRecord(body);
  const data = root?.data ?? root;
  // v2 groups results by source (`web`/`news`/`images`); older shapes used a
  // flat array. Accept both rather than silently returning nothing.
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(readRecord(data)?.web)
      ? readRecord(data)!.web as unknown[]
      : [];
  const hits: Array<{ title: string; url: string; snippet: string }> = [];
  for (const row of rows) {
    const entry = readRecord(row);
    const url = typeof entry?.url === 'string' ? entry.url : '';
    if (!url) continue;
    const metadata = readRecord(entry?.metadata);
    const title = typeof entry?.title === 'string' && entry.title
      ? entry.title
      : typeof metadata?.title === 'string' ? metadata.title : url;
    const snippet = typeof entry?.description === 'string'
      ? entry.description
      : typeof entry?.markdown === 'string' ? entry.markdown : '';
    hits.push({ title, url, snippet });
  }
  return hits;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
