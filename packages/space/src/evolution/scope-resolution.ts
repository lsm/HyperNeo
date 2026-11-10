import type { EvolutionScope } from '@hyperneo/shared';
import type { EvolutionScopeServiceDeps } from './scope-service-types.ts';

type ScopeResolutionDeps = Pick<
  EvolutionScopeServiceDeps,
  'evolutionRepo' | 'spaceRepo' | 'goalRepo' | 'taskRepo'
>;

export function requireSpace(deps: ScopeResolutionDeps, spaceId: string) {
  if (!spaceId) throw new Error('spaceId is required');
  const space = deps.spaceRepo.getSpace(spaceId);
  if (!space) throw new Error(`Space not found: ${spaceId}`);
  return space;
}

export function requireGoal(deps: ScopeResolutionDeps, goalId: string) {
  if (!goalId) throw new Error('spaceGoalId is required');
  const goal = deps.goalRepo.getById(goalId);
  if (!goal) throw new Error(`SpaceGoal not found: ${goalId}`);
  return goal;
}

export function requireGoalInSpace(deps: ScopeResolutionDeps, goalId: string, spaceId: string) {
  const goal = requireGoal(deps, goalId);
  if (goal.spaceId !== spaceId) throw new Error(`SpaceGoal not found in space: ${goalId}`);
  return goal;
}

export function requireScope(deps: ScopeResolutionDeps, scopeId: string): EvolutionScope {
  if (!scopeId) throw new Error('scopeId is required');
  const scope = deps.evolutionRepo.getScope(scopeId);
  if (!scope) throw new Error(`EvolutionScope not found: ${scopeId}`);
  return scope;
}

export function requireScopeInSpace(
  deps: ScopeResolutionDeps,
  scopeId: string,
  spaceId: string
): EvolutionScope {
  const scope = requireScope(deps, scopeId);
  if (scope.spaceId !== spaceId) throw new Error(`EvolutionScope not found in space: ${scopeId}`);
  return scope;
}

export function findScopeForTask(
  deps: ScopeResolutionDeps,
  evolutionScopeId: string | null,
  goalId: string | null
): EvolutionScope | null {
  if (evolutionScopeId) return deps.evolutionRepo.getScope(evolutionScopeId) ?? null;
  if (!goalId) return null;
  const goal = deps.goalRepo.getById(goalId);
  if (!goal) return null;
  return deps.evolutionRepo.listScopes({ spaceId: goal.spaceId, spaceGoalId: goal.id })[0] ?? null;
}

export function requireScopeForTask(
  deps: ScopeResolutionDeps,
  taskId: string,
  evolutionScopeId: string | null,
  goalId: string | null
): EvolutionScope {
  const scope = findScopeForTask(deps, evolutionScopeId, goalId);
  if (scope) return scope;
  if (evolutionScopeId) throw new Error(`EvolutionScope not found: ${evolutionScopeId}`);
  if (!goalId) throw new Error(`Task is not linked to an EvolutionScope or SpaceGoal: ${taskId}`);
  throw new Error(`EvolutionScope not found for SpaceGoal: ${goalId}`);
}

export function requireScopeForWorkflowRun(
  deps: ScopeResolutionDeps,
  workflowRunId: string
): EvolutionScope {
  const task = deps.taskRepo.listByWorkflowRunIncludingArchived(workflowRunId)[0];
  if (!task) throw new Error(`Task not found for workflow run: ${workflowRunId}`);
  return requireScopeForTask(deps, task.id, task.evolutionScopeId ?? null, task.goalId ?? null);
}
