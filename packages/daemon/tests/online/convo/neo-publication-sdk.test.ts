import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';

test('real SDK publishes an authored fictional reply through the daemon operation', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'neo-sdk-publication-'));
  const publicationId = randomUUID();
  const requestId = randomUUID();
  const shortText = 'The fictional moon garden is ready.';
  const fullText = '## Fictional garden\n\nThe moon garden has three blue flowers.';
  const calls: string[] = [];
  const receipts: { accepted: boolean; created?: boolean }[] = [];
  const requests: { path: string; tools: number; active: boolean }[] = [];
  let round = 0;
  const fixture = createServer(async (req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'claude-haiku-4-5-20251001',
              type: 'model',
              display_name: 'Fictional Haiku',
              created_at: '2025-10-01T00:00:00Z',
            },
          ],
          has_more: false,
        })
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
      stream?: boolean;
      messages?: { content?: string | { type: string; content?: { text?: string }[] }[] }[];
      tools?: { name: string }[];
    };
    if (req.url?.startsWith('/v1/messages/count_tokens')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    const invoke = body.tools?.find((tool) => tool.name.endsWith('hyperneo-operations__invoke'));
    const active = !!invoke && JSON.stringify(body.messages).includes('fictional moon garden');
    requests.push({ path: req.url ?? '', tools: body.tools?.length ?? 0, active });
    if (active) {
      const content = body.messages?.at(-1)?.content;
      if (Array.isArray(content))
        for (const result of content.filter((item) => item.type === 'tool_result'))
          for (const item of result.content ?? [])
            if (item.text) receipts.push(JSON.parse(item.text));
    }
    const publishing = active && round < 2;
    const block = publishing
      ? {
          type: 'tool_use',
          id: `tool-fictional-${++round}`,
          name: invoke!.name,
          input: {
            name: 'neo.publication.publish',
            input: { publicationId, shortText, fullText, links: [] },
          },
        }
      : { type: 'text', text: 'Fictional execution transcript only.' };
    if (active) calls.push(block.type);
    const message = {
      id: `msg-fictional-${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
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
        : { type: 'text_delta', text: 'Fictional execution transcript only.' },
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
  if (!address || typeof address === 'string') throw new Error('Missing fictional server port');
  const environment = {
    NODE_ENV: 'test',
    HYPERNEO_USE_DEV_PROXY: '0',
    HYPERNEO_DATA_DIR: join(isolated, 'data'),
    HYPERNEO_WORKSPACE_PATH: isolated,
    CLAUDE_CONFIG_DIR: join(isolated, 'sdk'),
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
          dbPath: join(isolated, 'daemon.db'),
          workspaceRoot: isolated,
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
    const opened = await hub.request<{ ok: boolean; sessionId: string }>('operation.invoke', {
      name: 'neo.open',
      input: {},
    });
    expect(opened.ok).toBe(true);
    expect(opened.sessionId).toMatch(/^neo:/);
    const accepted = await hub.request<{ ok: boolean; messageId: string }>('operation.invoke', {
      name: 'neo.message.send',
      input: {
        sessionId: opened.sessionId,
        requestId,
        content: 'Tell me about the fictional moon garden.',
      },
    });
    expect(accepted).toMatchObject({ ok: true, messageId: requestId });
    const read = () =>
      hub.request<{ ok: boolean; items: NeoPublication[] }>('operation.invoke', {
        name: 'neo.publication.read',
        input: { conversationId: opened.sessionId.slice(4) },
      });
    let page = await read();
    const deadline = Date.now() + 45000;
    while (!page.items?.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      page = await read();
    }
    expect(page.ok).toBe(true);
    expect(page.items, JSON.stringify({ calls, receipts, requests })).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      publicationId,
      shortText,
      fullText,
      links: [],
      askOrigin: { sessionId: opened.sessionId, messageId: requestId },
      producerInput: { sessionId: opened.sessionId, messageId: requestId },
    });
    const end = Date.now() + 15000;
    while (calls.length < 3 && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toEqual(['tool_use', 'tool_use', 'text']);
    expect(receipts).toMatchObject([
      { accepted: true, created: true },
      { accepted: true, created: false },
    ]);
    expect((await read()).items).toEqual(page.items);
  } finally {
    await transport?.close();
    await daemon?.cleanup();
    await new Promise<void>((resolve, reject) =>
      fixture.close((cause) => (cause ? reject(cause) : resolve()))
    );
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 90000);
