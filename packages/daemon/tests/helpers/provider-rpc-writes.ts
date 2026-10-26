import { bindGateway, type DbGateway } from '../../src/storage/db-gateway/db-gateway';
import type { Database } from '../../src/storage/sqlite-compat';
import type { ProviderRepository } from '../../src/storage/repositories/provider-repository';
import { providerRpcWrites } from '../../src/storage/repositories/provider-rpc-writes';

export function attachProviderWriter(repository: ProviderRepository): void {
  const raw = {} as Database;
  repository.getDatabase = () => raw;
  bindGateway(raw, {
    call: async (op, method, ...args) => {
      if (op !== providerRpcWrites) throw new Error('Unexpected provider writer command');
      const target =
        method === 'stripDiscovery'
          ? providerRpcWrites.Repository.prototype.stripDiscovery
          : (repository as unknown as Record<string, (...input: unknown[]) => unknown>)[method];
      return Reflect.apply(target, repository, args);
    },
  } as unknown as DbGateway);
}
