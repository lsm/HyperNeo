import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';

export class RemoteDaemonRegistry {
  private readonly urls = new Map<string, string>();
  private readonly connections = new Map<string, Promise<MessageHub>>();

  attach(daemonId: string, url: string): void {
    this.urls.set(daemonId, url);
    this.connections.delete(daemonId);
  }

  private open(daemonId: string, url: string): Promise<MessageHub> {
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
      return hub;
    })();
    this.connections.set(daemonId, opening);
    opening.catch(() => this.forget(daemonId));
    return opening;
  }

  forget(daemonId: string): void {
    this.connections.delete(daemonId);
  }

  readonly invoke = async (daemonId: string, name: string, input: unknown): Promise<unknown> => {
    const url = this.urls.get(daemonId);
    if (url === undefined) throw new Error(`No attached daemon: ${daemonId}`);
    const hub = await this.open(daemonId, url);
    try {
      return await hub.request('operation.invoke', { name, input });
    } catch (error) {
      this.forget(daemonId);
      throw error;
    }
  };
}

export const remoteDaemons = new RemoteDaemonRegistry();
