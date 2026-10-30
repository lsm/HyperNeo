import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';

type Client = { clientId: string; clientSecret?: string };
type Success = {
  ok: true;
  accountId: string;
  email: string;
  tokens: { accessToken: string; refreshToken?: string; expiresAt: number; scopes: string[] };
};
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().max(86400),
  scope: z.string().max(6000),
  token_type: z.literal('Bearer'),
  id_token: z.string().min(1),
});
type Token = z.infer<typeof tokenSchema>;

export async function readGoogleTokenJson(body: Response['body']) {
  const reader = body?.getReader();
  if (!reader) throw new Error('Missing token response');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error('Token response too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function tokenJson(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Token exchange failed');
  }
  return tokenSchema.parse(await readGoogleTokenJson(response.body));
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
  });
  if (client.clientSecret) body.set('client_secret', client.clientSecret);
  return tokenJson(
    await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    })
  );
}

async function validateIdentity(
  token: Token,
  nonce: string,
  client: Client,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<Success> {
  const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
    [customFetch]: (url, options) =>
      fetchImpl(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.any([signal, options.signal ?? AbortSignal.timeout(5000)]),
      }),
  });
  const { payload } = await jwtVerify(token.id_token, keys, {
    algorithms: ['RS256'],
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: client.clientId,
    requiredClaims: ['sub', 'exp', 'iat', 'nonce', 'email'],
  });
  if (
    payload.nonce !== nonce ||
    payload.email_verified !== true ||
    (payload.azp !== undefined && payload.azp !== client.clientId)
  )
    throw new Error('Identity mismatch');
  const email = z.string().email().parse(payload.email);
  return {
    ok: true,
    accountId: z.string().min(1).max(200).parse(payload.sub),
    email,
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes: token.scope.split(/\s+/).filter(Boolean),
    },
  };
}

export const exchangeGoogleCode = (superpipe({})('google-login-exchange') as PipelineAPI)
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
) => Promise<Success>;
