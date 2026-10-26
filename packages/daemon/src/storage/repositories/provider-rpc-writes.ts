import { stripPersistedDiscovery } from '../../lib/providers/discovery-refresh-pipeline.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { ProviderRepository } from './provider-repository.ts';

class ProviderRpcRepository extends ProviderRepository {
  constructor(
    private readonly authDb: Database,
    private readonly changes?: ReactiveDatabase
  ) {
    super(authDb, changes as ReactiveDatabase);
  }

  stripDiscovery(providerId: string): void {
    const record = this.getProviderByProviderId(providerId);
    if (!record) return;
    const stripped = stripPersistedDiscovery(record.configJson);
    if (stripped !== record.configJson) this.updateProvider(record.id, { configJson: stripped });
  }

  recordAuth(
    providerId: string,
    authType: 'api_key' | 'oauth' | 'none',
    healthStatus: 'unknown' | 'healthy' | 'unhealthy'
  ): void {
    this.authDb
      .prepare(
        `UPDATE providers
         SET auth_type = ?, health_status = ?, updated_at = ?
         WHERE provider_id = ? OR id = ?`
      )
      .run(authType, healthStatus, Date.now(), providerId, providerId);
    this.changes?.notifyChange('providers');
  }
}

export const providerRpcWrites = defineRepositoryOp(
  'providers.rpc.write',
  'write',
  ProviderRpcRepository,
  [
    'createProvider',
    'updateProvider',
    'deleteProvider',
    'setDefaultProvider',
    'stripDiscovery',
    'recordAuth',
  ]
);

export function providerWriter(repository: ProviderRepository) {
  return gatewayFor(repository.getDatabase());
}
