import type { SpaceAgentAutonomyLevel, SpaceLongHorizonAgent } from '@hyperneo/shared';
import type { OperationCaller } from '../operations/registry.ts';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit } from './slug.ts';

export function displayNameTaken(
  agents: readonly SpaceLongHorizonAgent[],
  name: string,
  excludeId?: string
): boolean {
  const target = name.trim().toLowerCase();
  if (!target) return false;
  return agents.some(
    (candidate) =>
      candidate.status !== 'archived' &&
      candidate.id !== excludeId &&
      (candidate.displayName ?? '').trim().toLowerCase() === target
  );
}

export function uniqueAgentHandle(agents: readonly SpaceLongHorizonAgent[], name: string): string {
  return slugifyWithinLimit(name, [
    ...agents.map((agent) => agent.handle),
    ...RESERVED_SPACE_AGENT_HANDLES,
  ]);
}

export function nameClonedAgent(
  agents: readonly SpaceLongHorizonAgent[],
  title: string
): { handle: string; displayName: string } {
  const handle = uniqueAgentHandle(agents, title);
  const base = title.trim() || handle;
  let displayName = base;
  for (let n = 2; displayNameTaken(agents, displayName); n++) displayName = `${base} (${n})`;
  return { handle, displayName };
}

export function callerAutonomyLevel(
  caller: OperationCaller,
  spaceId: string,
  getAgent: (agentId: string) => SpaceLongHorizonAgent | null
): SpaceAgentAutonomyLevel | null {
  if (!caller.agentId) return null;
  const agent = getAgent(caller.agentId);
  if (agent) return agent.spaceId === spaceId ? (agent.autonomyLevel ?? null) : null;
  return 1;
}
