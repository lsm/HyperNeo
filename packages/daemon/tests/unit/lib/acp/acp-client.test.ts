import { describe, expect, test, mock, beforeEach, afterAll } from 'bun:test';
import type {
  AcpJsonRpcNotification,
  AcpJsonRpcRequest,
  AcpJsonRpcResponse,
  AcpTransportOptions,
} from '@hyperneo/shared';

let lastMockTransport: MockAcpTransport | null = null;

class MockAcpTransport {
  options: AcpTransportOptions | undefined;
  private requestId = 1;
  private pending = new Map<number | string, (response: AcpJsonRpcResponse) => void>();
  sendRequest = mock(async (method: string, params?: unknown) => {
    const id = this.requestId++;
    return new Promise<AcpJsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
  });
  sendNotification = mock((_method: string, _params?: unknown) => {});
  sendResponse = mock((_id: unknown, _result: unknown) => {});
  sendErrorResponse = mock((_id: unknown, _error: unknown) => {});
  close = mock(async () => {});

  constructor(options: AcpTransportOptions) {
    this.options = options;
    lastMockTransport = this;
  }

  resolveRequest(id: number | string, result: unknown) {
    const resolver = this.pending.get(id);
    if (resolver) {
      resolver({ jsonrpc: '2.0', id, result } as AcpJsonRpcResponse);
      this.pending.delete(id);
    }
  }

  resolveError(id: number | string, error: { code: number; message: string }) {
    const resolver = this.pending.get(id);
    if (resolver) {
      resolver({ jsonrpc: '2.0', id, error } as AcpJsonRpcResponse);
      this.pending.delete(id);
    }
  }

  emitNotification(notification: AcpJsonRpcNotification) {
    this.options?.onNotification?.(notification);
  }

  emitRequest(request: AcpJsonRpcRequest) {
    this.options?.onRequest?.(request);
  }
}

let originalAcpTransport: typeof import('../../../../src/lib/acp/acp-transport') | undefined;
if (typeof Bun !== 'undefined') {
  originalAcpTransport = require('../../../../src/lib/acp/acp-transport');
}

mock.module('../../../../src/lib/acp/acp-transport', () => ({
  AcpTransport: MockAcpTransport,
}));

const { AcpClient } = await import('../../../../src/lib/acp/acp-client');

afterAll(() => {
  if (originalAcpTransport) {
    mock.module('../../../../src/lib/acp/acp-transport', () => originalAcpTransport);
  }
});

describe('AcpClient', () => {
  beforeEach(() => {
    lastMockTransport = null;
  });

  test('initialize sends correct params and stores capabilities', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const promise = client.initialize();
    transport.resolveRequest(1, {
      protocolVersion: 1,
      agentCapabilities: { auth: { logout: null } },
      agentInfo: { name: 'test-agent', version: '1.0' },
      authMethods: [{ id: 'api_key', name: 'API Key' }],
    });

    const result = await promise;
    expect(result.agentCapabilities).toEqual({ auth: { logout: null } });
    expect(result.authMethods).toEqual([{ id: 'api_key', name: 'API Key' }]);
    expect(client.getAgentCapabilities()).toEqual({ auth: { logout: null } });

    const reqArgs = transport.sendRequest.mock.calls[0];
    expect(reqArgs[0]).toBe('initialize');
    expect(reqArgs[1]).toMatchObject({ protocolVersion: 1, clientInfo: { name: 'HyperNeo' } });
  });

  test('initialize throws on error response', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const promise = client.initialize();
    transport.resolveError(1, { code: -32600, message: 'Bad request' });

    await expect(promise).rejects.toThrow('Initialize failed: Bad request');
  });

  test('authenticate sends first auth method when no credentials given', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const initPromise = client.initialize();
    transport.resolveRequest(1, {
      protocolVersion: 1,
      agentInfo: { name: 'a', version: '1' },
      authMethods: [{ id: 'oauth', name: 'OAuth' }],
    });
    await initPromise;

    const authPromise = client.authenticate();
    transport.resolveRequest(2, {});
    await authPromise;

    expect(transport.sendRequest.mock.calls[1][0]).toBe('authenticate');
    expect(transport.sendRequest.mock.calls[1][1]).toEqual({ methodId: 'oauth' });
  });

  test('authenticate skips when no authMethods', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const initPromise = client.initialize();
    transport.resolveRequest(1, {
      protocolVersion: 1,
      agentInfo: { name: 'a', version: '1' },
    });
    await initPromise;

    await client.authenticate();
    expect(transport.sendRequest).toHaveBeenCalledTimes(1);
  });

  test('createSession stores sessionId and configOptions', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const promise = client.createSession('/tmp/project', [
      { type: 'stdio', name: 'test-server', command: 'bun', args: ['server.ts'], env: [] },
    ]);
    transport.resolveRequest(1, {
      sessionId: 'sess-123',
      configOptions: [
        { id: 'model', name: 'Model', type: 'select', options: [], currentValue: 'default' },
      ],
      modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
    });

    const result = await promise;
    expect(result.sessionId).toBe('sess-123');
    expect(result.configOptions.length).toBe(1);
    expect(result.modes?.currentModeId).toBe('code');
    expect(client.getSessionId()).toBe('sess-123');

    const reqArgs = transport.sendRequest.mock.calls[0];
    expect(reqArgs[0]).toBe('session/new');
    expect(reqArgs[1]).toMatchObject({
      cwd: '/tmp/project',
      mcpServers: [{ type: 'stdio', name: 'test-server' }],
    });
  });

  test('createSession throws on error response', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const promise = client.createSession('/tmp');
    transport.resolveError(1, { code: -32600, message: 'Invalid cwd' });

    await expect(promise).rejects.toThrow('session/new failed: Invalid cwd');
  });

  test('loadSession sends session/load and stores returned session data', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const initPromise = client.initialize();
    transport.resolveRequest(1, {
      protocolVersion: 1,
      agentInfo: { name: 'a', version: '1' },
      agentCapabilities: { loadSession: true },
    });
    await initPromise;

    expect(client.canLoadSession()).toBe(true);

    const promise = client.loadSession('sess-existing', '/tmp/project', [
      { type: 'stdio', name: 'test-server', command: 'bun', args: [], env: [] },
    ]);
    transport.resolveRequest(2, {
      sessionId: 'sess-loaded',
      configOptions: [
        { id: 'model', name: 'Model', type: 'select', options: [], currentValue: 'default' },
      ],
      modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
    });

    const result = await promise;
    expect(result.sessionId).toBe('sess-loaded');
    expect(result.configOptions.length).toBe(1);
    expect(result.modes?.currentModeId).toBe('code');
    expect(client.getSessionId()).toBe('sess-loaded');

    expect(transport.sendRequest.mock.calls[1]).toEqual([
      'session/load',
      {
        sessionId: 'sess-existing',
        cwd: '/tmp/project',
        mcpServers: [{ type: 'stdio', name: 'test-server', command: 'bun', args: [], env: [] }],
      },
    ]);
  });

  test('resumeSession sends session/resume and falls back to requested session id', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const initPromise = client.initialize();
    transport.resolveRequest(1, {
      protocolVersion: 1,
      agentInfo: { name: 'a', version: '1' },
      agentCapabilities: { sessionCapabilities: { resume: null } },
    });
    await initPromise;

    expect(client.canLoadSession()).toBe(true);

    const promise = client.resumeSession('sess-existing', '/tmp/project');
    transport.resolveRequest(2, { configOptions: [] });

    const result = await promise;
    expect(result.sessionId).toBe('sess-existing');
    expect(client.getSessionId()).toBe('sess-existing');
    expect(transport.sendRequest.mock.calls[1]).toEqual([
      'session/resume',
      { sessionId: 'sess-existing', cwd: '/tmp/project', mcpServers: [] },
    ]);
  });

  test('sendPrompt yields session/update notifications', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const sessionPromise = client.createSession('/tmp');
    transport.resolveRequest(1, { sessionId: 'sess-456' });
    await sessionPromise;

    const gen = client.sendPrompt([{ type: 'text', text: 'hello' }]);

    const nextPromise = gen.next();

    transport.emitNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-456',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } },
      },
    });

    transport.resolveRequest(2, { stopReason: 'end_turn' });

    const updates: unknown[] = [];
    let result = await nextPromise;
    while (!result.done) {
      updates.push(result.value);
      result = await gen.next();
    }

    expect(updates.length).toBe(1);
    expect((updates[0] as { sessionId: string }).sessionId).toBe('sess-456');
    expect((updates[0] as { update: { sessionUpdate: string } }).update.sessionUpdate).toBe(
      'agent_message_chunk'
    );
  });

  test('sendPrompt throws when no session', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const gen = client.sendPrompt([{ type: 'text', text: 'hi' }]);
    await expect(gen.next()).rejects.toThrow('No active session');
  });

  test('sendPrompt propagates request errors', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const sessionPromise = client.createSession('/tmp');
    transport.resolveRequest(1, { sessionId: 'sess-789' });
    await sessionPromise;

    const gen = client.sendPrompt([{ type: 'text', text: 'hello' }]);

    const nextPromise = gen.next();
    transport.resolveError(2, { code: -32600, message: 'Bad prompt' });

    await expect(
      (async () => {
        let result = await nextPromise;
        while (!result.done) {
          result = await gen.next();
        }
      })()
    ).rejects.toThrow('Bad prompt');
  });

  test('sendPrompt terminates when onAccepted throws on the response path (#3743968037)', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const sessionPromise = client.createSession('/tmp');
    transport.resolveRequest(1, { sessionId: 'sess-cb-throw' });
    await sessionPromise;

    const gen = client.sendPrompt([{ type: 'text', text: 'hello' }], {
      onAccepted: () => {
        throw new Error('markMessageAccepted exploded');
      },
    });

    const nextPromise = gen.next();
    transport.resolveRequest(2, { stopReason: 'end_turn' });

    const result = await nextPromise;
    expect(result.done).toBe(true);
  });

  test('sendPrompt keeps acceptance retryable when onAccepted throws on notifications (#3743968037)', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const sessionPromise = client.createSession('/tmp');
    transport.resolveRequest(1, { sessionId: 'sess-cb-retry' });
    await sessionPromise;

    let acceptCalls = 0;
    const gen = client.sendPrompt([{ type: 'text', text: 'hello' }], {
      onAccepted: () => {
        acceptCalls++;
        if (acceptCalls === 1) throw new Error('transient persistence failure');
      },
    });

    const nextPromise = gen.next();

    transport.emitNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-cb-retry',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A' } },
      },
    });
    transport.emitNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-cb-retry',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B' } },
      },
    });

    transport.resolveRequest(2, { stopReason: 'end_turn' });

    const updates: unknown[] = [];
    let result = await nextPromise;
    while (!result.done) {
      updates.push(result.value);
      result = await gen.next();
    }

    expect(updates.length).toBe(2);
    expect(acceptCalls).toBe(2);
  });

  test('cancel sends session/cancel notification', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    const sessionPromise = client.createSession('/tmp');
    transport.resolveRequest(1, { sessionId: 'sess-cancel' });
    await sessionPromise;

    client.cancel();
    expect(transport.sendNotification).toHaveBeenCalledWith('session/cancel', {
      sessionId: 'sess-cancel',
    });
  });

  test('cancel is no-op without session', () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;
    client.cancel();
    expect(transport.sendNotification).not.toHaveBeenCalled();
  });

  test('close closes transport', async () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;
    client.close();
    expect(transport.close).toHaveBeenCalled();
  });

  test('close is idempotent', () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;
    client.close();
    client.close();
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  test('delegates fs/read to onFsRead callback', async () => {
    const onFsRead = mock(async () => ({ content: 'file contents' }));
    const client = new AcpClient({ command: 'acp-agent', onFsRead });
    const transport = lastMockTransport!;

    transport.emitRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'fs/read',
      params: { sessionId: 's1', path: '/tmp/file.txt' },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(onFsRead).toHaveBeenCalledWith({ sessionId: 's1', path: '/tmp/file.txt' });
    expect(transport.sendResponse).toHaveBeenCalledWith(10, { content: 'file contents' });
  });

  test('delegates fs/write to onFsWrite callback', async () => {
    const onFsWrite = mock(async () => ({}));
    const client = new AcpClient({ command: 'acp-agent', onFsWrite });
    const transport = lastMockTransport!;

    transport.emitRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'fs/write',
      params: { sessionId: 's1', path: '/tmp/file.txt', content: 'hello' },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(onFsWrite).toHaveBeenCalledWith({
      sessionId: 's1',
      path: '/tmp/file.txt',
      content: 'hello',
    });
    expect(transport.sendResponse).toHaveBeenCalledWith(11, {});
  });

  test('delegates terminal/create to onTerminalCreate callback', async () => {
    const onTerminalCreate = mock(async () => ({ terminalId: 't1' }));
    const client = new AcpClient({ command: 'acp-agent', onTerminalCreate });
    const transport = lastMockTransport!;

    transport.emitRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'terminal/create',
      params: { sessionId: 's1', command: 'ls' },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(onTerminalCreate).toHaveBeenCalledWith({ sessionId: 's1', command: 'ls' });
    expect(transport.sendResponse).toHaveBeenCalledWith(12, { terminalId: 't1' });
  });

  test('delegates session/request_permission to onPermissionRequest callback', async () => {
    const onPermissionRequest = mock(async () => ({
      outcome: { outcome: 'selected' as const, optionId: 'allow_once' },
    }));
    const client = new AcpClient({ command: 'acp-agent', onPermissionRequest });
    const transport = lastMockTransport!;

    transport.emitRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'session/request_permission',
      params: { sessionId: 's1', toolCall: { toolCallId: 'tc1' }, options: [] },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(onPermissionRequest).toHaveBeenCalled();
    expect(transport.sendResponse).toHaveBeenCalledWith(13, {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  });

  test('returns method not found for unhandled request', () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    transport.emitRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'unknown/method',
      params: {},
    });

    expect(transport.sendErrorResponse).toHaveBeenCalledWith(14, {
      code: -32601,
      message: 'Method not found: unknown/method',
    });
  });

  test('returns internal error when callback throws', async () => {
    const onFsRead = mock(async () => {
      throw new Error('disk full');
    });
    const client = new AcpClient({ command: 'acp-agent', onFsRead });
    const transport = lastMockTransport!;

    transport.emitRequest({
      jsonrpc: '2.0',
      id: 15,
      method: 'fs/read',
      params: { sessionId: 's1', path: '/tmp/file.txt' },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(transport.sendErrorResponse).toHaveBeenCalledWith(15, {
      code: -32603,
      message: 'disk full',
    });
  });

  test('ignores notifications without subscribers', () => {
    const client = new AcpClient({ command: 'acp-agent' });
    const transport = lastMockTransport!;

    transport.emitNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'plan', entries: [] } },
    });
  });
});
