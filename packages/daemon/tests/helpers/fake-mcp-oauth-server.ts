import { createHash, randomUUID } from 'node:crypto';
import { createHttpWsServer } from '../../src/lib/runtime-server/index.ts';

export type FakeMcpOAuthSwitches = {
  advertiseAllScopes?: boolean;
  grantScope?: string;
  omitRefreshScope?: boolean;
  slack?: boolean;
  slackError?: string;
  metadataIssuer?: string;
  authorizationEndpoint?: string;
  authorizationServer?: string;
  redirectMetadataTo?: string;
  oversized?: 'metadata' | 'resource' | 'token';
  stall?: 'headers' | 'body';
  redirectToken?: boolean;
  redirectTokenAway?: boolean;
  redirectWithoutLocation?: boolean;
  echoError?: 'oauth' | 'raw';
  tokenStatus?: number;
};

export const echoedSecret = 'echoed-synthetic-secret';

export type FakeRequest = {
  method: string;
  path: string;
  search: string;
  params: URLSearchParams;
  auth: string;
};

const allScopes = ['read', 'search', 'write', 'admin'];

export async function startFakeMcpOAuthServer(switches: FakeMcpOAuthSwitches = {}) {
  const requests: FakeRequest[] = [];
  const authorizeScopes: string[] = [];
  const codes = new Map<string, { challenge: string; scope: string; redirectUri: string }>();
  const refreshTokens = new Map<string, string>();
  const accessTokens = new Set<string>();
  let base = '';
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers });
  const padding = () => 'x'.repeat(300000);
  const tokenReply = (scope: string, includeScope: boolean) => {
    if (switches.slackError) return json({ ok: false, error: switches.slackError });
    if (switches.echoError === 'oauth')
      return json({ error: 'invalid_grant', error_description: `rejected ${echoedSecret}` }, 400);
    if (switches.echoError === 'raw') return json({ message: `rejected ${echoedSecret}` }, 400);
    const access = `access-${randomUUID()}`;
    const refresh = `refresh-${randomUUID()}`;
    accessTokens.add(access);
    refreshTokens.set(refresh, scope);
    const granted = switches.grantScope ?? scope;
    const tokens = {
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      ...(switches.oversized === 'token' ? { padding: padding() } : {}),
    };
    if (switches.slack)
      return json(
        {
          ok: true,
          ...tokens,
          token_type: 'user',
          authed_user: { scope: granted.split(' ').join(',') },
        },
        switches.tokenStatus
      );
    return json(
      { ...tokens, token_type: 'Bearer', ...(includeScope ? { scope: granted } : {}) },
      switches.tokenStatus
    );
  };
  const handle = async (request: Request) => {
    const url = new URL(request.url);
    const params = new URLSearchParams(
      request.method === 'POST' && !request.headers.get('content-type')?.includes('json')
        ? await request.text()
        : url.search
    );
    const auth = request.headers.get('authorization') ?? '';
    requests.push({ method: request.method, path: url.pathname, search: url.search, params, auth });
    if (
      url.pathname === '/.well-known/oauth-authorization-server' &&
      switches.redirectWithoutLocation
    )
      return new Response(null, { status: 302 });
    if (url.pathname === '/.well-known/oauth-authorization-server' && switches.stall === 'headers')
      await new Promise(() => {});
    if (url.pathname === '/.well-known/oauth-authorization-server' && switches.stall === 'body')
      return new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode('{')),
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' && switches.redirectMetadataTo)
      return new Response(null, {
        status: 307,
        headers: { location: switches.redirectMetadataTo },
      });
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json({
        resource: `${base}/mcp`,
        authorization_servers: [switches.authorizationServer ?? base],
        scopes_supported: switches.advertiseAllScopes ? allScopes : ['read', 'search'],
        ...(switches.oversized === 'resource' ? { padding: padding() } : {}),
      });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json({
        issuer: switches.metadataIssuer ?? base,
        authorization_endpoint: switches.authorizationEndpoint ?? `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: allScopes,
        ...(switches.oversized === 'metadata' ? { padding: padding() } : {}),
      });
    if (url.pathname === '/register')
      return json({ ...(await request.json()), client_id: `client-${randomUUID()}` }, 201);
    if (url.pathname === '/authorize') {
      const scope = params.get('scope') ?? '';
      authorizeScopes.push(scope);
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        challenge: params.get('code_challenge') ?? '',
        scope,
        redirectUri: params.get('redirect_uri') ?? '',
      });
      const target = new URL(params.get('redirect_uri') ?? '');
      target.searchParams.set('code', code);
      target.searchParams.set('state', params.get('state') ?? '');
      return new Response(null, { status: 302, headers: { location: target.href } });
    }
    if (url.pathname === '/token' && switches.redirectTokenAway)
      return Response.json(
        { error: 'invalid_grant', error_description: `rejected ${echoedSecret}` },
        { status: 302, headers: { location: `/elsewhere-${echoedSecret}` } }
      );
    if (url.pathname === '/token' && switches.redirectToken && !url.search)
      return new Response(null, { status: 307, headers: { location: '/token?moved=1' } });
    if (url.pathname === '/token') {
      if (params.get('grant_type') === 'authorization_code') {
        const entry = codes.get(params.get('code') ?? '');
        codes.delete(params.get('code') ?? '');
        const proof = createHash('sha256')
          .update(params.get('code_verifier') ?? '')
          .digest('base64url');
        if (!entry || entry.challenge !== proof || entry.redirectUri !== params.get('redirect_uri'))
          return json({ error: 'invalid_grant' }, 400);
        return tokenReply(entry.scope, true);
      }
      const scope = refreshTokens.get(params.get('refresh_token') ?? '');
      refreshTokens.delete(params.get('refresh_token') ?? '');
      if (scope === undefined) return json({ error: 'invalid_grant' }, 400);
      return tokenReply(scope, !switches.omitRefreshScope);
    }
    if (url.pathname === '/mcp' && !accessTokens.has(auth.replace(/^Bearer /, '')))
      return json({ error: 'unauthorized' }, 401, {
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
    return json({ error: 'not_found' }, 404);
  };
  const server = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: handle });
  base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    url: `${base}/mcp`,
    requests,
    authorizeScopes,
    switches,
    stop: () => server.stop(true),
  };
}
