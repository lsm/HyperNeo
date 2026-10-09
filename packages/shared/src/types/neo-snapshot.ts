import type { NeoConcern, NeoConsultation, NeoConsultationWaiter, NeoWork } from './neo-context.ts';
import type { DaemonInventoryLink } from './daemon-snapshot.ts';
import type { NeoModelPreference } from './settings.ts';

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
export const NEO_WORK_CLOSED_DONE = 'Closed as done by the user.';

export interface NeoWorkContinue {
  workId: string;
  count: number;
  continuedAt: number;
  lastMessage: string;
}

export type NeoAskStatus = 'open' | 'waiting' | 'achieved' | 'abandoned' | 'blocked';

export interface NeoAsk {
  id: string;
  requestKey: string;
  concernId: string | null;
  originSessionId: string;
  originMessageId: string | null;
  title: string;
  ask: string;
  doneWhen: string;
  doneSource: string;
  status: NeoAskStatus;
  outcome: string | null;
  evidence?: string | null;
  workIds: string[];
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

export interface NeoWorkPr {
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  checks: 'pending' | 'failing' | 'passing' | 'none';
  review: 'approved' | 'changes_requested' | 'none';
}

export interface NeoWorkPrReceipt {
  workId: string;
  prs: NeoWorkPr[];
  waiting: boolean;
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
  workPrs?: NeoWorkPrReceipt[];
  standingRules?: string[];
  asks?: NeoAsk[];
  preferences?: (NeoModelPreference & { saved: boolean }) | null;
}

export type NeoResult<T> = T | { ok: false; reason: string };
