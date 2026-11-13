import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mock } from 'bun:test';
import type { Options } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'])
  assert(!process.env[key], key);
for (const name of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });

const sdk = await import('../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const attempts: number[] = [];
const inputs: { attempt: number; uuid?: string }[] = [];
const children = new Set<ChildProcess>();
const finishers = new Set<() => void>();
let firstChild: ChildProcess | undefined;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...sdk,
  query: ({ prompt, options }: { prompt: AsyncIterable<{ uuid?: string }> | string; options?: Options }) => {
    let child: ChildProcess | undefined;
    let finish = () => {};
    const number = typeof prompt === 'string' ? 0 : attempts.push(1);
    if (typeof prompt !== 'string') {
      const controller = new AbortController();
      child = options?.spawnClaudeCodeProcess?.({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: options.cwd ?? join(run, 'workspace'),
        env: {},
        signal: controller.signal,
      }) as ChildProcess;
      assert(child);
      children.add(child);
      if (number === 1) firstChild = child;
    }
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
      finishers.add(resolve);
    });
    const close = () => {
      child?.kill('SIGTERM');
      finish();
    };
    return {
      async *[Symbol.asyncIterator]() {
        if (typeof prompt === 'string') {
          yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic title' }] } };
          return;
        }
        const feed = prompt[Symbol.asyncIterator]();
        const input = await feed.next();
        inputs.push({ attempt: number, uuid: input.value?.uuid });
        yield {
          type: 'system', subtype: 'init', uuid: crypto.randomUUID(), session_id: crypto.randomUUID(),
          cwd: join(run, 'workspace'), model: 'claude-haiku-4-5-20251001', permissionMode: 'default',
          apiKeySource: 'user', claude_code_version: 'synthetic', tools: [], skills: [], plugins: [],
          mcp_servers: [], slash_commands: [], output_style: 'default',
        };
        if (number === 1) {
          await ended;
          return;
        }
        yield {
          type: 'result', subtype: 'success', uuid: crypto.randomUUID(), session_id: crypto.randomUUID(),
          parent_tool_use_id: null, is_error: false, result: 'Recovered after process exit',
          duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
        };
      },
      close,
      interrupt: async () => close(),
      supportedModels: async () => [],
      supportedCommands: async () => [],
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    };
  },
}));

const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP disabled'); }) as typeof fetch;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { createLocalSocket } = await import('../../../packages/daemon/src/lib/pairing/local-credential.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: createLocalSocket,
});
hub.registerTransport(transport);
const evidence: Record<string, unknown> = { scriptedSdk: true, realChildProcess: true, attempts, inputs };
const until = async (check: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
try {
  assert.notEqual(app.server.port, 8399);
  await transport.initialize();
  await hub.request('providers.create', {
    params: { providerId: 'anthropic', displayName: 'Synthetic only', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 },
    credentials: { apiKey: 'synthetic-never-sent' },
  });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'workspace'), title: 'SDK process exit worker status',
    config: { model: 'haiku', provider: 'anthropic' },
  });
  const status = async () => {
    const result = await hub.request<{ ok: boolean; value: { status: string } }>('operation.invoke', {
      name: 'work.status', input: { ref: { adapter: 'hyperneo', id: sessionId } },
    });
    assert(result.ok);
    return result.value.status;
  };
  await hub.request('message.send', { sessionId, content: 'Hold the first synthetic turn' });
  await until(async () => {
    const rows = await hub.request<{ sdkMessages: { type: string; subtype?: string }[] }>('message.sdkMessages', { sessionId });
    return rows.sdkMessages.some((row) => row.type === 'system' && row.subtype === 'init');
  }, 'first SDK init was not observed');
  await until(() => inputs.length === 1, 'first SDK did not consume kickoff');
  evidence.statusBeforeExit = await status();
  assert.equal(evidence.statusBeforeExit, 'running');
  assert(firstChild);
  firstChild.kill('SIGTERM');
  await until(() => attempts.length === 2, 'process exit did not release the pending turn for retry');
  await until(async () => {
    const rows = await hub.request<{ sdkMessages: { type: string; result?: string }[] }>('message.sdkMessages', { sessionId });
    return rows.sdkMessages.some((row) => row.type === 'result' && row.result === 'Recovered after process exit');
  }, 'replacement SDK did not finish');
  await until(async () => (await status()) === 'done', 'worker stayed running after terminal cleanup');
  evidence.statusAfterRetry = await status();
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].uuid, inputs[1].uuid);
  const agent = app.sessionManager.getSession(sessionId)!;
  await agent.replayPendingMessagesForImmediateMode({ waitForPostSettlementFlush: true });
  evidence.postSettlementReplay = true;
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  for (const finish of finishers) finish();
  for (const child of children) child.kill('SIGTERM');
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(app.sessionManager.getCachedSessions().map(async (agent) => {
        const query = agent.queryPromise;
        agent.queryObject?.close();
        await query?.catch(() => {});
        const replay = (agent as unknown as {
          queryModeHandler: { postSettlementFlush: Promise<boolean> | null };
        }).queryModeHandler.postSettlementFlush;
        if (replay) await replay;
      })),
      new Promise<never>((_, reject) => {
        drainTimer = setTimeout(() => reject(new Error('Owned query cleanup did not settle')), 5000);
      }),
    ]);
    evidence.queriesDrained = true;
  } finally {
    clearTimeout(drainTimer);
    await transport.close();
    await app.cleanup();
    globalThis.fetch = network;
    evidence.resourcesClosed = true;
    writeFileSync(join(run, 'evidence/sdk-exit.json'), JSON.stringify(evidence, null, 2));
  }
}
console.log(JSON.stringify(evidence));
