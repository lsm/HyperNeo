import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WebSocket } from 'undici';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { getProcessingState, sendMessage, waitForIdle } from '../../helpers/daemon-actions';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const MODEL = IS_MOCK ? 'haiku' : 'haiku-4.5';
const IDLE_TIMEOUT = IS_MOCK ? 5000 : 30000;
const SETUP_TIMEOUT = IS_MOCK ? 10000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 150000;

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

describe('AgentSession SDK Integration', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  describe('sendMessage', () => {
    test(
      'should send message and receive real SDK response',
      async () => {
        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath: process.cwd(),
          title: 'Send Message Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const result = await sendMessage(
          daemon,
          sessionId,
          'What is 1+1? Answer with just the number.'
        );

        expect(result.messageId).toBeString();
        expect(result.messageId.length).toBeGreaterThan(0);

        await waitForIdle(daemon, sessionId);

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');
      },
      TEST_TIMEOUT
    );

    test(
      'should handle message with images',
      async () => {
        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath: process.cwd(),
          title: 'Image Message Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const result = await sendMessage(
          daemon,
          sessionId,
          'What color is this image? Answer with just the color name.',
          {
            images: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
                },
              },
            ],
          }
        );

        expect(result.messageId).toBeString();

        await waitForIdle(daemon, sessionId);

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');
      },
      TEST_TIMEOUT
    );
  });

  describe('enqueueMessage', () => {
    test(
      'should enqueue multiple messages in sequence',
      async () => {
        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath: process.cwd(),
          title: 'Enqueue Messages Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');

        await waitForIdle(daemon, sessionId);

        const result = await sendMessage(daemon, sessionId, 'What is 3+3? Just the number.');

        expect(result.messageId).toBeString();
        expect(result.messageId.length).toBeGreaterThan(0);

        await waitForIdle(daemon, sessionId);
      },
      TEST_TIMEOUT
    );
  });

  describe('handleInterrupt', () => {
    test(
      'should interrupt ongoing processing',
      async () => {
        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath: process.cwd(),
          title: 'Interrupt Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');
        await waitForIdle(daemon, sessionId);

        await daemon.messageHub.request('client.interrupt', { sessionId });

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');
      },
      TEST_TIMEOUT
    );
  });

  describe.skip('WebSocket SDK message events (DEPRECATED - uses old SUBSCRIBE protocol)', () => {
    test(
      'should broadcast sdk.message events via WebSocket',
      async () => {
        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath: process.cwd(),
          title: 'WebSocket Events Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
          daemon.baseUrl,
          sessionId
        );
        await waitForWebSocketState(ws, 1);
        await firstMessagePromise;

        const subPromise = waitForWebSocketMessage(ws);
        ws.send(
          JSON.stringify({
            id: 'sub-sdk-1',
            type: 'SUBSCRIBE',
            method: 'state.sdkMessages.delta',
            sessionId,
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          })
        );
        await subPromise;

        const sdkEventPromise = waitForWebSocketMessage(ws, 10000);

        await sendMessage(daemon, sessionId, 'Say hello. Just respond "Hello".');

        const sdkEvent = (await sdkEventPromise) as Record<string, unknown>;

        expect(sdkEvent.type).toBe('EVENT');
        expect(sdkEvent.method).toBe('state.sdkMessages.delta');
        expect(sdkEvent.data).toBeDefined();

        ws.close();
      },
      TEST_TIMEOUT
    );
  });

  describe('State transitions', () => {
    test(
      'should transition through processing states',
      async () => {
        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath: process.cwd(),
          title: 'State Transitions Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const initialState = await getProcessingState(daemon, sessionId);
        expect(initialState.status).toBe('idle');

        await sendMessage(daemon, sessionId, 'What is 5+5? Just the number.');

        const stateAfterSend = await getProcessingState(daemon, sessionId);
        expect(['queued', 'processing', 'idle']).toContain(stateAfterSend.status);

        await waitForIdle(daemon, sessionId);

        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe('idle');
      },
      TEST_TIMEOUT
    );

    test(
      'should handle multiple messages in sequence',
      async () => {
        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath: process.cwd(),
          title: 'Multiple Messages Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        const result1 = await sendMessage(daemon, sessionId, 'Count to 1');
        await waitForIdle(daemon, sessionId);

        const result2 = await sendMessage(daemon, sessionId, 'Count to 2');

        expect(result1.messageId).toBeString();
        expect(result2.messageId).toBeString();
        expect(result1.messageId).not.toBe(result2.messageId);

        await waitForIdle(daemon, sessionId);
      },
      TEST_TIMEOUT
    );
  });

  describe('session.interrupted event', () => {
    test(
      'should handle interrupt gracefully on active session',
      async () => {
        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath: process.cwd(),
          title: 'Interrupt Event Test',
          config: { model: MODEL, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');
        await waitForIdle(daemon, sessionId);

        const state1 = await getProcessingState(daemon, sessionId);
        expect(state1.status).toBe('idle');

        await daemon.messageHub.request('client.interrupt', { sessionId });

        const state2 = await getProcessingState(daemon, sessionId);
        expect(state2.status).toBe('idle');

        await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');
        await waitForIdle(daemon, sessionId);
      },
      TEST_TIMEOUT
    );
  });
});
