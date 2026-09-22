import type { SpaceAgentGoalScopeRepository } from '../../storage/repositories/space-agent-goal-scope-repository.ts';
import type { SpaceAgentReminderRepository } from '../../storage/repositories/space-agent-reminder-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { OperationDefinition } from '../operations/registry.ts';
import {
  createCreateAgentOperation,
  type CreateAgentDependencies,
} from './create-agent-operation.ts';
import {
  createEnsureAgentSessionOperation,
  type EnsureAgentSessionDependencies,
} from './ensure-agent-session-operation.ts';
import { createGetAgentOperation } from './get-agent-operation.ts';
import { createListAgentsOperation } from './list-agents-operation.ts';
import {
  createSetGoalOwnerOperation,
  createSetScopeOwnerOperation,
  type AgentAssignmentDependencies,
} from './assign-agent-operation.ts';
import type { AgentOperationDeps } from './operation-contracts.ts';
import {
  createCancelAgentReminderOperation,
  createCreateAgentReminderOperation,
  createListAgentRemindersOperation,
  type AgentReminderDependencies,
} from './reminder-operations.ts';
import {
  createUpdateAgentOperation,
  type UpdateAgentDependencies,
} from './update-agent-operation.ts';

export interface AgentOperationDependencies extends AgentOperationDeps {
  readonly longHorizonAgentRepo: Pick<
    SpaceLongHorizonAgentRepository,
    'getById' | 'listBySpaceId' | 'create' | 'update'
  >;
  readonly reminderRepo: Pick<
    SpaceAgentReminderRepository,
    'createReminder' | 'listReminders' | 'getReminder' | 'cancelReminder'
  >;
  readonly occurrenceIsClaimed?: AgentReminderDependencies['occurrenceIsClaimed'];
  readonly publishAgentCreated: CreateAgentDependencies['publishAgentCreated'];
  readonly publishAgentUpdated: UpdateAgentDependencies['publishAgentUpdated'];
  readonly refreshAgentSubscriptions: UpdateAgentDependencies['refreshAgentSubscriptions'];
  readonly clearAgentSessionProvider: UpdateAgentDependencies['clearAgentSessionProvider'];
  readonly ensureAgentSession: EnsureAgentSessionDependencies['ensureAgentSession'];
  readonly audit: CreateAgentDependencies['audit'];
  readonly getGoalSpace: AgentAssignmentDependencies['getGoalSpace'];
  readonly getForgeScopeSpace: AgentAssignmentDependencies['getForgeScopeSpace'];
  readonly goalScopeRepo: Pick<
    SpaceAgentGoalScopeRepository,
    | 'assignGoal'
    | 'deleteGoalAssignmentByRelationship'
    | 'assignForgeScope'
    | 'deleteForgeScopeAssignment'
  >;
  readonly publishGoalOwnerChanged: AgentAssignmentDependencies['publishGoalOwnerChanged'];
}

function assignmentDeps(deps: AgentOperationDependencies): AgentAssignmentDependencies {
  return {
    ...deps,
    getAgent: (agentId) => deps.longHorizonAgentRepo.getById(agentId),
    assignGoal: (agentId, goalId) => deps.goalScopeRepo.assignGoal(agentId, goalId),
    unassignGoal: (agentId, goalId) =>
      deps.goalScopeRepo.deleteGoalAssignmentByRelationship(agentId, goalId, 'owner'),
    assignForgeScope: (agentId, scopeId) => deps.goalScopeRepo.assignForgeScope(agentId, scopeId),
    unassignForgeScope: (agentId, scopeId) =>
      deps.goalScopeRepo.deleteForgeScopeAssignment(agentId, scopeId),
  };
}

function updateDeps(deps: AgentOperationDependencies): UpdateAgentDependencies {
  return {
    ...deps,
    listAgents: (spaceId) => deps.longHorizonAgentRepo.listBySpaceId(spaceId),
    getAgent: (agentId) => deps.longHorizonAgentRepo.getById(agentId),
    updateAgent: (agentId, params) => deps.longHorizonAgentRepo.update(agentId, params),
  };
}

function reminderDeps(deps: AgentOperationDependencies): AgentReminderDependencies {
  return {
    ...deps,
    getAgent: (agentId) => deps.longHorizonAgentRepo.getById(agentId),
    createReminder: (params) => deps.reminderRepo.createReminder(params),
    listReminders: (agentId) => deps.reminderRepo.listReminders(agentId),
    getReminder: (reminderId) => deps.reminderRepo.getReminder(reminderId),
    cancelReminder: (reminderId) => deps.reminderRepo.cancelReminder(reminderId),
    occurrenceIsClaimed: deps.occurrenceIsClaimed,
  };
}

export function createAgentOperations(deps: AgentOperationDependencies): OperationDefinition[] {
  return [
    createListAgentsOperation({
      ...deps,
      listAgents: (spaceId) => deps.longHorizonAgentRepo.listBySpaceId(spaceId),
    }),
    createGetAgentOperation({
      ...deps,
      getAgent: (agentId) => deps.longHorizonAgentRepo.getById(agentId),
    }),
    createEnsureAgentSessionOperation({
      ...deps,
      getAgent: (agentId) => deps.longHorizonAgentRepo.getById(agentId),
    }),
    createCreateAgentOperation({
      ...deps,
      listAgents: (spaceId) => deps.longHorizonAgentRepo.listBySpaceId(spaceId),
      getAgent: (agentId) => deps.longHorizonAgentRepo.getById(agentId),
      createAgent: (params) => deps.longHorizonAgentRepo.create(params),
    }),
    createUpdateAgentOperation(updateDeps(deps)),
    createSetGoalOwnerOperation(assignmentDeps(deps)),
    createSetScopeOwnerOperation(assignmentDeps(deps)),
    createCreateAgentReminderOperation(reminderDeps(deps)),
    createListAgentRemindersOperation(reminderDeps(deps)),
    createCancelAgentReminderOperation(reminderDeps(deps)),
  ];
}
