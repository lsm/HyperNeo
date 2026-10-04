import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import type { WorkAdapter } from '../../drivers/types.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';

export function registerDriverOperations(): OperationDefinition[] {
  const adapters: WorkAdapter[] = [];
  return [createFindWorkOperation({ adapters: () => adapters, remote: remoteDaemons })];
}
