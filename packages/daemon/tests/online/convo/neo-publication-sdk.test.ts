import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { readNeoPublications } from '../../../../web/src/neo/publication-client.ts';

test('real SDK sends root Neo its system prompt and the stored human message, and publishes the reply', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'neo-sdk-publication-'));
  const requestId = randomUUID();
  const shortText = 'The fictional moon garden is ready.';
  const fullText = '## Fictional garden\n\nThe moon garden has three blue flowers.';
  const calls: string[] = [];
  const receipts: { accepted: boolean; created?: boolean }[] = [];
  const requests: { path: string; tools: number; active: boolean }[] = [];
  const sent: { system: string; human: unknown }[] = [];
  const nudged: string[] = [];
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
      messages?: {
        role?: string;
        content?: string | { type: string; text?: string; content?: { text?: string }[] }[];
      }[];
      tools?: { name: string }[];
      system?: string | { text: string }[];
    };
    if (req.url?.startsWith('/v1/messages/count_tokens')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (JSON.stringify(body.messages ?? []).includes('had no visible output'))
      nudged.push(req.url ?? '');
    const invoke = body.tools?.find((tool) => tool.name.endsWith('hyperneo-operations__invoke'));
    const active = !!invoke && JSON.stringify(body.messages).includes('fictional moon garden');
    requests.push({ path: req.url ?? '', tools: body.tools?.length ?? 0, active });
    if (active && !sent.length)
      sent.push({
        system:
          typeof body.system === 'string'
            ? body.system
            : (body.system ?? []).map((part) => part.text).join('\n'),
        human: body.messages?.find(
          (message) =>
            message.role === 'user' && JSON.stringify(message).includes('fictional moon garden')
        )?.content,
      });
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
            input: { requestId: 'fictional-send', shortText, fullText, links: [] },
          },
        }
      : { type: 'text', text: 'Done.' };
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
  if (!address || typeof address === 'string') throw new Error('Missing fictional server port');
  const environment = {
    NODE_ENV: 'test',
    HYPERNEO_USE_DEV_PROXY: '0',
    HYPERNEO_DATA_DIR: join(isolated, 'data'),
    HYPERNEO_WORKSPACE_PATH: isolated,
    CLAUDE_CONFIG_DIR: join(isolated, 'sdk'),
    TEST_SDK_SESSION_DIR: join(isolated, 'sdk'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
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
  const { QueryOptionsBuilder } = await import('../../../src/lib/agent/query-options-builder.ts');
  const build = QueryOptionsBuilder.prototype.build;
  QueryOptionsBuilder.prototype.build = async function (...args) {
    const options = await build.apply(this, args);
    return {
      ...options,
      spawnClaudeCodeProcess: (opts) =>
        spawn(opts.command, opts.args, {
          cwd: opts.cwd,
          env: { ...opts.env, ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL },
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: opts.signal,
        }),
    };
  };

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
    const params = {
      providerId: 'anthropic',
      displayName: 'Synthetic local model',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
    };
    const credentials = { apiKey: 'sk-synthetic-loopback-only' };
    const { providers } = await hub.request<{ providers: { id: string; providerId: string }[] }>(
      'providers.list',
      {}
    );
    const existing = providers.find((provider) => provider.providerId === 'anthropic');
    if (existing) await hub.request('providers.update', { id: existing.id, params, credentials });
    else await hub.request('providers.create', { params, credentials });

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
    expect(page.items[0].askOrigin).toBeUndefined();
    expect(page.items[0].producerInput).toBeUndefined();
    expect(page.items[0]).toMatchObject({
      publicationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      shortText,
      fullText,
      links: [],
    });
    const end = Date.now() + 15000;
    while (calls.length < 3 && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toEqual(['tool_use', 'tool_use', 'text']);
    expect(receipts).toMatchObject([
      {
        accepted: true,
        created: true,
        publication: { publicationId: page.items[0].publicationId },
      },
      {
        accepted: true,
        created: false,
        publication: { publicationId: page.items[0].publicationId },
      },
    ]);
    expect((await read()).items).toEqual(page.items);
    const webRead = await readNeoPublications(
      { conversationId: opened.sessionId.slice(4), after: 0 },
      async () => hub,
      () => true
    );
    expect(webRead).toEqual({ state: 'ready', items: page.items, nextAfter: 1 });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(nudged, 'ending with Done. keeps the CLI from nudging for visible output').toEqual([]);
    const { neoPrompt } = await import('../../../src/lib/neo/prompt.ts');
    if (process.env.VERIFY_EVIDENCE_DIR) {
      await mkdir(process.env.VERIFY_EVIDENCE_DIR, { recursive: true });
      await writeFile(
        join(process.env.VERIFY_EVIDENCE_DIR, 'neo-goal-cycle-sdk.json'),
        JSON.stringify(
          {
            sent,
            calls,
            receipts,
            publication: page.items[0],
            webRead,
            daemonPort: daemon.server.port,
            mockPort: address.port,
          },
          null,
          2
        )
      );
    }
    expect(sent[0].system).toContain(neoPrompt());
    for (const instruction of [
      'On a scheduled goal wake',
      'goal.session.get',
      'neo.home.read',
      'goal.journal.append',
      'runId',
      'neo.question.get',
      'answeredByHuman',
      'sha256',
      'one plain-text summary line',
      'On other turns',
    ])
      expect(sent[0].system).toContain(instruction);
    const human = (sent[0].human as { type: string; text?: string }[]).filter(
      (part) => part.type === 'text'
    );
    expect(human.map((part) => part.text).slice(-2)).toEqual([
      expect.stringMatching(/^\(local time: \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+\)$/),
      'Tell me about the fictional moon garden.',
    ]);
    expect(human.map((part) => part.text).join('\n')).not.toContain('<human-input>');
  } finally {
    QueryOptionsBuilder.prototype.build = build;
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
