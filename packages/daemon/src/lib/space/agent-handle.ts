import { RESERVED_SPACE_AGENT_HANDLES } from './slug.ts';

export const SPACE_MANAGER_HANDLE = 'space-manager';
const SPACE_MANAGER_HANDLE_ALIASES = ['coordinator'];
export const SPACE_MANAGER_HANDLE_LOOKUP_ORDER = [
  SPACE_MANAGER_HANDLE,
  ...SPACE_MANAGER_HANDLE_ALIASES,
];

export function canonicalizeSpaceManagerHandle(handle: string): string {
  return SPACE_MANAGER_HANDLE_ALIASES.includes(handle) ? SPACE_MANAGER_HANDLE : handle;
}

export function isSpaceManagerHandle(handle: string): boolean {
  return handle === SPACE_MANAGER_HANDLE || SPACE_MANAGER_HANDLE_ALIASES.includes(handle);
}

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
  if (trimmed === 'space-agent') return `@${SPACE_MANAGER_HANDLE}`;
  if (isSpaceManagerHandle(trimmed.replace(/^@/, ''))) return `@${SPACE_MANAGER_HANDLE}`;
  return trimmed.startsWith('@') ? trimmed : handleFromName(trimmed);
}

export function isReservedAgentHandle(handle: string): boolean {
  return (RESERVED_SPACE_AGENT_HANDLES as readonly string[]).includes(handle);
}
