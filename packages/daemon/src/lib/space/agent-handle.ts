/**
 * Agent handle / name-token normalization.
 *
 * Pure helpers for normalizing Space agent name tokens and deriving reply
 * target handles. Extracted from space-agent-tools.ts, consolidating the
 * byte-identical `normalizeAgentNameToken` that was duplicated in
 * node-agent-tools.ts so the comparison/slug rules live in one place.
 *
 * Downward-only dependency: `RESERVED_SPACE_AGENT_HANDLES` from `./slug`.
 */
import { RESERVED_SPACE_AGENT_HANDLES } from './slug';

/**
 * Normalize an agent name token for case/whitespace-insensitive comparison.
 * Used wherever a caller-supplied name (worker agent name, handle, alias) is
 * matched against a stored value.
 */
export function normalizeAgentNameToken(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Derive an `@`-prefixed handle from a free-form display name: lowercase, then
 * collapse runs of non `[a-z0-9_-]` characters to single hyphens, trimming
 * leading/trailing hyphens. Returns null when the name yields an empty slug.
 */
function handleFromName(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `@${slug}` : null;
}

/**
 * Normalize a reply target into a canonical `@`-handle. Empty input returns
 * null; the literal `space-agent` maps to the synthetic `@coordinator`; an
 * already-`@`-prefixed value is returned as-is; anything else is slugified via
 * `handleFromName`.
 */
export function normalizeReplyTargetHandle(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === 'space-agent') return '@coordinator';
  return trimmed.startsWith('@') ? trimmed : handleFromName(trimmed);
}

/**
 * True for agent handles that are reserved system singletons (e.g. `coordinator`,
 * auto-created per space by `ensureCoordinator`). Such templates cannot be
 * created via `create_agent_from_template` — creating them would mint a
 * suffixed duplicate the runtime does not recognize as the singleton — so they
 * are also excluded from the `list_agent_templates` discovery catalog.
 */
export function isReservedAgentHandle(handle: string): boolean {
  return (RESERVED_SPACE_AGENT_HANDLES as readonly string[]).includes(handle);
}
