import { stripPersistedDiscovery } from '../../lib/providers/discovery-refresh-pipeline.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp, defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { ProviderRepository } from './provider-repository.ts';

class ProviderRpcRepository extends ProviderRepository {
  constructor(db: Database, changes?: ReactiveDatabase) {
    super(db, changes as ReactiveDatabase);
  }

  stripDiscovery(providerId: string): void {
    const record = this.getProviderByProviderId(providerId);
    if (!record) return;
    const stripped = stripPersistedDiscovery(record.configJson);
    if (stripped !== record.configJson) this.updateProvider(record.id, { configJson: stripped });
  }
}

export const providerRpcWrites = defineRepositoryOp(
  'providers.rpc.write',
  'write',
  ProviderRpcRepository,
  ['createProvider', 'updateProvider', 'deleteProvider', 'setDefaultProvider', 'stripDiscovery']
);

export function providerWriter(repository: ProviderRepository) {
  return gatewayFor(repository.getDatabase());
}

export const recordProviderAuth = defineDbOp<
  {
    providerId: string;
    authType: 'api_key' | 'oauth' | 'none';
    healthStatus: 'unknown' | 'healthy' | 'unhealthy';
  },
  void
>({
  name: 'providers.recordAuth',
  mode: 'write',
  run(db, { providerId, authType, healthStatus }, changes) {
    db.prepare(
      `UPDATE providers
         SET auth_type = ?, health_status = ?, updated_at = ?
         WHERE provider_id = ? OR id = ?`
    ).run(authType, healthStatus, Date.now(), providerId, providerId);
    changes.notifyChange('providers');
  },
});
