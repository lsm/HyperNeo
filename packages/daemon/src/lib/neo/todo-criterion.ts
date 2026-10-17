import type { NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';

export function neoTodoCriterionMet(item: NeoAskItem): boolean {
  return (
    item.state === 'met' &&
    (!(item.check || item.watch?.length) || item.metBy === 'daemon' || item.metBy === 'human')
  );
}
