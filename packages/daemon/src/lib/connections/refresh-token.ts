import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import { connectionTokens, type ConnectionTokens } from './status.ts';
import { readGoogleTokenJson } from './google-token-exchange.ts';

export type OfflineGrant = ConnectionTokens & {
  refreshToken: string;
  client: NonNullable<ConnectionTokens['client']>;
};
export type RefreshEndpoint = { url: string; form?: Record<string, string> };
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
async function request(
  old: OfflineGrant,
  endpoint: RefreshEndpoint,
  fetchImpl: typeof fetch,
  signal: AbortSignal
) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: old.refreshToken,
    client_id: old.client.clientId,
    ...endpoint.form,
  });
  if (old.client.clientSecret) body.set('client_secret', old.client.clientSecret);
  const response = await fetchImpl(endpoint.url, {
    method: 'POST',
    body,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  return {
    status: response.status,
    body: response.ok ? await readGoogleTokenJson(response.body) : await response.body?.cancel(),
  };
}
function renewed(
  response: Awaited<ReturnType<typeof request>>,
  old: OfflineGrant,
  now: () => number
): RefreshOutcome {
  if (response.status < 200 || response.status >= 300)
    return {
      ok: false,
      reason:
        response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)
          ? 'reconnect_needed'
          : 'refresh_failed',
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
const exchange = (superpipe({})('connection-grant-refresh') as PipelineAPI)
  .input(['old', 'endpoint', 'fetchImpl', 'signal', 'now'])
  .pipe(request, ['old', 'endpoint', 'fetchImpl', 'signal'], 'response')
  .pipe(renewed, ['response', 'old', 'now'], 'result')
  .endAsync('result') as (
  old: OfflineGrant,
  endpoint: RefreshEndpoint,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  now: () => number
) => Promise<RefreshOutcome>;

export async function refreshGrant(
  old: OfflineGrant,
  endpoint: RefreshEndpoint,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  now: () => number
): Promise<RefreshOutcome> {
  try {
    return await exchange(old, endpoint, fetchImpl, signal, now);
  } catch {
    return { ok: false, reason: signal.aborted ? 'cancelled' : 'refresh_failed' };
  }
}
