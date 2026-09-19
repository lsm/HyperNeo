import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_PROBE_REQUEST_TIMEOUT_MS = 4000;

interface RemoteConnection {
  readonly hub: MessageHub;
  readonly transport: WebSocketClientTransport;
}

interface RemoteAttempt {
  readonly hub: MessageHub;
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
  private readonly probeRequestTimeoutMs: number;

  constructor(options: { connectTimeoutMs?: number; probeRequestTimeoutMs?: number } = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.probeRequestTimeoutMs = options.probeRequestTimeoutMs ?? DEFAULT_PROBE_REQUEST_TIMEOUT_MS;
  }

  attach(daemonId: string, url: string): void {
    this.urls.set(daemonId, url);
    this.forget(daemonId);
  }

  list(): { daemonId: string; url: string }[] {
    return [...this.urls].map(([daemonId, url]) => ({ daemonId, url }));
  }

  detach(daemonId: string): boolean {
    const wasAttached = this.urls.delete(daemonId);
    this.forget(daemonId);
    return wasAttached;
  }

  private open(daemonId: string, url: string): RemoteAttempt {
    const existing = this.attempts.get(daemonId);
    if (existing) return existing;
    const attempt = this.createAttempt(url);
    this.attempts.set(daemonId, attempt);
    attempt.connection.catch(() => {
      if (this.attempts.get(daemonId) === attempt) this.attempts.delete(daemonId);
      attempt.hub.cleanup();
      void attempt.transport.close();
    });
    return attempt;
  }

  private createAttempt(url: string): RemoteAttempt {
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({ url, autoReconnect: false, pingInterval: 0 });
    hub.registerTransport(transport);
    const opening = transport.initialize();
    opening.catch(() => {});
    const connection = withConnectDeadline(opening, this.connectTimeoutMs, url, () => {
      void transport.close();
    }).then(() => ({ hub, transport }));
    return { hub, transport, connection };
  }

  async probe(url: string): Promise<void> {
    const attempt = this.createAttempt(url);
    try {
      const connection = await attempt.connection;
      await connection.hub.request(
        'operation.invoke',
        { name: 'operations.list', input: {} },
        { timeout: this.probeRequestTimeoutMs }
      );
    } finally {
      attempt.hub.cleanup();
      await attempt.transport.close();
    }
  }

  forget(daemonId: string): void {
    const attempt = this.attempts.get(daemonId);
    if (!attempt) return;
    this.discard(daemonId, attempt);
  }

  private discard(daemonId: string, attempt: RemoteAttempt): void {
    if (this.attempts.get(daemonId) !== attempt) return;
    this.attempts.delete(daemonId);
    void attempt.transport.close();
    attempt.hub.cleanup();
  }

  readonly invoke = async (daemonId: string, name: string, input: unknown): Promise<unknown> => {
    const url = this.urls.get(daemonId);
    if (url === undefined) throw new Error(`No attached daemon: ${daemonId}`);
    const attempt = this.open(daemonId, url);
    const connection = await attempt.connection;
    try {
      return await connection.hub.request('operation.invoke', { name, input });
    } catch (error) {
      this.discard(daemonId, attempt);
      throw error;
    }
  };
}

export const remoteDaemons = new RemoteDaemonRegistry();
