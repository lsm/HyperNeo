import { createGoogleHttp } from './google-http.ts';
import { randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { LoginOutcome } from './loopback-login.ts';
import type { ConnectionVault } from './vault.ts';
import type { ConnectionStatus, GoogleConnectionAttempt as View } from './status.ts';
import { createGoogleTokenAccess } from './token-access.ts';

type Client = { clientId: string; clientSecret?: string };
type Login = { authorizeUrl: string; result: Promise<LoginOutcome>; cancel: () => void };
export type StartLogin = (client: Client) => Promise<Login>;
type Outcome = LoginOutcome;
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
type LoginStatusFacts = {
  current: { id: string; view: View } | undefined;
  storage: ReturnType<ConnectionVault['storageStatus']>;
};

export function selectLoginStatus(facts: LoginStatusFacts, input: { loginId?: string }): View {
  return {
    ...(facts.current && (!input.loginId || facts.current.id === input.loginId)
      ? facts.current.view
      : { state: 'missing' }),
    storage: facts.storage,
  };
}

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

function planLogin(
  { flow, outcome }: Admitted,
  records: ConnectionStatus[],
  provider: ConnectionStatus['provider']
) {
  const id =
    records.find((record) => record.accountId === outcome.accountId)?.id ?? flow.connectionId;
  const connection: ConnectionStatus = {
    id,
    provider,
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

const completeLogin = (superpipe({})('connection-login-complete') as PipelineAPI)
  .input(['outcome', 'flow', 'active', 'closed', 'read', 'save', 'vault', 'provider'])
  .pipe(admit, ['outcome', 'flow', 'active', 'closed'], 'result:result')
  .pipe((read: Read) => read(), 'read', 'records')
  .pipe(planLogin, ['result', 'records', 'provider'], 'plan')
  .pipe(persistLogin, ['plan', 'save', 'vault'], 'result')
  .endAsync('result') as (
  outcome: Outcome,
  flow: Flow,
  active: Flow | undefined,
  closed: boolean,
  read: Read,
  save: Save,
  vault: ConnectionVault,
  provider: ConnectionStatus['provider']
) => Promise<View>;

const disconnect = (superpipe({})('connection-disconnect') as PipelineAPI)
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
  provider: ConnectionStatus['provider'];
  startLogin: StartLogin;
  closed: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  apiTimeoutMs?: number;
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
  const access = createGoogleTokenAccess({ ...deps, serial });
  const http = createGoogleHttp({ ...deps, token: access.token });
  const cancel = () => {
    if (current) {
      current.cancelled = true;
      current.login?.cancel();
      current.login = undefined;
    }
  };
  deps.closed.addEventListener('abort', cancel, { once: true });
  const statusFacts = (): LoginStatusFacts => ({
    current: current ? { id: current.id, view: current.view } : undefined,
    storage: deps.vault.storageStatus(),
  });
  const trackConnection = (
    account: ConnectionStatus | undefined,
    client: Client,
    login: Login
  ): View => {
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
            deps.closed.aborted,
            deps.read,
            deps.save,
            deps.vault,
            deps.provider
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
  };
  const startConnection = async (
    input: Partial<Client> & { connectionId?: string }
  ): Promise<View> => {
    if (deps.closed.aborted) return { state: 'failed', reason: 'cancelled' };
    const account = (await deps.read()).find((record) => record.id === input.connectionId);
    if (input.connectionId && !account) return { state: 'failed', reason: 'unknown_connection' };
    const client = input.clientId
      ? { clientId: input.clientId, clientSecret: input.clientSecret }
      : account
        ? (await deps.vault.read(account))?.client
        : undefined;
    if (!client) return { state: 'failed', reason: 'client_not_configured' };
    cancel();
    const login = await deps.startLogin(client);
    if (deps.closed.aborted) {
      login.cancel();
      return { state: 'failed', reason: 'cancelled' };
    }
    return trackConnection(account, client, login);
  };
  return {
    token: access.token,
    http,
    connect: (input: Partial<Client> & { connectionId?: string }) =>
      serial(() => startConnection(input)),
    statusFacts,
    status: (loginId?: string): View => selectLoginStatus(statusFacts(), { loginId }),
    disconnect: async (connectionId: string) => {
      if (!(await deps.read()).some((record) => record.id === connectionId))
        return { ok: false, reason: 'unknown_connection' };
      access.cancel(connectionId);
      http.cancel(connectionId);
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
