import { hostname } from 'node:os';
import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import { createSpaceAdapter } from '../../drivers/space-adapter.ts';
import { createWorkVerbOperations } from '../../drivers/work-operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerDriverOperations(context: FamilyOperationContext): OperationDefinition[] {
  const search = (text: string) =>
    context.deps.db.getSDKMessageRepo().searchMessages({ query: text, limit: 50 }).results;
  const adapters = [
    createSpaceAdapter({
      db: () => context.deps.db.getDatabase(),
      machine: hostname(),
      searchTaskIds: (text) =>
        new Set(search(text).flatMap((result) => (result.taskId ? [result.taskId] : []))),
    }),
  ];
  const deps = { adapters: () => adapters, remote: remoteDaemons };
  return [createFindWorkOperation(deps), ...createWorkVerbOperations(deps)];
}
