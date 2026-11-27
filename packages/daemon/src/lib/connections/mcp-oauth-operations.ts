import { randomUUID } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { artifactIdentityWrites } from '../../storage/repositories/artifact-file-identity-write.ts';
import type { CredentialStore } from '../credentials/credential-store.ts';
import { defineOperation } from '../operations/registry.ts';
import { startLoopbackLogin } from './loopback-login.ts';
import type { McpOAuthPreset } from './mcp-fetch.ts';
import { createMcpOAuthProvider } from './mcp-oauth-provider.ts';
import { ConnectionVault } from './vault.ts';

const loopback = 'http://127.0.0.1:18347';
const testPresets = {
  test: {
    url: `${loopback}/mcp`,
    issuer: loopback,
    authorizationEndpoint: `${loopback}/authorize`,
    origins: [loopback],
    scopes: ['read', 'search'],
  },
} satisfies Record<string, McpOAuthPreset>;

const policy = { safetyClass: 'human_only', caller: 'local_user' } as const;
const statusInput = z.strictObject({ id: z.string().min(1) });
const connectInput = statusInput.extend({ preset: z.string().min(1) });
const connectResult = z.union([
  z.object({ authorizeUrl: z.string() }),
  z.object({ reason: z.string() }),
]);
const statusResult = z.object({
  health: z.enum(['healthy', 'disconnected', 'reconnect_needed']),
  scopes: z.array(z.string()),
});

export function createMcpOAuthOperations(
  db: Database,
  store: CredentialStore,
  changed: () => void
) {
  const pending = new Set<string>();
  const { appMcpServers: registry, gateway } = db;
  const vault = async () =>
    new ConnectionVault(store, await gateway.call(artifactIdentityWrites, 'ensure', randomUUID()));

  async function connect(input: z.infer<typeof connectInput>) {
    const { id, preset: name } = input;
    if (process.env.NODE_ENV !== 'test' || name !== 'test') return { reason: 'invalid_preset' };
    const preset = testPresets[name];
    const target = () => {
      const row = registry.get(id);
      if (
        row?.sourceType === 'http' &&
        row.url === preset.url &&
        (!row.auth || row.auth.preset === name)
      )
        return row;
    };
    const row = target();
    if (!row) return { reason: 'invalid_preset' };
    if (row.auth?.active) return { reason: 'already_connected' };
    if (pending.has(id)) return { reason: 'connect_pending' };

    const generation = row.auth?.generation ?? 0;
    pending.add(id);
    let committing: Promise<void> | undefined;
    try {
      const store = await vault();
      let authorize: (code?: string) => ReturnType<typeof auth>;
      let commit: () => Promise<void>;
      const login = await startLoopbackLogin({
        signal: gateway.closeSignal,
        redirect: (port) => `http://127.0.0.1:${port}/oauth/mcp/callback`,
        authorize: async (redirectUrl, { state }, signal) => {
          const consent = Promise.withResolvers<URL>();
          const attempt = createMcpOAuthProvider({
            vault: store,
            serverId: id,
            preset,
            generation: generation + 1,
            redirectUrl,
            attempt: { authorize: consent.resolve },
          });
          const provider = { ...attempt.provider, state: () => state };
          authorize = (authorizationCode) =>
            auth(provider, {
              serverUrl: preset.url,
              scope: preset.scopes.join(' '),
              authorizationCode,
              fetchFn: (url, init) => attempt.fetch(url, { ...init, signal }),
            });
          commit = attempt.commit;
          if ((await authorize()) !== 'REDIRECT') throw new Error('login_failed');
          return consent.promise;
        },
        exchange: async (code, _verifier, _redirectUri, _nonce, signal) => {
          if ((await authorize(code)) !== 'AUTHORIZED') throw new Error('login_failed');
          signal.throwIfAborted();
          const current = target();
          if (!current || current.auth?.active || (current.auth?.generation ?? 0) !== generation)
            throw new Error('login_failed');

          const inactive = { kind: 'oauth', preset: name, generation, active: false } as const;
          if (!current.auth) registry.setAuth(id, inactive);
          committing = commit();
          await committing;
          signal.throwIfAborted();
          registry.setAuth(id, { ...inactive, generation: generation + 1, active: true });
          changed();
          return { ok: true };
        },
      });
      void login.result.then(async () => {
        await committing?.catch(() => {});
        pending.delete(id);
      });
      return { authorizeUrl: login.authorizeUrl };
    } catch {
      pending.delete(id);
      return { reason: 'login_failed' };
    }
  }

  async function status({
    id,
  }: z.infer<typeof statusInput>): Promise<z.infer<typeof statusResult>> {
    const auth = registry.get(id)?.auth;
    if (!auth?.active) return { health: 'disconnected', scopes: [] };
    try {
      const grant = await (await vault()).readMcp(id);
      if (grant?.generation === auth.generation) return { health: 'healthy', scopes: grant.scopes };
    } catch {
      throw new Error('request_failed');
    }
    return { health: 'reconnect_needed', scopes: [] };
  }

  const startConnect = (superpipe({})('mcp.registry.connect') as PipelineAPI)
    .input('input')
    .pipe(connect, 'input', 'result')
    .endAsync('result') as typeof connect;
  const readStatus = (superpipe({})('mcp.registry.status') as PipelineAPI)
    .input('input')
    .pipe(status, 'input', 'result')
    .endAsync('result') as typeof status;
  return [
    defineOperation({
      name: 'mcp.registry.connect',
      description: 'Start browser consent for a remote MCP registry row.',
      policy,
      inputSchema: connectInput,
      resultSchema: connectResult,
      execute: startConnect,
    }),
    defineOperation({
      name: 'mcp.registry.status',
      description: 'Read health and granted scopes of a remote MCP registry row.',
      policy,
      inputSchema: statusInput,
      resultSchema: statusResult,
      execute: readStatus,
    }),
  ];
}
