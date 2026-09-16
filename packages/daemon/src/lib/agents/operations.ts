import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { OperationDefinition } from '../operations/registry.ts';
import {
  createCreateAgentOperation,
  type CreateAgentDependencies,
} from './create-agent-operation.ts';
import { createGetAgentOperation } from './get-agent-operation.ts';
import { createListAgentsOperation } from './list-agents-operation.ts';
import type { AgentOperationDeps } from './operation-contracts.ts';

export interface AgentOperationDependencies extends AgentOperationDeps {
  readonly longHorizonAgentRepo: Pick<
    SpaceLongHorizonAgentRepository,
    'getById' | 'listBySpaceId' | 'create'
  >;
  readonly publishAgentCreated: CreateAgentDependencies['publishAgentCreated'];
  readonly audit: CreateAgentDependencies['audit'];
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
  ];
}
