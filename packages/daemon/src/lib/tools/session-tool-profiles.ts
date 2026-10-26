import type { SessionToolProfile } from '@hyperneo/shared/types/session-tool-choice';

const NEO_ORCHESTRATION_FAMILIES = ['neo.', 'pack.', 'work.'];

export function isAdvertisedToProfile(name: string, profile?: SessionToolProfile): boolean {
  return (
    profile !== 'worker' || !NEO_ORCHESTRATION_FAMILIES.some((family) => name.startsWith(family))
  );
}
