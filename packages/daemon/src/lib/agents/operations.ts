import type { SpaceAgentReminderRepository } from '../../storage/repositories/space-agent-reminder-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { OperationDefinition } from '../operations/registry.ts';
import {
  createCreateAgentOperation,
  type CreateAgentDependencies,
} from './create-agent-operation.ts';
import { createGetAgentOperation } from './get-agent-operation.ts';
import { createListAgentsOperation } from './list-agents-operation.ts';
import type { AgentOperationDeps } from './operation-contracts.ts';
import {
  createCreateAgentReminderOperation,
  createListAgentRemindersOperation,
  type AgentReminderDependencies,
} from './reminder-operations.ts';

export interface AgentOperationDependencies extends AgentOperationDeps {
  readonly longHorizonAgentRepo: Pick<
    SpaceLongHorizonAgentRepository,
    'getById' | 'listBySpaceId' | 'create'
  >;
  readonly reminderRepo: Pick<SpaceAgentReminderRepository, 'createReminder' | 'listReminders'>;
  readonly publishAgentCreated: CreateAgentDependencies['publishAgentCreated'];
  readonly audit: CreateAgentDependencies['audit'];
}

function reminderDeps(deps: AgentOperationDependencies): AgentReminderDependencies {
  return {
    ...deps,
    getAgent: (agentId) => deps.longHorizonAgentRepo.getById(agentId),
    createReminder: (params) => deps.reminderRepo.createReminder(params),
    listReminders: (agentId) => deps.reminderRepo.listReminders(agentId),
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
    createCreateAgentOperation({
      ...deps,
      listAgents: (spaceId) => deps.longHorizonAgentRepo.listBySpaceId(spaceId),
      getAgent: (agentId) => deps.longHorizonAgentRepo.getById(agentId),
      createAgent: (params) => deps.longHorizonAgentRepo.create(params),
    }),
    createCreateAgentReminderOperation(reminderDeps(deps)),
    createListAgentRemindersOperation(reminderDeps(deps)),
  ];
}
