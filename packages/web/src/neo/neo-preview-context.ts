import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';

export function readNeoPreviewReference(value: unknown): NeoPreviewReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const { artifactId, snapshot, displayName, state } = row;
  return Object.keys(row).length === 4 &&
    typeof artifactId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(artifactId) &&
    typeof snapshot === 'string' &&
    /^[a-f0-9]{64}$/.test(snapshot) &&
    typeof displayName === 'string' &&
    displayName.length > 0 &&
    displayName.length <= 200 &&
    (state === 'available' || state === 'unavailable')
    ? { artifactId, snapshot, displayName, state }
    : null;
}
