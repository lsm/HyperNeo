/**
 * Helpers for the synthetic Space session-id formats (task #873).
 *
 * Coordinator session: `space:chat:${spaceId}` — stable, created with the space.
 * Long-horizon agent session: `space:agent:${enc(spaceId)}:${enc(agentId)}` —
 * deterministic per (spaceId, agentId). See the daemon's
 * `longTermAgentSessionId` / `coordinatorSessionId`.
 *
 * Used to refresh a stale agent record: when a session fails to load, parse the
 * id back to its agent, re-fetch the agent list, and — if the agent now resolves
 * to a different session id — navigate to the live one instead of looping on a
 * deleted id.
 */

/** True for the per-space coordinator synthetic id `space:chat:${spaceId}`. */
export function isCoordinatorSessionId(
  spaceId: string,
  sessionId: string | null | undefined
): boolean {
  return !!sessionId && sessionId === `space:chat:${spaceId}`;
}

/** True for a long-horizon agent session id (`space:agent:…`). */
export function isLongHorizonAgentSessionId(sessionId: string | null | undefined): boolean {
  return !!sessionId && sessionId.startsWith('space:agent:');
}

export interface ParsedAgentSessionId {
  spaceId: string;
  agentId: string;
}

/**
 * Parse a `space:agent:<encSpaceId>:<encAgentId>` id back into its components.
 * Returns null for anything else (coordinator id, regular session, malformed).
 * `encodeURIComponent` is used for each component, so the literal `:` separators
 * never appear inside them — a plain split is safe.
 */
export function parseLongHorizonAgentSessionId(
  sessionId: string | null | undefined
): ParsedAgentSessionId | null {
  if (!sessionId || !sessionId.startsWith('space:agent:')) return null;
  const parts = sessionId.split(':'); // ['space', 'agent', encSpace, encAgent]
  if (parts.length !== 4) return null;
  try {
    return {
      spaceId: decodeURIComponent(parts[2]),
      agentId: decodeURIComponent(parts[3]),
    };
  } catch {
    // Malformed encoding — treat as unparseable rather than throwing.
    return null;
  }
}
