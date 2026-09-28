import type { NeoConcern, NeoConsultation, NeoConsultationWaiter, NeoWork } from './neo-context.ts';

export interface NeoReceiptAskOrigin {
  kind: 'work' | 'consultation';
  id: string;
  origin: { sessionId: string; messageId: string } | null;
}

export interface NeoSnapshot {
  ok: true;
  sessionId: string | null;
  concerns: NeoConcern[];
  work: NeoWork[];
  consultations?: NeoConsultation[];
  consultationWaiters?: NeoConsultationWaiter[];
  askOrigins?: NeoReceiptAskOrigin[];
}

export type NeoResult<T> = T | { ok: false; reason: string };
