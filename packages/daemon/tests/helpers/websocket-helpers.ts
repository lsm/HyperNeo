/**
 * Raw WebSocket helpers for protocol-level tests
 *
 * These helpers create raw WebSocket connections (bypassing MessageHub)
 * to test the WebSocket protocol layer directly: ping/pong, connection handling,
 * large message rejection, error responses, etc.
 *
 * For RPC-level tests, use daemon.messageHub.request() instead.
 */

/**
 * Create raw WebSocket connection to daemon server
 */
export function createWebSocket(baseUrl: string): WebSocket {
  const wsUrl = baseUrl.replace('http://', 'ws://');
  const ws = new WebSocket(`${wsUrl}/ws`);

  ws.addEventListener('error', (error) => {
    if (process.env.TEST_VERBOSE) {
      console.error('WebSocket error in test:', error);
    }
  });

  return ws;
}

/**
 * Create raw WebSocket and return a promise for the first message (connection.established)
 */
export function createWebSocketWithFirstMessage(
  baseUrl: string,
  timeout = 5000
): { ws: WebSocket; firstMessagePromise: Promise<Record<string, unknown>> } {
  const wsUrl = baseUrl.replace('http://', 'ws://');
  const ws = new WebSocket(`${wsUrl}/ws`);

  const firstMessagePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const messageHandler = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener('message', messageHandler);
      ws.removeEventListener('error', errorHandler);
      try {
        resolve(JSON.parse(event.data as string));
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
      reject(new Error(`No WebSocket message received within ${timeout}ms`));
    }, timeout);
  });

  return { ws, firstMessagePromise };
}

/**
 * Wait for WebSocket to reach a specific readyState
 */
export async function waitForWebSocketState(
  ws: WebSocket,
  state: number,
  timeout = 5000
): Promise<void> {
  const startTime = Date.now();
  while (ws.readyState !== state) {
    if (Date.now() - startTime > timeout) {
      throw new Error(`WebSocket did not reach state ${state} within ${timeout}ms`);
    }
    await Bun.sleep(10);
  }
}

/**
 * Wait for next WebSocket message
 */
export async function waitForWebSocketMessage(
  ws: WebSocket,
  timeout = 5000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const messageHandler = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener('message', messageHandler);
      ws.removeEventListener('error', errorHandler);
      try {
        resolve(JSON.parse(event.data as string));
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

/**
 * Send raw RPC call via WebSocket and return message ID
 */
export function sendRPCCall(
  ws: WebSocket,
  method: string,
  data: unknown = {},
  sessionId = 'global'
): string {
  const messageId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ws.send(
    JSON.stringify({
      id: messageId,
      type: 'REQ',
      method,
      data,
      sessionId,
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    })
  );
  return messageId;
}
