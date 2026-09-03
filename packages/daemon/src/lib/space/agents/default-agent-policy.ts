import type { SpaceLongHorizonAgent } from '@hyperneo/shared';

export interface DefaultAgentLookup {
  getCoordinator(spaceId: string): SpaceLongHorizonAgent | null;
}

export function resolveIsDefaultAgent(
  spaceId: string,
  agentId: string | null | undefined,
  lookup: DefaultAgentLookup | undefined
): boolean {
  if (agentId == null || !lookup) return false;
  return agentId === lookup.getCoordinator(spaceId)?.id;
}

const LOCKED_DEFAULT_AGENT_STATUSES = new Set(['paused', 'archived', 'disabled']);

export type DefaultAgentUpdateAdmission =
  | { action: 'allow' }
  | { action: 'reject'; message: string };

export function decideDefaultAgentUpdateAdmission(input: {
  isDefaultAgent: boolean;
  handleChanged: boolean;
  nextStatus?: string | null;
}): DefaultAgentUpdateAdmission {
  if (!input.isDefaultAgent) return { action: 'allow' };
  if (input.handleChanged) {
    return {
      action: 'reject',
      message:
        'The default Space agent (coordinator) handle is locked and cannot be changed; ' +
        'instructions, model, provider, and tools stay editable.',
    };
  }
  if (input.nextStatus != null && LOCKED_DEFAULT_AGENT_STATUSES.has(input.nextStatus)) {
    return {
      action: 'reject',
      message:
        'The default Space agent (coordinator) cannot be paused, archived, or disabled; ' +
        'instructions, model, provider, and tools stay editable.',
    };
  }
  return { action: 'allow' };
}
