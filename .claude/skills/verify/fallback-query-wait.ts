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
const cancel = process.argv.includes('--cancel');
let resultAnnounced = false;
let allowInterrupt = () => {};
const interruptGate = new Promise<void>((done) => {
  allowInterrupt = done;
});
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence', 'bin'])
  mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const sdk = await import(
  '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
);
const starts: { model: string; at: number }[] = [];
const releases: (() => void)[] = [];
const consumed: unknown[] = [];
let oldInterrupted = false;
let oldClosed = false;
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
    const first = typeof prompt !== 'string' && starts.length === 0;
    if (typeof prompt !== 'string') starts.push({ model: options?.model ?? '', at: Date.now() });
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
        const input = await feed.next();
        consumed.push(input.value);
        void feed.next().catch(() => {});
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
          model: options?.model ?? 'haiku',
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
        resultAnnounced = true;
        yield {
          type: 'result',
          subtype: 'success',
          uuid: crypto.randomUUID(),
          session_id: sdkSessionId,
          parent_tool_use_id: null,
          is_error: first,
          result: first
            ? 'API Error: 429 rate_limit_error: too many requests'
            : 'FALLBACK_RECOVERED',
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
          modelUsage: {},
          permission_denials: [],
          ...(first ? { api_error_status: 429, terminal_reason: 'blocking_limit' } : {}),
        };
        await held;
      },
      interrupt: async () => {
        if (first) {
          oldInterrupted = true;
          if (cancel) await interruptGate;
        }
        release();
      },
      close: () => {
        if (first) oldClosed = true;
        release();
      },
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
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
});
hub.registerTransport(transport);
const evidence: Record<string, unknown> = {
  surface: 'message.send, session.get and message.sdkMessages RPC',
  scriptedSdk: true,
  cancel,
  passed: false,
  starts,
  consumed,
};
const until = async (check: () => boolean | Promise<boolean>, label: string, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 25));
  }
};
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
    modelFallbackMap: {},
    fallbackModels: [{ provider: 'anthropic', model: 'sonnet' }],
  });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'workspace'),
    title: 'Synthetic fallback wait',
    config: { provider: 'anthropic', model: 'haiku' },
  });
  const read = async () =>
    (await hub.request<{ session: Session }>('session.get', { sessionId })).session;
  await hub.request('message.send', { sessionId, content: 'Retain this input through fallback.' });
  await until(() => starts.length > 0, 'Initial SDK query never started');
  const agent = app.sessionManager.getSession(sessionId)!;
  const started = Date.now();
  try {
    if (cancel) {
      await until(
        () => resultAnnounced && agent.isLimitRecoveryPending(),
        'Fallback handoff did not become pending'
      );
      evidence.cancellation = await hub.request('session.cancelRateLimitRetry', { sessionId });
      allowInterrupt();
      releases[0]();
      await until(
        () => oldClosed && !agent.isLimitRecoveryPending(),
        'Cancelled fallback did not settle'
      );
    } else
      await until(async () => {
        const { sdkMessages } = await hub.request<{
          sdkMessages: { type: string; result?: string }[];
        }>('message.sdkMessages', { sessionId });
        evidence.results = sdkMessages.filter((message) => message.type === 'result');
        return sdkMessages.some(
          (message) => message.type === 'result' && message.result === 'FALLBACK_RECOVERED'
        );
      }, 'Fallback never consumed the retained prompt while the old SDK stream stayed open');
  } finally {
    evidence.elapsedMs = Date.now() - started;
    evidence.session = await read();
    evidence.oldInterrupted = oldInterrupted;
    evidence.oldClosed = oldClosed;
  }
  await until(() => !agent.isLimitRecoveryPending(), 'Fallback recovery callback did not settle');
  await agent.replayPendingMessagesForImmediateMode({ waitForPostSettlementFlush: true });
  const state = await hub.request<{ agentState: { status: string } }>('state.session', {
    sessionId,
  });
  evidence.finalState = state.agentState;
  if (!cancel) assert.equal(state.agentState.status, 'idle');
  evidence.session = await read();
  if (cancel) {
    assert.equal(starts.length, 1);
    assert.equal((evidence.session as Session).config.model, 'haiku');
  } else {
    assert(oldClosed && oldInterrupted);
    assert.equal(starts.length, 2);
    assert(starts[1].model.includes('sonnet'));
    assert.equal(consumed.length, 2);
    const content = (value: unknown) =>
      (value as { message: { content: unknown } }).message.content;
    assert.deepEqual(content(consumed[1]), content(consumed[0]));
  }
  evidence.passed = true;
} finally {
  allowInterrupt();
  await transport.close();
  await app.cleanup();
  for (const release of releases) release();
  globalThis.fetch = originalFetch;
  evidence.resourcesStopped = true;
  writeFileSync(
    join(run, 'evidence/fallback-query-wait.json'),
    JSON.stringify(evidence, null, 2).replaceAll(run, '<synthetic-run>')
  );
}
