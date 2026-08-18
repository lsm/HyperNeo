import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Session RPC Handlers (API-dependent)', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, 30000);

  afterEach(
    async () => {
      if (daemon) {
        daemon.kill('SIGTERM');
        await daemon.waitForExit();
      }
    },
    { timeout: 15000 }
  );

  function createWebSocketWithFirstMessage(baseUrl: string): {
    ws: WebSocket;
    firstMessagePromise: Promise<unknown>;
  } {
    const wsUrl = baseUrl.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/ws`);

    const firstMessagePromise = new Promise((resolve, reject) => {
      const messageHandler = (event: MessageEvent) => {
        clearTimeout(timer);
        ws.removeEventListener('message', messageHandler);
        ws.removeEventListener('error', errorHandler);
        try {
          const data = JSON.parse(event.data as string);
          resolve(data);
        } catch {
          reject(new Error('Failed to parse WebSocket message'));
        }
      };

      const errorHandler = (error: Event) => {
        clearTimeout(timer);
        ws.removeEventListener('message', messageHandler);
        ws.removeEventListener('error', errorHandler);
        reject(error);
      };

      ws.addEventListener('message', messageHandler);
      ws.addEventListener('error', errorHandler);

      const timer = setTimeout(() => {
        ws.removeEventListener('message', messageHandler);
        ws.removeEventListener('error', errorHandler);
        reject(new Error('No WebSocket message received within 5000ms'));
      }, 5000);
    });

    return { ws, firstMessagePromise };
  }

  async function waitForWebSocketState(ws: WebSocket, state: number): Promise<void> {
    const startTime = Date.now();
    while (ws.readyState !== state) {
      if (Date.now() - startTime > 5000) {
        throw new Error(`WebSocket did not reach state ${state} within 5000ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitForWebSocketMessage(ws: WebSocket, timeout = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const messageHandler = (event: MessageEvent) => {
        clearTimeout(timer);
        ws.removeEventListener('message', messageHandler);
        ws.removeEventListener('error', errorHandler);
        try {
          const data = JSON.parse(event.data as string);
          resolve(data);
        } catch {
          reject(new Error('Failed to parse WebSocket message'));
        }
      };

      const errorHandler = (error: Event) => {
        clearTimeout(timer);
        ws.removeEventListener('message', messageHandler);
        ws.removeEventListener('error', errorHandler);
        reject(error);
      };

      ws.addEventListener('message', messageHandler);
      ws.addEventListener('error', errorHandler);

      const timer = setTimeout(() => {
        ws.removeEventListener('message', messageHandler);
        ws.removeEventListener('error', errorHandler);
        reject(
          new Error(
            `No WebSocket message received within ${timeout}ms (readyState: ${ws.readyState})`
          )
        );
      }, timeout);
    });
  }

  describe('message.send', () => {
    test(
      'should accept message for existing session',
      async () => {
        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath: `${TMP_DIR}/hyperneo-test-message-send-${Date.now()}`,
          title: 'Message Send Test',
          config: { model: 'haiku-4.5' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
        await waitForWebSocketState(ws, WebSocket.OPEN);
        await firstMessagePromise;

        const responsePromise = waitForWebSocketMessage(ws, 12000);

        ws.send(
          JSON.stringify({
            id: 'msg-2',
            type: 'REQ',
            method: 'message.send',
            data: {
              sessionId,
              content: 'Hello, Claude!',
            },
            namespaceId: 'global',
            sessionId: 'global',
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          })
        );

        const response = (await responsePromise) as {
          type: string;
          data: { messageId: string };
          error?: unknown;
        };

        if (response.error) {
          console.error('Error response:', response.error);
        }
        expect(response.type).toBe('RSP');
        expect(response.data.messageId).toBeString();

        ws.close();
      },
      { timeout: 15000 }
    );
  });

  describe('models.list', () => {
    test('should return list of models with cache', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws, 10000);

      ws.send(
        JSON.stringify({
          id: 'models-list-1',
          type: 'REQ',
          method: 'models.list',
          data: {
            useCache: true,
            forceRefresh: false,
          },
          namespaceId: 'global',
          sessionId: 'global',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );

      const response = (await responsePromise) as {
        type: string;
        data: { models: unknown[] };
      };

      expect(response.type).toBe('RSP');
      expect(response.data.models).toBeArray();

      ws.close();
    });

    test('should return list of models without cache', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws, 10000);

      ws.send(
        JSON.stringify({
          id: 'models-list-2',
          type: 'REQ',
          method: 'models.list',
          data: {
            useCache: false,
          },
          namespaceId: 'global',
          sessionId: 'global',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );

      const response = (await responsePromise) as {
        type: string;
        data: { models: unknown[]; cached: boolean };
      };

      expect(response.type).toBe('RSP');
      expect(response.data.models).toBeArray();
      expect(response.data.cached).toBe(false);

      ws.close();
    });

    test('should force refresh cache', async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(daemon.baseUrl);
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws, 10000);

      ws.send(
        JSON.stringify({
          id: 'models-list-3',
          type: 'REQ',
          method: 'models.list',
          data: {
            useCache: true,
            forceRefresh: true,
          },
          namespaceId: 'global',
          sessionId: 'global',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );

      const response = (await responsePromise) as {
        type: string;
        data: { models: unknown[] };
      };

      expect(response.type).toBe('RSP');
      expect(response.data.models).toBeArray();

      ws.close();
    });
  });
});
