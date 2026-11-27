import { randomUUID } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { artifactIdentityWrites } from '../../storage/repositories/artifact-file-identity-write.ts';
import type { CredentialStore } from '../credentials/credential-store.ts';
import { defineOperation } from '../operations/registry.ts';
import { requireUnreservedName } from '../rpc-handlers/app-mcp-handlers.ts';
import { writeToolDefaults } from '../tools/write-tool-defaults.ts';
import { startLoopbackLogin } from './loopback-login.ts';
import type { McpOAuthPreset, McpRefreshFailure } from './mcp-fetch.ts';
import { createMcpOAuthProvider } from './mcp-oauth-provider.ts';
import { ConnectionVault } from './vault.ts';

const loopback = 'http://127.0.0.1:18347';
const testPreset = {
  url: `${loopback}/mcp`,
  issuer: loopback,
  authorizationEndpoint: `${loopback}/authorize`,
  origins: [loopback],
  scopes: ['read', 'search'],
} satisfies McpOAuthPreset;
const testPresets = { test: testPreset, 'test-slack': { ...testPreset, slackTokens: true } };
function presetFor(name: string | undefined) {
  if (process.env.NODE_ENV === 'test' && (name === 'test' || name === 'test-slack')) {
    return { name, preset: testPresets[name] } as const;
  }
}

type RefreshResult = { ok: true } | { ok: false; reason: McpRefreshFailure };

const policy = { safetyClass: 'human_only', caller: 'local_user' } as const;
const statusInput = z.strictObject({ id: z.string().min(1) });
const connectInput = statusInput.extend({ preset: z.string().min(1) });
const replaceInput = statusInput
  .extend({
    url: z.string().nullable(),
    sourceType: z.literal('http').optional(),
    name: z.string().optional(),
  })
  .loose();
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
  changed: () => void,
  now = Date.now
) {
  const pending = new Map<
    string,
    { controller: AbortController; preset: keyof typeof testPresets }
  >();
  const refreshes = new Map<
    string,
    { controller: AbortController; result: Promise<RefreshResult> }
  >();
  const retries = new Map<string, { until: number; reason: McpRefreshFailure }>();
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
    const selection = presetFor(requestedPreset ?? row?.auth?.preset);
    if (!selection) return { reason: 'invalid_preset' };
    const { name, preset } = selection;
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
            refreshes.get(id)?.controller.abort();
            retries.delete(id);
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

  async function runRefresh(id: string, signal: AbortSignal): Promise<RefreshResult> {
    const row = registry.get(id);
    const previous = row?.auth;
    const selection = presetFor(previous?.preset);
    if (
      signal.aborted ||
      !previous?.active ||
      !selection ||
      row?.sourceType !== 'http' ||
      row.url !== selection.preset.url
    )
      return { ok: false, reason: 'reconnect_needed' };

    const { preset } = selection;
    const generation = previous.generation;
    const current = () => {
      const auth = registry.get(id)?.auth;
      return !signal.aborted && auth?.active && auth.generation === generation;
    };
    const retry = retries.get(id);
    if (retry && retry.until > now()) return { ok: false, reason: retry.reason };
    retries.delete(id);

    let reason: McpRefreshFailure = 'request_failed';
    try {
      const store = await vault();
      const attempt = createMcpOAuthProvider({
        vault: store,
        serverId: id,
        preset,
        generation,
        redirectUrl: 'http://127.0.0.1/oauth/mcp/callback',
        onRefreshFailure: (failure) => {
          reason = failure;
        },
        save: (grant) =>
          serial(id, async () => {
            if (!current()) throw new Error('reconnect_needed');
            await store.replaceMcp(id, grant);
          }),
      });
      if (!(await attempt.provider.tokens())?.refresh_token || !current())
        return { ok: false, reason: 'reconnect_needed' };
      const result = await auth(
        {
          ...attempt.provider,
          invalidateCredentials: () => {
            throw new Error('request_failed');
          },
        },
        {
          serverUrl: preset.url,
          fetchFn: (url, init) => attempt.fetch(url, { ...init, signal }),
        }
      );
      if (result === 'AUTHORIZED' && current()) return { ok: true };
    } catch {}

    return serial(id, async () => {
      if (!current()) return { ok: false, reason: 'reconnect_needed' };
      if (reason === 'reconnect_needed') {
        registry.setAuth(id, { ...previous, generation: generation + 1 });
        changed();
        try {
          await (await vault()).removeMcp(id);
        } catch {}
      } else {
        retries.set(id, { until: now() + 60000, reason });
      }
      return { ok: false, reason };
    });
  }

  function refresh(id: string) {
    const active = refreshes.get(id);
    if (active && !active.controller.signal.aborted) return active.result;
    const controller = new AbortController();
    const signal = AbortSignal.any([gateway.closeSignal, controller.signal]);
    const result = runRefresh(id, signal).catch(
      (): RefreshResult => ({ ok: false, reason: 'request_failed' })
    );
    refreshes.set(id, { controller, result });
    void result.then(() => {
      if (refreshes.get(id)?.result === result) refreshes.delete(id);
    });
    return result;
  }

  function retire({ id }: z.infer<typeof statusInput>, replacement?: z.infer<typeof replaceInput>) {
    const active = pending.get(id);
    if (!replacement) {
      active?.controller.abort();
      refreshes.get(id)?.controller.abort();
    }
    return serial(id, async (): Promise<z.infer<typeof disconnectResult>> => {
      const row = registry.get(id);
      if (replacement) {
        if (!row?.auth) return { ok: false, reason: 'not_connected' };
        const { id, url, ...updates } = replacement;
        if (updates.name !== undefined) requireUnreservedName(updates.name.trim());
        registry.validateUpdate(id, updates);
        if (row.url === (url ?? undefined)) {
          if (Object.keys(updates).length > 0) await writeReplacement(replacement, 'update');
          return { ok: true };
        }
      }
      const flow = pending.get(id) ?? active;
      flow?.controller.abort();
      const auth =
        row?.auth ??
        (flow && row?.sourceType === 'http' && row.url === testPresets[flow.preset].url
          ? { kind: 'oauth' as const, preset: flow.preset, generation: 0 }
          : undefined);
      if (!row || !auth) return { ok: false, reason: 'not_connected' };
      refreshes.get(id)?.controller.abort();
      retries.delete(id);
      registry.setAuth(id, { ...auth, active: false, generation: auth.generation + 1 });
      changed();
      try {
        await (await vault()).removeMcp(id);
        if (replacement) await writeReplacement(replacement, 'replaceOAuthUrl');
        return { ok: true };
      } catch {
        return { ok: false, reason: 'request_failed' };
      }
    });
  }

  async function writeReplacement(
    { id, url, ...updates }: z.infer<typeof replaceInput>,
    method: 'replaceOAuthUrl' | 'update'
  ) {
    await writeToolDefaults(db, {
      mutations: [
        { repository: 'registry', method, args: [id, { ...updates, url: url ?? undefined }] },
      ],
      edits:
        updates.enabled === undefined ? [] : [{ key: `mcp:${id}`, selected: !!updates.enabled }],
    });
    changed();
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
  const operations = [
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
  return { operations, refresh };
}
