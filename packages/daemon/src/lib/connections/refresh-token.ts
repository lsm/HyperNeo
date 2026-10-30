import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import { connectionTokens, type ConnectionTokens } from './status.ts';
import { readGoogleTokenJson } from './google-token-exchange.ts';

export type OfflineGrant = ConnectionTokens & {
  refreshToken: string;
  client: NonNullable<ConnectionTokens['client']>;
};
export type RefreshOutcome =
  | { ok: true; tokens: ConnectionTokens }
  | { ok: false; reason: 'reconnect_needed' | 'refresh_failed' | 'cancelled' };
const grant = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().max(86400),
  token_type: z.literal('Bearer'),
  scope: z.string().max(6000).optional(),
});
async function request(old: OfflineGrant, fetchImpl: typeof fetch, signal: AbortSignal) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: old.refreshToken,
    client_id: old.client.clientId,
  });
  if (old.client.clientSecret) body.set('client_secret', old.client.clientSecret);
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  return { ok: response.ok, body: await readGoogleTokenJson(response.body) };
}
function renewed(
  response: Awaited<ReturnType<typeof request>>,
  old: OfflineGrant,
  now: () => number
): RefreshOutcome {
  if (!response.ok)
    return {
      ok: false,
      reason: response.body?.error === 'invalid_grant' ? 'reconnect_needed' : 'refresh_failed',
    };
  const value = grant.parse(response.body);
  return {
    ok: true,
    tokens: connectionTokens.parse({
      ...old,
      accessToken: value.access_token,
      refreshToken: value.refresh_token ?? old.refreshToken,
      expiresAt: now() + value.expires_in * 1000,
      scopes: value.scope === undefined ? old.scopes : value.scope.split(/\s+/).filter(Boolean),
    }),
  };
}
const exchange = (superpipe({})('google-grant-refresh') as PipelineAPI)
  .input(['old', 'fetchImpl', 'signal', 'now'])
  .pipe(request, ['old', 'fetchImpl', 'signal'], 'response')
  .pipe(renewed, ['response', 'old', 'now'], 'result')
  .endAsync('result') as (
  old: OfflineGrant,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  now: () => number
) => Promise<RefreshOutcome>;

export async function refreshGoogleGrant(
  old: OfflineGrant,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  now: () => number
): Promise<RefreshOutcome> {
  try {
    return await exchange(old, fetchImpl, signal, now);
  } catch {
    return { ok: false, reason: signal.aborted ? 'cancelled' : 'refresh_failed' };
  }
}
