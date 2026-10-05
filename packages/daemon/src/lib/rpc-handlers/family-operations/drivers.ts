import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import type { WorkAdapter } from '../../drivers/types.ts';
import { createWorkVerbOperations } from '../../drivers/work-operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';

export function registerDriverOperations(): OperationDefinition[] {
  const adapters: WorkAdapter[] = [];
  const deps = { adapters: () => adapters, remote: remoteDaemons };
  return [createFindWorkOperation(deps), ...createWorkVerbOperations(deps)];
}
