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

const sameEndpoint = (a: URL, b: string) =>
  a.origin + a.pathname === new URL(b).origin + new URL(b).pathname;

async function readCapped(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) return Buffer.concat(chunks);
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('response_too_large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader?.cancel();
  }
}

function slackReply(body: Buffer) {
  const data = JSON.parse(body.toString('utf8'));
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
  fetchImpl?: typeof fetch;
}): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    if (!options.preset.origins.includes(url.origin)) throw new Error('request_failed');
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    const params =
      init?.body instanceof URLSearchParams
        ? init.body
        : new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const tokenEndpoint = options.tokenEndpoint();
    const toToken = !!tokenEndpoint && sameEndpoint(url, tokenEndpoint);
    if ((/^basic /i.test(auth) || grantParams.some((key) => params.has(key))) && !toToken)
      throw new Error('request_failed');
    if (/^bearer /i.test(auth) && !sameEndpoint(url, options.preset.url))
      throw new Error('request_failed');
    const response = await (options.fetchImpl ?? fetch)(url, { ...init, redirect: 'manual' });
    const body = await readCapped(response, options.maxBytes ?? 262144);
    const reply =
      toToken && options.preset.slackTokens
        ? slackReply(body)
        : {
            status: response.status,
            body: [204, 205, 304].includes(response.status) ? null : body,
          };
    const replyHeaders = new Headers(response.headers);
    replyHeaders.delete('content-length');
    replyHeaders.delete('content-encoding');
    return new Response(reply.body, { status: reply.status, headers: replyHeaders });
  };
}
