import { describe, test, expect } from 'bun:test';
import { MessageHub } from '../src/message-hub/message-hub';
import type { IMessageTransport, ConnectionState, CallContext } from '../src/message-hub/types';
import type { HubMessage } from '../src/message-hub/types';
import { createRequestMessage } from '../src/message-hub/protocol';
import type { HubMessageWithMetadata } from '../src/message-hub/protocol';

class MockTransport implements IMessageTransport {
  readonly name = 'mock-transport';
  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private stateHandlers: Set<(state: ConnectionState) => void> = new Set();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async send(_message: HubMessage): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  getState(): ConnectionState {
    return 'connected';
  }
  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }
  onConnectionChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  inject(message: HubMessage): void {
    for (const h of this.messageHandlers) {
      h(message);
    }
  }
}

function buildHubWithTransport(): { hub: MessageHub; transport: MockTransport } {
  const transport = new MockTransport();
  const hub = new MessageHub({ defaultSessionId: 'global' });
  hub.registerTransport(transport);
  return { hub, transport };
}

describe('CallContext.clientId', () => {
  test('clientId is present in CallContext when message carries a clientId (WebSocket-like)', async () => {
    const { hub, transport } = buildHubWithTransport();

    const handlerCalled = new Promise<CallContext>((resolve) => {
      hub.onRequest('test.method', (_data, ctx) => {
        resolve(ctx);
        return { ok: true };
      });
    });

    const req = createRequestMessage({
      method: 'test.method',
      data: {},
      sessionId: 'global',
    }) as HubMessageWithMetadata;
    req.clientId = 'ws-client-abc';

    transport.inject(req);

    const capturedContext = await handlerCalled;
    expect(capturedContext.clientId).toBe('ws-client-abc');

    hub.cleanup();
  });

  test('clientId is absent in CallContext when message has no clientId (in-process call)', async () => {
    const { hub, transport } = buildHubWithTransport();

    const handlerCalled = new Promise<CallContext>((resolve) => {
      hub.onRequest('test.method', (_data, ctx) => {
        resolve(ctx);
        return { ok: true };
      });
    });

    const req = createRequestMessage({
      method: 'test.method',
      data: {},
      sessionId: 'global',
    });

    transport.inject(req);

    const capturedContext = await handlerCalled;
    expect(capturedContext.clientId).toBeUndefined();

    hub.cleanup();
  });
});
