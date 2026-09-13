import type { SpaceLongHorizonAgent } from '@hyperneo/shared';

export type AgentRecordResolution =
  | { kind: 'long_horizon'; agent: SpaceLongHorizonAgent }
  | { kind: 'missing' };

export interface ResolveAgentRecordDeps {
  getLongHorizonAgent(agentId: string): SpaceLongHorizonAgent | null;
}

export function resolveAgentRecord(
  spaceId: string,
  agentId: string,
  deps: ResolveAgentRecordDeps
): AgentRecordResolution {
  const longHorizonAgent = deps.getLongHorizonAgent(agentId);
  if (!longHorizonAgent || longHorizonAgent.spaceId !== spaceId) {
    return { kind: 'missing' };
  }
  if (longHorizonAgent.status !== 'active') return { kind: 'missing' };
  return { kind: 'long_horizon', agent: longHorizonAgent };
}
