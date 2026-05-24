/**
 * Unit tests for anthropic-copilot/streaming.ts
 *
 * Exercises runSessionStreaming / resumeSessionStreaming without a real HTTP
 * server by using minimal mock objects for CopilotSession, IncomingMessage,
 * and ServerResponse.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import {
  runSessionStreaming,
  resumeSessionStreaming,
  STREAMING_TIMEOUT_MS,
} from '../../../../../src/lib/providers/anthropic-copilot/streaming';
import { estimateTokens } from '../../../../../src/lib/providers/anthropic-copilot/sse';
import { ContextUsageStore } from '../../../../../src/lib/providers/anthropic-copilot/context-usage';
import { ToolBridgeRegistry } from '../../../../../src/lib/providers/anthropic-copilot/tool-bridge';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type SessionHandler = (event: SessionEvent) => void;

class MockSession {
  private subs: SessionHandler[] = [];
  disconnectCalled = false;
  abortCalled = false;
  lastPrompt: string | undefined;

  on(handler: SessionHandler): () => void {
    this.subs.push(handler);
    return () => {
      this.subs = this.subs.filter((h) => h !== handler);
    };
  }

  emit(type: string, data: Record<string, unknown> = {}): void {
    const event = { type, data } as SessionEvent;
    for (const h of [...this.subs]) h(event);
  }

  async send(opts: { prompt: string }): Promise<void> {
    this.lastPrompt = opts.prompt;
  }
  async abort(): Promise<void> {
    this.abortCalled = true;
  }
  async disconnect(): Promise<void> {
    this.disconnectCalled = true;
  }
}

function makeMockRes(): {
  written: string[];
  state: { ended: boolean; statusCode?: number; headers?: Record<string, string> };
  res: ServerResponse;
} {
  const written: string[] = [];
  const state: { ended: boolean; statusCode?: number; headers?: Record<string, string> } = {
    ended: false,
  };
  const res = {
    writeHead: (statusCode: number, headers?: Record<string, string>) => {
      state.statusCode = statusCode;
      state.headers = headers;
    },
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: (chunk?: string) => {
      if (chunk) written.push(chunk);
      state.ended = true;
    },
    headersSent: false,
  } as unknown as ServerResponse;
  return { written, state, res };
}

function makeMockReq(): { emitter: EventEmitter; req: IncomingMessage } {
  const emitter = new EventEmitter();
  const req = emitter as unknown as IncomingMessage;
  return { emitter, req };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSessionStreaming', () => {
  it('resolves completed on session.idle', async () => {
    const session = new MockSession();
    const { res } = makeMockRes();
    const { req } = makeMockReq();

    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'model',
      req,
      res
    );
    // Fire session events on next tick
    await Promise.resolve();
    session.emit('assistant.message_delta', { deltaContent: 'hi' });
    session.emit('session.idle');

    const outcome = await p;
    expect(outcome.kind).toBe('completed');
    expect(session.disconnectCalled).toBe(true);
  });

  it('returns a JSON error when session.error happens before any SSE output', async () => {
    const session = new MockSession();
    const { written, state, res } = makeMockRes();
    const { req } = makeMockReq();

    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'model',
      req,
      res
    );
    await Promise.resolve();
    session.emit('session.error', { message: '402 You have no quota' });

    const outcome = await p;
    expect(outcome.kind).toBe('completed');
    expect(session.disconnectCalled).toBe(true);
    expect(state.statusCode).toBe(402);
    expect(state.headers?.['Content-Type']).toBe('application/json');
    expect(written.some((c) => c.includes('event: message_start'))).toBe(false);
    expect(written.some((c) => c.includes('"type":"rate_limit_error"'))).toBe(true);
    expect(written.some((c) => c.includes('You have no quota'))).toBe(true);
  });

  it('emits an SSE error when session.error happens after streaming output started', async () => {
    const session = new MockSession();
    const { written, res } = makeMockRes();
    const { req } = makeMockReq();

    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'model',
      req,
      res
    );
    await Promise.resolve();
    session.emit('assistant.message_delta', { deltaContent: 'partial' });
    session.emit('session.error', { message: 'bad token' });

    const outcome = await p;
    expect(outcome.kind).toBe('completed');
    expect(session.disconnectCalled).toBe(true);
    expect(written.some((c) => c.includes('event: message_start'))).toBe(true);
    expect(written.some((c) => c.includes('event: error'))).toBe(true);
    expect(written.some((c) => c.includes('"type":"api_error"'))).toBe(true);
  });

  it('resolves completed and aborts on client disconnect', async () => {
    const session = new MockSession();
    const { res } = makeMockRes();
    const { emitter, req } = makeMockReq();

    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'model',
      req,
      res
    );
    // Simulate client disconnect before session.idle
    emitter.emit('close');

    const outcome = await p;
    expect(outcome.kind).toBe('completed');
    expect(session.abortCalled).toBe(true);
    expect(session.disconnectCalled).toBe(true);
  });

  it('does not fire twice when both idle and close arrive', async () => {
    const session = new MockSession();
    const { res } = makeMockRes();
    const { emitter, req } = makeMockReq();

    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'model',
      req,
      res
    );
    await Promise.resolve();
    session.emit('session.idle');
    emitter.emit('close'); // second finish — should be a no-op

    const outcome = await p;
    expect(outcome.kind).toBe('completed');
    // disconnect called exactly once (by finishCompleted, not by the close handler)
    expect(session.disconnectCalled).toBe(true);
  });

  it('resolves tool_use outcome when registry emits tool use', async () => {
    const session = new MockSession();
    const { res } = makeMockRes();
    const { req } = makeMockReq();
    const registry = new ToolBridgeRegistry();

    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'model',
      req,
      res,
      registry
    );
    await Promise.resolve();
    // streamSession calls registry.setOnToolUseEmitted(finishToolUse).
    // Trigger finishToolUse directly via the stored callback.
    const onToolUseEmitted = (
      registry as unknown as { onToolUseEmitted: ((ids: string[]) => void) | null }
    ).onToolUseEmitted;
    expect(onToolUseEmitted).not.toBeNull();
    onToolUseEmitted!(['tc_1']);

    const outcome = await p;
    expect(outcome.kind).toBe('tool_use');
    expect((outcome as { kind: 'tool_use'; toolCallIds: string[] }).toolCallIds).toEqual(['tc_1']);
    // Session must NOT be disconnected for tool_use outcome
    expect(session.disconnectCalled).toBe(false);
  });

  it('times out and resolves completed if session never idles', async () => {
    jest.useFakeTimers();
    try {
      const session = new MockSession();
      const { written, state, res } = makeMockRes();
      const { req } = makeMockReq();

      expect(STREAMING_TIMEOUT_MS).toBeGreaterThan(0);

      const p = runSessionStreaming(session as unknown as CopilotSession, 'x', 'model', req, res);

      // Advance the clock past the 5-minute timeout — the timeout handler fires.
      jest.advanceTimersByTime(STREAMING_TIMEOUT_MS + 1);

      const outcome = await p;
      expect(outcome.kind).toBe('completed');
      // Timeout path must abort and disconnect the session.
      expect(session.abortCalled).toBe(true);
      expect(session.disconnectCalled).toBe(true);
      expect(state.statusCode).toBe(500);
      expect(state.headers?.['Content-Type']).toBe('application/json');
      expect(written.some((c) => c.includes('event: message_start'))).toBe(false);
      expect(written.some((c) => c.includes('"type":"api_error"'))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// SSE parse helper (shared with token accounting assertions below)
// ---------------------------------------------------------------------------

function parseEvents(written: string[]): Array<{ type: string; data: unknown }> {
  const events: Array<{ type: string; data: unknown }> = [];
  let currentType = '';
  for (const chunk of written) {
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) {
        currentType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        events.push({ type: currentType, data: JSON.parse(line.slice(6)) });
        currentType = '';
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Token accounting via inputText parameter
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// output_tokens — assistant.message fallback
// ---------------------------------------------------------------------------

describe('runSessionStreaming — output_tokens via assistant.message fallback', () => {
  it('counts output chars from assistant.message.content when no message_delta events arrived', async () => {
    // Simulate the Copilot SDK sending assistant.message (complete response)
    // WITHOUT any preceding assistant.message_delta events.  This is valid
    // Copilot SDK behaviour observed in CI: the SDK delivers the full text
    // in a single assistant.message event instead of streaming deltas.
    const session = new MockSession();
    const { written, res } = makeMockRes();
    const { req } = makeMockReq();

    const responseText = 'Hello! How can I help you today?'; // 32 chars → ceil(32/4) = 8

    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'model',
      req,
      res
    );
    await Promise.resolve();
    // Emit assistant.message with full content (NO assistant.message_delta)
    session.emit('assistant.message', { content: responseText });
    session.emit('session.idle');
    await p;

    const events = parseEvents(written);
    const delta = events.find((e) => e.type === 'message_delta');
    const outputTokens = (
      (delta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>
    )['output_tokens'];
    expect(outputTokens).toBe(estimateTokens(responseText.length)); // = 8
    expect(outputTokens).toBeGreaterThan(0);
  });

  it('does not double-count when both assistant.message_delta and assistant.message arrive', async () => {
    // Normal streaming path: deltas arrive first, then assistant.message fires.
    // The fallback must NOT add assistant.message.content on top of the deltas.
    const session = new MockSession();
    const { written, res } = makeMockRes();
    const { req } = makeMockReq();

    const delta1 = 'Hello ';
    const delta2 = 'world!';
    // assistant.message.content is the combined text — should NOT be counted again.
    const fullContent = delta1 + delta2;

    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'model',
      req,
      res
    );
    await Promise.resolve();
    session.emit('assistant.message_delta', { deltaContent: delta1 });
    session.emit('assistant.message_delta', { deltaContent: delta2 });
    // Now assistant.message fires — pendingDeltas is non-empty, so fallback skips.
    session.emit('assistant.message', { content: fullContent });
    session.emit('session.idle');
    await p;

    const events = parseEvents(written);
    const delta = events.find((e) => e.type === 'message_delta');
    const outputTokens = (
      (delta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>
    )['output_tokens'];
    // Should count delta1+delta2 only (12 chars → 3), NOT fullContent twice (24 chars → 6).
    expect(outputTokens).toBe(estimateTokens(fullContent.length)); // = ceil(12/4) = 3
  });
});

describe('runSessionStreaming — inputText / input_tokens', () => {
  it('message_start carries non-zero input_tokens when inputText is provided', async () => {
    const session = new MockSession();
    const { written, res } = makeMockRes();
    const { req } = makeMockReq();

    const inputText = 'hello world'; // 11 chars → ceil(11/4) = 3
    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'model',
      req,
      res,
      undefined,
      () => {},
      inputText
    );
    await Promise.resolve();
    session.emit('session.idle');
    await p;

    const events = parseEvents(written);
    const start = events.find((e) => e.type === 'message_start');
    const usage = ((start!.data as Record<string, unknown>)['message'] as Record<string, unknown>)[
      'usage'
    ] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(estimateTokens(inputText.length));
  });

  it('message_start carries 0 input_tokens when inputText is empty (default)', async () => {
    const session = new MockSession();
    const { written, res } = makeMockRes();
    const { req } = makeMockReq();

    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'model',
      req,
      res
    );
    await Promise.resolve();
    session.emit('session.idle');
    await p;

    const events = parseEvents(written);
    const start = events.find((e) => e.type === 'message_start');
    const usage = ((start!.data as Record<string, unknown>)['message'] as Record<string, unknown>)[
      'usage'
    ] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(0);
  });

  it('consumes session.usage_info and uses it for final input_tokens', async () => {
    const session = new MockSession();
    const { written, res } = makeMockRes();
    const { req } = makeMockReq();
    const store = new ContextUsageStore();

    const p = runSessionStreaming(
      session as unknown as CopilotSession,
      'prompt',
      'gpt-5-mini',
      req,
      res,
      undefined,
      () => {},
      'heuristic input',
      { store, requestKey: '/tmp:gpt-5-mini', outputTokenLimit: 100 }
    );
    await Promise.resolve();
    session.emit('session.usage_info', {
      currentTokens: 18_000,
      tokenLimit: 160_000,
      messagesLength: 12,
      systemTokens: 3_000,
      toolDefinitionsTokens: 2_000,
      conversationTokens: 13_000,
    });
    session.emit('assistant.message_delta', { deltaContent: 'done' });
    session.emit('session.idle');
    await p;

    const snapshot = store.getForRequestKey('/tmp:gpt-5-mini');
    expect(snapshot?.systemTokens).toBe(3_000);
    expect(snapshot?.toolDefinitionsTokens).toBe(2_000);
    expect(snapshot?.conversationTokens).toBe(13_000);
    expect(snapshot?.totalTokens).toBe(18_000);
    expect(snapshot?.promptTokenLimit).toBe(160_000);
    expect(snapshot?.bufferTokens).toBeGreaterThan(0);

    const events = parseEvents(written);
    const delta = events.find((e) => e.type === 'message_delta');
    const usage = (delta!.data as Record<string, unknown>)['usage'] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(18_000);
  });
});

describe('resumeSessionStreaming', () => {
  it('resolves completed after tool results resume and session idles', async () => {
    const session = new MockSession();
    const { res } = makeMockRes();
    const { req } = makeMockReq();
    const registry = new ToolBridgeRegistry();

    // Plant a real pending entry using the correct internal property name ('pending').
    // This exercises the actual resolveToolResult() code path.
    let resolvedWith: { text: string; isError: boolean } | undefined;
    const fakeTimer = setTimeout(() => {}, 100_000);
    (registry as unknown as Record<string, unknown>)['pending'] = new Map([
      [
        'tc_1',
        {
          resolve: (v: { text: string; isError: boolean }) => {
            resolvedWith = v;
          },
          reject: () => {},
          timer: fakeTimer,
        },
      ],
    ]);

    const p = resumeSessionStreaming(
      session as unknown as CopilotSession,
      'model',
      req,
      res,
      registry,
      [{ toolUseId: 'tc_1', result: 'result-value' }]
    );
    await Promise.resolve();
    // resolveToolResult should have been called immediately by resumeSessionStreaming
    expect(resolvedWith).toEqual({ text: 'result-value', isError: false });

    // After tool results are delivered, session should eventually idle
    session.emit('session.idle');

    const outcome = await p;
    expect(outcome.kind).toBe('completed');
    expect(session.disconnectCalled).toBe(true);
    clearTimeout(fakeTimer);
  });

  it('message_start carries non-zero input_tokens when inputText is provided', async () => {
    const session = new MockSession();
    const { written, res } = makeMockRes();
    const { req } = makeMockReq();
    const registry = new ToolBridgeRegistry();

    const fakeTimer = setTimeout(() => {}, 100_000);
    (registry as unknown as Record<string, unknown>)['pending'] = new Map([
      [
        'tc_1',
        {
          resolve: () => {},
          reject: () => {},
          timer: fakeTimer,
        },
      ],
    ]);

    const inputText = 'system context\nuser: run the tool'; // 34 chars → ceil(34/4) = 9
    const p = resumeSessionStreaming(
      session as unknown as CopilotSession,
      'model',
      req,
      res,
      registry,
      [{ toolUseId: 'tc_1', result: 'ok' }],
      () => {},
      inputText
    );
    await Promise.resolve();
    session.emit('session.idle');
    await p;

    const events = parseEvents(written);
    const start = events.find((e) => e.type === 'message_start');
    const usage = ((start!.data as Record<string, unknown>)['message'] as Record<string, unknown>)[
      'usage'
    ] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(estimateTokens(inputText.length));
    clearTimeout(fakeTimer);
  });
});
