import { hostname } from 'node:os';
import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import { createHyperneoAdapter } from '../../drivers/hyperneo-adapter.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerDriverOperations(context: FamilyOperationContext): OperationDefinition[] {
  const adapters = [
    createHyperneoAdapter({
      db: () => context.deps.db.getDatabase(),
      machine: hostname(),
      searchSessionIds: (text) =>
        new Set(
          context.deps.db
            .getSDKMessageRepo()
            .searchMessages({ query: text, limit: 50 })
            .results.flatMap((result) => (result.sessionId ? [result.sessionId] : []))
        ),
    }),
  ];
  return [createFindWorkOperation({ adapters: () => adapters, remote: remoteDaemons })];
}
