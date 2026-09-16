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
  createArchiveAgentOperation,
  createPauseAgentOperation,
  createUpdateAgentOperation,
  type UpdateAgentDependencies,
} from './update-agent-operation.ts';

export interface AgentOperationDependencies extends AgentOperationDeps {
  readonly longHorizonAgentRepo: Pick<
    SpaceLongHorizonAgentRepository,
    'getById' | 'listBySpaceId' | 'create' | 'update'
  >;
  readonly publishAgentCreated: CreateAgentDependencies['publishAgentCreated'];
  readonly publishAgentUpdated: UpdateAgentDependencies['publishAgentUpdated'];
  readonly refreshAgentSubscriptions: UpdateAgentDependencies['refreshAgentSubscriptions'];
  readonly clearAgentSessionProvider: UpdateAgentDependencies['clearAgentSessionProvider'];
  readonly audit: CreateAgentDependencies['audit'];
}

function updateDeps(deps: AgentOperationDependencies): UpdateAgentDependencies {
  return {
    ...deps,
    listAgents: (spaceId) => deps.longHorizonAgentRepo.listBySpaceId(spaceId),
    getAgent: (agentId) => deps.longHorizonAgentRepo.getById(agentId),
    updateAgent: (agentId, params) => deps.longHorizonAgentRepo.update(agentId, params),
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
    createUpdateAgentOperation(updateDeps(deps)),
    createPauseAgentOperation(updateDeps(deps)),
    createArchiveAgentOperation(updateDeps(deps)),
  ];
}
