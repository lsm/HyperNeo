import type { SpaceGoal } from '@hyperneo/shared';
import type { OperationDefinition } from '../operations/registry.ts';
import {
  createForgeEpisodeOperations,
  type EvolutionEpisodeOperationDependencies,
} from './episode-operations.ts';
import {
  createForgeEvidenceAttachOperation,
  type EvolutionEvidenceAttachDependencies,
} from './evidence-attach-operation.ts';
import {
  createForgeScopeGetOperation,
  type EvolutionScopeGetDependencies,
} from './scope-get-operation.ts';
import {
  createForgeScopeOperations,
  type EvolutionScopeOperationDependencies,
} from './scope-operations.ts';

export type EvolutionOperationDependencies = Omit<EvolutionScopeOperationDependencies, 'getGoal'> &
  Omit<EvolutionEpisodeOperationDependencies, 'getGoal'> &
  Omit<EvolutionScopeGetDependencies, 'getGoal'> &
  EvolutionEvidenceAttachDependencies & {
    readonly getGoal: (goalId: string) => SpaceGoal | null;
  };

export function createForgeOperations(
  evolution: EvolutionOperationDependencies
): OperationDefinition[] {
  return [
    ...createForgeScopeOperations(evolution),
    ...createForgeEpisodeOperations(evolution),
    createForgeEvidenceAttachOperation(evolution),
    createForgeScopeGetOperation(evolution),
  ];
}
