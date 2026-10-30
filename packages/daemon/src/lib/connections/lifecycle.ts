import { randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { startGoogleLogin } from './google-login.ts';
import type { ConnectionVault } from './vault.ts';
import type { ConnectionStatus } from './status.ts';

type Login = Awaited<ReturnType<typeof startGoogleLogin>>;
type Outcome = Awaited<Login['result']>;
type Client = Parameters<typeof startGoogleLogin>[0];
type View = {
  state: 'pending' | 'complete' | 'failed' | 'missing';
  loginId?: string;
  connectionId?: string;
  reason?: string;
  authorizeUrl?: string;
  storage?: ReturnType<ConnectionVault['storageStatus']>;
};
type Flow = {
  id: string;
  connectionId: string;
  accountId?: string;
  client: Client;
  login: Login;
  cancelled: boolean;
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
}) {
  let current: Flow | undefined;
  let pending = Promise.resolve();
  const serial = <T>(action: () => Promise<T>) => {
    const result = pending.then(action);
    pending = result.then(
      () => {},
      () => {}
    );
    return result;
  };
  const cancel = () => {
    if (current) {
      current.cancelled = true;
      current.login.cancel();
    }
  };
  deps.closed.addEventListener('abort', cancel, { once: true });
  return {
    connect: (input: Client & { connectionId?: string }) =>
      serial<View>(async () => {
        if (deps.closed.aborted) return { state: 'failed', reason: 'cancelled' };
        const account = (await deps.read()).find((record) => record.id === input.connectionId);
        if (input.connectionId && !account)
          return { state: 'failed', reason: 'unknown_connection' };
        cancel();
        const client = { clientId: input.clientId, clientSecret: input.clientSecret };
        const login = await deps.startLogin(client);
        if (deps.closed.aborted) {
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
                deps.closed.aborted,
                deps.read,
                deps.save,
                deps.vault
              )
            )
          )
          .then(
            (view) => {
              flow.view = view;
            },
            () => {
              flow.view = { state: 'failed', reason: 'storage_failed' };
            }
          );
        return { ...flow.view, authorizeUrl: login.authorizeUrl };
      }),
    status: (loginId?: string): View => ({
      ...(current && (!loginId || current.id === loginId) ? current.view : { state: 'missing' }),
      storage: deps.vault.storageStatus(),
    }),
    disconnect: (connectionId: string) =>
      serial(async () => {
        const connection = (await deps.read()).find((record) => record.id === connectionId);
        if (!connection) return { ok: false, reason: 'unknown_connection' };
        if (current?.connectionId === connectionId) cancel();
        return disconnect(connection, deps.save, deps.vault);
      }),
  };
}
