import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import {
  startEmbeddedServer,
  runSessionStreaming,
  resolveRequestCwd,
} from '../../../../../src/lib/providers/anthropic-copilot/index';
import {
  initializeProviders,
  resetProviderFactory,
  waitForOptionalProviderRegistration,
} from '../../../../../src/lib/providers/factory';
import {
  getProviderRegistry,
  resetProviderRegistry,
} from '../../../../../src/lib/providers/registry';
import { Logger } from '../../../../../src/lib/logger';

const testDir = dirname(fileURLToPath(import.meta.url));

type AnyHandler = (event: { type: string; data: Record<string, unknown> }) => void;

class MockCopilotSession {
  readonly sessionId = 'mock-session';
  private subs: AnyHandler[] = [];
  capturedPrompt: string | undefined = undefined;
  capturedConfig: unknown = undefined;
  shouldError = false;
  shouldRejectSend = false;
  shouldHang = false;
  disconnectCalled = false;
  abortCalled = false;

  registeredTools: Array<{ name: string; handler: (...a: unknown[]) => unknown }> = [];

  on(handler: AnyHandler): () => void {
    this.subs.push(handler);
    return () => {
      this.subs = this.subs.filter((h) => h !== handler);
    };
  }

  emit(type: string, data: Record<string, unknown> = {}): void {
    for (const h of [...this.subs]) h({ type, data });
  }

  async send(opts: { prompt: string }): Promise<string> {
    this.capturedPrompt = opts.prompt;
    if (this.shouldRejectSend) throw new Error('connection lost');
    if (this.shouldHang) {
      Promise.resolve().then(() => {
        this.emit('assistant.message_delta', { deltaContent: 'Hanging...' });
        this.emit('assistant.message', {});
      });
      return 'send-result';
    }
    if (this.shouldError) {
      Promise.resolve().then(() =>
        this.emit('session.error', { message: 'mock error', errorType: 'internal' })
      );
    } else {
      Promise.resolve().then(() => {
        this.emit('assistant.message_delta', { deltaContent: 'Hello' });
        this.emit('assistant.message_delta', { deltaContent: ' world' });
        this.emit('assistant.message', { content: 'Hello world' });
        this.emit('session.idle', {});
      });
    }
    return 'send-result';
  }

  async abort(): Promise<void> {
    this.abortCalled = true;
  }
  async disconnect(): Promise<void> {
    this.disconnectCalled = true;
  }
}

function makeMockClient(
  factory?: () => MockCopilotSession
): CopilotClient & { lastSession?: MockCopilotSession } {
  const mock = {
    lastSession: undefined as MockCopilotSession | undefined,
    async createSession(cfg: unknown): Promise<CopilotSession> {
      const s = factory ? factory() : new MockCopilotSession();
      s.capturedConfig = cfg;
      const tools = (cfg as Record<string, unknown>)?.['tools'] as
        | Array<{ name: string; handler: (...a: unknown[]) => unknown }>
        | undefined;
      if (tools) s.registeredTools = tools;
      mock.lastSession = s;
      return s as unknown as CopilotSession;
    },
    async listModels() {
      return [
        {
          id: 'gpt-5-mini',
          name: 'GPT-5 Mini',
          capabilities: {
            supports: { vision: false, reasoningEffort: true },
            limits: { max_context_window_tokens: 160000, max_prompt_tokens: 32000 },
          },
        },
      ];
    },
  };
  return mock as unknown as CopilotClient & { lastSession?: MockCopilotSession };
}

async function postMessages(
  url: string,
  body: object
): Promise<{ status: number; events: Array<{ type: string; data: unknown }>; rawBody?: string }> {
  const resp = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok || !resp.headers.get('content-type')?.includes('text/event-stream')) {
    return { status: resp.status, events: [], rawBody: text };
  }
  const events: Array<{ type: string; data: unknown }> = [];
  let currentType = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      currentType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      try {
        events.push({ type: currentType, data: JSON.parse(line.slice(6)) });
      } catch {
        events.push({ type: currentType, data: line.slice(6) });
      }
      currentType = '';
    }
  }
  return { status: resp.status, events };
}

async function postCountTokens(
  url: string,
  body: object
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const resp = await fetch(`${url}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
}

describe('startEmbeddedServer', () => {
  let session: MockCopilotSession;
  let client: CopilotClient & { lastSession?: MockCopilotSession };
  let serverUrl: string;
  let stopServer: () => Promise<void>;

  beforeEach(async () => {
    session = new MockCopilotSession();
    client = makeMockClient(() => session);
    const server = await startEmbeddedServer(client, '/tmp');
    serverUrl = server.url;
    stopServer = server.stop;
  });

  afterEach(async () => {
    await stopServer();
  });

  it('binds to a real port (> 0)', () => {
    expect(Number(new URL(serverUrl).port)).toBeGreaterThan(0);
  });

  it('health endpoint returns ok', async () => {
    const resp = await fetch(`${serverUrl}/health`);
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as Record<string, unknown>)['ok']).toBe(true);
  });

  it('models endpoint returns Anthropic-compatible model metadata', async () => {
    const resp = await fetch(`${serverUrl}/v1/models`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const data = body['data'] as Array<Record<string, unknown>>;
    expect(data[0]['id']).toBe('gpt-5-mini');
    expect(data[0]['type']).toBe('model');
    expect(data[0]['max_input_tokens']).toBe(160000);
  });

  it('models endpoint falls back to static GPT-5.4 and GPT-5.5 metadata', async () => {
    (client as unknown as { listModels: () => Promise<unknown[]> }).listModels = async () => {
      throw new Error('listModels unavailable');
    };
    const resp = await fetch(`${serverUrl}/v1/models`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const data = body['data'] as Array<Record<string, unknown>>;

    expect(data.find((m) => m['id'] === 'gpt-5.3-codex')?.['max_input_tokens']).toBe(272000);
    expect(data.find((m) => m['id'] === 'gpt-5.4')?.['max_input_tokens']).toBe(272000);
    expect(data.find((m) => m['id'] === 'gpt-5.5')?.['max_input_tokens']).toBe(272000);
  });

  it('count_tokens returns non-zero values that grow with system, messages, tools, and tool results', async () => {
    const base = await postCountTokens(serverUrl, {
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const richer = await postCountTokens(serverUrl, {
      model: 'gpt-5-mini',
      system: 'Use concise answers and inspect tool output carefully.',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'a fairly long tool result that should increase token estimates',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'bash',
          description: 'Run shell commands',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    });

    expect(base.status).toBe(200);
    expect(richer.status).toBe(200);
    expect(base.body['input_tokens']).toBeGreaterThan(0);
    expect(richer.body['input_tokens']).toBeGreaterThan(base.body['input_tokens'] as number);
    const context = richer.body['context'] as Record<string, unknown>;
    expect(context['systemTokens']).toBeGreaterThan(0);
    expect(context['toolDefinitionsTokens']).toBeGreaterThan(0);
    expect(context['conversationTokens']).toBeGreaterThan(0);
    expect(context['freeSpaceTokens']).toBeGreaterThan(0);
    expect(context['bufferTokens']).toBeGreaterThan(0);
  });

  it('keeps Copilot context integration out of daemon and UI context retrieval paths', () => {
    const files = [
      `${testDir}/../../../../../src/lib/agent/context-fetcher.ts`,
      `${testDir}/../../../../../src/lib/agent/context-tracker.ts`,
      `${testDir}/../../../../../../web/src/components/ContextUsageBar.tsx`,
      `${testDir}/../../../../../../web/src/islands/ContextPanel.tsx`,
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('conversationTokens');
      expect(source).not.toContain('freeSpaceTokens');
      expect(source).not.toContain('bufferTokens');
    }
  });

  it('returns 404 for unknown paths', async () => {
    expect((await fetch(`${serverUrl}/unknown`)).status).toBe(404);
  });

  it('returns 400 for missing required fields', async () => {
    const r = await postMessages(serverUrl, { model: 'x' });
    expect(r.status).toBe(400);
  });

  it('returns 400 JSON error envelope for missing required fields', async () => {
    const r = await postMessages(serverUrl, { model: 'x' });
    expect(r.status).toBe(400);
    const body = JSON.parse(r.rawBody ?? '{}') as Record<string, unknown>;
    expect(body['type']).toBe('error');
    const err = body['error'] as Record<string, unknown>;
    expect(err['type']).toBe('invalid_request_error');
    expect(typeof err['message']).toBe('string');
  });

  it('returns 400 for stream=false', async () => {
    const r = await postMessages(serverUrl, {
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    expect(r.status).toBe(400);
  });

  it('returns 400 JSON error envelope for stream=false', async () => {
    const r = await postMessages(serverUrl, {
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    expect(r.status).toBe(400);
    const body = JSON.parse(r.rawBody ?? '{}') as Record<string, unknown>;
    expect(body['type']).toBe('error');
    const err = body['error'] as Record<string, unknown>;
    expect(err['type']).toBe('invalid_request_error');
  });

  it('returns 413 when body exceeds 10 MB', async () => {
    const resp = await fetch(`${serverUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'x'.repeat(11 * 1024 * 1024) }],
      }),
    });
    expect(resp.status).toBe(413);
  });

  it('returns 413 JSON error envelope for oversized body', async () => {
    const resp = await fetch(`${serverUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'x'.repeat(11 * 1024 * 1024) }],
      }),
    });
    expect(resp.status).toBe(413);
    const text = await resp.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body['type']).toBe('error');
    const err = body['error'] as Record<string, unknown>;
    expect(err['type']).toBe('request_too_large');
  });

  it('rejects image blocks before creating a Copilot session', async () => {
    const r = await postMessages(serverUrl, {
      model: 'gpt-5-mini',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          ],
        },
      ],
    });

    expect(r.status).toBe(400);
    const body = JSON.parse(r.rawBody ?? '{}') as Record<string, unknown>;
    const err = body['error'] as Record<string, unknown>;
    expect(err['type']).toBe('invalid_request_error');
    expect(err['message']).toContain('image content blocks');
    expect(client.lastSession).toBeUndefined();
  });

  it('rejects image blocks nested in Copilot tool results', async () => {
    const r = await postMessages(serverUrl, {
      model: 'gpt-5-mini',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'text', text: 'screenshot:' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
              ],
            },
          ],
        },
      ],
    });

    expect(r.status).toBe(400);
    const body = JSON.parse(r.rawBody ?? '{}') as Record<string, unknown>;
    const err = body['error'] as Record<string, unknown>;
    expect(err['type']).toBe('invalid_request_error');
    expect(err['message']).toContain('image content blocks');
    expect(client.lastSession).toBeUndefined();
  });

  it('streams complete SSE event sequence', async () => {
    const r = await postMessages(serverUrl, {
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(r.status).toBe(200);
    const types = r.events.map((e) => e.type);
    expect(types).toContain('message_start');
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_delta');
    expect(types).toContain('content_block_stop');
    expect(types).toContain('message_delta');
    expect(types).toContain('message_stop');
  });

  it('streams concatenated text', async () => {
    const r = await postMessages(serverUrl, {
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    });
    const texts = r.events
      .filter((e) => e.type === 'content_block_delta')
      .map(
        (e) =>
          ((e.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
            'text'
          ] as string
      );
    expect(texts.join('')).toBe('Hello world');
  });

  it('formats user message with [User]: prefix', async () => {
    await postMessages(serverUrl, {
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(session.capturedPrompt).toContain('[User]: test');
  });

  it('formats assistant message with [Assistant]: prefix', async () => {
    await postMessages(serverUrl, {
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'next' },
      ],
    });
    expect(session.capturedPrompt).toContain('[Assistant]: reply');
  });

  it('formats tool_use content block inline', async () => {
    await postMessages(serverUrl, {
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }],
        },
        { role: 'user', content: 'ok' },
      ],
    });
    expect(session.capturedPrompt).toContain('[Assistant called tool bash with args:');
  });

  it('formats tool_result content block inline', async () => {
    await postMessages(serverUrl, {
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file.txt' }],
        },
      ],
    });
    expect(session.capturedPrompt).toContain('[Tool result for tu_1]: file.txt');
  });

  it('message_start contains correct model id', async () => {
    const r = await postMessages(serverUrl, {
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const start = r.events.find((e) => e.type === 'message_start');
    const msg = (start!.data as Record<string, unknown>)['message'] as Record<string, unknown>;
    expect(msg['model']).toBe('claude-sonnet-4.6');
  });

  it('surfaces SDK usage_info through final SSE usage and later count_tokens responses', async () => {
    session.send = async function (opts) {
      this.capturedPrompt = opts.prompt;
      Promise.resolve().then(() => {
        this.emit('session.usage_info', {
          currentTokens: 18000,
          tokenLimit: 160000,
          messagesLength: 4,
          systemTokens: 2500,
          toolDefinitionsTokens: 1500,
          conversationTokens: 14000,
        });
        this.emit('assistant.message_delta', { deltaContent: 'Done' });
        this.emit('assistant.message', { content: 'Done' });
        this.emit('session.idle', {});
      });
      return 'send-result';
    };

    const request = {
      model: 'gpt-5-mini',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    };
    const r = await postMessages(serverUrl, request);
    const msgDelta = r.events.find((e) => e.type === 'message_delta');
    const usage = (msgDelta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(18000);

    const counted = await postCountTokens(serverUrl, request);
    expect(counted.body['input_tokens']).toBeGreaterThan(0);
    expect(counted.body['input_tokens']).toBeLessThan(18000);
    const context = counted.body['context'] as Record<string, unknown>;
    expect(context['totalTokens']).toBe(18000);
    expect(context['systemTokens']).toBe(2500);
    expect(context['toolDefinitionsTokens']).toBe(1500);
    expect(context['conversationTokens']).toBe(14000);
    expect(context['promptTokenLimit']).toBe(160000);
  });

  it('extracts string system message and passes to session config', async () => {
    let captured: unknown;
    const cap = makeMockClient(() => session);
    spyOn(cap, 'createSession').mockImplementation(async (cfg: unknown) => {
      captured = cfg;
      return session as unknown as CopilotSession;
    });
    const s2 = await startEmbeddedServer(cap, '/tmp');
    try {
      await postMessages(s2.url, {
        model: 'x',
        max_tokens: 100,
        system: 'be concise',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect((captured as Record<string, unknown>)['systemMessage']).toEqual({
        mode: 'replace',
        content: 'be concise',
      });
    } finally {
      await s2.stop();
    }
  });

  it('extracts text-block array system message', async () => {
    let captured: unknown;
    const cap = makeMockClient(() => session);
    spyOn(cap, 'createSession').mockImplementation(async (cfg: unknown) => {
      captured = cfg;
      return session as unknown as CopilotSession;
    });
    const s2 = await startEmbeddedServer(cap, '/tmp');
    try {
      await postMessages(s2.url, {
        model: 'x',
        max_tokens: 100,
        system: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect((captured as Record<string, unknown>)['systemMessage']).toEqual({
        mode: 'replace',
        content: 'line one\n\nline two',
      });
    } finally {
      await s2.stop();
    }
  });

  it('sets availableTools:[] on plain sessions to prevent built-in tool use', async () => {
    let captured: unknown;
    const cap = makeMockClient(() => session);
    spyOn(cap, 'createSession').mockImplementation(async (cfg: unknown) => {
      captured = cfg;
      return session as unknown as CopilotSession;
    });
    const s2 = await startEmbeddedServer(cap, '/tmp');
    try {
      await postMessages(s2.url, {
        model: 'x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect((captured as Record<string, unknown>)['availableTools']).toEqual([]);
    } finally {
      await s2.stop();
    }
  });

  it('returns 500 with model name when createSession throws (unknown/rejected model)', async () => {
    const rejectClient = makeMockClient(() => {
      throw new Error('model not found');
    });
    const rs = await startEmbeddedServer(rejectClient, '/tmp');
    try {
      const r = await postMessages(rs.url, {
        model: 'copilot-unknown-model-xyz',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(r.status).toBe(500);
      const body = JSON.parse(r.rawBody ?? '{}') as Record<string, unknown>;
      const errMsg = ((body['error'] as Record<string, unknown>)['message'] as string) ?? '';
      expect(errMsg).toContain('copilot-unknown-model-xyz');
    } finally {
      await rs.stop();
    }
  });

  it('returns 500 JSON error envelope when createSession throws', async () => {
    const rejectClient = makeMockClient(() => {
      throw new Error('internal error');
    });
    const rs = await startEmbeddedServer(rejectClient, '/tmp');
    try {
      const r = await postMessages(rs.url, {
        model: 'some-model',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(r.status).toBe(500);
      const body = JSON.parse(r.rawBody ?? '{}') as Record<string, unknown>;
      expect(body['type']).toBe('error');
      const err = body['error'] as Record<string, unknown>;
      expect(err['type']).toBe('api_error');
      expect(typeof err['message']).toBe('string');
    } finally {
      await rs.stop();
    }
  });

  it('returns Anthropic JSON error when session errors before streaming output', async () => {
    session.shouldError = true;
    const r = await postMessages(serverUrl, {
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'err' }],
    });
    expect(r.status).toBe(500);
    expect(r.events).toEqual([]);
    const data = JSON.parse(r.rawBody ?? '{}') as Record<string, unknown>;
    expect(data['type']).toBe('error');
    const err = data['error'] as Record<string, unknown>;
    expect(err['type']).toBe('api_error');
    expect(err['message']).toBe('mock error');
  });

  it('returns Anthropic JSON error when session.send() rejects before streaming output', async () => {
    session.shouldRejectSend = true;
    const r = await postMessages(serverUrl, {
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'err' }],
    });
    expect(r.status).toBe(500);
    expect(r.events).toEqual([]);
    const data = JSON.parse(r.rawBody ?? '{}') as Record<string, unknown>;
    expect(data['type']).toBe('error');
    const err = data['error'] as Record<string, unknown>;
    expect(err['type']).toBe('api_error');
    expect(err['message']).toBe('Internal streaming error');
  });

  it('calls session.disconnect() after successful request', async () => {
    await postMessages(serverUrl, {
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(session.disconnectCalled).toBe(true);
  });

  it('calls session.disconnect() after session.error event', async () => {
    session.shouldError = true;
    await postMessages(serverUrl, {
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'err' }],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(session.disconnectCalled).toBe(true);
  });

  it('calls session.disconnect() when send() rejects', async () => {
    session.shouldRejectSend = true;
    await postMessages(serverUrl, {
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'err' }],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(session.disconnectCalled).toBe(true);
  });

  it('calls session.disconnect() when req emits close mid-stream', async () => {
    const hangSession = new MockCopilotSession();
    hangSession.shouldHang = true;

    const mockReq = new EventEmitter() as unknown as import('node:http').IncomingMessage;
    const written: string[] = [];
    const mockRes = {
      headersSent: true,
      writeHead: () => {},
      write: (c: string) => {
        written.push(c);
        return true;
      },
      end: () => {},
    } as unknown as import('node:http').ServerResponse;

    const streamPromise = runSessionStreaming(
      hangSession as unknown as CopilotSession,
      'test',
      'claude-sonnet-4.6',
      mockReq,
      mockRes
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(written.some((c) => c.includes('content_block_delta'))).toBe(true);

    mockReq.emit('close');
    await streamPromise;
    expect(hangSession.disconnectCalled).toBe(true);
  });

  it('handles concurrent requests independently', async () => {
    const sessions: MockCopilotSession[] = [];
    const cc = makeMockClient(() => {
      const s = new MockCopilotSession();
      sessions.push(s);
      return s;
    });
    const cs = await startEmbeddedServer(cc, '/tmp');
    try {
      const [r1, r2] = await Promise.all([
        postMessages(cs.url, {
          model: 'x',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'A' }],
        }),
        postMessages(cs.url, {
          model: 'x',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'B' }],
        }),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(sessions.length).toBe(2);
      const prompts = sessions.map((s) => s.capturedPrompt ?? '');
      expect(prompts.some((p) => p.includes('A'))).toBe(true);
      expect(prompts.some((p) => p.includes('B'))).toBe(true);
    } finally {
      await cs.stop();
    }
  });

  async function waitForTools(s: MockCopilotSession): Promise<void> {
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        if (s.registeredTools.length > 0) {
          clearInterval(id);
          resolve();
        }
      }, 5);
    });
  }

  it('emits tool_use SSE block when model calls a registered tool', async () => {
    let toolHandler: ((args: unknown, inv: unknown) => unknown) | undefined;
    const toolSession = new MockCopilotSession();

    const toolClient = makeMockClient(() => toolSession);
    spyOn(toolClient, 'createSession').mockImplementation(async (cfg: unknown) => {
      toolSession.capturedConfig = cfg;
      const tools = (cfg as Record<string, unknown>)?.['tools'] as
        | Array<{ name: string; handler: (args: unknown, inv: unknown) => unknown }>
        | undefined;
      if (tools?.[0]) toolHandler = tools[0].handler;
      return toolSession as unknown as CopilotSession;
    });

    const originalSend = toolSession.send.bind(toolSession);
    toolSession.send = async function (opts) {
      this.capturedPrompt = opts.prompt;
      Promise.resolve().then(async () => {
        if (toolHandler) {
          toolHandler(
            { command: 'ls' },
            {
              sessionId: 's1',
              toolCallId: 'tc_test',
              toolName: 'bash',
              arguments: { command: 'ls' },
            }
          ).catch(() => {});
        }
      });
      return 'send-result';
    };

    const ts = await startEmbeddedServer(toolClient, '/tmp');
    try {
      const requestBody = {
        model: 'claude-sonnet-4.6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'run ls' }],
        tools: [{ name: 'bash', description: 'Run bash', input_schema: { type: 'object' } }],
      };

      const r = await postMessages(ts.url, requestBody);
      expect(r.status).toBe(200);

      const types = r.events.map((e) => e.type);
      expect(types).toContain('message_start');
      const msgDelta = r.events.find((e) => e.type === 'message_delta');
      expect(msgDelta).toBeDefined();
      const stopReason = (
        (msgDelta!.data as Record<string, unknown>)['delta'] as Record<string, unknown>
      )['stop_reason'];
      expect(stopReason).toBe('tool_use');

      const toolUseStart = r.events.find(
        (e) =>
          e.type === 'content_block_start' &&
          ((e.data as Record<string, unknown>)['content_block'] as Record<string, unknown>)?.[
            'type'
          ] === 'tool_use'
      );
      expect(toolUseStart).toBeDefined();
      const cb = (toolUseStart!.data as Record<string, unknown>)['content_block'] as Record<
        string,
        unknown
      >;
      expect(cb['name']).toBe('bash');
      expect(cb['id']).toBe('tc_test');
    } finally {
      await ts.stop();
    }
  });

  it('routes tool_result continuation to suspended session (round-trip)', async () => {
    let toolHandler: ((args: unknown, inv: unknown) => Promise<unknown>) | undefined;
    const toolSession = new MockCopilotSession();
    const toolClient = makeMockClient(() => toolSession);

    spyOn(toolClient, 'createSession').mockImplementation(async (cfg: unknown) => {
      toolSession.capturedConfig = cfg;
      const tools = (cfg as Record<string, unknown>)?.['tools'] as
        | Array<{ name: string; handler: (args: unknown, inv: unknown) => Promise<unknown> }>
        | undefined;
      if (tools?.[0]) toolHandler = tools[0].handler;
      return toolSession as unknown as CopilotSession;
    });

    toolSession.send = async function (opts) {
      this.capturedPrompt = opts.prompt;
      Promise.resolve().then(async () => {
        if (toolHandler) {
          toolHandler(
            { command: 'ls' },
            {
              sessionId: 's1',
              toolCallId: 'tc_round',
              toolName: 'bash',
              arguments: { command: 'ls' },
            }
          )
            .then(() => {
              toolSession.emit('assistant.message_delta', { deltaContent: 'Done.' });
              toolSession.emit('assistant.message', { content: 'Done.' });
              toolSession.emit('session.idle', {});
            })
            .catch(() => {});
        }
      });
      return 'send-result';
    };

    const ts = await startEmbeddedServer(toolClient, '/tmp');
    try {
      const toolsDef = [
        { name: 'bash', description: 'Run bash', input_schema: { type: 'object' } },
      ];

      const r1 = await postMessages(ts.url, {
        model: 'x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'run ls' }],
        tools: toolsDef,
      });

      expect(r1.status).toBe(200);
      const toolUseStart = r1.events.find(
        (e) =>
          e.type === 'content_block_start' &&
          ((e.data as Record<string, unknown>)['content_block'] as Record<string, unknown>)?.[
            'type'
          ] === 'tool_use'
      );
      expect(toolUseStart).toBeDefined();
      const toolCallId = (
        (toolUseStart!.data as Record<string, unknown>)['content_block'] as Record<string, unknown>
      )['id'] as string;
      expect(toolCallId).toBe('tc_round');

      const msgDelta1 = r1.events.find((e) => e.type === 'message_delta');
      expect(
        ((msgDelta1!.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
          'stop_reason'
        ]
      ).toBe('tool_use');

      const r2 = await postMessages(ts.url, {
        model: 'x',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'run ls' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: toolCallId, name: 'bash', input: { command: 'ls' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolCallId, content: 'file.txt\ndir/' }],
          },
        ],
      });

      expect(r2.status).toBe(200);
      const msgDelta2 = r2.events.find((e) => e.type === 'message_delta');
      expect(msgDelta2).toBeDefined();
      expect(
        ((msgDelta2!.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
          'stop_reason'
        ]
      ).toBe('end_turn');
    } finally {
      await ts.stop();
    }
  });

  it('rejects image tool_result continuation with 400', async () => {
    let toolHandler: ((args: unknown, inv: unknown) => Promise<unknown>) | undefined;
    const toolSession = new MockCopilotSession();
    const toolClient = makeMockClient(() => toolSession);

    spyOn(toolClient, 'createSession').mockImplementation(async (cfg: unknown) => {
      toolSession.capturedConfig = cfg;
      const tools = (cfg as Record<string, unknown>)?.['tools'] as
        | Array<{ name: string; handler: (args: unknown, inv: unknown) => Promise<unknown> }>
        | undefined;
      if (tools?.[0]) toolHandler = tools[0].handler;
      return toolSession as unknown as CopilotSession;
    });

    toolSession.send = async function (opts) {
      this.capturedPrompt = opts.prompt;
      Promise.resolve().then(() => {
        if (toolHandler) {
          toolHandler(
            { command: 'screenshot' },
            {
              sessionId: 's1',
              toolCallId: 'tc_image',
              toolName: 'screenshot',
              arguments: { command: 'screenshot' },
            }
          ).catch(() => {});
        }
      });
      return 'send-result';
    };

    const ts = await startEmbeddedServer(toolClient, '/tmp');
    try {
      const r1 = await postMessages(ts.url, {
        model: 'x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'take screenshot' }],
        tools: [
          { name: 'screenshot', description: 'Take screenshot', input_schema: { type: 'object' } },
        ],
      });
      expect(r1.status).toBe(200);

      const r2 = await postMessages(ts.url, {
        model: 'x',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'take screenshot' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tc_image',
                name: 'screenshot',
                input: { command: 'screenshot' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tc_image',
                content: 'screenshot captured',
              },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' },
              },
            ],
          },
        ],
      });

      expect(r2.status).toBe(400);
      const body = JSON.parse(r2.rawBody ?? '{}') as Record<string, unknown>;
      const err = body['error'] as Record<string, unknown>;
      expect(err['type']).toBe('invalid_request_error');
      expect(err['message']).toContain('image content blocks');
    } finally {
      await ts.stop();
    }
  });

  it('routes tool_result continuation even when tools array is omitted from follow-up', async () => {
    let toolHandler: ((args: unknown, inv: unknown) => Promise<unknown>) | undefined;
    const ts2Session = new MockCopilotSession();
    const ts2Client = makeMockClient(() => ts2Session);

    spyOn(ts2Client, 'createSession').mockImplementation(async (cfg: unknown) => {
      ts2Session.capturedConfig = cfg;
      const tools = (cfg as Record<string, unknown>)?.['tools'] as
        | Array<{ name: string; handler: (args: unknown, inv: unknown) => Promise<unknown> }>
        | undefined;
      if (tools?.[0]) toolHandler = tools[0].handler;
      return ts2Session as unknown as CopilotSession;
    });

    ts2Session.send = async function (opts) {
      this.capturedPrompt = opts.prompt;
      Promise.resolve().then(() => {
        if (toolHandler) {
          toolHandler(
            { q: 1 },
            {
              sessionId: 's2',
              toolCallId: 'tc_notools',
              toolName: 'read',
              arguments: { q: 1 },
            }
          )
            .then(() => {
              ts2Session.emit('session.idle', {});
            })
            .catch(() => {});
        }
      });
      return 'send-result';
    };

    const ts2 = await startEmbeddedServer(ts2Client, '/tmp');
    try {
      const r1 = await postMessages(ts2.url, {
        model: 'x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'q' }],
        tools: [{ name: 'read', description: 'read file', input_schema: {} }],
      });
      expect(r1.status).toBe(200);
      const delta1 = r1.events.find((e) => e.type === 'message_delta');
      expect(
        ((delta1!.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
          'stop_reason'
        ]
      ).toBe('tool_use');

      const r2 = await postMessages(ts2.url, {
        model: 'x',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tc_notools', name: 'read', input: { q: 1 } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tc_notools', content: 'ok' }],
          },
        ],
      });

      expect(r2.status).toBe(200);
      const delta2 = r2.events.find((e) => e.type === 'message_delta');
      expect(
        ((delta2!.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
          'stop_reason'
        ]
      ).toBe('end_turn');
    } finally {
      await ts2.stop();
    }
  });
});

describe('resolveRequestCwd', () => {
  function makeReq(authHeader?: string): import('node:http').IncomingMessage {
    return {
      headers: authHeader !== undefined ? { authorization: authHeader } : {},
    } as unknown as import('node:http').IncomingMessage;
  }

  it('returns the path from a valid anthropic-copilot-proxy token', () => {
    const req = makeReq('Bearer anthropic-copilot-proxy:/my/workspace');
    expect(resolveRequestCwd(req, '/default')).toBe('/my/workspace');
  });

  it('falls back to defaultCwd when the token has no prefix', () => {
    const req = makeReq('Bearer some-other-token');
    expect(resolveRequestCwd(req, '/default')).toBe('/default');
  });

  it('falls back to defaultCwd when the path after prefix is empty', () => {
    const req = makeReq('Bearer anthropic-copilot-proxy:');
    expect(resolveRequestCwd(req, '/default')).toBe('/default');
  });

  it('falls back to defaultCwd when Authorization header is absent', () => {
    const req = makeReq(undefined);
    expect(resolveRequestCwd(req, '/default')).toBe('/default');
  });

  it('falls back to defaultCwd for non-Bearer auth schemes', () => {
    const req = makeReq('Basic dXNlcjpwYXNz');
    expect(resolveRequestCwd(req, '/default')).toBe('/default');
  });

  it('falls back to defaultCwd when path is relative (not absolute)', () => {
    const req = makeReq('Bearer anthropic-copilot-proxy:relative/path');
    expect(resolveRequestCwd(req, '/default')).toBe('/default');
  });

  it('normalises dot-dot segments so traversal attempts are collapsed', () => {
    const req = makeReq('Bearer anthropic-copilot-proxy:/foo/bar/../../baz');
    expect(resolveRequestCwd(req, '/default')).toBe('/baz');
  });
});

describe('factory registration', () => {
  beforeEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
  });

  it('registers AnthropicToCopilotBridgeProvider with id anthropic-copilot', async () => {
    initializeProviders();
    await waitForOptionalProviderRegistration();
    const registry = getProviderRegistry();
    const p = registry.get('anthropic-copilot');
    expect(p).toBeDefined();
    expect(p?.id).toBe('anthropic-copilot');
  });
});

describe('tool_choice warning — copilot bridge', () => {
  let session: MockCopilotSession;
  let client: CopilotClient & { lastSession?: MockCopilotSession };
  let serverUrl: string;
  let stopServer: () => Promise<void>;

  beforeEach(async () => {
    session = new MockCopilotSession();
    client = makeMockClient(() => session);
    const server = await startEmbeddedServer(client, '/tmp');
    serverUrl = server.url;
    stopServer = server.stop;
  });

  afterEach(async () => {
    await stopServer();
  });

  it('logs a warning when tool_choice is provided', async () => {
    const warnSpy = spyOn(Logger.prototype, 'warn');

    const r = await postMessages(serverUrl, {
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: { type: 'auto' },
    });

    expect(r.status).toBe(200);
    const warnMessages = warnSpy.mock.calls.map((args) => args.map(String).join(' '));
    expect(warnMessages.some((m) => m.includes('tool_choice'))).toBe(true);

    warnSpy.mockRestore();
  });

  it('processes the request successfully even when tool_choice is provided', async () => {
    const r = await postMessages(serverUrl, {
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: { type: 'none' },
    });

    expect(r.status).toBe(200);
    const types = r.events.map((e) => e.type);
    expect(types).toContain('message_stop');
  });

  it('does NOT log a warning when tool_choice is absent', async () => {
    const warnSpy = spyOn(Logger.prototype, 'warn');

    await postMessages(serverUrl, {
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    });

    const toolChoiceWarns = warnSpy.mock.calls.filter((args) =>
      args.map(String).join(' ').includes('tool_choice')
    );
    expect(toolChoiceWarns.length).toBe(0);

    warnSpy.mockRestore();
  });
});
