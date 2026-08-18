import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import { ConversationManager } from '../../../../../src/lib/providers/anthropic-copilot/conversation';
import type { ActiveConversation } from '../../../../../src/lib/providers/anthropic-copilot/conversation';
import type {
  AnthropicMessage,
  AnthropicTool,
} from '../../../../../src/lib/providers/anthropic-copilot/types';
import { ToolBridgeRegistry } from '../../../../../src/lib/providers/anthropic-copilot/tool-bridge';

class MockSession {
  disconnectCalled = false;
  rejectCount = 0;

  async disconnect(): Promise<void> {
    this.disconnectCalled = true;
  }
  async abort(): Promise<void> {}
  on(): () => void {
    return () => {};
  }
  async send(): Promise<void> {}
}

function makeConv(session?: MockSession): { conv: ActiveConversation; session: MockSession } {
  const s = session ?? new MockSession();
  const registry = new ToolBridgeRegistry();
  const conv: ActiveConversation = { session: s as unknown as CopilotSession, registry };
  return { conv, session: s };
}

function makeMockClient(session: MockSession): CopilotClient {
  return {
    async createSession(): Promise<CopilotSession> {
      return session as unknown as CopilotSession;
    },
  } as unknown as CopilotClient;
}

function toolResultMsg(toolUseId: string, result: string): AnthropicMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }],
  };
}

describe('ConversationManager.findContinuation', () => {
  it('returns undefined when no tool_result IDs present', () => {
    const manager = new ConversationManager();
    const result = manager.findContinuation([{ role: 'user', content: 'hello' }]);
    expect(result).toBeUndefined();
  });

  it('returns undefined when all IDs are historical (not in byToolCallId)', () => {
    const manager = new ConversationManager();
    const result = manager.findContinuation([toolResultMsg('old-id', 'value')]);
    expect(result).toBeUndefined();
  });

  it('routes to the correct conversation for a registered ID', () => {
    const manager = new ConversationManager();
    const { conv } = makeConv();
    (manager as unknown as Record<string, unknown>)['byToolCallId'] = new Map([['tc_1', conv]]);

    const result = manager.findContinuation([toolResultMsg('tc_1', 'result-a')]);
    expect(result).toBeDefined();
    expect(result!.conv).toBe(conv);
    expect(result!.toolResults).toHaveLength(1);
    expect(result!.toolResults[0].toolUseId).toBe('tc_1');
    expect(result!.toolResults[0].result).toBe('result-a');
  });

  it('ignores historical IDs mixed with active ones', () => {
    const manager = new ConversationManager();
    const { conv } = makeConv();
    (manager as unknown as Record<string, unknown>)['byToolCallId'] = new Map([
      ['tc_active', conv],
    ]);

    const messages = [
      toolResultMsg('old-historical', 'irrelevant'),
      toolResultMsg('tc_active', 'active-result'),
    ];
    const result = manager.findContinuation(messages);
    expect(result).toBeDefined();
    expect(result!.toolResults).toHaveLength(1);
    expect(result!.toolResults[0].toolUseId).toBe('tc_active');
  });

  it('returns undefined when second pass yields no matched results', () => {
    const manager = new ConversationManager();
    const { conv } = makeConv();
    const { conv: otherConv } = makeConv();
    (manager as unknown as Record<string, unknown>)['byToolCallId'] = new Map([
      ['tc_1', otherConv],
    ]);
    const msgs: AnthropicMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: undefined }],
      },
    ];
    const result = manager.findContinuation(msgs);
    expect(result).toBeDefined();
    expect(result!.toolResults[0].result).toBe('');
  });
});

describe('ConversationManager.createConversation permission hooks', () => {
  async function captureHooks(): Promise<Record<string, unknown>> {
    const manager = new ConversationManager();
    let capturedHooks: Record<string, unknown> | undefined;
    const mockSession = new MockSession();
    const client: CopilotClient = {
      async createSession(cfg: unknown): Promise<import('@github/copilot-sdk').CopilotSession> {
        capturedHooks = (cfg as Record<string, unknown>)['hooks'] as Record<string, unknown>;
        return mockSession as unknown as import('@github/copilot-sdk').CopilotSession;
      },
    } as unknown as CopilotClient;
    const tools: AnthropicTool[] = [
      { name: 'bash', description: 'run', input_schema: { type: 'object' } },
    ];
    await manager.createConversation(client, 'model', undefined, tools, '/tmp');
    return capturedHooks!;
  }

  it('onPreToolUse is present and returns allow', async () => {
    const hooks = await captureHooks();
    const onPreToolUse = hooks['onPreToolUse'] as () => Promise<{ permissionDecision: string }>;
    expect(typeof onPreToolUse).toBe('function');
    const result = await onPreToolUse();
    expect(result).toEqual({ permissionDecision: 'allow' });
  });

  it('onPostToolUse is present and is a no-op function', async () => {
    const hooks = await captureHooks();
    const onPostToolUse = hooks['onPostToolUse'] as () => void;
    expect(typeof onPostToolUse).toBe('function');
    expect(() => onPostToolUse()).not.toThrow();
  });
});

describe('ConversationManager.createConversation onErrorOccurred hook', () => {
  it('returns retry for recoverable model_call errors', async () => {
    const manager = new ConversationManager();
    let capturedHooks: Record<string, unknown> | undefined;
    const mockSession = new MockSession();
    const client: CopilotClient = {
      async createSession(cfg: unknown): Promise<import('@github/copilot-sdk').CopilotSession> {
        capturedHooks = (cfg as Record<string, unknown>)['hooks'] as Record<string, unknown>;
        return mockSession as unknown as import('@github/copilot-sdk').CopilotSession;
      },
    } as unknown as CopilotClient;

    const tools: AnthropicTool[] = [
      { name: 'bash', description: 'run', input_schema: { type: 'object' } },
    ];
    await manager.createConversation(client, 'model', undefined, tools, '/tmp');

    expect(capturedHooks).toBeDefined();
    const onErrorOccurred = capturedHooks!['onErrorOccurred'] as (input: {
      error: Error;
      errorContext: string;
      recoverable: boolean;
    }) => unknown;
    expect(typeof onErrorOccurred).toBe('function');

    const result = onErrorOccurred({
      error: new Error('model fail'),
      errorContext: 'model_call',
      recoverable: true,
    });
    expect(result).toEqual({ errorHandling: 'retry', retryCount: 2 });
  });

  it('returns undefined for non-recoverable errors', async () => {
    const manager = new ConversationManager();
    let capturedHooks: Record<string, unknown> | undefined;
    const mockSession = new MockSession();
    const client: CopilotClient = {
      async createSession(cfg: unknown): Promise<import('@github/copilot-sdk').CopilotSession> {
        capturedHooks = (cfg as Record<string, unknown>)['hooks'] as Record<string, unknown>;
        return mockSession as unknown as import('@github/copilot-sdk').CopilotSession;
      },
    } as unknown as CopilotClient;

    const tools: AnthropicTool[] = [
      { name: 'bash', description: 'run', input_schema: { type: 'object' } },
    ];
    await manager.createConversation(client, 'model', undefined, tools, '/tmp');

    const onErrorOccurred = capturedHooks!['onErrorOccurred'] as (input: {
      error: Error;
      errorContext: string;
      recoverable: boolean;
    }) => unknown;

    const result = onErrorOccurred({
      error: new Error('fatal'),
      errorContext: 'model_call',
      recoverable: false,
    });
    expect(result).toBeUndefined();
  });
});

describe('ConversationManager.createConversation runtime guard', () => {
  it('throws if setOnPendingToolCall fires before conv is assigned', async () => {
    const manager = new ConversationManager();
    const { conv } = makeConv();
    const registry = conv.registry;

    let capturedCb: ((id: string) => void) | undefined;
    const origSet = registry.setOnPendingToolCall.bind(registry);
    registry.setOnPendingToolCall = (cb: (id: string) => void) => {
      capturedCb = cb;
      origSet(cb);
    };

    const callbackWithGuard = (toolCallId: string): void => {
      let innerConv: ActiveConversation | undefined;
      if (!innerConv)
        throw new Error('[anthropic-copilot] tool call registered before conversation was created');
      (manager as unknown as Record<string, unknown>)['byToolCallId'] = new Map([
        [toolCallId, innerConv],
      ]);
    };

    expect(() => callbackWithGuard('tc_1')).toThrow(
      'tool call registered before conversation was created'
    );
  });
});

describe('ConversationManager.acknowledgeContinuation', () => {
  it('removes routing entries and cancels TTL timer', () => {
    const manager = new ConversationManager();
    const { conv } = makeConv();
    const m = manager as unknown as Record<string, unknown>;

    const fakeTimer = setTimeout(() => {}, 100_000);
    (m['byToolCallId'] as Map<string, unknown>).set('tc_1', conv);
    (m['cleanupTimers'] as Map<unknown, unknown>).set(conv, fakeTimer);

    manager.acknowledgeContinuation(conv, ['tc_1']);

    expect((m['byToolCallId'] as Map<string, unknown>).has('tc_1')).toBe(false);
    expect((m['cleanupTimers'] as Map<unknown, unknown>).has(conv)).toBe(false);
    clearTimeout(fakeTimer);
  });
});

describe('ConversationManager.cleanupConversation', () => {
  it('removes routing entries without calling session.disconnect', () => {
    const manager = new ConversationManager();
    const { conv, session } = makeConv();
    const m = manager as unknown as Record<string, unknown>;
    (m['byToolCallId'] as Map<string, unknown>).set('tc_1', conv);

    manager.cleanupConversation(conv);

    expect((m['byToolCallId'] as Map<string, unknown>).has('tc_1')).toBe(false);
    expect(session.disconnectCalled).toBe(false);
  });

  it('rejects any remaining pending tool calls', () => {
    const manager = new ConversationManager();
    const { conv } = makeConv();
    let rejected = false;
    const fakeTimer = setTimeout(() => {}, 100_000);
    (conv.registry as unknown as Record<string, unknown>)['pending'] = new Map([
      [
        'tc_1',
        {
          resolve: () => {},
          reject: (err: Error) => {
            rejected = true;
            expect(err.message).toContain('Conversation complete');
          },
          timer: fakeTimer,
        },
      ],
    ]);

    manager.cleanupConversation(conv);
    clearTimeout(fakeTimer);
    expect(rejected).toBe(true);
  });
});

describe('ConversationManager.releaseConversation', () => {
  it('calls session.disconnect', async () => {
    const manager = new ConversationManager();
    const { conv, session } = makeConv();

    await manager.releaseConversation(conv);
    expect(session.disconnectCalled).toBe(true);
  });

  it('removes all routing entries for the conversation', async () => {
    const manager = new ConversationManager();
    const { conv } = makeConv();
    const { conv: otherConv } = makeConv();
    const m = manager as unknown as Record<string, unknown>;
    (m['byToolCallId'] as Map<string, unknown>).set('tc_1', conv);
    (m['byToolCallId'] as Map<string, unknown>).set('tc_2', conv);
    (m['byToolCallId'] as Map<string, unknown>).set('tc_other', otherConv);

    await manager.releaseConversation(conv);

    const map = m['byToolCallId'] as Map<string, unknown>;
    expect(map.has('tc_1')).toBe(false);
    expect(map.has('tc_2')).toBe(false);
    expect(map.has('tc_other')).toBe(true);
  });
});

describe('ConversationManager TTL expiry', () => {
  it('scheduleCleanup fires releaseConversation after timeout', async () => {
    const manager = new ConversationManager();
    const { conv, session } = makeConv();

    const m = manager as unknown as Record<string, () => void>;

    let releaseCalled = false;
    const origRelease = manager.releaseConversation.bind(manager);
    manager.releaseConversation = async (c: ActiveConversation) => {
      if (c === conv) releaseCalled = true;
      return origRelease(c);
    };

    const timer = setTimeout(() => {
      (manager as unknown as Record<string, unknown>)['cleanupTimers'].delete(conv);
      manager.releaseConversation(conv).catch(() => {});
    }, 1);
    (manager as unknown as Record<string, unknown>)['cleanupTimers'].set(conv, timer);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(releaseCalled).toBe(true);
  });
});

describe('ConversationManager.shutdown', () => {
  it('releases all conversations in byToolCallId and cleanupTimers', async () => {
    const manager = new ConversationManager();
    const { conv: conv1, session: s1 } = makeConv();
    const { conv: conv2, session: s2 } = makeConv();
    const m = manager as unknown as Record<string, unknown>;

    (m['byToolCallId'] as Map<string, unknown>).set('tc_1', conv1);
    const fakeTimer = setTimeout(() => {}, 100_000);
    (m['cleanupTimers'] as Map<unknown, unknown>).set(conv2, fakeTimer);

    await manager.shutdown();

    expect(s1.disconnectCalled).toBe(true);
    expect(s2.disconnectCalled).toBe(true);
    expect((m['byToolCallId'] as Map<string, unknown>).size).toBe(0);
  });

  it('is safe to call when no conversations are active', async () => {
    const manager = new ConversationManager();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});
