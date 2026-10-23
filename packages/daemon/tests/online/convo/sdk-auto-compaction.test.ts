import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';

test('SDK compacts mid-turn without cancelling tools or losing queued inputs', async () => {
  const run = await mkdtemp(join(tmpdir(), 'sdk-auto-compact-'));
  await mkdir(join(run, 'workspace'));
  await mkdir(join(run, 'home'));
  const probe = join(run, 'workspace', 'probe.txt');
  await writeFile(probe, 'Synthetic tool receipt.');
  const requests: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const markers = ['COMPACT_QUEUED_1', 'COMPACT_QUEUED_2', 'COMPACT_QUEUED_3', 'COMPACT_QUEUED_4'];
  const receipts = new Map<string, unknown>();
  let turn = 0;
  let summaryCalls = 0;
  let beforeCrossing: unknown;
  let held = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    res.setHeader('content-type', 'application/json');
    if (req.url?.includes('count_tokens')) return res.end('{"input_tokens":1000}');
    if (req.url?.endsWith('/models')) return res.end('{"data":[],"has_more":false}');
    if (!req.url?.startsWith('/v1/messages')) {
      res.statusCode = 404;
      return res.end('{}');
    }
    const active = body.tools?.some((tool: { name: string }) => tool.name === 'Read');
    requests.push({ active, body });
    for (const message of body.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type === 'tool_result' && String(part.tool_use_id).startsWith('compact-read-'))
          receipts.set(part.tool_use_id, part);
      }
    }
    let content: Array<Record<string, unknown>>;
    let usage = 1000;
    if (active) {
      turn += 1;
      if (turn === 2) {
        held = true;
        await gate;
      }
      usage = turn === 2 ? 125000 : 1000;
      content =
        turn <= 2
          ? [
              {
                type: 'tool_use',
                id: `compact-read-${turn}`,
                name: 'Read',
                input: { file_path: probe },
              },
            ]
          : [{ type: 'text', text: 'COMPACT_CONTINUED_SUCCESS' }];
    } else {
      summaryCalls += 1;
      content = [
        {
          type: 'text',
          text: 'Synthetic compaction summary: continue SDK_COMPACTION_PROOF; both file reads succeeded. Preserve queued markers and finish the task.',
        },
      ];
    }
    const tool = content[0].type === 'tool_use';
    const message = {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: tool ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: usage, output_tokens: 20 },
    };
    if (!body.stream) return res.end(JSON.stringify(message));
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
      content_block: tool
        ? { type: 'tool_use', id: content[0].id, name: 'Read', input: {} }
        : { type: 'text', text: '' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(content[0].input) }
        : { type: 'text_delta', text: content[0].text },
    });
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 20 },
    });
    event('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback model address');
  const environment = {
    HOME: join(run, 'home'),
    NODE_ENV: 'test',
    HYPERNEO_USE_DEV_PROXY: '0',
    HYPERNEO_DATA_DIR: join(run, 'data'),
    HYPERNEO_WORKSPACE_PATH: join(run, 'workspace'),
    CLAUDE_CONFIG_DIR: join(run, 'sdk'),
    TEST_SDK_SESSION_DIR: join(run, 'sdk'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  };
  const prior = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const { QueryOptionsBuilder } = await import('../../../src/lib/agent/query-options-builder.ts');
  const build = QueryOptionsBuilder.prototype.build;
  const built: unknown[] = [];
  QueryOptionsBuilder.prototype.build = async function (...args) {
    const options = await build.apply(this, args);
    built.push({
      settings: options.settings,
      env: Object.fromEntries(
        Object.entries(options.env ?? {}).filter(([key]) => /COMPACT/.test(key))
      ),
    });
    return {
      ...options,
      sandbox: { enabled: false },
      debugFile: join(run, 'sdk-debug.log'),
      stderr: (data) => {
        errors.push(data);
        options.stderr?.(data);
      },
      spawnClaudeCodeProcess: (opts) =>
        spawn(opts.command, opts.args, {
          cwd: opts.cwd,
          env: { ...opts.env, ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL },
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: opts.signal,
        }),
    };
  };
  let app: Awaited<ReturnType<typeof import('../../../src/app.ts').createDaemonApp>> | undefined;
  let transport: WebSocketClientTransport | undefined;
  let messages: SDKMessage[] = [];
  let rows: unknown[] = [];
  try {
    const { createDaemonApp } = await import('../../../src/app.ts');
    const { getConfig } = await import('../../../src/config.ts');
    app = await createDaemonApp({
      config: {
        ...getConfig({
          host: '127.0.0.1',
          port: 0,
          dbPath: join(run, 'daemon.db'),
          workspaceRoot: join(run, 'workspace'),
        }),
        disableGoalProcessing: true,
        disableWorktrees: true,
      },
      verbose: false,
    });
    expect(app.server.port).not.toBe(8399);
    app.settingsManager.updateGlobalSettings({ sandbox: { enabled: false } });
    const hub = new MessageHub({ defaultSessionId: 'global' });
    transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${app.server.port}/ws`,
      autoReconnect: false,
    });
    hub.registerTransport(transport);
    await transport.initialize();
    const { servers } = await hub.request<{ servers: Array<{ id: string }> }>(
      'mcp.registry.list',
      {}
    );
    for (const server of servers)
      await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
    const params = {
      providerId: 'anthropic',
      displayName: 'Synthetic loopback',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
    };
    const credentials = { apiKey: 'sk-synthetic-loopback-only' };
    const { providers } = await hub.request<{
      providers: Array<{ id: string; providerId: string }>;
    }>('providers.list', {});
    const existing = providers.find((provider) => provider.providerId === 'anthropic');
    if (existing) await hub.request('providers.update', { id: existing.id, params, credentials });
    else await hub.request('providers.create', { params, credentials });
    const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
      workspacePath: join(run, 'workspace'),
      title: 'SDK compaction proof',
      config: {
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        autoCompactPercent: 60,
        sdkToolsPreset: ['Read'],
        permissionMode: 'bypassPermissions',
      },
    });
    const send = (content: string) =>
      hub.request<{ messageId: string }>('message.send', { sessionId, content });
    const accepted = [
      await send('SDK_COMPACTION_PROOF: read the synthetic probe twice and finish.'),
    ];
    const wait = async (predicate: () => boolean | Promise<boolean>, label: string) => {
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Missing ${label}; run=${run}`);
    };
    await wait(() => held, 'held second model call');
    for (const marker of markers) accepted.push(await send(marker));
    const live = await app.sessionManager.getSessionForControl(sessionId);
    beforeCrossing = await live?.queryObject?.getContextUsage();
    await new Promise((resolve) => setTimeout(resolve, 11000));
    release();
    await wait(async () => {
      messages = (
        await hub.request<{ sdkMessages: SDKMessage[] }>('message.sdkMessages', { sessionId })
      ).sdkMessages;
      return (
        JSON.stringify(messages).includes('COMPACT_CONTINUED_SUCCESS') &&
        markers.every((marker) => requests.some((r) => JSON.stringify(r.body).includes(marker)))
      );
    }, 'continued answer and queued model receipts');
    rows = app.db
      .getDatabase()
      .query(
        'SELECT sdk_uuid, send_status FROM sdk_messages WHERE session_id = ? AND message_type = ?'
      )
      .all(sessionId, 'user');
    expect(
      messages.filter(
        (message) => message.type === 'system' && message.subtype === 'compact_boundary'
      )
    ).not.toHaveLength(0);
    expect(summaryCalls).toBeGreaterThan(0);
    expect(receipts.size).toBe(2);
    for (const receipt of receipts.values()) expect(receipt).not.toMatchObject({ is_error: true });
    expect(JSON.stringify(messages)).not.toContain("The user doesn't want to proceed");
    for (const { messageId } of accepted) {
      expect(rows.filter((row) => (row as { sdk_uuid: string }).sdk_uuid === messageId)).toEqual([
        { sdk_uuid: messageId, send_status: 'consumed' },
      ]);
    }
    for (const marker of markers)
      expect(requests.some((r) => JSON.stringify(r.body).includes(marker))).toBe(true);
  } finally {
    release();
    const output = process.env.VERIFY_EVIDENCE_DIR;
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(
        join(output, 'sdk-auto-compaction.json'),
        JSON.stringify(
          {
            run,
            beforeCrossing,
            built,
            turn,
            summaryCalls,
            requests,
            receipts: Object.fromEntries(receipts),
            messages,
            rows,
            errors,
          },
          null,
          2
        )
      );
    }
    await transport?.close();
    await app?.cleanup();
    QueryOptionsBuilder.prototype.build = build;
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 90000);
