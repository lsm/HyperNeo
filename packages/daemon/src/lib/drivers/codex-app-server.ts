import WebSocket from 'ws';

const CALL_TIMEOUT_MS = 30_000;

export interface CodexAppServer {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function connectCodexAppServer(socketPath: string): Promise<CodexAppServer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws+unix://${socketPath}:/`);
    const pending = new Map<number, Pending>();
    let nextId = 1;
    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<unknown>((resolveCall, rejectCall) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error(`${method} got no answer from the Codex app-server.`));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { method, resolve: resolveCall, reject: rejectCall, timer });
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    socket.on('message', (data) => {
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      const waiting = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (!waiting || typeof message.id !== 'number') return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error !== undefined) {
        waiting.reject(new Error(`${waiting.method}: ${JSON.stringify(message.error)}`));
      } else {
        waiting.resolve(message.result);
      }
    });
    socket.on('close', () => {
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error('The Codex app-server closed the connection.'));
      }
      pending.clear();
    });
    socket.on('error', reject);
    socket.on('open', async () => {
      try {
        await call('initialize', {
          clientInfo: { name: 'hyperneo', title: 'HyperNeo', version: '1' },
        });
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
        resolve({ call, close: () => socket.close() });
      } catch (error) {
        socket.close();
        reject(error);
      }
    });
  });
}
