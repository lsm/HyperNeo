import { describe, expect, test, mock } from 'bun:test';
import type { AcpSessionUpdateNotification, AcpContentBlock } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';

class MockAcpClient {
  private sessionId: string;
  private notifications: AcpSessionUpdateNotification[] = [];
  cancel = mock(() => {});
  close = mock(() => {});
  setConfigOption = mock((_configId: string, value: string) =>
    Promise.resolve([
      {
        id: 'model-option',
        name: 'Model',
        type: 'select' as const,
        category: 'model',
        currentValue: value,
        options: [{ name: 'Opus', value: 'opus' }],
      },
    ])
  );
  updateConfigOptions = mock((_configOptions: unknown[]) => {});

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }

  getLastPromptStopReason() {
    return undefined;
  }

  getConfigOptions() {
    return [
      {
        id: 'model-option',
        name: 'Model',
        type: 'select' as const,
        category: 'model',
        currentValue: 'sonnet',
        options: [{ name: 'Opus', value: 'opus' }],
      },
      {
        id: 'thought-option',
        name: 'Thinking',
        type: 'select' as const,
        category: 'thought_level',
        currentValue: 'low',
        options: [
          { name: 'Low', value: 'low' },
          { name: 'High', value: 'high' },
        ],
      },
    ];
  }

  queueNotification(notification: AcpSessionUpdateNotification) {
    this.notifications.push(notification);
  }

  async *sendPrompt(
    _prompt: AcpContentBlock[],
    callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
  ): AsyncGenerator<AcpSessionUpdateNotification> {
    callbacks?.onSubmitted?.();
    callbacks?.onAccepted?.();
    for (const n of this.notifications) {
      yield n;
    }
  }
}

const { AcpQueryAdapter } = await import('../../../../src/lib/acp/acp-query-adapter');

describe('AcpQueryAdapter', () => {
  test('throws when client has no session', () => {
    class EmptyClient {
      getSessionId() {
        return undefined;
      }
    }
    expect(
      () =>
        new (
          AcpQueryAdapter as unknown as new (
            client: unknown,
            prompt: unknown
          ) => AcpQueryAdapter
        )(new EmptyClient(), [])
    ).toThrow('AcpClient has no active session');
  });

  test('forwards ACP delivery lifecycle callbacks at prompt iteration', async () => {
    const client = new MockAcpClient('sess-1');
    const onSubmitted = mock(() => {});
    const onAccepted = mock(() => {});
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }],
      { onSubmitted, onAccepted }
    );

    for await (const _message of adapter) {
    }

    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  test('yields translated assistant messages from chunks', async () => {
    const client = new MockAcpClient('sess-1');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    client.queueNotification({
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi there' } },
    });
    client.queueNotification({
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '!' } },
    });

    const messages: SDKMessage[] = [];
    const iterator = adapter[Symbol.asyncIterator]();

    const msg1 = await iterator.next();
    expect(msg1.done).toBe(false);
    expect(msg1.value.type).toBe('assistant');
    expect(
      (msg1.value as { message: { content: { text: string }[] } }).message.content[0].text
    ).toBe('Hi there!');

    const msg2 = await iterator.next();
    expect(msg2.done).toBe(false);
    expect(msg2.value.type).toBe('result');

    const msg3 = await iterator.next();
    expect(msg3.done).toBe(true);
  });

  test('yields tool_use message on tool_call', async () => {
    const client = new MockAcpClient('sess-2');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'do it' }]
    );

    client.queueNotification({
      sessionId: 'sess-2',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Bash',
        rawInput: { command: 'ls' },
      },
    });

    const iterator = adapter[Symbol.asyncIterator]();
    const msg = await iterator.next();
    expect(msg.done).toBe(false);
    expect(msg.value.type).toBe('assistant');
    const content = (msg.value as { message: { content: { type: string }[] } }).message.content;
    expect(content[0].type).toBe('tool_use');
  });

  test('yields tool_progress on tool_call_update', async () => {
    const client = new MockAcpClient('sess-3');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'go' }]
    );

    client.queueNotification({
      sessionId: 'sess-3',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-2',
        title: 'Build',
        status: 'in_progress',
      },
    });

    const iterator = adapter[Symbol.asyncIterator]();
    const msg = await iterator.next();
    expect(msg.done).toBe(false);
    expect(msg.value.type).toBe('tool_progress');
    expect((msg.value as { tool_use_id: string }).tool_use_id).toBe('tc-2');
  });

  test('flushes incomplete tool output before the turn result', async () => {
    const client = new MockAcpClient('sess-partial');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'go' }]
    );

    client.queueNotification({
      sessionId: 'sess-partial',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-partial',
        title: 'Build',
        status: 'in_progress',
        rawOutput: 'partial output',
      },
    });

    const messages: SDKMessage[] = [];
    for await (const message of adapter) {
      messages.push(message);
    }

    expect(messages.map((message) => message.type)).toEqual(['tool_progress', 'user', 'result']);
    expect((messages[1] as { tool_use_result: unknown }).tool_use_result).toBe('partial output');
  });

  test('counts prompt estimate in result input tokens', async () => {
    const client = new MockAcpClient('sess-usage');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello world' }]
    );

    const messages: SDKMessage[] = [];
    for await (const msg of adapter) {
      messages.push(msg);
    }

    const result = messages.find((msg) => msg.type === 'result') as {
      usage: { input_tokens: number };
    };
    expect(result.usage.input_tokens).toBeGreaterThan(0);
  });

  test('stops iteration when interrupted', async () => {
    const client = new MockAcpClient('sess-4');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    client.queueNotification({
      sessionId: 'sess-4',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial' } },
    });

    const iterator = adapter[Symbol.asyncIterator]();
    const msg1 = await iterator.next();
    expect(msg1.value.type).toBe('assistant');

    await adapter.interrupt();

    const msg2 = await iterator.next();
    expect(msg2.value.type).toBe('result');
    expect(msg2.done).toBe(false);

    const msg3 = await iterator.next();
    expect(msg3.done).toBe(true);
  });

  test('flushes incomplete tool output when iteration fails', async () => {
    class FailingClient extends MockAcpClient {
      async *sendPrompt(): AsyncGenerator<AcpSessionUpdateNotification> {
        yield {
          sessionId: 'sess-failed',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-failed',
            status: 'in_progress',
            rawOutput: 'partial output',
          },
        };
        throw new Error('prompt failed');
      }
    }
    const client = new FailingClient('sess-failed');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );
    const messages: SDKMessage[] = [];

    await expect(
      (async () => {
        for await (const message of adapter) {
          messages.push(message);
        }
      })()
    ).rejects.toThrow('prompt failed');

    expect(messages.map((message) => message.type)).toEqual(['tool_progress', 'user', 'result']);
    expect((messages[1] as { tool_use_result: unknown }).tool_use_result).toBe('partial output');
  });

  test('returns early when closed before iteration', async () => {
    const client = new MockAcpClient('sess-5');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    adapter.close();

    const messages: SDKMessage[] = [];
    for await (const msg of adapter) {
      messages.push(msg);
    }
    expect(messages.length).toBe(0);
  });

  test('interrupt calls client.cancel', async () => {
    const client = new MockAcpClient('sess-6');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    await adapter.interrupt();
    expect(client.cancel).toHaveBeenCalled();
  });

  test('interrupt is idempotent', async () => {
    const client = new MockAcpClient('sess-7');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    await adapter.interrupt();
    await adapter.interrupt();
    expect(client.cancel).toHaveBeenCalledTimes(1);
  });

  test('close calls client.close', () => {
    const client = new MockAcpClient('sess-8');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    adapter.close();
    expect(client.close).toHaveBeenCalled();
  });

  test('close is idempotent', () => {
    const client = new MockAcpClient('sess-9');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    adapter.close();
    adapter.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test('sessionId getter returns client sessionId', () => {
    const client = new MockAcpClient('sess-10');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    expect(adapter.sessionId).toBe('sess-10');
  });

  test('setMcpServers resolves immediately', async () => {
    const client = new MockAcpClient('sess-11');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    await expect(adapter.setMcpServers()).resolves.toEqual({ added: [], removed: [], errors: {} });
  });

  test('setModel updates ACP model config option and refreshes callback', async () => {
    const client = new MockAcpClient('sess-model');
    const onConfigOptionsUpdate = mock((_configOptions: unknown[]) => {});
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }],
      { onConfigOptionsUpdate }
    );

    await adapter.setModel('opus');

    expect(client.setConfigOption).toHaveBeenCalledWith('model-option', 'opus');
    expect(onConfigOptionsUpdate).toHaveBeenCalledWith([
      {
        id: 'model-option',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'opus',
        options: [{ name: 'Opus', value: 'opus' }],
      },
    ]);
  });

  test('setMaxThinkingTokens updates ACP thought level config option', async () => {
    const client = new MockAcpClient('sess-thinking');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    await adapter.setMaxThinkingTokens(12000);

    expect(client.setConfigOption).toHaveBeenCalledWith('thought-option', 'high');
  });

  test('setMaxThinkingTokens maps null and zero to none', async () => {
    const client = new MockAcpClient('sess-thinking-none');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    await adapter.setMaxThinkingTokens(null);
    await adapter.setMaxThinkingTokens(0);

    expect(client.setConfigOption).toHaveBeenNthCalledWith(1, 'thought-option', 'low');
    expect(client.setConfigOption).toHaveBeenNthCalledWith(2, 'thought-option', 'low');
  });

  test('config option updates refresh client cache and callback', async () => {
    const client = new MockAcpClient('sess-config-update');
    const onConfigOptionsUpdate = mock((_configOptions: unknown[]) => {});
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }],
      { onConfigOptionsUpdate }
    );
    const configOptions = [
      {
        id: 'model-option',
        name: 'Model',
        type: 'select' as const,
        category: 'model',
        currentValue: 'opus',
        options: [{ name: 'Opus', value: 'opus' }],
      },
    ];

    client.queueNotification({
      sessionId: 'sess-config-update',
      update: { sessionUpdate: 'config_option_update', configOptions },
    });

    const iterator = adapter[Symbol.asyncIterator]();
    await iterator.next();

    expect(client.updateConfigOptions).toHaveBeenCalledWith(configOptions);
    expect(onConfigOptionsUpdate).toHaveBeenCalledWith(configOptions);
  });

  test('rewindFiles reports unsupported for ACP sessions', async () => {
    const client = new MockAcpClient('sess-12');
    const adapter = new AcpQueryAdapter(
      client as unknown as InstanceType<
        typeof import('../../../../src/lib/acp/acp-client').AcpClient
      >,
      [{ type: 'text', text: 'hello' }]
    );

    await expect(adapter.rewindFiles()).resolves.toEqual({
      canRewind: false,
      error: 'ACP sessions do not support file rewind yet.',
    });
  });
});
