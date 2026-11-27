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
const replaceInput = statusInput.extend({ url: z.string().nullable() });
const connectResult = z.union([
  z.object({ authorizeUrl: z.string() }),
  z.object({ reason: z.string() }),
]);
const statusResult = z.object({
  health: z.enum(['healthy', 'disconnected', 'reconnect_needed']),
  scopes: z.array(z.string()),
});
const disconnectResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

export function createMcpOAuthOperations(
  db: Database,
  store: CredentialStore,
  changed: () => void
) {
  const pending = new Map<
    string,
    { controller: AbortController; preset: keyof typeof testPresets }
  >();
  const writes = new Map<string, Promise<unknown>>();
  const { appMcpServers: registry, gateway } = db;
  const vault = async () =>
    new ConnectionVault(store, await gateway.call(artifactIdentityWrites, 'ensure', randomUUID()));

  function serial<T>(id: string, write: () => Promise<T> | T): Promise<T> {
    const result = (writes.get(id) ?? Promise.resolve()).then(write, write);
    writes.set(id, result);
    const clear = () => {
      if (writes.get(id) === result) writes.delete(id);
    };
    void result.then(clear, clear);
    return result;
  }

  function reserve(id: string, requestedPreset?: string) {
    const row = registry.get(id);
    const name = requestedPreset ?? row?.auth?.preset;
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
    const current = target();
    if (!current) return { reason: 'invalid_preset' };
    if (requestedPreset && current.auth?.active) return { reason: 'already_connected' };
    if (pending.has(id)) return { reason: 'connect_pending' };

    const flow = { controller: new AbortController(), preset: name } as const;
    pending.set(id, flow);
    return { flow, generation: current.auth?.generation ?? 0, name, preset, target };
  }

  async function openConsent(id: string, requestedPreset?: string) {
    const admission = await serial(id, () => reserve(id, requestedPreset));
    if (!admission.flow) return { reason: admission.reason };
    const { flow, generation, name, preset, target } = admission;
    const clear = () => {
      if (pending.get(id) === flow) pending.delete(id);
    };
    try {
      const store = await vault();
      let authorize: (code?: string) => ReturnType<typeof auth>;
      let commit: () => Promise<void>;
      const login = await startLoopbackLogin({
        signal: AbortSignal.any([gateway.closeSignal, flow.controller.signal]),
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
          return serial(id, async () => {
            signal.throwIfAborted();
            const current = target();
            if (!current || (current.auth?.generation ?? 0) !== generation)
              throw new Error('login_failed');

            const previous =
              current.auth ?? ({ kind: 'oauth', preset: name, generation, active: false } as const);
            if (!current.auth) registry.setAuth(id, previous);
            await commit();
            signal.throwIfAborted();
            registry.setAuth(id, { ...previous, generation: generation + 1, active: true });
            changed();
            return { ok: true } as const;
          });
        },
      });
      void login.result.then(clear);
      return { authorizeUrl: login.authorizeUrl };
    } catch {
      clear();
      return { reason: 'login_failed' };
    }
  }

  const connect = ({ id, preset }: z.infer<typeof connectInput>) => openConsent(id, preset);
  const reconnect = ({ id }: z.infer<typeof statusInput>) => openConsent(id);

  function retire({ id }: z.infer<typeof statusInput>, replacement?: { url: string | null }) {
    const active = pending.get(id);
    if (!replacement) active?.controller.abort();
    return serial(id, async (): Promise<z.infer<typeof disconnectResult>> => {
      const row = registry.get(id);
      if (replacement && !row?.auth) return { ok: false, reason: 'not_connected' };
      if (replacement && row?.url === (replacement.url ?? undefined)) return { ok: true };
      const flow = pending.get(id) ?? active;
      flow?.controller.abort();
      const auth =
        row?.auth ??
        (flow && row?.sourceType === 'http' && row.url === testPresets[flow.preset].url
          ? { kind: 'oauth' as const, preset: flow.preset, generation: 0 }
          : undefined);
      if (!row || !auth) return { ok: false, reason: 'not_connected' };
      registry.setAuth(id, { ...auth, active: false, generation: auth.generation + 1 });
      changed();
      try {
        await (await vault()).removeMcp(id);
        if (replacement) {
          if (!registry.replaceOAuthUrl(id, replacement.url)) {
            return { ok: false, reason: 'request_failed' };
          }
          changed();
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: 'request_failed' };
      }
    });
  }

  async function status({
    id,
  }: z.infer<typeof statusInput>): Promise<z.infer<typeof statusResult>> {
    const disconnected: z.infer<typeof statusResult> = { health: 'disconnected', scopes: [] };
    if (!registry.get(id)?.auth?.active) return disconnected;
    try {
      const grant = await (await vault()).readMcp(id);
      const auth = registry.get(id)?.auth;
      if (!auth?.active) return disconnected;
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
  const startReconnect = (superpipe({})('mcp.registry.reconnect') as PipelineAPI)
    .input('input')
    .pipe(reconnect, 'input', 'result')
    .endAsync('result') as typeof reconnect;
  const disconnect = (input: z.infer<typeof statusInput>) => retire(input);
  const runDisconnect = (superpipe({})('mcp.registry.disconnect') as PipelineAPI)
    .input('input')
    .pipe(disconnect, 'input', 'result')
    .endAsync('result') as typeof disconnect;
  const replace = (input: z.infer<typeof replaceInput>) => retire(input, input);
  const runReplace = (superpipe({})('mcp.registry.replace') as PipelineAPI)
    .input('input')
    .pipe(replace, 'input', 'result')
    .endAsync('result') as typeof replace;
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
      name: 'mcp.registry.reconnect',
      description: 'Start new browser consent for a remote MCP registry row with OAuth.',
      policy,
      inputSchema: statusInput,
      resultSchema: connectResult,
      execute: startReconnect,
    }),
    defineOperation({
      name: 'mcp.registry.disconnect',
      description: 'Disconnect a remote MCP registry row and erase its saved grant.',
      policy,
      inputSchema: statusInput,
      resultSchema: disconnectResult,
      execute: runDisconnect,
    }),
    defineOperation({
      name: 'mcp.registry.replace',
      description: 'Disconnect a remote MCP registry row before changing its URL.',
      policy,
      inputSchema: replaceInput,
      resultSchema: disconnectResult,
      execute: runReplace,
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
