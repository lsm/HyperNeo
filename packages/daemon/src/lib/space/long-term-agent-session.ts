export function longTermAgentSessionId(spaceId: string, agentId: string): string {
	return `space:agent:${encodeActorIdComponent(spaceId)}:${encodeActorIdComponent(agentId)}`;
}

export function encodeActorIdComponent(value: string): string {
	return encodeURIComponent(value);
}
