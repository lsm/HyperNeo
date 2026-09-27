import type { NeoConcern, NeoWork } from './neo-context.ts';

export interface NeoSnapshot {
  ok: true;
  sessionId: string | null;
  concerns: NeoConcern[];
  work: NeoWork[];
}

export type NeoResult<T> = T | { ok: false; reason: string };
