import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { NeoAskTodoRepository } from '../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { handoffPromptToMailbox } from '../../../src/lib/mailbox/handoff.ts';
import { renderAddress } from '../../../src/lib/mailbox/address.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Synthetic turn did not reach its next boundary');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('Costco human input survives a consumed teammate prompt when question.ask omits replyTo', async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'neo-card-reply-turn-'));
  const requestId = crypto.randomUUID();
  const systemId = crypto.randomUUID();
  const firstModel = deferred();
  const releaseModel = deferred();
  const calls: unknown[] = [];
  const receipts: unknown[] = [];
  let rounds = 0;
  let finished = false;
  const fixture = createServer(async (req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [], has_more: false }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
      stream?: boolean;
      messages?: { content?: unknown }[];
      tools?: { name: string }[];
    };
    if (req.url?.includes('count_tokens')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    const active = JSON.stringify(body.messages ?? []).includes(requestId);
    if (active && rounds === 0) {
      firstModel.resolve();
      await releaseModel.promise;
    }
    for (const message of body.messages ?? [])
      if (Array.isArray(message.content))
        for (const block of message.content) if (block.type === 'tool_result') receipts.push(block);
    const invoke = body.tools?.find((tool) => tool.name.endsWith('hyperneo-operations__invoke'));
    const asking = active && invoke && rounds < 2;
    const block = asking
      ? {
          type: 'tool_use',
          id: `costco-${++rounds}`,
          name: invoke.name,
          input: {
            name: 'neo.question.ask',
            input: {
              askId: 'costco',
              text: '周六还是周日去 Costco？',
              kind: 'choice',
              options: ['周六', '周日'],
            },
          },
        }
      : { type: 'text', text: 'Done.' };
    if (active) calls.push(block);
    if (active && !asking) finished = true;
    const message = {
      id: `msg_${crypto.randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [block],
      stop_reason: asking ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 30 },
    };
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(message));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    const event = (type: string, data: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event('message_start', {
      type: 'message_start',
      message: { ...message, content: [], stop_reason: null },
    });
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: asking ? { ...block, input: {} } : { type: 'text', text: '' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: asking
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify('input' in block ? block.input : {}),
          }
        : { type: 'text_delta', text: 'Done.' },
    });
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 30 },
    });
    event('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  await mkdir(join(isolated, 'bin'));
  await writeFile(join(isolated, 'bin', 'gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
  const environment = {
    NODE_ENV: 'test',
    HYPERNEO_USE_DEV_PROXY: '0',
    HYPERNEO_DATA_DIR: join(isolated, 'data'),
    HYPERNEO_WORKSPACE_PATH: isolated,
    CLAUDE_CONFIG_DIR: join(isolated, 'sdk'),
    TEST_SDK_SESSION_DIR: join(isolated, 'sdk'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    PATH: `${join(isolated, 'bin')}:${process.env.PATH}`,
    DEFAULT_MODEL: 'haiku',
    HYPERNEO_PROVIDER_CREDENTIAL_KEY: 'synthetic-credential-encryption-key',
    GITHUB_ACTIONS: 'true',
  };
  const prior = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const { QueryOptionsBuilder } = await import('../../../src/lib/agent/query-options-builder.ts');
  const build = QueryOptionsBuilder.prototype.build;
  QueryOptionsBuilder.prototype.build = async function (...args) {
    const options = await build.apply(this, args);
    return {
      ...options,
      sandbox: { enabled: false },
      spawnClaudeCodeProcess: (opts) =>
        spawn(opts.command, opts.args, {
          cwd: opts.cwd,
          env: { ...opts.env, ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL },
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: opts.signal,
        }),
    };
  };
  let daemon: Awaited<ReturnType<typeof import('../../../src/app.ts').createDaemonApp>> | undefined;
  const hub = new MessageHub({ defaultSessionId: 'global' });
  let transport: WebSocketClientTransport | undefined;
  let evidence: unknown;
  try {
    const { createDaemonApp } = await import('../../../src/app.ts');
    const { getConfig } = await import('../../../src/config.ts');
    daemon = await createDaemonApp({
      config: {
        ...getConfig({
          host: '127.0.0.1',
          port: 0,
          dbPath: join(isolated, 'daemon.db'),
          workspaceRoot: isolated,
        }),
        disableWorktrees: true,
        disableGoalProcessing: true,
      },
      standalone: false,
      verbose: false,
    });
    expect(daemon.server.port).not.toBe(8399);
    daemon.db.updateGlobalSettings({ language: 'zh-Hans' });
    transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${daemon.server.port}/ws`,
      autoReconnect: false,
    });
    hub.registerTransport(transport);
    await transport.initialize();
    const { servers } = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
    for (const server of servers)
      await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
    await hub.request('providers.create', {
      params: {
        providerId: 'anthropic',
        displayName: 'Synthetic loopback',
        kind: 'built_in',
        authType: 'api_key',
        isEnabled: true,
        isDefault: true,
        sortOrder: 0,
      },
      credentials: { apiKey: 'sk-synthetic-loopback-only' },
    });
    const opened = await hub.request<{ ok: boolean; sessionId: string }>('operation.invoke', {
      name: 'neo.open',
      input: {},
    });
    expect(opened.ok).toBe(true);
    const root = opened.sessionId;
    const conversationId = root.slice(4);
    const todos = new NeoAskTodoRepository(daemon.db.getDatabase());
    todos.openAsk({
      id: 'costco',
      title: 'Costco',
      request: 'Synthetic weekend choice',
      sessionId: root,
      projectId: null,
      originMessageId: null,
      createdAt: Date.now(),
    });
    expect(
      await hub.request('operation.invoke', {
        name: 'neo.message.send',
        input: { sessionId: root, requestId, content: '周六还是周日去 Costco？用卡片问我' },
      })
    ).toMatchObject({ ok: true, messageId: requestId });
    await firstModel.promise;
    await handoffPromptToMailbox({
      to: renderAddress({ kind: 'session', sessionId: root }),
      origin: 'session:synthetic-teammate',
      messageUuid: systemId,
      message: {
        type: 'user',
        parent_tool_use_id: null,
        inputKind: 'task',
        message: { role: 'user', content: 'Synthetic teammate progress; not human input.' },
      },
      jobQueue: daemon.db.getJobQueueRepo(),
    });
    await until(() => !!daemon!.db.getMessageByStatusAndUuid(root, 'consumed', systemId));
    const during = daemon.sessionManager.getCachedSession(root)!.getProcessingState();
    expect(during).toMatchObject({ status: 'processing', messageId: systemId });
    releaseModel.resolve();
    await until(() => finished);
    await until(
      () => daemon!.sessionManager.getCachedSession(root)?.getProcessingState().status === 'idle'
    );
    const read = () =>
      hub.request<{ ok: boolean; items: NeoPublication[] }>('operation.invoke', {
        name: 'neo.publication.read',
        input: { conversationId },
      });
    const page = await read();
    const statuses = await hub.request('operation.invoke', {
      name: 'neo.conversation.asks.read',
      input: { conversationId },
    });
    evidence = {
      requestId,
      systemId,
      during,
      calls,
      receipts,
      page,
      statuses,
      questions: todos.listQuestions('costco'),
      daemonPort: daemon.server.port,
      mockPort: address.port,
    };
    expect(calls.filter((call) => (call as { type: string }).type === 'tool_use')).toHaveLength(2);
    const notices = page.items.filter((row) => row.cardReply);
    expect(notices, JSON.stringify(evidence)).toHaveLength(1);
    expect(todos.listQuestions('costco')).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      shortText: expect.stringContaining('我给你回了 · 查看卡片'),
      cardReply: {
        sourceMessageIds: [requestId],
        askId: 'costco',
        questionId: todos.listQuestions('costco')[0].id,
      },
    });
    expect(notices[0].replyTo).toBeUndefined();
    expect(statuses).toMatchObject({
      items: [expect.objectContaining({ requestId, messageStatus: 'read' })],
    });
    expect((await read()).items).toEqual(page.items);
  } finally {
    releaseModel.resolve();
    QueryOptionsBuilder.prototype.build = build;
    await transport?.close();
    await daemon?.cleanup();
    await new Promise<void>((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve()))
    );
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (process.env.VERIFY_EVIDENCE_DIR) {
      await mkdir(process.env.VERIFY_EVIDENCE_DIR, { recursive: true });
      await writeFile(
        join(process.env.VERIFY_EVIDENCE_DIR, 'card-reply-consumed-turn.json'),
        JSON.stringify(evidence ?? { calls, receipts }, null, 2)
      );
    }
  }
}, 90000);
