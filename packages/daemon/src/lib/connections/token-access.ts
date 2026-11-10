import superpipe, { type PipelineAPI } from 'superpipe';
import type { ConnectionVault } from './vault.ts';
import type { ConnectionStatus, ConnectionTokens } from './status.ts';
import { refreshGoogleGrant, type OfflineGrant, type RefreshOutcome } from './refresh-token.ts';

type Access =
  | { ok: true; accessToken: string; expiresAt: number; scopes: string[] }
  | { ok: false; reason: string };
type Loaded = { connection: ConnectionStatus; tokens: ConnectionTokens | null };
type Plan = Loaded & { offline?: OfflineGrant };
type Decision =
  | { kind: 'return'; result: Access }
  | { kind: 'disable'; connection: ConnectionStatus; result: Access }
  | { kind: 'backoff'; id: string; until: number; result: Access }
  | { kind: 'persist'; connection: ConnectionStatus; tokens: ConnectionTokens; result: Access };
const failed = (reason: string): Access => ({ ok: false, reason });
const access = (tokens: ConnectionTokens): Access => ({
  ok: true,
  accessToken: tokens.accessToken,
  expiresAt: tokens.expiresAt,
  scopes: tokens.scopes,
});
function planAccess(
  loaded: Loaded,
  now: number,
  retryAt: number,
  aborted: boolean,
  force: boolean
): { value: Plan } | { reason: Access } {
  if (aborted) return { reason: failed('cancelled') };
  const { tokens } = loaded;
  if (!force && tokens && tokens.expiresAt - now > 120000) return { reason: access(tokens) };
  if (retryAt > now)
    return { reason: tokens && tokens.expiresAt > now ? access(tokens) : failed('refresh_failed') };
  const offline =
    tokens?.refreshToken && tokens.client
      ? { ...tokens, refreshToken: tokens.refreshToken, client: tokens.client }
      : undefined;
  return { value: { ...loaded, offline } };
}
function decide(plan: Plan, outcome: RefreshOutcome, now: number, aborted: boolean): Decision {
  if (aborted || (!outcome.ok && outcome.reason === 'cancelled'))
    return { kind: 'return', result: failed('cancelled') };
  if (outcome.ok)
    return {
      kind: 'persist',
      connection: { ...plan.connection, scopes: outcome.tokens.scopes },
      tokens: outcome.tokens,
      result: access(outcome.tokens),
    };
  if (outcome.reason === 'reconnect_needed')
    return { kind: 'disable', connection: plan.connection, result: failed('reconnect_needed') };
  return {
    kind: 'backoff',
    id: plan.connection.id,
    until: now + 60000,
    result:
      plan.tokens && plan.tokens.expiresAt > now ? access(plan.tokens) : failed('refresh_failed'),
  };
}

export function createGoogleTokenAccess(deps: {
  read: () => Promise<ConnectionStatus[]>;
  save: (row: ConnectionStatus) => Promise<void>;
  vault: ConnectionVault;
  closed: AbortSignal;
  serial: <T>(action: () => Promise<T>) => Promise<T>;
  now?: () => number;
  fetchImpl?: typeof fetch;
}) {
  const now = deps.now ?? Date.now;
  const flights = new Map<string, { force: boolean; result: Promise<Access> }>();
  const controllers = new Map<string, AbortController>();
  const retries = new Map<string, { until: number; storage?: boolean }>();
  const apply = async (decision: Decision): Promise<Access> => {
    if (decision.kind === 'disable')
      await deps.save({ ...decision.connection, health: 'reconnect_needed' });
    if (decision.kind === 'backoff') retries.set(decision.id, { until: decision.until });
    if (decision.kind === 'persist') {
      await deps.vault.replace(decision.connection, decision.tokens);
      await deps.save(decision.connection);
      retries.delete(decision.connection.id);
    }
    return decision.result;
  };
  const execute = (superpipe({})('google-connection-access') as PipelineAPI)
    .input(['id', 'signal', 'force'])
    .pipe(
      async (id: string) => (await deps.read()).find((row) => row.id === id),
      'id',
      'connection'
    )
    .pipe(
      (connection: ConnectionStatus | undefined, signal: AbortSignal) =>
        signal.aborted
          ? { reason: failed('cancelled') }
          : !connection
            ? { reason: failed('unknown_connection') }
            : connection.health !== 'healthy'
              ? { reason: failed(connection.health) }
              : { value: connection },
      ['connection', 'signal'],
      'result:result'
    )
    .pipe(
      async (connection: ConnectionStatus): Promise<{ value: Loaded } | { reason: Access }> => {
        const retry = retries.get(connection.id);
        if (retry?.storage && retry.until > now()) return { reason: failed('refresh_failed') };
        const tokens = await deps.vault.read(connection);
        const current = tokens ? { ...connection, scopes: tokens.scopes } : connection;
        if (JSON.stringify(current.scopes) !== JSON.stringify(connection.scopes))
          await deps.save(current);
        return { value: { connection: current, tokens } };
      },
      'result',
      'result:result'
    )
    .pipe(
      (loaded: Loaded, signal: AbortSignal, force: boolean) =>
        planAccess(
          loaded,
          now(),
          retries.get(loaded.connection.id)?.until ?? 0,
          signal.aborted,
          force
        ),
      ['result', 'signal', 'force'],
      'result:result'
    )
    .pipe(
      (plan: Plan, signal: AbortSignal): Promise<RefreshOutcome> | RefreshOutcome =>
        plan.offline
          ? refreshGoogleGrant(plan.offline, deps.fetchImpl ?? fetch, signal, now)
          : { ok: false, reason: 'reconnect_needed' },
      ['result', 'signal'],
      'outcome'
    )
    .pipe(
      (plan: Plan, outcome: RefreshOutcome, signal: AbortSignal) =>
        decide(plan, outcome, now(), signal.aborted),
      ['result', 'outcome', 'signal'],
      'decision'
    )
    .pipe(apply, 'decision', 'result')
    .endAsync('result') as (id: string, signal: AbortSignal, force: boolean) => Promise<Access>;
  const handle = {
    token(id: string, force = false): Promise<Access> {
      if (deps.closed.aborted) return Promise.resolve(failed('cancelled'));
      const pending = flights.get(id);
      if (pending)
        return force && !pending.force
          ? pending.result.then(() => handle.token(id, true))
          : pending.result;
      const controller = new AbortController();
      controllers.set(id, controller);
      const result = deps
        .serial(() => execute(id, AbortSignal.any([deps.closed, controller.signal]), force))
        .catch(() => {
          retries.set(id, { until: now() + 60000, storage: true });
          return failed('refresh_failed');
        });
      flights.set(id, { force, result });
      void result.finally(() => {
        flights.delete(id);
        controllers.delete(id);
      });
      return result;
    },
    cancel(id: string) {
      controllers.get(id)?.abort();
    },
    resume(id: string) {
      retries.delete(id);
    },
  };
  return handle;
}
