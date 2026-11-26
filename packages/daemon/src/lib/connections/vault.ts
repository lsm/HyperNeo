import type { CredentialStore } from '../credentials/credential-store.ts';
import {
  connectionStatus,
  connectionTokens,
  mcpGrant,
  type ConnectionStatus,
  type ConnectionTokens,
  type McpGrant,
} from './status.ts';

export class ConnectionVault {
  constructor(
    private readonly store: CredentialStore,
    private readonly daemonId: string
  ) {
    if (!daemonId) throw new Error('Connection vault requires a persisted daemon identity');
  }

  private address(connection: ConnectionStatus): [string, string] {
    const { id, accountId, provider } = connectionStatus.parse(connection);
    return [
      `hyperneo.connection.${encodeURIComponent(this.daemonId)}.${provider}.${encodeURIComponent(id)}`,
      JSON.stringify([accountId, 'main']),
    ];
  }

  private mcpAddress(serverId: string): [string, string] {
    if (!serverId) throw new Error('MCP grant requires a server id');
    return [
      `hyperneo.connection.${encodeURIComponent(this.daemonId)}.mcp.${encodeURIComponent(serverId)}`,
      JSON.stringify([serverId, 'main']),
    ];
  }

  private async load(address: [string, string]): Promise<unknown> {
    const stored = await this.store.get(...address);
    const status = this.storageStatus();
    if (stored === null && status.backend.startsWith('keychain') && !status.keychainAvailable)
      throw new Error('Connection vault is unavailable');
    return stored === null ? null : JSON.parse(stored);
  }

  async read(connection: ConnectionStatus): Promise<ConnectionTokens | null> {
    const stored = await this.load(this.address(connection));
    return stored === null ? null : connectionTokens.parse(stored);
  }

  async readMcp(serverId: string): Promise<McpGrant | null> {
    const stored = await this.load(this.mcpAddress(serverId));
    return stored === null ? null : mcpGrant.parse(stored);
  }

  async replaceMcp(serverId: string, grant: McpGrant): Promise<void> {
    const [service, account] = this.mcpAddress(serverId);
    await this.store.set(service, account, JSON.stringify(mcpGrant.parse(grant)));
  }

  async replace(connection: ConnectionStatus, tokens: ConnectionTokens): Promise<void> {
    const [service, account] = this.address(connection);
    await this.store.set(service, account, JSON.stringify(connectionTokens.parse(tokens)));
  }

  async remove(connection: ConnectionStatus): Promise<void> {
    await this.store.delete(...this.address(connection));
  }

  storageStatus() {
    return this.store.getStatus?.() ?? { backend: 'database' as const, keychainAvailable: false };
  }
}
