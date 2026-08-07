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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Wait for next WebSocket message
 *
 * Uses a per-connection message queue so that messages arriving between
 * consecutive `waitForWebSocketMessage` calls are buffered rather than
 * dropped. Without this, rapid concurrent RPC responses can arrive in the
 * microtask gap between the previous promise resolving and the next
 * `addEventListener` call, causing intermittent timeouts (especially under
 * Node's native WebSocket, which delivers frames on a different cadence
 * than Bun's).
 */
const messageQueues = new WeakMap<
  WebSocket,
  {
    queue: unknown[];
    resolvers: Array<(v: Record<string, unknown>) => void>;
    rejecters: Array<(e: Error) => void>;
  }
>();

function ensureQueue(ws: WebSocket): {
  queue: unknown[];
  resolvers: Array<(v: Record<string, unknown>) => void>;
  rejecters: Array<(e: Error) => void>;
} {
  let entry = messageQueues.get(ws);
  if (!entry) {
    entry = { queue: [], resolvers: [], rejecters: [] };
    messageQueues.set(ws, entry);
    const persistentHandler = (event: MessageEvent) => {
      const e = messageQueues.get(ws);
      if (!e) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        parsed = { _parseError: true, raw: event.data };
      }
      // If a waiter is waiting, resolve it directly; otherwise buffer.
      const resolver = e.resolvers.shift();
      if (resolver) {
        e.rejecters.shift();
        resolver(parsed);
      } else {
        e.queue.push(parsed);
      }
    };
    const persistentErrorHandler = (error: Event) => {
      const e = messageQueues.get(ws);
      if (!e) return;
      const rejecter = e.rejecters.shift();
      if (rejecter) {
        e.resolvers.shift();
        rejecter(new Error(`WebSocket error: ${JSON.stringify(error)}`));
      }
    };
    ws.addEventListener('message', persistentHandler);
    ws.addEventListener('error', persistentErrorHandler);
  }
  return entry;
}

export async function waitForWebSocketMessage(
  ws: WebSocket,
  timeout = 5000
): Promise<Record<string, unknown>> {
  const entry = ensureQueue(ws);

  // If a buffered message is already waiting, drain it immediately.
  if (entry.queue.length > 0) {
    const msg = entry.queue.shift() as Record<string, unknown>;
    return msg;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove our resolver/rejecter from the pending lists on timeout.
      const idx = entry.resolvers.indexOf(resolve);
      if (idx >= 0) {
        entry.resolvers.splice(idx, 1);
        entry.rejecters.splice(idx, 1);
      }
      reject(
        new Error(
          `No WebSocket message received within ${timeout}ms (readyState: ${ws.readyState})`
        )
      );
    }, timeout);

    // Wrap resolve/reject so the timer is cleared when fulfilled.
    entry.resolvers.push((v: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(v);
    });
    entry.rejecters.push((e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
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
