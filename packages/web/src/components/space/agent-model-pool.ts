import type { AgentModelPoolEntry, SpaceAgent } from '@hyperneo/shared';

export function poolFromAgent(agent: SpaceAgent): AgentModelPoolEntry[] {
  if (agent.modelPool && agent.modelPool.length > 0) return agent.modelPool;
  if (!agent.model) return [];
  return [
    {
      model: agent.model,
      provider: agent.provider ?? undefined,
      maxConcurrent: 1,
      weight: 100,
    },
  ];
}
