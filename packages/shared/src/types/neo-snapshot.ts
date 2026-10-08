import type { NeoConcern, NeoConsultation, NeoConsultationWaiter, NeoWork } from './neo-context.ts';
import type { DaemonInventoryLink } from './daemon-snapshot.ts';

export interface NeoWorkResourceReceipt {
  workId: string;
  refs: DaemonInventoryLink[] | null;
}

export interface NeoWorkDriverReceipt {
  workId: string;
  adapter: string;
  daemon: string | null;
  status: 'queued' | 'running' | 'needs_you' | 'done' | 'failed' | 'stopped' | null;
  link: string | null;
  remoteLink?: string;
}

export interface NeoWorkGoal {
  workId: string;
  goal: string | null;
  doneWhen: string | null;
}

export const NEO_WORK_CONTINUE_LIMIT = 5;

export interface NeoWorkContinue {
  workId: string;
  count: number;
  continuedAt: number;
  lastMessage: string;
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
  workDrivers?: NeoWorkDriverReceipt[];
  workGoals?: NeoWorkGoal[];
  workContinues?: NeoWorkContinue[];
}

export type NeoResult<T> = T | { ok: false; reason: string };
