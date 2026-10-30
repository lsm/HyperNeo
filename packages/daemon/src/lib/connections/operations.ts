import { createGoogleThreadOperations } from './google-thread-operations.ts';
import { createGoogleReadOperations } from './google-read-operations.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { artifactIdentityWrites } from '../../storage/repositories/artifact-file-identity-write.ts';
import {
  googleConnectionReads,
  googleConnectionWrites,
} from '../../storage/repositories/google-connections-worker.ts';
import { createCredentialStore } from '../credentials/credential-store.ts';
import { defineOperation } from '../operations/registry.ts';
import { ConnectionVault } from './vault.ts';
import { googleClient, googleConnectionAttempt } from './status.ts';
import { startGoogleLogin } from './google-login.ts';
import { createConnectionLifecycle } from './lifecycle.ts';

const policy = { safetyClass: 'human_only' as const, caller: 'local_user' as const };

export type GoogleConnectionDependencies = {
  createStore?: typeof createCredentialStore;
  startLogin?: typeof startGoogleLogin;
  fetchImpl?: typeof fetch;
  now?: () => number;
  apiTimeoutMs?: number;
};
type ServiceEntry = {
  deps: GoogleConnectionDependencies;
  closed: AbortController;
  pending?: Promise<ReturnType<typeof createConnectionLifecycle>>;
};
const services = new WeakMap<Database, ServiceEntry>();

export function configureGoogleConnections(db: Database, deps: GoogleConnectionDependencies) {
  if (!services.has(db)) services.set(db, { deps, closed: new AbortController() });
  return services.get(db)!.closed;
}

export function getGoogleConnectionService(sql: Database, deps: GoogleConnectionDependencies = {}) {
  configureGoogleConnections(sql, deps);
  const entry = services.get(sql)!;
  entry.closed.signal.throwIfAborted();
  const configured = entry.deps;
  let pending = entry.pending;
  if (!pending) {
    const gateway = gatewayFor(sql);
    pending = gateway.call(artifactIdentityWrites, 'ensure', randomUUID()).then((identity) => {
      entry.closed.signal.throwIfAborted();
      return createConnectionLifecycle({
        read: () => gateway.call(googleConnectionReads, 'list'),
        save: (connection) => gateway.call(googleConnectionWrites, 'put', connection),
        vault: new ConnectionVault(
          (configured.createStore ?? createCredentialStore)(sql),
          identity
        ),
        startLogin:
          configured.startLogin ??
          ((client) => startGoogleLogin(client, { fetchImpl: configured.fetchImpl })),
        fetchImpl: configured.fetchImpl,
        now: configured.now,
        apiTimeoutMs: configured.apiTimeoutMs,
        closed: AbortSignal.any([gateway.closeSignal, entry.closed.signal]),
      });
    });
    entry.pending = pending;
    void pending.catch(() => {
      entry.pending = undefined;
    });
  }
  return pending;
}

export function createGoogleConnectionOperations(
  db: () => Database,
  deps: GoogleConnectionDependencies = {}
) {
  const service = () => getGoogleConnectionService(db(), deps);
  return [
    ...createGoogleReadOperations(db, service),
    ...createGoogleThreadOperations(service),
    defineOperation({
      name: 'connections.google.connect',
      description:
        'Connect Google or reconnect the named account. Returns a one-use consent URL, never credentials.',
      policy,
      inputSchema: googleClient
        .partial()
        .extend({ connectionId: z.string().min(1).max(200).optional() })
        .strict()
        .refine(
          (input) => input.clientId || (input.connectionId && !input.clientSecret),
          'Provide clientId, or connectionId to reuse saved client details.'
        ),
      resultSchema: googleConnectionAttempt,
      execute: async (input) => (await service()).connect(input),
    }),
    defineOperation({
      name: 'connections.google.login',
      description: 'Read the status of this instance’s current Google consent attempt.',
      policy,
      inputSchema: z.object({ loginId: z.string().min(1).max(200).optional() }).strict(),
      resultSchema: googleConnectionAttempt,
      execute: async ({ loginId }) => (await service()).status(loginId),
    }),
    defineOperation({
      name: 'connections.google.disconnect',
      description:
        'Disable a Google connection and erase only this instance’s credential bundle. Does not revoke Google-wide access.',
      policy,
      inputSchema: z.object({ connectionId: z.string().min(1).max(200) }).strict(),
      resultSchema: z.object({ ok: z.boolean(), reason: z.string().optional() }),
      execute: async ({ connectionId }) => (await service()).disconnect(connectionId),
    }),
  ];
}
