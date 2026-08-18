import { RESERVED_SPACE_AGENT_HANDLES } from './slug';

export function normalizeAgentNameToken(value: string): string {
  return value.trim().toLowerCase();
}

function handleFromName(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `@${slug}` : null;
}

export function normalizeReplyTargetHandle(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === 'space-agent') return '@coordinator';
  return trimmed.startsWith('@') ? trimmed : handleFromName(trimmed);
}

export function isReservedAgentHandle(handle: string): boolean {
  return (RESERVED_SPACE_AGENT_HANDLES as readonly string[]).includes(handle);
}
