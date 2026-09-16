import type { OperationDefinition } from '../operations/registry.ts';
import {
  createForgeEpisodeOperations,
  type ForgeEpisodeOperationDependencies,
} from './episode-operations.ts';
import {
  createForgeScopeOperations,
  type ForgeScopeOperationDependencies,
} from './scope-operations.ts';

export type ForgeOperationDependencies = Omit<ForgeScopeOperationDependencies, 'getGoal'> &
  ForgeEpisodeOperationDependencies;

export function createForgeOperations(forge: ForgeOperationDependencies): OperationDefinition[] {
  return [...createForgeScopeOperations(forge), ...createForgeEpisodeOperations(forge)];
}
