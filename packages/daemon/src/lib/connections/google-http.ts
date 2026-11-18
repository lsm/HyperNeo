import superpipe, { type PipelineAPI } from 'superpipe';
import { readGoogleTokenJson as readBoundedJson } from './google-token-exchange.ts';
import type { createGoogleTokenAccess } from './token-access.ts';
import { grantedScopes } from './status.ts';

type Token = ReturnType<typeof createGoogleTokenAccess>['token'];
type Grant = Extract<Awaited<ReturnType<Token>>, { ok: true }>;
export type GoogleReply = { ok: true; data: unknown } | { ok: false; reason: string };
type Write = { method: 'POST' | 'PUT' | 'PATCH'; body: string };
type Payload = Partial<Write> & { headers?: Record<string, string> };
type Reply = { response: Response; token: string };
const denied = (reason: string) => ({ ok: false as const, reason });
function admit(grant: Awaited<ReturnType<Token>>, scope: string) {
  return !grant.ok
    ? { reason: grant }
    : grantedScopes(grant.scopes.join(' ')).includes(scope)
      ? { value: grant }
      : { reason: denied('missing_scope') };
}
async function finish({ response, token }: Reply): Promise<GoogleReply> {
  if (!response.ok) {
    await response.body?.cancel();
    return denied(
      response.status === 401
        ? 'unauthorized'
        : response.status === 429
          ? 'rate_limited'
          : 'request_failed'
    );
  }
  try {
    const data = await readBoundedJson(response.body);
    return {
      ok: true,
      data: JSON.parse(
        JSON.stringify(data, (_key, value) =>
          typeof value === 'string' ? value.replaceAll(token, '[redacted]') : value
        )
      ),
    };
  } catch {
    return denied('invalid_response');
  }
}

export function createGoogleHttp(deps: {
  token: Token;
  closed: AbortSignal;
  fetchImpl?: typeof fetch;
  apiTimeoutMs?: number;
}) {
  const active = new Map<string, Set<AbortController>>();
  const request = async (
    grant: Grant,
    url: string,
    signal: AbortSignal,
    payload?: Payload
  ): Promise<Reply> => ({
    response: await (deps.fetchImpl ?? fetch)(url, {
      method: payload?.method,
      body: payload?.body,
      headers: {
        Authorization: `Bearer ${grant.accessToken}`,
        ...(payload?.body ? { 'Content-Type': 'application/json' } : {}),
        ...payload?.headers,
      },
      redirect: 'error',
      signal,
    }),
    token: grant.accessToken,
  });
  const run = (superpipe({})('google-read-request') as PipelineAPI)
    .input(['id', 'url', 'scope', 'signal', 'payload'])
    .pipe((id: string) => deps.token(id), 'id', 'grant')
    .pipe(admit, ['grant', 'scope'], 'result:result')
    .pipe(request, ['result', 'url', 'signal', 'payload'], 'reply')
    .pipe(
      async (
        reply: Reply,
        id: string,
        scope: string,
        url: string,
        signal: AbortSignal,
        payload?: Payload
      ) => {
        if (reply.response.status !== 401) return { value: reply };
        await reply.response.body?.cancel();
        const next = admit(await deps.token(id, true), scope);
        return 'reason' in next ? next : { value: await request(next.value, url, signal, payload) };
      },
      ['reply', 'id', 'scope', 'url', 'signal', 'payload'],
      'result:result'
    )
    .pipe(finish, 'result', 'result')
    .endAsync('result') as (
    id: string,
    url: string,
    scope: string,
    signal: AbortSignal,
    payload?: Payload
  ) => Promise<GoogleReply>;
  const perform = async (
    id: string,
    url: string,
    scope: string,
    payload?: Payload
  ): Promise<GoogleReply> => {
    const controller = new AbortController();
    const requests = active.get(id) ?? new Set<AbortController>();
    active.set(id, requests);
    requests.add(controller);
    const timeout = AbortSignal.timeout(deps.apiTimeoutMs ?? 10000);
    const signal = AbortSignal.any([controller.signal, deps.closed, timeout]);
    try {
      return await run(id, url, scope, signal, payload);
    } catch {
      return denied(timeout.aborted ? 'timeout' : signal.aborted ? 'cancelled' : 'request_failed');
    } finally {
      requests.delete(controller);
      if (!requests.size) active.delete(id);
    }
  };
  return {
    get: (id: string, url: string, scope: string, headers?: Record<string, string>) =>
      perform(id, url, scope, headers && { headers }),
    write: (id: string, url: string, scope: string, method: Write['method'], body: string) =>
      perform(id, url, scope, { method, body }),
    cancel(id: string) {
      for (const request of active.get(id) ?? []) request.abort();
    },
  };
}
