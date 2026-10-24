import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';
import NodeWebSocket from 'ws';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_PROBE_REQUEST_TIMEOUT_MS = 4000;
const CONNECT_FAILURE_MEMORY_MS = 60_000;

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

export interface DaemonAttachment {
  daemonId: string;
  url: string;
}

export interface RemoteDaemonSecrets {
  save(daemonId: string, url: string, credential: string, now: number): Promise<void>;
  credentialFor(daemonId: string, url: string): string | null;
  remove(daemonId: string): Promise<void>;
}

export class RemoteDaemonRegistry {
  private readonly urls = new Map<string, string>();
  private persist: ((attachments: DaemonAttachment[]) => void) | null = null;
  private secrets: RemoteDaemonSecrets | null = null;
  private readonly attempts = new Map<string, RemoteAttempt>();
  private readonly connectFailures = new Map<string, { at: number; reason: string }>();
  private readonly connectTimeoutMs: number;
  private readonly probeRequestTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    options: { connectTimeoutMs?: number; probeRequestTimeoutMs?: number; now?: () => number } = {}
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.probeRequestTimeoutMs = options.probeRequestTimeoutMs ?? DEFAULT_PROBE_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  restore(
    attachments: readonly DaemonAttachment[],
    persist: (attachments: DaemonAttachment[]) => void,
    secrets: RemoteDaemonSecrets
  ): void {
    for (const { daemonId, url } of attachments) this.urls.set(daemonId, url);
    this.persist = persist;
    this.secrets = secrets;
  }

  async attach(daemonId: string, url: string, credential?: string): Promise<void> {
    if (credential) await this.secrets?.save(daemonId, url, credential, this.now());
    this.urls.set(daemonId, url);
    this.forget(daemonId);
    this.persist?.(this.list());
  }

  list(): DaemonAttachment[] {
    return [...this.urls].map(([daemonId, url]) => ({ daemonId, url }));
  }

  async detach(daemonId: string): Promise<boolean> {
    await this.secrets?.remove(daemonId);
    const wasAttached = this.urls.delete(daemonId);
    this.forget(daemonId);
    if (wasAttached) this.persist?.(this.list());
    return wasAttached;
  }

  private open(daemonId: string, url: string): RemoteAttempt {
    const existing = this.attempts.get(daemonId);
    if (existing) return existing;
    const attempt = this.createAttempt(url, this.secrets?.credentialFor(daemonId, url) ?? null);
    this.attempts.set(daemonId, attempt);
    attempt.connection
      .then(() =>
        attempt.transport.onConnectionChange((state) => {
          if (state !== 'connected') this.discard(daemonId, attempt);
        })
      )
      .catch(() => {});
    attempt.connection.catch((error: unknown) => {
      if (this.attempts.get(daemonId) === attempt) {
        this.attempts.delete(daemonId);
        this.connectFailures.set(daemonId, {
          at: this.now(),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      attempt.hub.cleanup();
      void attempt.transport.close();
    });
    return attempt;
  }

  private createAttempt(url: string, credential: string | null): RemoteAttempt {
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({
      url,
      autoReconnect: false,
      pingInterval: 0,
      ...(credential
        ? {
            createSocket: (socketUrl: string) =>
              new NodeWebSocket(socketUrl, {
                headers: { authorization: `Bearer ${credential}` },
              }) as unknown as WebSocket,
          }
        : {}),
    });
    hub.registerTransport(transport);
    const opening = transport.initialize();
    opening.catch(() => {});
    const connection = withConnectDeadline(opening, this.connectTimeoutMs, url, () => {
      void transport.close();
    }).then(() => ({ hub, transport }));
    return { hub, transport, connection };
  }

  async probe(url: string): Promise<void> {
    const attempt = this.createAttempt(url, null);
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
    this.connectFailures.delete(daemonId);
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

  readonly invoke = async (
    daemonId: string,
    name: string,
    input: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown> => this.request(daemonId, 'operation.invoke', { name, input }, options);

  readonly request = async (
    daemonId: string,
    method: string,
    data: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown> => {
    const url = this.urls.get(daemonId);
    if (url === undefined) throw new Error(`No attached daemon: ${daemonId}`);
    const failed = this.connectFailures.get(daemonId);
    if (failed && this.now() - failed.at < CONNECT_FAILURE_MEMORY_MS)
      throw new Error(`${failed.reason} (not retried for ${CONNECT_FAILURE_MEMORY_MS / 1000}s)`);
    const attempt = this.open(daemonId, url);
    const connection = await attempt.connection;
    try {
      return await connection.hub.request(
        method,
        data,
        options?.timeoutMs ? { timeout: options.timeoutMs } : undefined
      );
    } catch (error) {
      this.discard(daemonId, attempt);
      throw error;
    }
  };
}

export const remoteDaemons = new RemoteDaemonRegistry();
