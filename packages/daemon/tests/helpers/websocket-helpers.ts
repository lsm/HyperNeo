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

  if (entry.queue.length > 0) {
    const msg = entry.queue.shift() as Record<string, unknown>;
    return msg;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
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
