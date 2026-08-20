import { describe, expect, test, mock } from 'bun:test';
import type {
  AcpJsonRpcNotification,
  AcpJsonRpcRequest,
  AcpJsonRpcResponse,
  AcpTransportOptions,
} from '@hyperneo/shared';
import { AcpClient } from '../../../../src/lib/acp/acp-client';
import { AcpQueryAdapter } from '../../../../src/lib/acp/acp-query-adapter';

class MockAcpTransport {
  options: AcpTransportOptions | undefined;
  private requestId = 1;
  private pending = new Map<number | string, (response: AcpJsonRpcResponse) => void>();
  private notificationQueue: AcpJsonRpcNotification[] = [];
  private sessionId: string | null = null;

  constructor(options: AcpTransportOptions) {
    this.options = options;
  }

  sendRequest = async (method: string, params?: unknown): Promise<AcpJsonRpcResponse> => {
    const id = this.requestId++;
    return new Promise<AcpJsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => this.handleRequest(id, method, params), 0);
    });
  };

  sendNotification = (_method: string, _params?: unknown) => {};
  sendResponse = (_id: unknown, _result: unknown) => {};
  sendErrorResponse = (_id: unknown, _error: unknown) => {};
  close = async () => {};

  private handleRequest(id: number | string, method: string, params?: unknown) {
    switch (method) {
      case 'initialize': {
        this.resolve(id, {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { close: null } },
          agentInfo: { name: 'mock-acp-server', version: '0.0.1' },
          authMethods: [{ id: 'none', name: 'None' }],
        });
        break;
      }
      case 'authenticate': {
        this.resolve(id, {});
        break;
      }
      case 'session/new': {
        this.sessionId = 'mock-session-001';
        this.resolve(id, {
          sessionId: this.sessionId,
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              options: [{ name: 'Default', value: 'default' }],
              currentValue: 'default',
              category: 'model',
            },
          ],
          modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
        });
        break;
      }
      case 'session/prompt': {
        const p = params as { sessionId: string };
        this.notificationQueue.push({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: p.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello ' },
            },
          },
        });
        this.notificationQueue.push({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: p.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'world' },
            },
          },
        });
        this.notificationQueue.push({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: p.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-mock-1',
              title: 'Read file',
              rawInput: { path: '/tmp/test.txt' },
            },
          },
        });
        this.notificationQueue.push({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: p.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-mock-1',
              title: 'Read file',
              status: 'completed',
            },
          },
        });
        setTimeout(() => this.drainNotifications(), 5);
        setTimeout(() => this.resolve(id, { stopReason: 'end_turn' }), 20);
        break;
      }
      default: {
        this.resolve(id, { error: { code: -32601, message: `Method not found: ${method}` } });
      }
    }
  }

  private drainNotifications() {
    for (const n of this.notificationQueue) {
      this.options?.onNotification?.(n);
    }
    this.notificationQueue = [];
  }

  private resolve(id: number | string, result: unknown) {
    const resolver = this.pending.get(id);
    if (resolver) {
      resolver({ jsonrpc: '2.0', id, result } as AcpJsonRpcResponse);
      this.pending.delete(id);
    }
  }
}

mock.module('../../../../src/lib/acp/acp-transport', () => ({
  AcpTransport: MockAcpTransport,
}));

const { AcpClient: MockedAcpClient } = await import('../../../../src/lib/acp/acp-client');

describe('ACP Integration', () => {
  test('full lifecycle with mock ACP server', async () => {
    const client = new MockedAcpClient({ command: 'mock-agent' });

    const initResult = await client.initialize();
    expect(initResult.agentInfo?.name).toBe('mock-acp-server');
    expect(initResult.authMethods?.length).toBeGreaterThan(0);

    await client.authenticate();

    const session = await client.createSession('/tmp/project');
    expect(session.sessionId).toBe('mock-session-001');
    expect(session.configOptions.length).toBeGreaterThan(0);

    const adapter = new AcpQueryAdapter(client, [{ type: 'text', text: 'hello' }]);
    expect(adapter.sessionId).toBe('mock-session-001');

    const messages: unknown[] = [];
    for await (const msg of adapter) {
      messages.push(msg);
    }

    expect(messages.length).toBeGreaterThanOrEqual(3);

    const types = messages.map((m) => (m as { type: string }).type);
    expect(types).toContain('assistant');
    expect(types).toContain('user');
    expect(types).toContain('result');

    const assistantMsgs = messages.filter((m) => (m as { type: string }).type === 'assistant');
    const textMsg = assistantMsgs.find((m) =>
      (m as { message: { content: { type: string }[] } }).message.content.some(
        (c) => c.type === 'text'
      )
    );
    expect(textMsg).toBeDefined();
    expect(
      (textMsg as { message: { content: { type: string; text: string }[] } }).message.content.find(
        (c) => c.type === 'text'
      )?.text
    ).toBe('Hello world');

    const toolMsg = assistantMsgs.find((m) =>
      (m as { message: { content: { type: string }[] } }).message.content.some(
        (c) => c.type === 'tool_use'
      )
    );
    expect(toolMsg).toBeDefined();
    const toolBlock = (
      toolMsg as { message: { content: { type: string; id: string; name: string }[] } }
    ).message.content.find((c) => c.type === 'tool_use');
    expect(toolBlock?.id).toBe('tc-mock-1');
    expect(toolBlock?.name).toBe('Read file');

    const toolResult = messages.find((m) => (m as { type: string }).type === 'user') as
      | { parent_tool_use_id: string; tool_use_result: unknown }
      | undefined;
    expect(toolResult?.parent_tool_use_id).toBe('tc-mock-1');
    expect(toolResult?.tool_use_result).toBe('');

    adapter.close();
  });

  test('sendPrompt directly with mock server', async () => {
    const client = new MockedAcpClient({ command: 'mock-agent' });

    await client.initialize();
    await client.authenticate();
    await client.createSession('/tmp');

    const updates: unknown[] = [];
    for await (const update of client.sendPrompt([{ type: 'text', text: 'hi' }])) {
      updates.push(update);
    }

    expect(updates.length).toBe(4);
    expect((updates[0] as { update: { sessionUpdate: string } }).update.sessionUpdate).toBe(
      'agent_message_chunk'
    );
    expect((updates[1] as { update: { sessionUpdate: string } }).update.sessionUpdate).toBe(
      'agent_message_chunk'
    );
    expect((updates[2] as { update: { sessionUpdate: string } }).update.sessionUpdate).toBe(
      'tool_call'
    );
    expect((updates[3] as { update: { sessionUpdate: string } }).update.sessionUpdate).toBe(
      'tool_call_update'
    );

    client.close();
  });
});
