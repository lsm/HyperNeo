export function isCoordinatorSessionId(
  spaceId: string,
  sessionId: string | null | undefined
): boolean {
  return !!sessionId && sessionId === `space:chat:${spaceId}`;
}

export function isLongHorizonAgentSessionId(sessionId: string | null | undefined): boolean {
  return !!sessionId && sessionId.startsWith('space:agent:');
}

export interface ParsedAgentSessionId {
  spaceId: string;
  agentId: string;
}

export function parseLongHorizonAgentSessionId(
  sessionId: string | null | undefined
): ParsedAgentSessionId | null {
  if (!sessionId || !sessionId.startsWith('space:agent:')) return null;
  const parts = sessionId.split(':');
  if (parts.length !== 4) return null;
  try {
    return {
      spaceId: decodeURIComponent(parts[2]),
      agentId: decodeURIComponent(parts[3]),
    };
  } catch {
    return null;
  }
}
