import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';

export type NeoAskGroup = 'attention' | 'running' | 'outcomes';

export function neoAskEntryGroup(entry: Pick<NeoAskEntry, 'state'>): NeoAskGroup {
  return entry.state === 'waiting'
    ? 'attention'
    : entry.state === 'done' || entry.state === 'dropped'
      ? 'outcomes'
      : 'running';
}
