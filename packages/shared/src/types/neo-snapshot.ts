import type { NeoConcern, NeoConsultation, NeoWork } from './neo-context.ts';

export interface NeoSnapshot {
  ok: true;
  sessionId: string | null;
  concerns: NeoConcern[];
  work: NeoWork[];
  consultations?: NeoConsultation[];
}

export type NeoResult<T> = T | { ok: false; reason: string };
