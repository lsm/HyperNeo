import type { CredentialStore } from '../credentials/credential-store.ts';
import {
  connectionStatus,
  connectionTokens,
  type ConnectionStatus,
  type ConnectionTokens,
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

  async read(connection: ConnectionStatus): Promise<ConnectionTokens | null> {
    const stored = await this.store.get(...this.address(connection));
    return stored === null ? null : connectionTokens.parse(JSON.parse(stored));
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
