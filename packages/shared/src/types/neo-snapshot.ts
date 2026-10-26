import type { NeoRuleSource } from './settings';
import type { WorkerIdentity } from './worker-identity.ts';
import type { NeoSessionMessage } from './neo-session-message.ts';
import type { NeoConversationWake } from './neo-wake.ts';
import type { NeoAskEntry, NeoStatusCode } from './neo-ask.ts';
import type { NeoProject } from './neo-context.ts';
import type { NeoModelPreference } from './settings.ts';

export interface NeoWorkDriverReceipt {
  workId: string;
  adapter: string;
  model?: string;
  effort?: string;
  daemon: string | null;
  status: 'queued' | 'running' | 'needs_you' | 'done' | 'failed' | 'stopped' | null;
  link: string | null;
  remoteLink?: string;
  uncheckedSince?: number;
  checkedAt?: number;
  unconfirmed?: true;
  abandoned?: true;
  retryable?: true;
}

export interface NeoWorkGoal {
  workId: string;
  goal: string | null;
  doneWhen: string | null;
}

export const NEO_WORK_CLOSED_DONE_PREFIX = 'Closed as done by ';
export const NEO_WORK_CLOSED_DONE = `${NEO_WORK_CLOSED_DONE_PREFIX}the user.`;

export function isNeoWorkClosedDone(report: string | null | undefined): boolean {
  return !!report?.startsWith(NEO_WORK_CLOSED_DONE_PREFIX);
}

export type NeoAskStatus = 'open' | 'waiting' | 'achieved' | 'abandoned' | 'blocked';
export type NeoAskApprovalSpent = 'continues' | 'expired';

export interface NeoAskItem {
  answer?: { choice: string | null; at: number | null };
  deliveredBy?: string | null;
  verifiedDefinitionHash?: string | null;
  id: string;
  text: string;
  state: 'pending' | 'met' | 'needs_you' | 'reported';
  evidence: string | null;
  check: string | null;
  metBy: 'neo' | 'daemon' | 'human' | null;
  removed: boolean;
  removedReason?: string;
  addedAt: number | null;
  options?: string[];
  decision?: true;
  action?: string;
  waitCard?: string;
  kind?: NeoAskItemKind;
  question?: string;
  decides?: string;
  because?: NeoAskQuestionBecause;
  watch?: string[];
  outcomeKind?: NeoAskItemOutcomeKind;
}

export type NeoAskItemOutcomeKind = 'state' | 'answer';

export const NEO_ASK_QUESTION_REASONS = [
  'target_unavailable',
  'card_waits',
  'card_failed',
] as const;

export interface NeoAskQuestionBecause {
  card: string;
  reason: (typeof NEO_ASK_QUESTION_REASONS)[number];
}

export type NeoAskItemKind = 'decision' | 'action' | 'approval' | 'wait';

export interface NeoAsk {
  revision?: number;
  approvedRevision?: number | null;
  id: string;
  requestKey: string;
  projectId: string | null;
  originSessionId: string;
  originMessageId: string | null;
  title: string;
  ask: string;
  doneWhen: string;
  doneSource: string;
  pack?: string | null;
  approvedAt?: number | null;
  approvedContinues?: number;
  approvedUntil?: number;
  approvedContinueLimit?: number;
  pooled?: boolean;
  approvalSpent?: NeoAskApprovalSpent | null;
  stalledWorkIds?: string[];
  summarized?: true;
  waitingItem?: string | null;
  refused?: string | null;
  refusedCount?: number;
  status: NeoAskStatus;
  outcome: string | null;
  evidence?: string | null;
  doneItems?: NeoAskItem[];
  workIds: string[];
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

export interface NeoPackRows {
  pack: string;
  rows: Record<string, string | number | null>[];
}

export interface NeoWorkPr {
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  checks: 'pending' | 'failing' | 'passing' | 'none';
  review: 'approved' | 'changes_requested' | 'none';
  blockers?: string[];
  createdAt?: number;
  mergedAt?: number;
  closedAt?: number;
  title?: string;
  branch?: string;
  head?: string;
  refs?: number[];
}

export type NeoWorkPrVerdict = 'done' | 'failed' | 'waiting' | 'ready' | 'pending';

export function neoWorkPrVerdict(
  pr: Pick<NeoWorkPr, 'state' | 'checks' | 'review'>
): NeoWorkPrVerdict {
  if (pr.state === 'MERGED') return 'done';
  if (pr.state === 'CLOSED') return 'failed';
  if (pr.checks === 'pending') return 'waiting';
  if (pr.checks === 'failing' || pr.review === 'changes_requested') return 'failed';
  return pr.review === 'approved' ? 'ready' : 'pending';
}

export interface NeoSessionNotice {
  worker?: WorkerIdentity;
  key: string;
  ref: { adapter: string; daemon?: string; id: string };
  title: string;
  kind: 'needs_you' | 'failed' | 'finished';
  at: number;
  link?: string;
  remoteLink?: string;
}

export interface NeoSessionNoticeGroup {
  id: string;
  at: number;
  line: string;
  lineCodes?: NeoStatusCode[];
  notices: NeoSessionNotice[];
}

export interface NeoPackSetting {
  pack: string;
  scope: { kind: 'global' | 'repo' | 'project'; key: string };
  key: string;
  value: unknown;
  setBy: string;
  setAt: number;
}

export interface NeoAskHistoryPage {
  ok: true;
  entries: NeoAskEntry[];
  nextCursor: { updatedAt: number; id: string } | null;
}

export interface NeoSnapshot {
  session?: WorkerIdentity | null;
  packPreferences?: NeoPackSetting[];
  ok: true;
  rev?: string;
  sessionId: string | null;
  conversationId?: string | null;
  projects: NeoProject[];
  projectRedirects?: { sourceId: string; targetId: string }[];
  sessionNotices?: NeoSessionNotice[];
  sessionNoticeGroups?: NeoSessionNoticeGroup[];
  sessionMessages?: NeoSessionMessage[];
  wakes?: NeoConversationWake[];
  mutedSessions?: string[];
  standingRules?: string[];
  standingRuleSources?: Record<string, NeoRuleSource>;
  omitted?: { asks?: number };
  working?: NeoWorkingSession[];
  todoAsks?: NeoAskEntry[];
  historyCursor?: { updatedAt: number; id: string } | null;
  packRows?: NeoPackRows[];
  preferences?: (NeoModelPreference & { saved: boolean }) | null;
  trimmed?: string;
}

export type NeoWorkingStatus = 'queued' | 'processing' | 'rate_limit_cooldown';

export interface NeoWorkingSession {
  worker?: WorkerIdentity;
  sessionId: string;
  projectId: string | null;
  title: string;
  status: NeoWorkingStatus;
}

export interface NeoWorkingEvent {
  working: NeoWorkingSession[];
}

export type NeoResult<T> = T | { ok: false; reason: string };
