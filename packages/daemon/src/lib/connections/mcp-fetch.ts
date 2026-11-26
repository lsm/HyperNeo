import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

export type McpOAuthPreset = {
  url: string;
  issuer: string;
  authorizationEndpoint: string;
  origins: string[];
  scopes: string[];
  slackTokens?: boolean;
};

const grantParams = ['code', 'code_verifier', 'refresh_token', 'client_secret'];
const slackErrors: Record<string, [number, string]> = {
  invalid_refresh_token: [400, 'invalid_grant'],
  token_revoked: [400, 'invalid_grant'],
  token_expired: [400, 'invalid_grant'],
  account_inactive: [400, 'invalid_grant'],
  invalid_code: [400, 'invalid_grant'],
  bad_client_secret: [401, 'invalid_client'],
  invalid_client_id: [401, 'invalid_client'],
  ratelimited: [503, 'temporarily_unavailable'],
  internal_error: [503, 'temporarily_unavailable'],
  fatal_error: [503, 'temporarily_unavailable'],
  service_unavailable: [503, 'temporarily_unavailable'],
  request_timeout: [503, 'temporarily_unavailable'],
};

const oauthErrors = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
  'invalid_client_metadata',
  'invalid_redirect_uri',
  'invalid_token',
  'insufficient_scope',
]);

const sameUrl = (a: URL, b: string) => a.href === new URL(b).href;

function parse(body: string) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('request_failed');
  }
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  const aborted = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('request_failed')), { once: true })
  );
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = reader && (await Promise.race([reader.read(), aborted]));
      if (!chunk || chunk.done) return Buffer.concat(chunks).toString('utf8');
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('response_too_large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader?.cancel().catch(() => {});
  }
}

function errorReply(status: number, body: string) {
  let error: unknown;
  try {
    error = JSON.parse(body).error;
  } catch {}
  const code =
    typeof error === 'string' && oauthErrors.has(error)
      ? error
      : status === 429 || status >= 500
        ? 'temporarily_unavailable'
        : 'invalid_request';
  return { status, body: JSON.stringify({ error: code }) };
}

function redirectReply(response: Response, url: URL, init?: RequestInit) {
  const location = response.headers.get('location');
  const target = location ? URL.parse(location, url.href) : null;
  const followable =
    (init?.method ?? 'GET').toUpperCase() === 'GET' && target?.origin === url.origin;
  return followable
    ? new Response(null, { status: response.status, headers: { location: target.href } })
    : new Response(errorReply(400, '').body, { status: 400 });
}

function tokenReply(body: string, slack: boolean) {
  const data = parse(body);
  if (!slack) return { status: 200, body };
  if (data.ok === false) {
    const [status, error] = slackErrors[data.error] ?? [400, 'invalid_request'];
    return { status, body: JSON.stringify({ error }) };
  }
  const granted = data.authed_user?.scope;
  const scope = typeof granted === 'string' ? granted.split(',').join(' ') : data.scope;
  return { status: 200, body: JSON.stringify({ ...data, scope, token_type: 'Bearer' }) };
}

export function createMcpFetch(options: {
  preset: McpOAuthPreset;
  tokenEndpoint: () => string | undefined;
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): FetchLike {
  let tooLarge = false;
  return async (input, init) => {
    if (tooLarge) throw new Error('response_too_large');
    const url = new URL(input);
    if (!options.preset.origins.includes(url.origin)) throw new Error('request_failed');
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    const params =
      init?.body instanceof URLSearchParams
        ? init.body
        : new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const tokenEndpoint = options.tokenEndpoint();
    const toToken = !!tokenEndpoint && sameUrl(url, tokenEndpoint);
    if ((/^basic /i.test(auth) || grantParams.some((key) => params.has(key))) && !toToken)
      throw new Error('request_failed');
    if (/^bearer /i.test(auth) && !sameUrl(url, options.preset.url))
      throw new Error('request_failed');
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 30000),
      ...(init?.signal ? [init.signal] : []),
    ]);
    let response: Response;
    let body: string;
    try {
      response = await (options.fetchImpl ?? fetch)(url, { ...init, redirect: 'manual', signal });
      body = await readCapped(response, options.maxBytes ?? 262144, signal);
    } catch (error) {
      tooLarge = error instanceof Error && error.message === 'response_too_large';
      throw new Error(tooLarge ? 'response_too_large' : 'request_failed');
    }
    if (response.status >= 300 && response.status < 400) return redirectReply(response, url, init);
    const reply =
      response.status >= 400
        ? errorReply(response.status, body)
        : toToken && response.ok
          ? tokenReply(body, !!options.preset.slackTokens)
          : {
              status: response.status,
              body: [204, 205].includes(response.status) ? null : body,
            };
    const replyHeaders = new Headers(response.headers);
    replyHeaders.delete('content-length');
    replyHeaders.delete('content-encoding');
    return new Response(reply.body, { status: reply.status, headers: replyHeaders });
  };
}
