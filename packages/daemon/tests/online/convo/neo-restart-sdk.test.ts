import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';

type Body = {
  stream?: boolean;
  messages?: { role?: string; content?: unknown }[];
  tools?: { name: string }[];
};

test('a restart and a /compact each start root Neo from a visible state note in the same session', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'neo-sdk-restart-'));
  const noted: string[] = [];
  const earlier: string[] = [];
  let published = false;
  const fixture = createServer(async (req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [], has_more: false }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Body;
    if (req.url?.startsWith('/v1/messages/count_tokens')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    const invoke = body.tools?.find((tool) => tool.name.endsWith('hyperneo-operations__invoke'));
    const text = JSON.stringify(body.messages ?? []);
    const note = invoke && text.includes('Your context starts here');
    if (note) noted.push(text);
    else if (invoke && text.includes('An earlier moon question')) earlier.push(text);
    const line = note ? text.split('Your context starts here')[1]?.split('\\n')[1] : undefined;
    const asks = line
      ? (JSON.parse(JSON.parse(`"${line}"`)) as { title: string; todos: { title: string }[] }[])
      : [];
    const publishing = !!note && !published && asks.length > 0;
    if (publishing) published = true;
    const block = publishing
      ? {
          type: 'tool_use',
          id: `tool-restart-${randomUUID()}`,
          name: invoke!.name,
          input: {
            name: 'neo.publication.publish',
            input: {
              requestId: 'restart-recall',
              shortText: asks.map((ask) => `${ask.title}: ${ask.todos[0]?.title}`).join('; '),
              fullText: 'Recalled after restart.',
              links: [],
            },
          },
        }
      : {
          type: 'text',
          text: text.includes('followed by a <summary> block')
            ? '<analysis>Moon garden.</analysis>\n<summary>The human planned a moon garden.</summary>'
            : 'Done.',
        };
    const message = {
      id: `msg-restart-${randomUUID()}`,
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
      message: { ...message, content: [], stop_reason: null },
    });
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: publishing ? { ...block, input: {} } : { type: 'text', text: '' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta:
        'input' in block
          ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
          : { type: 'text_delta', text: block.text },
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
    TEST_SDK_SESSION_DIR: join(isolated, 'sdk'),
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
    const { NeoAskTodoRepository } = await import(
      '../../../src/storage/repositories/neo-ask-todo-repository.ts'
    );
    const dbPath = join(isolated, 'daemon.db');
    daemon = await createDaemonApp({
      config: {
        ...getConfig({ host: '127.0.0.1', port: 0, dbPath, workspaceRoot: isolated }),
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
    const invoke = <T>(name: string, input: unknown) =>
      hub.request<T>('operation.invoke', { name, input });
    const opened = await invoke<{ ok: boolean; sessionId: string }>('neo.open', {});
    const store = new NeoAskTodoRepository(daemon.db.getDatabase());
    store.openAsk({
      id: 'ask-garden',
      projectId: null,
      sessionId: opened.sessionId,
      originMessageId: null,
      title: 'Plant the moon garden',
      request: 'Plant the moon garden',
      createdAt: Date.now(),
    });
    store.addTodo(
      'todo-seeds',
      'ask-garden',
      {
        title: 'Order blue seeds',
        doneWhen: 'Seeds ordered',
        check: null,
        instruction: 'Order them',
        named: null,
      },
      Date.now()
    );
    await invoke('neo.message.send', {
      sessionId: opened.sessionId,
      requestId: randomUUID(),
      content: 'An earlier moon question.',
    });
    const before = Date.now() + 30000;
    while (!earlier.length && Date.now() < before)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(earlier.length, 'the first context answered a turn').toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const restarted = await invoke<{ ok: boolean; sessionId: string }>('neo.restart', {});
    expect(restarted).toEqual({ ok: true, sessionId: opened.sessionId });
    expect(daemon.db.getSession(opened.sessionId)?.status).toBe('active');
    const read = () =>
      invoke<{ ok: boolean; items: NeoPublication[] }>('neo.publication.read', {
        conversationId: opened.sessionId.slice(4),
      });
    let page = await read();
    const deadline = Date.now() + 45000;
    const recalled = () => page.items?.some((item) => item.shortText.startsWith('Plant'));
    while (!recalled() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      page = await read();
    }
    expect(noted.length, 'the fresh session received the state note').toBeGreaterThan(0);
    expect(noted[0]).toContain('Plant the moon garden');
    expect(noted[0]).toContain('Order blue seeds');
    expect(noted[0], 'the note starts a fresh context').not.toContain('An earlier moon question');
    expect(
      page.items.map((item) => item.shortText),
      'the earlier human turn ended in plain text and was still answered; the note turn added only its own publication'
    ).toEqual(['Done.', 'Plant the moon garden: Order blue seeds']);
    const sent = noted.length;
    await hub.request('message.send', { sessionId: opened.sessionId, content: '/compact' });
    const compacted = () => noted.slice(sent).find((text) => !text.includes('restart-recall'));
    const after = Date.now() + 45000;
    while (!compacted() && Date.now() < after)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(compacted(), 'the context after /compact starts from the state note').toContain(
      'Order blue seeds'
    );
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
