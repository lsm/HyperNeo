export function longTermAgentSessionId(spaceId: string, agentId: string): string {
  return `space:agent:${encodeActorIdComponent(spaceId)}:${encodeActorIdComponent(agentId)}`;
}

export function encodeActorIdComponent(value: string): string {
  return encodeURIComponent(value);
}

export function agentSessionIdFor(agent: {
  id: string;
  spaceId: string;
  sessionId?: string | null;
}): string {
  return agent.sessionId ?? longTermAgentSessionId(agent.spaceId, agent.id);
}

export function resolveAgentSessionId(
  agents:
    | { getById(id: string): { id: string; spaceId: string; sessionId?: string | null } | null }
    | undefined,
  spaceId: string,
  agentId: string
): string {
  const agent = agents?.getById(agentId);
  return agent && agent.spaceId === spaceId
    ? agentSessionIdFor(agent)
    : longTermAgentSessionId(spaceId, agentId);
}
