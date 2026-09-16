import type { OperationDefinition } from '../operations/registry.ts';
import {
  createGetExternalEventOperation,
  type GetExternalEventDependencies,
} from './get-event-operation.ts';
import {
  createListDeliveriesOperation,
  type ListDeliveriesDependencies,
} from './list-deliveries-operation.ts';

export type ExternalEventOperationDependencies = GetExternalEventDependencies &
  ListDeliveriesDependencies;

export function createExternalEventOperations(
  deps: ExternalEventOperationDependencies
): OperationDefinition[] {
  return [createGetExternalEventOperation(deps), createListDeliveriesOperation(deps)];
}
