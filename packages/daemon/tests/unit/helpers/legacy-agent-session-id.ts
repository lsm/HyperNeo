export function longTermAgentSessionId(spaceId: string, agentId: string): string {
  return `space:agent:${encodeURIComponent(spaceId)}:${encodeURIComponent(agentId)}`;
}
