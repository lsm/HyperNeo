import * as crypto from 'crypto';

export const CLAUDE_SUBSCRIPTION_OAUTH_CONFIG = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  callbackPath: '/callback',
  allScopes: [
    'org:create_api_key',
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
  ],
  refreshScopes: [
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
  ],
  requestTimeoutMs: 30000,
} as const;

export interface ClaudeSubscriptionTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  token_type?: string;
  scope?: string;
  account?: { uuid?: string; email_address?: string };
  organization?: { uuid?: string };
}

export interface ClaudeSubscriptionPkce {
  verifier: string;
  challenge: string;
}

export function createClaudeSubscriptionPkce(
  random: (size: number) => Buffer = crypto.randomBytes
): ClaudeSubscriptionPkce {
  const verifier = random(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest().toString('base64url');
  return { verifier, challenge };
}

export function createClaudeSubscriptionState(
  random: (size: number) => Buffer = crypto.randomBytes
): string {
  return random(32).toString('base64url');
}

export function buildClaudeSubscriptionAuthorizeUrl(params: {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  clientId?: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.authorizeUrl);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', params.clientId ?? CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set(
    'scope',
    (params.scopes ?? CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.allScopes).join(' ')
  );
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  return url.toString();
}

interface TokenRequestResult {
  status: number;
  token: ClaudeSubscriptionTokenResponse | null;
}

async function requestClaudeSubscriptionTokens(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<TokenRequestResult> {
  const response = await fetchImpl(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.requestTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, token: null };
  }
  const parsed = (await response.json()) as ClaudeSubscriptionTokenResponse;
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
    return { status: response.status, token: null };
  }
  if (typeof parsed.expires_in !== 'number') {
    return { status: response.status, token: null };
  }
  return { status: response.status, token: parsed };
}

export async function exchangeClaudeSubscriptionCode(params: {
  code: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}): Promise<ClaudeSubscriptionTokenResponse> {
  const { status, token } = await requestClaudeSubscriptionTokens(
    {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId ?? CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.clientId,
      code_verifier: params.codeVerifier,
      state: params.state,
    },
    params.fetchImpl ?? fetch
  );
  if (status === 401) {
    throw new Error('Authentication failed: Invalid authorization code');
  }
  if (!token) {
    throw new Error(`Token exchange failed (${status})`);
  }
  return token;
}

export type ClaudeSubscriptionRefreshResult =
  | { ok: true; token: ClaudeSubscriptionTokenResponse }
  | { ok: false; definitive: boolean };

export type ClaudeSubscriptionCallback = { code: string; state: string } | { error: string } | null;

export function parseClaudeSubscriptionCallback(input: string): ClaudeSubscriptionCallback {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.includes('://')) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const error = url.searchParams.get('error');
    if (error) return { error };
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return null;
    return { code, state };
  }
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex <= 0) return null;
  const code = trimmed.slice(0, hashIndex);
  const state = trimmed.slice(hashIndex + 1);
  if (!code || !state) return null;
  return { code, state };
}

export async function refreshClaudeSubscriptionToken(params: {
  refreshToken: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}): Promise<ClaudeSubscriptionRefreshResult> {
  let result: TokenRequestResult;
  try {
    result = await requestClaudeSubscriptionTokens(
      {
        grant_type: 'refresh_token',
        refresh_token: params.refreshToken,
        client_id: params.clientId ?? CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.clientId,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.refreshScopes.join(' '),
      },
      params.fetchImpl ?? fetch
    );
  } catch {
    return { ok: false, definitive: false };
  }
  if (result.token) {
    return { ok: true, token: result.token };
  }
  const { status } = result;
  const definitive = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return { ok: false, definitive };
}
