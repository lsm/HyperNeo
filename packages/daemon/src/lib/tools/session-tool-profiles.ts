import type { SessionToolProfile } from '@hyperneo/shared/types/session-tool-choice';

const NEO_ORCHESTRATION_FAMILIES = ['neo.', 'pack.', 'work.'];

export const DESKTOP_OPERATIONS = new Set([
  'desktop.call',
  'message.send',
  'operations.list',
  'operations.describe',
]);

export function isAdvertisedToProfile(name: string, profile?: SessionToolProfile): boolean {
  if (profile === 'desktop') return DESKTOP_OPERATIONS.has(name);
  return (
    profile !== 'worker' || !NEO_ORCHESTRATION_FAMILIES.some((family) => name.startsWith(family))
  );
}
