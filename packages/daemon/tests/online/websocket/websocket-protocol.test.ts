import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import {
  createWebSocket,
  createWebSocketWithFirstMessage,
  waitForWebSocketState,
  waitForWebSocketMessage,
  sendRPCCall,
} from '../../helpers/websocket-helpers';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const SETUP_TIMEOUT = IS_MOCK ? 15000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 15000 : 30000;

describe('WebSocket Protocol', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (daemon) {
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  describe('Connection Lifecycle', () => {
    test('should establish WebSocket connection', async () => {
      const ws = createWebSocket(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);

      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
      await waitForWebSocketState(ws, WebSocket.CLOSED);
    });

    test('should send connection.established event on connect', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);

      const message = await firstMessagePromise;

      expect(message.type).toBe('EVENT');
      expect(message.method).toBe('connection.established');
      expect((message.data as Record<string, unknown>).message).toBe(
        'WebSocket connection established'
      );
      expect((message.data as Record<string, unknown>).protocol).toBe('MessageHub');
      expect((message.data as Record<string, unknown>).version).toBe('1.0.0');

      ws.close();
    });

    test(
      'should handle multiple concurrent connections',
      async () => {
        const ws1 = createWebSocket(daemon.baseUrl);
        const ws2 = createWebSocket(daemon.baseUrl);
        const ws3 = createWebSocket(daemon.baseUrl);

        await Promise.all([
          waitForWebSocketState(ws1, WebSocket.OPEN),
          waitForWebSocketState(ws2, WebSocket.OPEN),
          waitForWebSocketState(ws3, WebSocket.OPEN),
        ]);

        expect(ws1.readyState).toBe(WebSocket.OPEN);
        expect(ws2.readyState).toBe(WebSocket.OPEN);
        expect(ws3.readyState).toBe(WebSocket.OPEN);

        await new Promise((resolve) => setTimeout(resolve, 100));

        sendRPCCall(ws1, 'session.list');
        sendRPCCall(ws2, 'session.list');
        sendRPCCall(ws3, 'session.list');

        const getResult = async (ws: WebSocket) => {
          while (true) {
            const msg = await waitForWebSocketMessage(ws, 10000);
            if (msg.type === 'RSP') return msg;
          }
        };

        const [r1, r2, r3] = await Promise.all([getResult(ws1), getResult(ws2), getResult(ws3)]);

        expect(r1.type).toBe('RSP');
        expect(r2.type).toBe('RSP');
        expect(r3.type).toBe('RSP');

        ws1.close();
        ws2.close();
        ws3.close();
      },
      TEST_TIMEOUT
    );

    test('should handle client disconnection without affecting other clients', async () => {
      const ws1 = createWebSocket(daemon.baseUrl);
      const ws2 = createWebSocket(daemon.baseUrl);

      await Promise.all([
        waitForWebSocketState(ws1, WebSocket.OPEN),
        waitForWebSocketState(ws2, WebSocket.OPEN),
      ]);

      ws1.close();
      await waitForWebSocketState(ws1, WebSocket.CLOSED);

      await new Promise((resolve) => setTimeout(resolve, 100));
      sendRPCCall(ws2, 'session.list');

      let response: Record<string, unknown>;
      while (true) {
        response = await waitForWebSocketMessage(ws2);
        if (response.type === 'RSP') break;
      }

      expect(response.type).toBe('RSP');

      ws2.close();
    });
  });

  describe('Ping/Pong Heartbeat', () => {
    test('should respond to ping with pong', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: 'ping-1',
          type: 'ping',
          namespaceId: 'global',
          sessionId: 'global',
          method: 'heartbeat',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );

      const response = await responsePromise;

      expect(response.type).toBe('PONG');
      expect(response.requestId).toBe('ping-1');
      expect(response.method).toBe('heartbeat');

      ws.close();
    });

    test('should respond to PING (uppercase) with pong', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: 'ping-2',
          type: 'PING',
          namespaceId: 'global',
          sessionId: 'global',
          method: 'heartbeat',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );

      const response = await responsePromise;

      expect(response.type).toBe('PONG');
      expect(response.requestId).toBe('ping-2');

      ws.close();
    });
  });

  describe('RPC Call/Response', () => {
    test('should handle RPC call/response with correct correlation', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const messageId = sendRPCCall(ws, 'session.list');

      const response = await waitForWebSocketMessage(ws);

      expect(response.type).toBe('RSP');
      expect(response.requestId).toBe(messageId);
      expect((response.data as Record<string, unknown>).sessions).toBeInstanceOf(Array);

      ws.close();
    });

    test('should handle concurrent RPC calls with correct correlation', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const id1 = sendRPCCall(ws, 'session.list');
      const id2 = sendRPCCall(ws, 'session.list');
      const id3 = sendRPCCall(ws, 'session.list');

      const responses = [];
      for (let i = 0; i < 3; i++) {
        responses.push(await waitForWebSocketMessage(ws));
      }

      expect(responses.length).toBe(3);
      expect(responses.every((r) => r.type === 'RSP')).toBe(true);

      const receivedIds = responses.map((r) => r.requestId);
      expect(receivedIds).toContain(id1);
      expect(receivedIds).toContain(id2);
      expect(receivedIds).toContain(id3);

      ws.close();
    });

    test(
      'should handle many concurrent calls',
      async () => {
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
        await waitForWebSocketState(ws, WebSocket.OPEN);
        await firstMessagePromise;

        const count = 50;
        for (let i = 0; i < count; i++) {
          sendRPCCall(ws, 'session.list');
        }

        const responses = [];
        for (let i = 0; i < count; i++) {
          responses.push(await waitForWebSocketMessage(ws, TEST_TIMEOUT));
        }

        const successCount = responses.filter((r) => r.type === 'RSP').length;
        expect(successCount).toBe(count);

        ws.close();
      },
      TEST_TIMEOUT
    );
  });

  describe('Error Handling', () => {
    test('should return error for non-existent RPC method', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const messageId = sendRPCCall(ws, 'non.existent.method');

      const response = await waitForWebSocketMessage(ws);

      expect(response.type).toBe('RSP');
      expect(response.requestId).toBe(messageId);
      expect(response.error).toBeDefined();
      expect(response.error).toContain('No handler');

      ws.close();
    });

    test('should return SESSION_NOT_FOUND for non-existent session', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: 'test-1',
          type: 'REQ',
          method: 'message.send',
          data: { content: 'test' },
          sessionId: 'non-existent-session-id',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );

      const response = await responsePromise;

      expect(response.type).toBe('RSP');
      expect(response.error).toBeDefined();
      expect(response.errorCode).toBe('SESSION_NOT_FOUND');

      ws.close();
    });

    test('should handle invalid JSON gracefully', async () => {
      const ws = createWebSocket(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);

      ws.send('invalid json {{{');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const ws2 = createWebSocket(daemon.baseUrl);
      await waitForWebSocketState(ws2, WebSocket.OPEN);
      expect(ws2.readyState).toBe(WebSocket.OPEN);

      ws.close();
      ws2.close();
    });

    test('should default to global sessionId', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: 'test-1',
          type: 'REQ',
          method: 'session.list',
          data: {},
          namespaceId: 'global',
          sessionId: 'global',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );

      const response = await responsePromise;

      expect(response.type).toBe('RSP');
      expect((response.data as Record<string, unknown>).sessions).toBeInstanceOf(Array);

      ws.close();
    });

    test('should accept messages smaller than 50MB', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: 'normal-1',
          type: 'REQ',
          method: 'session.list',
          data: {},
          namespaceId: 'global',
          sessionId: 'global',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );

      const response = await responsePromise;
      expect(response.type).toBe('RSP');

      ws.close();
    });
  });

  describe('Session Operations via Raw WebSocket', () => {
    test('should create session via WebSocket RPC', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const messageId = sendRPCCall(ws, 'session.create', {
        workspacePath: '/test/ws-protocol',
      });

      let response: Record<string, unknown>;
      let attempts = 0;
      while (attempts < 10) {
        response = await waitForWebSocketMessage(ws);
        if (response.type === 'RSP' && response.requestId === messageId) break;
        attempts++;
      }

      expect(response!.type).toBe('RSP');
      expect((response!.data as Record<string, unknown>).sessionId).toBeString();

      const sessionId = (response!.data as Record<string, unknown>).sessionId as string;
      const getResult = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: Record<string, unknown> };

      expect(getResult.session).toBeDefined();
      expect(getResult.session.workspacePath).toBe('/test/ws-protocol');

      daemon.trackSession(sessionId);

      ws.close();
    });

    test('should get RPC error for non-existent session.get', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const messageId = sendRPCCall(ws, 'session.get', {
        sessionId: 'non-existent-id',
      });

      const response = await waitForWebSocketMessage(ws);

      expect(response.type).toBe('RSP');
      expect(response.requestId).toBe(messageId);
      expect(response.error).toBeDefined();
      expect(response.error).toContain('not found');

      ws.close();
    });
  });
});
