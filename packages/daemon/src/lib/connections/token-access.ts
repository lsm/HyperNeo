import superpipe, { type PipelineAPI } from 'superpipe';
import type { ConnectionVault } from './vault.ts';
import type { ConnectionStatus, ConnectionTokens } from './status.ts';
import { refreshGoogleGrant, type OfflineGrant, type RefreshOutcome } from './refresh-token.ts';

type Access = { ok: true; accessToken: string; expiresAt: number } | { ok: false; reason: string };
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
});
function planAccess(
  loaded: Loaded,
  now: number,
  retryAt: number,
  aborted: boolean
): { value: Plan } | { reason: Access } {
  if (aborted) return { reason: failed('cancelled') };
  const { tokens } = loaded;
  if (tokens && tokens.expiresAt - now > 120000) return { reason: access(tokens) };
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
  const flights = new Map<string, Promise<Access>>();
  const controllers = new Map<string, AbortController>();
  const retries = new Map<string, number>();
  const apply = async (decision: Decision): Promise<Access> => {
    if (decision.kind === 'disable')
      await deps.save({ ...decision.connection, health: 'reconnect_needed' });
    if (decision.kind === 'backoff') retries.set(decision.id, decision.until);
    if (decision.kind === 'persist') {
      await deps.save({ ...decision.connection, health: 'reconnect_needed' });
      await deps.vault.replace(decision.connection, decision.tokens);
      await deps.save(decision.connection);
      retries.delete(decision.connection.id);
    }
    return decision.result;
  };
  const execute = (superpipe({})('google-connection-access') as PipelineAPI)
    .input(['id', 'signal'])
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
      async (connection: ConnectionStatus): Promise<Loaded> => ({
        connection,
        tokens: await deps.vault.read(connection).catch(() => null),
      }),
      'result',
      'loaded'
    )
    .pipe(
      (loaded: Loaded, signal: AbortSignal) =>
        planAccess(loaded, now(), retries.get(loaded.connection.id) ?? 0, signal.aborted),
      ['loaded', 'signal'],
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
    .endAsync('result') as (id: string, signal: AbortSignal) => Promise<Access>;
  return {
    token(id: string): Promise<Access> {
      if (deps.closed.aborted) return Promise.resolve(failed('cancelled'));
      const pending = flights.get(id);
      if (pending) return pending;
      const controller = new AbortController();
      controllers.set(id, controller);
      const result = deps
        .serial(() => execute(id, AbortSignal.any([deps.closed, controller.signal])))
        .catch(() => failed('refresh_failed'));
      flights.set(id, result);
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
}
