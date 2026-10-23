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

export function isNeoCardLive(
  work: Pick<NeoWork, 'status' | 'report'> | null
): work is Pick<NeoWork, 'status' | 'report'> {
  return (
    !!work &&
    (work.status === 'queued' || work.status === 'reported') &&
    !isNeoWorkClosedDone(work.report)
  );
}

export function planNeoCardSend({ work, ref }: NeoCardSendTarget): NeoCardSend {
  if (!isNeoCardLive(work)) return { via: 'none' };
  if (ref) return { via: 'driver', ref };
  return work.sessionId ? { via: 'session', sessionId: work.sessionId } : { via: 'none' };
}

export function neoCardWorkerSession(send: NeoCardSend): string | null {
  if (send.via === 'session') return send.sessionId;
  return send.via === 'driver' && send.ref.adapter === 'hyperneo' && !send.ref.daemon
    ? send.ref.id
    : null;
}
