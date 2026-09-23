import type { SpaceGoal } from '@hyperneo/shared';
import type { OperationDefinition } from '../operations/registry.ts';
import {
  createEvolutionEpisodeOperations,
  type EvolutionEpisodeOperationDependencies,
} from './episode-operations.ts';
import {
  createEvolutionEvidenceAttachOperation,
  type EvolutionEvidenceAttachDependencies,
} from './evidence-attach-operation.ts';
import {
  createEvolutionScopeGetOperation,
  type EvolutionScopeGetDependencies,
} from './scope-get-operation.ts';
import {
  createEvolutionScopeOperations,
  type EvolutionScopeOperationDependencies,
} from './scope-operations.ts';

export type EvolutionOperationDependencies = Omit<EvolutionScopeOperationDependencies, 'getGoal'> &
  Omit<EvolutionEpisodeOperationDependencies, 'getGoal'> &
  Omit<EvolutionScopeGetDependencies, 'getGoal'> &
  EvolutionEvidenceAttachDependencies & {
    readonly getGoal: (goalId: string) => SpaceGoal | null;
  };

export function createEvolutionOperations(
  evolution: EvolutionOperationDependencies
): OperationDefinition[] {
  return [
    ...createEvolutionScopeOperations(evolution),
    ...createEvolutionEpisodeOperations(evolution),
    createEvolutionEvidenceAttachOperation(evolution),
    createEvolutionScopeGetOperation(evolution),
  ];
}
