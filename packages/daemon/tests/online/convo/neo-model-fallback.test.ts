import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';

test('Neo completes a limited primary turn on its fallback thinking level and returns to the recovered primary', async () => {
  const run = await mkdtemp(join(tmpdir(), 'neo-model-fallback-'));
  let primary = 'sonnet';
  let fallback = 'opus';
  const requests: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = { run, primary, fallback, requests };
  let unavailable = true;
  let sequence = 1;
  const published = new Set<number>();
  const fixture = createServer(async (req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [primary, fallback].map((id) => ({
            id,
            type: 'model',
            display_name: id,
            created_at: '2025-10-01T00:00:00Z',
          })),
          has_more: false,
        })
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.url?.startsWith('/v1/messages/count_tokens')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    const invoke = body.tools?.find((tool: { name: string }) =>
      tool.name.endsWith('hyperneo-operations__invoke')
    );
    const active = !!invoke && JSON.stringify(body.messages).includes('fictional fallback garden');
    requests.push({
      active,
      sequence,
      model: body.model,
      thinking: body.thinking ?? null,
      output: body.output_config ?? null,
      unavailable,
    });
    if (active && String(body.model).includes(primary) && unavailable) {
      res.statusCode = 402;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'billing_error', message: 'usage limit reached for this billing cycle' },
        })
      );
      return;
    }
    const publishing = active && !published.has(sequence);
    if (publishing) published.add(sequence);
    const block = publishing
      ? {
          type: 'tool_use',
          id: `publish-${sequence}`,
          name: invoke.name,
          input: {
            name: 'neo.publication.publish',
            input: {
              requestId: `fallback-reply-${sequence}`,
              shortText: `Garden reply ${sequence}`,
              fullText: `The fictional fallback garden is ready (${sequence}).`,
              links: [],
            },
          },
        }
      : { type: 'text', text: 'Done.' };
    const message = {
      id: `msg-${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: body.model ?? primary,
      content: [block],
      stop_reason: publishing ? 'tool_use' : 'end_turn',
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
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: publishing ? { ...block, input: {} } : { type: 'text', text: '' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: publishing
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
  if (!address || typeof address === 'string') throw new Error('Missing isolated model port');
  const environment = {
    NODE_ENV: 'test',
    HYPERNEO_USE_DEV_PROXY: '0',
    HYPERNEO_DATA_DIR: join(run, 'data'),
    HYPERNEO_WORKSPACE_PATH: run,
    CLAUDE_CONFIG_DIR: join(run, 'sdk'),
    TEST_SDK_SESSION_DIR: join(run, 'sdk'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_API_KEY: 'sk-fictional-acceptance-only',
    ANTHROPIC_AUTH_TOKEN: 'fictional-acceptance-only',
    CLAUDE_CODE_OAUTH_TOKEN: 'fictional-acceptance-only',
    GLM_API_KEY: '',
    OPENAI_API_KEY: '',
    MINIMAX_API_KEY: '',
    COPILOT_GITHUB_TOKEN: '',
    DEFAULT_MODEL: 'haiku',
  };
  const prior = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let daemon: Awaited<ReturnType<typeof import('../../../src/app.ts').createDaemonApp>> | undefined;
  const hub = new MessageHub({ defaultSessionId: 'global' });
  let transport: WebSocketClientTransport | undefined;
  try {
    const { createDaemonApp } = await import('../../../src/app.ts');
    const { getConfig } = await import('../../../src/config.ts');
    daemon = await createDaemonApp({
      config: {
        ...getConfig({
          host: '127.0.0.1',
          port: 0,
          dbPath: join(run, 'daemon.db'),
          workspaceRoot: run,
        }),
        disableWorktrees: true,
        disableGoalProcessing: true,
      },
      standalone: false,
      verbose: false,
    });
    daemon.settingsManager.updateGlobalSettings({ sandbox: { enabled: false } });
    transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${daemon.server.port}/ws`,
      autoReconnect: false,
    });
    hub.registerTransport(transport);
    await transport.initialize();
    const call = (name: string, input: unknown = {}) =>
      hub.request<Record<string, unknown>>('operation.invoke', { name, input });
    const opened = await call('neo.open');
    const sessionId = String(opened.sessionId);
    const catalog = await hub.request<{ models: { id: string; provider: string }[] }>(
      'models.list',
      { sessionId: 'global' }
    );
    primary = catalog.models.find(
      (model) => model.provider === 'anthropic' && model.id.includes('sonnet')
    )!.id;
    fallback = catalog.models.find(
      (model) => model.provider === 'anthropic' && model.id.includes('opus')
    )!.id;
    Object.assign(evidence, { primary, fallback });
    const preference = {
      model: primary,
      provider: 'anthropic',
      thinkingLevel: 'think24k',
      fallbacks: [{ model: fallback, provider: 'anthropic', thinkingLevel: 'think8k' }],
    };
    evidence.saved = await call('neo.preferences.set', preference);
    expect(evidence.saved).toMatchObject({ ok: true });
    const requestId = randomUUID();
    evidence.sent = await call('neo.message.send', {
      sessionId,
      requestId,
      content: 'Tell me about the fictional fallback garden.',
    });
    const read = () => call('neo.publication.read', { conversationId: sessionId.slice(4) });
    let page = await read();
    const deadline = Date.now() + 45000;
    while (
      !(page.items as { shortText: string }[])?.some(
        (item) => item.shortText === 'Garden reply 1'
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      page = await read();
    }
    evidence.first = page;
    expect(
      (page.items as { shortText: string }[])?.some((item) => item.shortText === 'Garden reply 1'),
      JSON.stringify(evidence)
    ).toBe(true);
    expect(requests.some((r) => String(r.model).includes(primary) && r.unavailable)).toBe(true);
    const selected = requests.find((r) => String(r.model).includes(fallback));
    expect(selected, JSON.stringify(requests)).toBeDefined();
    expect(JSON.stringify(selected)).toMatch(/8000|"effort":"low"/);
    expect(
      (page.items as { shortText: string; askOrigin: { messageId: string } }[]).find(
        (item) => item.shortText === 'Garden reply 1'
      )?.askOrigin.messageId
    ).toBe(requestId);
    const idle = Date.now() + 15000;
    while (
      (await daemon.sessionManager.getSessionForControl(sessionId))?.getProcessingState().status !==
        'idle' &&
      Date.now() < idle
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 500));
    unavailable = false;
    sequence = 2;
    evidence.secondSent = await call('neo.message.send', {
      sessionId,
      requestId: randomUUID(),
      content: 'Check the fictional fallback garden again.',
    });
    const nextDeadline = Date.now() + 30000;
    page = await read();
    while (
      !(page.items as { shortText: string }[])?.some(
        (item) => item.shortText === 'Garden reply 2'
      ) &&
      Date.now() < nextDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      page = await read();
    }
    evidence.second = page;
    expect(
      (page.items as { shortText: string }[]).some((item) => item.shortText === 'Garden reply 2')
    ).toBe(true);
    expect(
      requests
        .filter((r) => r.sequence === 2 && r.active)
        .every((r) => String(r.model).includes(primary))
    ).toBe(true);
    expect(
      JSON.stringify(requests.find((r) => r.sequence === 2 && r.active)),
      JSON.stringify(requests)
    ).toMatch(/24000|"effort":"high"/);
    evidence.settings = daemon.db.getGlobalSettings().neo?.preferences;
    expect(evidence.settings).toMatchObject(preference);
  } finally {
    if (process.env.VERIFY_EVIDENCE_DIR) {
      await mkdir(process.env.VERIFY_EVIDENCE_DIR, { recursive: true });
      await writeFile(
        join(process.env.VERIFY_EVIDENCE_DIR, 'neo-model-fallback.json'),
        JSON.stringify(evidence, null, 2)
      );
    }
    await transport?.close();
    await daemon?.cleanup();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 90000);
