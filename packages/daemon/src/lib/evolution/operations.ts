import type { OperationDefinition } from '../operations/registry.ts';
import {
  createForgeEpisodeOperations,
  type ForgeEpisodeOperationDependencies,
} from './episode-operations.ts';
import {
  createForgeScopeReadOperation,
  type ForgeScopeReadDependencies,
} from './scope-read-operation.ts';
import {
  createForgeScopeOperations,
  type ForgeScopeOperationDependencies,
} from './scope-operations.ts';

export type ForgeOperationDependencies = Omit<ForgeScopeOperationDependencies, 'getGoal'> &
  ForgeEpisodeOperationDependencies &
  Omit<ForgeScopeReadDependencies, 'getGoal'>;

export function createForgeOperations(forge: ForgeOperationDependencies): OperationDefinition[] {
  return [
    ...createForgeScopeOperations(forge),
    ...createForgeEpisodeOperations(forge),
    createForgeScopeReadOperation(forge),
  ];
}
