export const OPENAI_PROFILE_IDS = ['openai', 'compatible'] as const;

export type OpenAiProfileId = typeof OPENAI_PROFILE_IDS[number];

export type ResponsesTransport = 'http_sse';
export type ToolSearchExecution = 'hosted' | 'client';

export interface OpenAiProfile {
  id: OpenAiProfileId;
  providerName: string;
  baseUrl: string;
  responsesTransport: ResponsesTransport;
  toolSearchExecution: ToolSearchExecution;
  supportsHostedProgrammaticToolCalling: boolean;
  supportsLocalParallelBatch: boolean;
  supportsTruncation: boolean;
  supportsEncryptedReasoningReplay: boolean;
  supportsServerResponseState: boolean;
  readSubagentsDefault: boolean;
}

/**
 * A profile is the capability contract of the endpoint, never its address:
 * OPENAI_BASE_URL alone decides where requests go. Every flag here maps to one
 * optional part of the Responses request that a gateway may not implement.
 */
type OpenAiProfileCapabilities = Omit<OpenAiProfile, 'baseUrl' | 'providerName'>;

const OPENAI_PROFILES: Record<OpenAiProfileId, OpenAiProfileCapabilities> = {
  // Official OpenAI Responses API. Everything optional is contract-backed:
  // hosted tool search and Programmatic Tool Calling, `truncation`, encrypted
  // reasoning replay, and server-side response state.
  openai: {
    id: 'openai',
    responsesTransport: 'http_sse',
    toolSearchExecution: 'hosted',
    supportsHostedProgrammaticToolCalling: true,
    supportsLocalParallelBatch: false,
    supportsTruncation: true,
    supportsEncryptedReasoningReplay: true,
    supportsServerResponseState: true,
    readSubagentsDefault: false,
  },
  // Any OpenAI-compatible Responses gateway. Only the documented core of the
  // API is assumed, so each optional field an unknown gateway may reject with
  // a 400 stays off and the application-owned substitutes take over: client
  // tool search instead of hosted discovery, the local parallel batch instead
  // of hosted PTC, and read subagents for independent public research.
  compatible: {
    id: 'compatible',
    responsesTransport: 'http_sse',
    toolSearchExecution: 'client',
    supportsHostedProgrammaticToolCalling: false,
    supportsLocalParallelBatch: true,
    supportsTruncation: false,
    supportsEncryptedReasoningReplay: false,
    supportsServerResponseState: false,
    readSubagentsDefault: true,
  },
};

const MAX_PROVIDER_NAME_LENGTH = 64;

export function resolveOpenAiProfile(
  env: Record<string, string | undefined> = process.env,
): OpenAiProfile {
  const capabilities = OPENAI_PROFILES[parseProfileId(env)];
  const baseUrl = parseBaseUrl(env.OPENAI_BASE_URL);
  return { ...capabilities, baseUrl, providerName: parseProviderName(env.OPENAI_PROVIDER_NAME, baseUrl) };
}

function parseProfileId(env: Record<string, string | undefined>): OpenAiProfileId {
  const raw = env.OPENAI_PROFILE?.trim().toLowerCase() ?? '';
  if (!raw) {
    // The old variable named a vendor and carried its endpoint. Migrating it
    // silently would point a compatibility profile at OpenAI's capabilities.
    if (env.OPENAI_PROVIDER !== undefined && env.OPENAI_PROVIDER !== '') {
      throw new Error(
        'OPENAI_PROVIDER was replaced by OPENAI_PROFILE (openai | compatible) plus an explicit OPENAI_BASE_URL; '
        + 'the former modelhub provider is OPENAI_PROFILE=compatible with that gateway URL',
      );
    }
    throw new Error(`OPENAI_PROFILE is required and must be one of: ${OPENAI_PROFILE_IDS.join(', ')}`);
  }
  if (!OPENAI_PROFILE_IDS.includes(raw as OpenAiProfileId)) {
    throw new Error(`OPENAI_PROFILE must be one of: ${OPENAI_PROFILE_IDS.join(', ')}`);
  }
  return raw as OpenAiProfileId;
}

function parseBaseUrl(raw: string | undefined): string {
  const value = raw?.trim().replace(/\/+$/, '') ?? '';
  if (!value) {
    throw new Error(
      'OPENAI_BASE_URL is required: the API root of the Responses endpoint, '
      + 'e.g. https://api.openai.com/v1',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OPENAI_BASE_URL must be an absolute URL, got: "${value}"`);
  }
  // http stays allowed: a gateway on the operator's own machine or LAN is a
  // supported setup, and which transport is acceptable is the operator's call.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`OPENAI_BASE_URL must be an http(s) URL, got: "${value}"`);
  }
  // The key travels in the Authorization header. A URL-embedded credential
  // would additionally reach every request log line that prints the endpoint.
  if (url.username || url.password) {
    throw new Error('OPENAI_BASE_URL must not embed credentials; pass the key in OPENAI_API_KEY');
  }
  if (url.search || url.hash) {
    throw new Error('OPENAI_BASE_URL must not carry a query string or fragment');
  }
  if (url.pathname.endsWith('/responses')) {
    throw new Error('OPENAI_BASE_URL is the API root (e.g. .../v1); the app appends /responses itself');
  }
  return value;
}

function parseProviderName(raw: string | undefined, baseUrl: string): string {
  const value = raw?.trim().replace(/\s+/g, ' ') ?? '';
  // The name is what the consent page tells a user about the recipient of
  // their data, so an unset name falls back to the host actually configured
  // instead of a vendor label that may no longer be true.
  if (!value) return new URL(baseUrl).host;
  if (value.length > MAX_PROVIDER_NAME_LENGTH) {
    throw new Error(`OPENAI_PROVIDER_NAME must be at most ${MAX_PROVIDER_NAME_LENGTH} characters`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new Error('OPENAI_PROVIDER_NAME must not contain control characters');
  }
  return value;
}
