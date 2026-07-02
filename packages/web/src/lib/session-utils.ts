import type { Session } from '@hyperneo/shared';

/**
 * Session types created by users (not internal orchestration agents).
 * undefined = legacy sessions created before typing was introduced.
 */
const USER_SESSION_TYPES = new Set<string | undefined>(['worker', undefined]);

/**
 * Check if a session is user-created (as opposed to internal runtime agents).
 *
 * Filters out sessions like "Leader Agent", "Coder Agent", "Planner Agent"
 * that are internal to legacy orchestration surfaces and confuse users when
 * shown in the Sessions list.
 */
export function isUserSession(session: Session): boolean {
  return (
    USER_SESSION_TYPES.has(session.type) && !session.context?.roomId && !session.context?.spaceId
  );
}

/**
 * Returns a human-readable model label from a model ID string.
 *
 * e.g.
 *   "claude-sonnet-4-5-20250929" → "Sonnet 4"
 *   "claude-opus-4-20251120"       → "Opus 4"
 *   "claude-haiku-3-20250730"      → "Haiku 3"
 *   "glm-4-flash"                  → "GLM 4 Flash"
 *   "deepseek-chat"                → "Deepseek Chat"
 */
export function getModelLabel(modelId: string | null | undefined): string {
  if (!modelId) return '';
  const lower = modelId.toLowerCase();

  // Anthropic models: claude-{family}-{number}(-...) → "{Family} {number}"
  if (lower.startsWith('claude-')) {
    const rest = modelId.slice('claude-'.length);
    // Strip date suffix (e.g. -20250929)
    const withoutDate = rest.replace(/-\d{8}$/, '');
    const parts = withoutDate.split('-');
    if (parts.length >= 2) {
      const family = parts[0]!;
      const number = parts[1]!;
      return `${family.charAt(0).toUpperCase() + family.slice(1)} ${number}`;
    }
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }

  // GLM models: glm-4-flash → GLM 4 Flash
  if (lower.startsWith('glm-')) {
    const rest = modelId.slice('glm-'.length);
    const parts = rest.split('-');
    if (parts.length >= 2) {
      const family = parts[0]!;
      const suffix = parts.slice(1).join(' ');
      return `GLM ${family.charAt(0).toUpperCase() + family.slice(1)}${suffix ? ' ' + suffix : ''}`;
    }
    return `GLM ${rest.charAt(0).toUpperCase() + rest.slice(1)}`;
  }

  // Kimi models: kimi-for-coding → Kimi For Coding
  if (lower.startsWith('kimi-')) {
    const rest = modelId.slice('kimi-'.length).replace(/-/g, ' ');
    return `Kimi ${rest}`;
  }

  // Moonshot models: moonshot-v1-32k → Moonshot v1 32k
  if (lower.startsWith('moonshot-')) {
    const rest = modelId.slice('moonshot-'.length).replace(/-/g, ' ');
    return `Moonshot ${rest}`;
  }

  // Unknown models: clean up dashes and camelCase for readability
  return modelId.replace(/-/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}
