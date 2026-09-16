import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as crypto from 'crypto';
import type { ProviderCredentials } from '@hyperneo/shared/provider';
import { AnthropicProvider } from '../../../../src/lib/providers/anthropic-provider';
import { resetProviderFailureStore } from '../../../../src/lib/providers/provider-failure-store';
import {
  CLAUDE_SUBSCRIPTION_OAUTH_CONFIG,
  buildClaudeSubscriptionAuthorizeUrl,
  createClaudeSubscriptionPkce,
  exchangeClaudeSubscriptionCode,
  parseClaudeSubscriptionCallback,
  refreshClaudeSubscriptionToken,
} from '../../../../src/lib/providers/anthropic-subscription-oauth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sha256Base64Url(value: string): string {
  return crypto.createHash('sha256').update(value).digest().toString('base64url');
}

const TOKEN_RESPONSE = {
  access_token: 'subscription-access-token',
  refresh_token: 'subscription-refresh-token',
  expires_in: 3600,
  scope: 'user:inference user:profile',
  account: { uuid: 'account-uuid', email_address: 'user@example.com' },
  organization: { uuid: 'org-uuid' },
};

describe('anthropic-subscription-oauth helpers', () => {
  it('pins the Claude Code subscription OAuth endpoints and client id', () => {
    expect(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.clientId).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.authorizeUrl).toBe(
      'https://claude.com/cai/oauth/authorize'
    );
    expect(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.tokenUrl).toBe(
      'https://platform.claude.com/v1/oauth/token'
    );
    expect(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.manualRedirectUrl).toBe(
      'https://platform.claude.com/oauth/code/callback'
    );
    expect(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.allScopes).toEqual([
      'org:create_api_key',
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ]);
    expect(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.refreshScopes).toEqual([
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ]);
  });

  it('builds the authorize URL with PKCE and subscription scopes', () => {
    const url = new URL(
      buildClaudeSubscriptionAuthorizeUrl({
        state: 'state-value',
        codeChallenge: 'challenge-value',
        redirectUri: 'http://localhost:54545/callback',
      })
    );
    expect(`${url.origin}${url.pathname}`).toBe(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.authorizeUrl);
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.clientId);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:54545/callback');
    expect(url.searchParams.get('scope')).toBe(
      CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.allScopes.join(' ')
    );
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('derives the PKCE S256 challenge from the verifier', () => {
    const { verifier, challenge } = createClaudeSubscriptionPkce((size) => Buffer.alloc(size, 7));
    expect(verifier).toHaveLength(43);
    expect(challenge).toBe(sha256Base64Url(verifier));
  });

  it('exchanges an authorization code with the documented request body', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const fetchImpl = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      });
      return jsonResponse(TOKEN_RESPONSE);
    }) as unknown as typeof fetch;

    const token = await exchangeClaudeSubscriptionCode({
      code: 'auth-code',
      state: 'state-value',
      codeVerifier: 'verifier-value',
      redirectUri: 'http://localhost:54545/callback',
      fetchImpl,
    });

    expect(token).toEqual(TOKEN_RESPONSE);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.tokenUrl);
    expect(captured[0].headers.get('content-type')).toBe('application/json');
    expect(captured[0].body).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code',
      redirect_uri: 'http://localhost:54545/callback',
      client_id: CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.clientId,
      code_verifier: 'verifier-value',
      state: 'state-value',
    });
  });

  it('rejects an invalid authorization code', async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ error: 'invalid_grant' }, 401)
    ) as unknown as typeof fetch;
    await expect(
      exchangeClaudeSubscriptionCode({
        code: 'bad-code',
        state: 'state-value',
        codeVerifier: 'verifier-value',
        redirectUri: 'http://localhost:54545/callback',
        fetchImpl,
      })
    ).rejects.toThrow('Invalid authorization code');
  });

  it('rejects a malformed token response', async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ scope: 'user:inference' })
    ) as unknown as typeof fetch;
    await expect(
      exchangeClaudeSubscriptionCode({
        code: 'auth-code',
        state: 'state-value',
        codeVerifier: 'verifier-value',
        redirectUri: 'http://localhost:54545/callback',
        fetchImpl,
      })
    ).rejects.toThrow('Token exchange failed (200)');
  });

  it('refreshes with the refresh-token grant and subscription scopes', async () => {
    const captured: Array<{ body: Record<string, unknown> }> = [];
    const fetchImpl = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return jsonResponse({ ...TOKEN_RESPONSE, access_token: 'refreshed-access-token' });
    }) as unknown as typeof fetch;

    const result = await refreshClaudeSubscriptionToken({
      refreshToken: 'refresh-value',
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      token: { ...TOKEN_RESPONSE, access_token: 'refreshed-access-token' },
    });
    expect(captured[0].body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-value',
      client_id: CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.clientId,
      scope: CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.refreshScopes.join(' '),
    });
  });

  it('classifies a rejected refresh grant as definitive', async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ error: 'invalid_grant' }, 400)
    ) as unknown as typeof fetch;
    const result = await refreshClaudeSubscriptionToken({
      refreshToken: 'expired-refresh',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, definitive: true });
  });

  it('classifies a server error during refresh as transient', async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ error: 'unavailable' }, 503)
    ) as unknown as typeof fetch;
    const result = await refreshClaudeSubscriptionToken({
      refreshToken: 'refresh-value',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, definitive: false });
  });

  it('classifies a network failure during refresh as transient', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await refreshClaudeSubscriptionToken({
      refreshToken: 'refresh-value',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, definitive: false });
  });
});

describe('AnthropicProvider Claude subscription OAuth', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    resetProviderFailureStore();
  });

  afterEach(() => {
    resetProviderFailureStore();
    process.env = originalEnv;
  });

  function makeProvider(fetchImpl: typeof fetch): {
    provider: AnthropicProvider;
    bodies: Array<Record<string, unknown>>;
  } {
    const bodies: Array<Record<string, unknown>> = [];
    const wrapper: typeof fetch = async (input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return fetchImpl(input, init);
    };
    const provider = new AnthropicProvider({}, 'anthropic-oauth-test', wrapper);
    return { provider, bodies };
  }

  it('authorizes against the Anthropic code page with the manual redirect', async () => {
    const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

    const flow = await provider.startOAuthFlow();
    expect(flow.type).toBe('redirect');
    expect(flow.authUrl).toBeTruthy();

    const authUrl = new URL(flow.authUrl!);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
      CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.authorizeUrl
    );
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.manualRedirectUrl
    );
    expect(flow.message).toContain('paste the code');
    await provider.logout();
  });

  it('returns the in-progress flow when startOAuthFlow is called twice', async () => {
    const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

    const first = await provider.startOAuthFlow();
    const second = await provider.startOAuthFlow();
    expect(second.authUrl).toBe(first.authUrl);
    expect(second.message).toContain('in progress');

    await provider.logout();
  });

  it('refreshes stored subscription tokens and keeps the previous refresh token', async () => {
    const { provider, bodies } = makeProvider(async () =>
      jsonResponse({
        ...TOKEN_RESPONSE,
        access_token: 'refreshed-access-token',
        refresh_token: undefined,
      })
    );

    provider.setCredentials({
      type: 'oauth',
      accessToken: 'old-access-token',
      refreshToken: 'stored-refresh-token',
      expiresAt: Date.now() - 1000,
      raw: { account: TOKEN_RESPONSE.account },
    });

    const refreshed = await provider.refreshToken();
    expect(refreshed).toBe(true);

    const credentials = provider.getCredentials();
    expect(credentials).toMatchObject({
      type: 'oauth',
      accessToken: 'refreshed-access-token',
      refreshToken: 'stored-refresh-token',
    });
    expect(credentials?.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
    expect((credentials?.raw?.account as { email_address?: string }).email_address).toBe(
      'user@example.com'
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'stored-refresh-token',
      client_id: CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.clientId,
      scope: CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.refreshScopes.join(' '),
    });
  });

  it('returns false from refreshToken without oauth refresh credentials', async () => {
    const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));
    expect(await provider.refreshToken()).toBe(false);

    provider.setCredentials({ type: 'api_key', apiKey: 'sk-key' });
    expect(await provider.refreshToken()).toBe(false);
  });

  it('returns false from refreshToken when the grant is rejected and keeps credentials', async () => {
    const { provider } = makeProvider(async () => jsonResponse({ error: 'invalid_grant' }, 400));

    provider.setCredentials({
      type: 'oauth',
      accessToken: 'old-access-token',
      refreshToken: 'stored-refresh-token',
      expiresAt: Date.now() + 3600_000,
    });

    expect(await provider.refreshToken()).toBe(false);
    expect(provider.getCredentials()).toMatchObject({
      accessToken: 'old-access-token',
      refreshToken: 'stored-refresh-token',
    });
  });

  it('reports oauth expiry and account email in auth status', async () => {
    const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

    provider.setCredentials({
      type: 'oauth',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      raw: { account: TOKEN_RESPONSE.account },
    });
    const healthy = await provider.getAuthStatus();
    expect(healthy.isAuthenticated).toBe(true);
    expect(healthy.method).toBe('oauth');
    expect(healthy.expiresAt).toBeGreaterThan(Date.now());
    expect(healthy.needsRefresh).toBeUndefined();
    expect(healthy.user?.email).toBe('user@example.com');

    provider.setCredentials({
      type: 'oauth',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 5 * 60_000,
      raw: { account: TOKEN_RESPONSE.account },
    });
    const expiring = await provider.getAuthStatus();
    expect(expiring.isAuthenticated).toBe(true);
    expect(expiring.needsRefresh).toBe(true);
  });

  it('clears credentials on logout', async () => {
    const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

    provider.setCredentials({
      type: 'oauth',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    expect(provider.isAvailable()).toBe(true);

    await provider.logout();
    expect(provider.getCredentials()).toBeNull();
    expect(provider.isAvailable()).toBe(false);
  });

  it('cancels an in-flight flow on logout and allows a new flow', async () => {
    const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

    const first = await provider.startOAuthFlow();
    await provider.logout();
    expect(provider.getCredentials()).toBeNull();

    const second = await provider.startOAuthFlow();
    expect(second.authUrl).toBeTruthy();
    expect(second.authUrl).not.toBe(first.authUrl);
    await provider.logout();
  });

  describe('submitOAuthCallback', () => {
    it('completes the flow from a pasted code page URL', async () => {
      const { provider, bodies } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

      const credentialsPromise = new Promise<ProviderCredentials>((resolve) =>
        provider.onCredentialsChanged(resolve)
      );
      const flow = await provider.startOAuthFlow();
      const authUrl = new URL(flow.authUrl!);
      const state = authUrl.searchParams.get('state')!;
      const pasted =
        `${CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.manualRedirectUrl}` +
        `#code=relayed-code&state=${encodeURIComponent(state)}`;

      const result = await provider.submitOAuthCallback(pasted);
      expect(result).toEqual({ ok: true });

      const credentials = await credentialsPromise;
      expect(credentials).toMatchObject({
        type: 'oauth',
        accessToken: 'subscription-access-token',
        refreshToken: 'subscription-refresh-token',
      });
      expect(bodies[0]).toMatchObject({
        grant_type: 'authorization_code',
        code: 'relayed-code',
        state,
        redirect_uri: CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.manualRedirectUrl,
        code_verifier: expect.any(String),
      });
      expect(sha256Base64Url(String(bodies[0].code_verifier))).toBe(
        authUrl.searchParams.get('code_challenge')
      );
    });

    it('accepts the code#state paste format', async () => {
      const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

      const flow = await provider.startOAuthFlow();
      const state = new URL(flow.authUrl!).searchParams.get('state')!;

      const result = await provider.submitOAuthCallback(`relay-code-1#${state}`);
      expect(result).toEqual({ ok: true });
      expect(provider.getCredentials()).toMatchObject({ accessToken: 'subscription-access-token' });
    });

    it('rejects a paste whose state does not match but keeps the flow alive', async () => {
      const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

      await provider.startOAuthFlow();

      const result = await provider.submitOAuthCallback(
        `${CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.manualRedirectUrl}#code=some-code&state=wrong-state`
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('does not match');

      const retry = await provider.submitOAuthCallback('late-code#wrong-state');
      expect(retry.ok).toBe(false);

      await provider.logout();
    });

    it('rejects a malformed paste with the paste hint', async () => {
      const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

      await provider.startOAuthFlow();

      const result = await provider.submitOAuthCallback('not-a-callback');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Paste the authorization code');

      await provider.logout();
    });

    it('rejects pasted URLs that are not the Anthropic code page', async () => {
      const { provider, bodies } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

      await provider.startOAuthFlow();

      const result = await provider.submitOAuthCallback(
        'http://localhost:49279/callback?code=abc&state=def'
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Paste the authorization code');
      expect(bodies).toHaveLength(0);

      await provider.logout();
    });

    it('fails when no flow is active', async () => {
      const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

      const result = await provider.submitOAuthCallback('some-code#some-state');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('No active OAuth login flow');
    });

    it('finishes the flow when the relayed exchange is rejected', async () => {
      const { provider } = makeProvider(async () => jsonResponse({ error: 'invalid_grant' }, 401));

      const flow = await provider.startOAuthFlow();
      const state = new URL(flow.authUrl!).searchParams.get('state')!;

      const result = await provider.submitOAuthCallback(`bad-code#${state}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Invalid authorization code');
      expect(provider.getCredentials()).toBeNull();

      const retry = await provider.submitOAuthCallback(`other-code#${state}`);
      expect(retry.ok).toBe(false);
      if (!retry.ok) expect(retry.error).toContain('No active OAuth login flow');
    });

    it('finishes the flow when the pasted URL carries an authorization error', async () => {
      const { provider } = makeProvider(async () => jsonResponse(TOKEN_RESPONSE));

      await provider.startOAuthFlow();

      const result = await provider.submitOAuthCallback(
        `${CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.manualRedirectUrl}#error=access_denied`
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('access_denied');

      const retry = await provider.submitOAuthCallback('code#state');
      expect(retry.ok).toBe(false);
      if (!retry.ok) expect(retry.error).toContain('No active OAuth login flow');
    });
  });

  describe('parseClaudeSubscriptionCallback', () => {
    it('parses the code page URL with the code in the fragment', () => {
      expect(
        parseClaudeSubscriptionCallback(
          'https://platform.claude.com/oauth/code/callback#code=abc&state=def'
        )
      ).toEqual({ code: 'abc', state: 'def' });
    });

    it('parses the code page URL with the code in the query', () => {
      expect(
        parseClaudeSubscriptionCallback(
          'https://platform.claude.com/oauth/code/callback?code=abc&state=def'
        )
      ).toEqual({ code: 'abc', state: 'def' });
    });

    it('surfaces the authorization error parameter', () => {
      expect(
        parseClaudeSubscriptionCallback(
          'https://platform.claude.com/oauth/code/callback#error=access_denied'
        )
      ).toEqual({ error: 'access_denied' });
    });

    it('parses the code#state format', () => {
      expect(parseClaudeSubscriptionCallback(' code#state ')).toEqual({
        code: 'code',
        state: 'state',
      });
    });

    it('rejects inputs without a state and non-code-page URLs', () => {
      expect(
        parseClaudeSubscriptionCallback('https://platform.claude.com/oauth/code/callback?code=abc')
      ).toBeNull();
      expect(parseClaudeSubscriptionCallback('just-a-code')).toBeNull();
      expect(parseClaudeSubscriptionCallback('  ')).toBeNull();
      expect(
        parseClaudeSubscriptionCallback('http://localhost:1/callback?code=abc&state=def')
      ).toBeNull();
    });
  });
});
