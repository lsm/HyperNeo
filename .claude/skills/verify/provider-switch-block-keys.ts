process.env.HYPERNEO_SPACE ??= 'on';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getSDKProjectDir,
  getSDKSessionFilePath,
} from '../../../packages/daemon/src/lib/sdk-session-file-manager.ts';
import { mock } from 'bun:test';
import type { Session } from '@hyperneo/shared';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence', 'bin'])
  mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const workspace = join(run, 'workspace');
const sdk = await import(
  '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
);
const starts: { model: string; replayedToolUse: unknown[] }[] = [];
const releases: (() => void)[] = [];
let sdkSessionId = '';
const toolUseBlocks = () =>
  readFileSync(getSDKSessionFilePath(workspace, sdkSessionId), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .flatMap((line) => (Array.isArray(line.message?.content) ? line.message.content : []))
    .filter((block: { type?: string }) => block.type === 'tool_use');
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
    if (typeof prompt !== 'string')
      starts.push({
        model: options?.model ?? '',
        replayedToolUse: first ? [] : toolUseBlocks(),
      });
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
        void feed.next().catch(() => {});
        if (first) {
          sdkSessionId = crypto.randomUUID();
          mkdirSync(getSDKProjectDir(workspace), { recursive: true });
          const file = getSDKSessionFilePath(workspace, sdkSessionId);
          const user = { ...(input.value as object), type: 'user', parentUuid: null };
          writeFileSync(file, JSON.stringify(user) + '\n');
          appendFileSync(
            file,
            JSON.stringify({
              type: 'assistant',
              uuid: crypto.randomUUID(),
              parentUuid: (user as { uuid?: string }).uuid ?? null,
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_synthetic',
                    name: 'Bash',
                    input: { command: 'ls' },
                    text: '',
                    thinking: 'synthetic reasoning from the other provider',
                  },
                ],
              },
            }) + '\n'
          );
        }
        yield {
          type: 'system',
          subtype: 'init',
          uuid: crypto.randomUUID(),
          session_id: sdkSessionId,
          cwd: workspace,
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
        yield {
          type: 'result',
          subtype: 'success',
          uuid: crypto.randomUUID(),
          session_id: sdkSessionId,
          parent_tool_use_id: null,
          is_error: first,
          result: first ? 'API Error: 429 rate_limit_error: too many requests' : 'SWITCH_RECOVERED',
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
const { MessageHub, WebSocketClientTransport } = await import(
  '../../../packages/shared/src/mod.ts'
);
const app = await createDaemonApp({
  config: {
    ...getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: workspace,
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
  surface: 'message.send, session.get and message.sdkMessages RPC; SDK transcript on resume',
  scriptedSdk: true,
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
try {
  await transport.initialize();
  for (const [providerId, isDefault] of [
    ['anthropic', true],
    ['glm', false],
  ] as const)
    await hub.request('providers.create', {
      params: {
        providerId,
        displayName: `Synthetic ${providerId}`,
        kind: 'built_in',
        authType: 'api_key',
        isEnabled: true,
        isDefault,
        sortOrder: isDefault ? 0 : 1,
      },
      credentials: { apiKey: 'synthetic-never-sent' },
    });
  const registry = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of registry.servers)
    await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await app.settingsManager.updateGlobalSettingsAsync({
    fallbackModels: [{ provider: 'glm', model: 'glm-5' }],
  });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: workspace,
    title: 'Synthetic provider switch',
    config: { provider: 'anthropic', model: 'haiku' },
  });
  await hub.request('message.send', { sessionId, content: 'Keep going after the switch.' });
  await until(async () => {
    const { sdkMessages } = await hub.request<{
      sdkMessages: { type: string; result?: string }[];
    }>('message.sdkMessages', { sessionId });
    return sdkMessages.some((m) => m.type === 'result' && m.result === 'SWITCH_RECOVERED');
  }, 'The fallback provider never answered the retained prompt');
  evidence.session = (await hub.request<{ session: Session }>('session.get', { sessionId })).session;
  assert.equal((evidence.session as Session).config.provider, 'glm');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[1].replayedToolUse, [
    { type: 'tool_use', id: 'toolu_synthetic', name: 'Bash', input: { command: 'ls' } },
  ]);
  evidence.passed = true;
} finally {
  await transport.close();
  await app.cleanup();
  for (const release of releases) release();
  globalThis.fetch = originalFetch;
  evidence.resourcesStopped = true;
  writeFileSync(
    join(run, 'evidence/provider-switch-block-keys.json'),
    JSON.stringify(evidence, null, 2).replaceAll(run, '<synthetic-run>')
  );
}
process.exit(0);
