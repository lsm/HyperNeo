import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';

interface RemoteConnection {
  readonly hub: MessageHub;
  readonly transport: WebSocketClientTransport;
}

export class RemoteDaemonRegistry {
  private readonly urls = new Map<string, string>();
  private readonly connections = new Map<string, Promise<RemoteConnection>>();

  attach(daemonId: string, url: string): void {
    this.urls.set(daemonId, url);
    this.forget(daemonId);
  }

  private open(daemonId: string, url: string): Promise<RemoteConnection> {
    const existing = this.connections.get(daemonId);
    if (existing) return existing;
    const opening = (async () => {
      const hub = new MessageHub({ defaultSessionId: 'global' });
      const transport = new WebSocketClientTransport({
        url,
        autoReconnect: false,
        pingInterval: 0,
      });
      hub.registerTransport(transport);
      await transport.initialize();
      return { hub, transport };
    })();
    this.connections.set(daemonId, opening);
    opening.catch(() => {
      if (this.connections.get(daemonId) === opening) this.connections.delete(daemonId);
    });
    return opening;
  }

  forget(daemonId: string): void {
    const pending = this.connections.get(daemonId);
    this.connections.delete(daemonId);
    if (!pending) return;
    void pending
      .then(async (connection) => {
        connection.hub.cleanup();
        await connection.transport.close();
      })
      .catch(() => {});
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
