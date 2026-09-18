import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

interface RemoteConnection {
  readonly hub: MessageHub;
  readonly transport: WebSocketClientTransport;
}

interface RemoteAttempt {
  readonly transport: WebSocketClientTransport;
  readonly connection: Promise<RemoteConnection>;
}

async function withConnectDeadline<T>(
  opening: Promise<T>,
  timeoutMs: number,
  url: string,
  abandon: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandon();
      reject(new Error(`Timed out connecting to ${url} after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([opening, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class RemoteDaemonRegistry {
  private readonly urls = new Map<string, string>();
  private readonly attempts = new Map<string, RemoteAttempt>();
  private readonly connectTimeoutMs: number;

  constructor(options: { connectTimeoutMs?: number } = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  attach(daemonId: string, url: string): void {
    this.urls.set(daemonId, url);
    this.forget(daemonId);
  }

  private open(daemonId: string, url: string): Promise<RemoteConnection> {
    const existing = this.attempts.get(daemonId);
    if (existing) return existing.connection;
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({ url, autoReconnect: false, pingInterval: 0 });
    hub.registerTransport(transport);
    const opening = transport.initialize();
    opening.catch(() => {});
    const connection = withConnectDeadline(opening, this.connectTimeoutMs, url, () => {
      void transport.close();
    }).then(() => ({ hub, transport }));
    const attempt: RemoteAttempt = { transport, connection };
    this.attempts.set(daemonId, attempt);
    connection.catch(() => {
      if (this.attempts.get(daemonId) === attempt) this.attempts.delete(daemonId);
      hub.cleanup();
      void transport.close();
    });
    return connection;
  }

  forget(daemonId: string): void {
    const attempt = this.attempts.get(daemonId);
    this.attempts.delete(daemonId);
    if (!attempt) return;
    void attempt.transport.close();
    void attempt.connection.then((connection) => connection.hub.cleanup()).catch(() => {});
  }

  readonly invoke = async (daemonId: string, name: string, input: unknown): Promise<unknown> => {
    const url = this.urls.get(daemonId);
    if (url === undefined) throw new Error(`No attached daemon: ${daemonId}`);
    const connection = await this.open(daemonId, url);
    try {
      return await connection.hub.request('operation.invoke', { name, input });
    } catch (error) {
      this.forget(daemonId);
      throw error;
    }
  };
}

export const remoteDaemons = new RemoteDaemonRegistry();
