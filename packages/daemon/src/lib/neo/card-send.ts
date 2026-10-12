import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { isNeoWorkClosedDone } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkRef } from '../drivers/types.ts';

export interface NeoCardSendTarget {
  work: Pick<NeoWork, 'id' | 'status' | 'report' | 'sessionId'> | null;
  ref: WorkRef | null;
}

export type NeoCardSend =
  | { via: 'driver'; ref: WorkRef }
  | { via: 'session'; sessionId: string }
  | { via: 'none' };

export function planNeoCardSend({ work, ref }: NeoCardSendTarget): NeoCardSend {
  if (!work || (work.status !== 'queued' && work.status !== 'reported')) return { via: 'none' };
  if (isNeoWorkClosedDone(work.report)) return { via: 'none' };
  if (ref) return { via: 'driver', ref };
  return work.sessionId ? { via: 'session', sessionId: work.sessionId } : { via: 'none' };
}
