export function encodeActorIdComponent(value: string): string {
  return encodeURIComponent(value);
}

export function resolveAgentSessionId(
  agents:
    | { getById(id: string): { id: string; spaceId: string; sessionId?: string | null } | null }
    | undefined,
  spaceId: string,
  agentId: string
): string | null {
  const agent = agents?.getById(agentId);
  return agent && agent.spaceId === spaceId ? (agent.sessionId ?? null) : null;
}
