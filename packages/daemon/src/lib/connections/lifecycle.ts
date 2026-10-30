import { randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { startGoogleLogin } from './google-login.ts';
import type { ConnectionVault } from './vault.ts';
import type { ConnectionStatus, GoogleConnectionAttempt as View } from './status.ts';
import { createGoogleTokenAccess } from './token-access.ts';

type Login = Awaited<ReturnType<typeof startGoogleLogin>>;
type Outcome = Awaited<Login['result']>;
type Client = Parameters<typeof startGoogleLogin>[0];
type Flow = {
  id: string;
  connectionId: string;
  accountId?: string;
  client: Client;
  login?: Login;
  cancelled: boolean;
  deniedAccounts: Set<string>;
  view: View;
};
type Admitted = { flow: Flow; outcome: Extract<Outcome, { ok: true }> };
type Read = () => Promise<ConnectionStatus[]>;
type Save = (connection: ConnectionStatus) => Promise<void>;

function admit(
  outcome: Outcome,
  flow: Flow,
  active: Flow | undefined,
  closed: boolean
): { value: Admitted } | { reason: View } {
  if (closed || flow.cancelled || flow !== active)
    return { reason: { state: 'failed', reason: 'cancelled' } };
  if (!outcome.ok) return { reason: { state: 'failed', reason: outcome.reason } };
  if (flow.deniedAccounts.has(outcome.accountId))
    return { reason: { state: 'failed', reason: 'cancelled' } };
  if (flow.accountId && flow.accountId !== outcome.accountId)
    return { reason: { state: 'failed', reason: 'account_mismatch' } };
  return { value: { flow, outcome } };
}

function planLogin({ flow, outcome }: Admitted, records: ConnectionStatus[]) {
  const id =
    records.find((record) => record.accountId === outcome.accountId)?.id ?? flow.connectionId;
  const connection: ConnectionStatus = {
    id,
    provider: 'google',
    accountId: outcome.accountId,
    email: outcome.email,
    scopes: outcome.tokens.scopes,
    health: 'healthy',
  };
  return { connection, loginId: flow.id, tokens: { ...outcome.tokens, client: flow.client } };
}

async function persistLogin(
  plan: ReturnType<typeof planLogin>,
  save: Save,
  vault: ConnectionVault
): Promise<View> {
  await save({ ...plan.connection, health: 'reconnect_needed' });
  await vault.replace(plan.connection, plan.tokens);
  await save(plan.connection);
  return { state: 'complete', loginId: plan.loginId, connectionId: plan.connection.id };
}

const completeLogin = (superpipe({})('google-connection-complete') as PipelineAPI)
  .input(['outcome', 'flow', 'active', 'closed', 'read', 'save', 'vault'])
  .pipe(admit, ['outcome', 'flow', 'active', 'closed'], 'result:result')
  .pipe((read: Read) => read(), 'read', 'records')
  .pipe(planLogin, ['result', 'records'], 'plan')
  .pipe(persistLogin, ['plan', 'save', 'vault'], 'result')
  .endAsync('result') as (
  outcome: Outcome,
  flow: Flow,
  active: Flow | undefined,
  closed: boolean,
  read: Read,
  save: Save,
  vault: ConnectionVault
) => Promise<View>;

const disconnect = (superpipe({})('google-connection-disconnect') as PipelineAPI)
  .input(['connection', 'save', 'vault'])
  .pipe(
    async (connection: ConnectionStatus, save: Save) => {
      const disabled = { ...connection, health: 'disconnected' as const };
      await save(disabled);
      return disabled;
    },
    ['connection', 'save'],
    'disabled'
  )
  .pipe(
    async (disabled: ConnectionStatus, vault: ConnectionVault) => {
      try {
        await vault.remove(disabled);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'credential_delete_failed' };
      }
    },
    ['disabled', 'vault'],
    'result'
  )
  .endAsync('result') as (
  connection: ConnectionStatus,
  save: Save,
  vault: ConnectionVault
) => Promise<{ ok: boolean; reason?: string }>;

export function createConnectionLifecycle(deps: {
  read: Read;
  save: Save;
  vault: ConnectionVault;
  startLogin: typeof startGoogleLogin;
  closed: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  let current: Flow | undefined;
  let pending = Promise.resolve();
  const serial = <T>(action: () => Promise<T>) => {
    const result = pending.then(action);
    pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const closing = new AbortController();
  const closed = AbortSignal.any([deps.closed, closing.signal]);
  const access = createGoogleTokenAccess({ ...deps, serial, closed });
  const cancel = () => {
    if (current) {
      current.cancelled = true;
      current.login?.cancel();
      current.login = undefined;
    }
  };
  closed.addEventListener('abort', cancel, { once: true });
  return {
    token: access.token,
    close: () => closing.abort(),
    connect: (input: Partial<Client> & { connectionId?: string }) =>
      serial<View>(async () => {
        if (closed.aborted) return { state: 'failed', reason: 'cancelled' };
        const account = (await deps.read()).find((record) => record.id === input.connectionId);
        if (input.connectionId && !account)
          return { state: 'failed', reason: 'unknown_connection' };
        const client = input.clientId
          ? { clientId: input.clientId, clientSecret: input.clientSecret }
          : account
            ? (await deps.vault.read(account))?.client
            : undefined;
        if (!client) return { state: 'failed', reason: 'client_not_configured' };
        cancel();
        const login = await deps.startLogin(client);
        if (closed.aborted) {
          login.cancel();
          return { state: 'failed', reason: 'cancelled' };
        }
        const id = randomUUID();
        const flow: Flow = {
          id,
          connectionId: account?.id ?? randomUUID(),
          accountId: account?.accountId,
          client,
          login,
          cancelled: false,
          deniedAccounts: new Set(),
          view: { state: 'pending', loginId: id },
        };
        current = flow;
        void login.result
          .then((outcome) =>
            serial(() =>
              completeLogin(
                outcome,
                flow,
                current,
                closed.aborted,
                deps.read,
                deps.save,
                deps.vault
              )
            )
          )
          .then(
            (view) => {
              flow.view = view;
              flow.login = undefined;
              if (view.state === 'complete' && view.connectionId) access.resume(view.connectionId);
            },
            () => {
              flow.view = { state: 'failed', reason: 'storage_failed' };
              flow.login = undefined;
            }
          );
        return { ...flow.view, authorizeUrl: login.authorizeUrl };
      }),
    status: (loginId?: string): View => ({
      ...(current && (!loginId || current.id === loginId) ? current.view : { state: 'missing' }),
      storage: deps.vault.storageStatus(),
    }),
    disconnect: (connectionId: string) => {
      access.cancel(connectionId);
      return serial(async () => {
        const connection = (await deps.read()).find((record) => record.id === connectionId);
        if (!connection) return { ok: false, reason: 'unknown_connection' };
        current?.deniedAccounts.add(connection.accountId);
        if (current?.connectionId === connectionId) cancel();
        return disconnect(connection, deps.save, deps.vault);
      });
    },
  };
}
