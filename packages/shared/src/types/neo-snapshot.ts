import type { NeoConcern, NeoConsultation, NeoConsultationWaiter, NeoWork } from './neo-context.ts';
import type { DaemonInventoryLink } from './daemon-snapshot.ts';

export interface NeoWorkResourceReceipt {
  workId: string;
  refs: DaemonInventoryLink[] | null;
}

export interface NeoReceiptAskOrigin {
  kind: 'work' | 'consultation';
  id: string;
  origin: { sessionId: string; messageId: string } | null;
}

export interface NeoSnapshot {
  ok: true;
  sessionId: string | null;
  concerns: NeoConcern[];
  publicAuthorBindings?: { sessionId: string; concernId: string; kind: 'concern' }[];
  work: NeoWork[];
  consultations?: NeoConsultation[];
  consultationWaiters?: NeoConsultationWaiter[];
  askOrigins?: NeoReceiptAskOrigin[];
  workResources?: NeoWorkResourceReceipt[];
}

export type NeoResult<T> = T | { ok: false; reason: string };
