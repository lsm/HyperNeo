import type { SpaceGoal } from '@hyperneo/shared';
import type { OperationDefinition } from '../operations/registry.ts';
import {
  createForgeEpisodeOperations,
  type ForgeEpisodeOperationDependencies,
} from './episode-operations.ts';
import {
  createForgeScopeGetOperation,
  type ForgeScopeGetDependencies,
} from './scope-get-operation.ts';
import {
  createForgeScopeOperations,
  type ForgeScopeOperationDependencies,
} from './scope-operations.ts';

export type ForgeOperationDependencies = Omit<ForgeScopeOperationDependencies, 'getGoal'> &
  Omit<ForgeEpisodeOperationDependencies, 'getGoal'> &
  Omit<ForgeScopeGetDependencies, 'getGoal'> & {
    readonly getGoal: (goalId: string) => SpaceGoal | null;
  };

export function createForgeOperations(forge: ForgeOperationDependencies): OperationDefinition[] {
  return [
    ...createForgeScopeOperations(forge),
    ...createForgeEpisodeOperations(forge),
    createForgeScopeGetOperation(forge),
  ];
}
