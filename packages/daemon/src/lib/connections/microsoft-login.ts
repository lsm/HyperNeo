import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import { readGoogleTokenJson as readBoundedJson } from './google-token-exchange.ts';
import { startLoopbackLogin, type LoginOutcome } from './loopback-login.ts';
import { grantedScopes } from './status.ts';

const authority = 'https://login.microsoftonline.com';
const SCOPES = 'openid profile email offline_access Mail.ReadWrite Calendars.Read';
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Client = { clientId: string };
export const microsoftTokenEndpoint = (accountId: string) => ({
  url: `${authority}/${accountId.split('.')[0]}/oauth2/v2.0/token`,
  form: { scope: SCOPES },
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().max(86400),
  scope: z.string().max(6000),
  token_type: z.literal('Bearer'),
  id_token: z.string().min(1),
});
type Token = z.infer<typeof tokenSchema>;
const keySet = z.object({
  keys: z
    .array(z.object({ kid: z.string(), issuer: z.string().optional() }).passthrough())
    .max(100),
});

async function boundedJson(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Microsoft identity request failed');
  }
  return readBoundedJson(response.body);
}

async function requestToken(
  code: string,
  verifier: string,
  redirectUri: string,
  client: Client,
  fetchImpl: typeof fetch,
  signal: AbortSignal
) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    scope: SCOPES,
  });
  const response = await fetchImpl(`${authority}/common/oauth2/v2.0/token`, {
    method: 'POST',
    body,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  return tokenSchema.parse(await boundedJson(response));
}

async function validateIdentity(
  token: Token,
  nonce: string,
  client: Client,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<LoginOutcome> {
  const { kid } = decodeProtectedHeader(token.id_token);
  const response = await fetchImpl(`${authority}/common/discovery/v2.0/keys`, {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  const key = keySet.parse(await boundedJson(response)).keys.find((entry) => entry.kid === kid);
  if (!key?.issuer) throw new Error('Unknown signing key');
  const { payload } = await jwtVerify(token.id_token, await importJWK(key as JWK, 'RS256'), {
    algorithms: ['RS256'],
    audience: client.clientId,
    requiredClaims: ['iss', 'tid', 'oid', 'nonce', 'exp', 'iat'],
  });
  const tid = z.string().regex(guid).parse(payload.tid);
  const issuer = `${authority}/${tid}/v2.0`;
  if (
    payload.iss !== issuer ||
    key.issuer.replace('{tenantid}', tid) !== issuer ||
    payload.nonce !== nonce
  )
    throw new Error('Identity mismatch');
  const email = z
    .string()
    .email()
    .safeParse(payload.email ?? payload.preferred_username);
  if (!email.success) return { ok: false, reason: 'account_unsupported' };
  return {
    ok: true,
    accountId: `${tid}.${z.string().min(1).max(100).parse(payload.oid)}`,
    email: email.data,
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes: grantedScopes(token.scope),
    },
  };
}

const exchangeMicrosoftCode = (superpipe({})('microsoft-login-exchange') as PipelineAPI)
  .input(['code', 'verifier', 'redirectUri', 'nonce', 'client', 'fetchImpl', 'signal'])
  .pipe(requestToken, ['code', 'verifier', 'redirectUri', 'client', 'fetchImpl', 'signal'], 'token')
  .pipe(validateIdentity, ['token', 'nonce', 'client', 'fetchImpl', 'signal'], 'identity')
  .endAsync('identity') as (
  code: string,
  verifier: string,
  redirectUri: string,
  nonce: string,
  client: Client,
  fetchImpl: typeof fetch,
  signal: AbortSignal
) => Promise<LoginOutcome>;

export async function startMicrosoftLogin(
  client: Client,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
) {
  if (!client.clientId.trim()) throw new Error('Microsoft application client ID is required');
  return startLoopbackLogin({
    timeoutMs: options.timeoutMs,
    redirect: (port) => `http://localhost:${port}/oauth/microsoft/callback`,
    exchange: (code, verifier, redirectUri, nonce, signal) =>
      exchangeMicrosoftCode(
        code,
        verifier,
        redirectUri,
        nonce,
        client,
        options.fetchImpl ?? fetch,
        signal
      ),
    authorize: (redirectUri, { state, nonce, challenge }) => {
      const authorize = new URL(`${authority}/common/oauth2/v2.0/authorize`);
      for (const [name, value] of Object.entries({
        client_id: client.clientId,
        response_type: 'code',
        response_mode: 'query',
        redirect_uri: redirectUri,
        scope: SCOPES,
        prompt: 'select_account',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      }))
        authorize.searchParams.set(name, value);
      return authorize;
    },
  });
}
