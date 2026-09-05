import type { SpaceLongHorizonAgent } from '@hyperneo/shared';

export type AgentRecordResolution =
  | { kind: 'coordinator'; agent: SpaceLongHorizonAgent | null }
  | { kind: 'long_horizon'; agent: SpaceLongHorizonAgent }
  | { kind: 'missing' };

export interface ResolveAgentRecordDeps {
  getLongHorizonAgent(agentId: string): SpaceLongHorizonAgent | null;
  getCoordinator(spaceId: string): SpaceLongHorizonAgent | null;
  getCoordinatorRecord(spaceId: string): SpaceLongHorizonAgent | null;
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
  if (!longHorizonAgent || longHorizonAgent.spaceId !== spaceId) {
    return { kind: 'missing' };
  }
  if (longHorizonAgent.status !== 'active') return { kind: 'missing' };
  if (deps.getCoordinator(spaceId)?.id === longHorizonAgent.id) {
    return { kind: 'coordinator', agent: longHorizonAgent };
  }
  return { kind: 'long_horizon', agent: longHorizonAgent };
}
