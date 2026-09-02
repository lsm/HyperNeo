import type { SpaceLongHorizonAgent, SpaceWorkerAgent } from '@hyperneo/shared';
import { coordinatorLongHorizonAgentId } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../space/agents/worker-long-horizon-mapper.ts';

export type AgentRecordResolution =
  | { kind: 'coordinator'; agent: SpaceLongHorizonAgent | null }
  | { kind: 'long_horizon'; agent: SpaceLongHorizonAgent }
  | { kind: 'worker'; agent: SpaceWorkerAgent }
  | { kind: 'missing' };

export interface ResolveAgentRecordDeps {
  getLongHorizonAgent(agentId: string): SpaceLongHorizonAgent | null;
  getCoordinator(spaceId: string): SpaceLongHorizonAgent | null;
  getCoordinatorRecord(spaceId: string): SpaceLongHorizonAgent | null;
  getWorkerAgent(agentId: string): SpaceWorkerAgent | null;
}

export function resolveAgentRecord(
  spaceId: string,
  agentId: string,
  deps: ResolveAgentRecordDeps
): AgentRecordResolution {
  if (agentId === 'coordinator' || agentId === `coordinator:${spaceId}`) {
    const record = deps.getCoordinatorRecord(spaceId);
    if (record != null && record.status !== 'active') return { kind: 'missing' };
    return { kind: 'coordinator', agent: record };
  }
  const longHorizonAgent = deps.getLongHorizonAgent(agentId);
  if (
    longHorizonAgent?.spaceId === spaceId &&
    longHorizonAgent.templateKey !== MIGRATED_WORKER_TEMPLATE_KEY
  ) {
    if (longHorizonAgent.status !== 'active') return { kind: 'missing' };
    const coordinator = deps.getCoordinator(spaceId);
    if (
      longHorizonAgent.id === coordinatorLongHorizonAgentId(spaceId) ||
      coordinator?.id === longHorizonAgent.id
    ) {
      return { kind: 'coordinator', agent: longHorizonAgent };
    }
    return { kind: 'long_horizon', agent: longHorizonAgent };
  }
  const worker = deps.getWorkerAgent(agentId);
  if (!worker || worker.spaceId !== spaceId) return { kind: 'missing' };
  return { kind: 'worker', agent: worker };
}
