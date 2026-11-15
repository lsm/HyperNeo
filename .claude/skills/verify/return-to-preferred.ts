process.env.HYPERNEO_SPACE ??= 'on';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getSDKProjectDir,
  getSDKSessionFilePath,
} from '../../../packages/daemon/src/lib/sdk-session-file-manager.ts';
import { mock } from 'bun:test';
import type { Session } from '@hyperneo/shared';

const run = resolve(process.argv.at(-1)!);
const role = process.argv.includes('--front') ? 'front' : 'neo';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence', 'bin'])
  mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const sdk = await import(
  '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
);
const resetAt = Date.now() + 4000;
const starts: string[] = [];
const releases: (() => void)[] = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...sdk,
  query: ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<unknown> | string;
    options?: { model?: string };
  }) => {
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
      releases.push(done);
    });
    const model = options?.model ?? '';
    return {
      async *[Symbol.asyncIterator]() {
        if (typeof prompt === 'string') {
          yield {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic title' }] },
          };
          return;
        }
        const feed = prompt[Symbol.asyncIterator]();
        for (;;) {
          const input = await feed.next();
          if (input.done) break;
          starts.push(model);
          const limited = model.includes('haiku') && Date.now() < resetAt;
          const sdkSessionId = crypto.randomUUID();
          mkdirSync(getSDKProjectDir(join(run, 'workspace')), { recursive: true });
          writeFileSync(
            getSDKSessionFilePath(join(run, 'workspace'), sdkSessionId),
            JSON.stringify({ ...(input.value as object), type: 'user', parentUuid: null }) + '\n'
          );
          yield {
            type: 'system',
            subtype: 'init',
            uuid: crypto.randomUUID(),
            session_id: sdkSessionId,
            cwd: join(run, 'workspace'),
            model,
            permissionMode: 'default',
            apiKeySource: 'user',
            claude_code_version: 'synthetic',
            tools: [],
            skills: [],
            plugins: [],
            mcp_servers: [],
            slash_commands: [],
            output_style: 'default',
          };
          yield {
            type: 'result',
            subtype: 'success',
            uuid: crypto.randomUUID(),
            session_id: sdkSessionId,
            parent_tool_use_id: null,
            is_error: limited,
            result: limited
              ? `API Error: 429 usage limit reached, resets at ${new Date(resetAt).toISOString()}`
              : `ANSWERED_ON ${model}`,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {},
            permission_denials: [],
            ...(limited ? { api_error_status: 429, terminal_reason: 'blocking_limit' } : {}),
          };
          if (limited) await held;
        }
      },
      interrupt: async () => release(),
      close: () => release(),
      supportedModels: async () => [],
      supportedCommands: async () => [],
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    };
  },
}));
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error('External HTTP disabled');
}) as typeof fetch;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { createNeoService } = await import(
  '../../../packages/daemon/tests/unit/helpers/neo-service.ts'
);
const { globalSettingsWrites } = await import(
  '../../../packages/daemon/src/storage/repositories/global-settings-writes.ts'
);
const { NeoRepository } = await import(
  '../../../packages/daemon/src/storage/repositories/neo-repository.ts'
);
const { frontSessionId } = await import('../../../packages/daemon/src/lib/neo/front-mode.ts');
const { MessageHub, WebSocketClientTransport } = await import(
  '../../../packages/shared/src/mod.ts'
);
const app = await createDaemonApp({
  config: {
    ...getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: join(run, 'workspace'),
    }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  createSocket: createLocalSocket,
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
});
hub.registerTransport(transport);
const evidence: Record<string, unknown> = {
  surface: 'message.send, session.get and message.sdkMessages RPC; Neo sweep return',
  scriptedSdk: true,
  role,
  passed: false,
  starts,
};
const until = async (check: () => boolean | Promise<boolean>, label: string, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 25));
  }
};
let service: ReturnType<typeof createNeoService> | undefined;
try {
  await transport.initialize();
  await hub.request('providers.create', {
    params: {
      providerId: 'anthropic',
      displayName: 'Synthetic local provider',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
    },
    credentials: { apiKey: 'synthetic-never-sent' },
  });
  const registry = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of registry.servers)
    await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await app.settingsManager.updateGlobalSettingsAsync({
    fallbackModels: [{ provider: 'anthropic', model: 'sonnet', thinkingLevel: 'off' }],
  });
  const preferred = { provider: 'anthropic', model: 'haiku', thinkingLevel: 'off' as const };
  await app.db.gateway.call(
    globalSettingsWrites,
    role === 'neo' ? 'neoPreferences' : 'neoFrontModel',
    preferred
  );
  const db = app.db.getDatabase();
  const root = `neo:${crypto.randomUUID()}`;
  db.prepare("INSERT INTO neo_session_bindings (session_id, kind) VALUES (?, 'neo')").run(root);
  const sessionId = role === 'neo' ? root : frontSessionId(new NeoRepository(db).conversationId()!);
  await app.sessionManager.createSession({
    sessionId,
    workspacePath: join(run, 'workspace'),
    title: `Synthetic ${role} return`,
    config: { provider: 'anthropic', model: 'haiku' },
  });
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  const read = async () =>
    (await hub.request<{ session: Session }>('session.get', { sessionId })).session;
  const answers = async () =>
    (
      await hub.request<{ sdkMessages: { type: string; result?: string }[] }>(
        'message.sdkMessages',
        { sessionId }
      )
    ).sdkMessages
      .filter((message) => message.type === 'result')
      .map((message) => message.result ?? '');
  const agent = () => app.sessionManager.getSession(sessionId)!;

  await hub.request('message.send', { sessionId, content: 'First turn hits the limit.' });
  await until(
    async () => (await answers()).some((text) => text.startsWith('ANSWERED_ON sonnet')),
    'The limited turn never recovered on the fallback'
  );
  await until(() => !agent().isLimitRecoveryPending(), 'Fallback recovery did not settle');
  evidence.afterLimit = { model: (await read()).config.model, limits: agent().getRateLimitWatchdogState().modelLimits };
  assert.equal((evidence.afterLimit as { model: string }).model.includes('sonnet'), true);

  await service.returnToPreferredModels();
  evidence.beforeReset = { model: (await read()).config.model };
  assert((evidence.beforeReset as { model: string }).model.includes('sonnet'));

  await until(() => Date.now() > resetAt, 'Reset time never passed', 10000);
  await service.returnToPreferredModels();
  await until(async () => (await read()).config.model === 'haiku', 'Session did not return');
  evidence.afterReset = { model: (await read()).config.model, limits: agent().getRateLimitWatchdogState().modelLimits };

  await hub.request('message.send', { sessionId, content: 'Next turn after the limit cleared.' });
  await until(
    async () => (await answers()).some((text) => text.startsWith('ANSWERED_ON haiku')),
    'The next turn did not run on the preferred model'
  );
  evidence.answers = await answers();
  await until(() => !agent().isLimitRecoveryPending(), 'Recovery did not settle at the end');
  await agent().replayPendingMessagesForImmediateMode({ waitForPostSettlementFlush: true });
  evidence.passed = true;
} finally {
  await service?.dispose();
  await transport.close();
  await app.cleanup();
  for (const release of releases) release();
  globalThis.fetch = originalFetch;
  evidence.resourcesStopped = true;
  writeFileSync(
    join(run, `evidence/return-to-preferred-${role}.json`),
    JSON.stringify(evidence, null, 2).replaceAll(run, '<synthetic-run>')
  );
}
