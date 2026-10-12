import type { DaemonInventoryLink } from './daemon-snapshot.ts';
import type { NeoConcern, NeoConsultation, NeoConsultationWaiter, NeoWork } from './neo-context.ts';
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
  uncheckedSince?: number;
  unconfirmed?: true;
  abandoned?: true;
  retryable?: true;
}

export interface NeoWorkGoal {
  workId: string;
  goal: string | null;
  doneWhen: string | null;
}

export interface NeoAskForwardView {
  askSessionId: string;
  askMessageId: string;
  hop: number;
  fromSessionId: string;
  toSessionId: string;
}

export function neoForwardKey(
  ask: { sessionId: string; messageId: string },
  toSessionId: string
): string {
  return `${ask.sessionId}|${ask.messageId}|${toSessionId}`;
}

export const NEO_WORK_STALLED_CONTINUES = 3;
export const NEO_ASK_CONTINUE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const NEO_WORK_CLOSED_DONE_PREFIX = 'Closed as done by ';
export const NEO_WORK_CLOSED_DONE = `${NEO_WORK_CLOSED_DONE_PREFIX}the user.`;

export function isNeoWorkClosedDone(report: string | null | undefined): boolean {
  return !!report?.startsWith(NEO_WORK_CLOSED_DONE_PREFIX);
}

export interface NeoWorkContinue {
  workId: string;
  count: number;
  continuedAt: number;
  lastMessage: string;
  progress: string | null;
  stalled: number;
}

export interface NeoWorkWake {
  workId: string;
  wakes: number;
  note: string | null;
  progress: string | null;
  stalled: number;
  wokeAt: number | null;
  continuedWake: number | null;
}

export interface NeoWorkSupersession {
  workId: string;
  supersededBy: string;
  supersededAt: number;
}

export type NeoAskStatus = 'open' | 'waiting' | 'achieved' | 'abandoned' | 'blocked';
export type NeoAskApprovalSpent = 'continues' | 'expired';

export function isPooledNeoAsk<T extends Pick<NeoAsk, 'status' | 'approvedAt'>>(
  ask: T | null | undefined
): ask is T & { approvedAt: number } {
  return ask?.approvedAt != null && ask.status !== 'achieved' && ask.status !== 'abandoned';
}

export function neoAskApprovalSpent(
  ask: Pick<NeoAsk, 'approvedAt'>,
  now: number
): NeoAskApprovalSpent | null {
  if (ask.approvedAt == null) return null;
  return now - ask.approvedAt >= NEO_ASK_CONTINUE_WINDOW_MS ? 'expired' : null;
}

export interface NeoAskItem {
  id: string;
  text: string;
  state: 'pending' | 'met' | 'needs_you' | 'reported';
  evidence: string | null;
  check:
    | 'coding.pr_merged'
    | 'coding.issue_filed'
    | 'coding.issue_sub_issue'
    | 'coding.issue_closed'
    | 'life-admin.confirmed'
    | null;
  metBy: 'neo' | 'daemon' | 'human' | null;
  removed: boolean;
  addedAt: number | null;
  options?: string[];
  decision?: true;
  action?: string;
  waitCard?: string;
  kind?: NeoAskItemKind;
  question?: string;
  watch?: string[];
}

export type NeoAskItemKind = 'decision' | 'action' | 'approval' | 'wait';

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
  pack?: string | null;
  approvedAt?: number | null;
  approvedContinues?: number;
  approvedUntil?: number;
  approvedContinueLimit?: number;
  pooled?: boolean;
  approvalSpent?: NeoAskApprovalSpent | null;
  stalledWorkIds?: string[];
  waitingItem?: string | null;
  status: NeoAskStatus;
  outcome: string | null;
  evidence?: string | null;
  doneItems?: NeoAskItem[];
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
  blockers?: string[];
  createdAt?: number;
  title?: string;
  branch?: string;
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

export interface NeoWorkPrReceipt {
  workId: string;
  prs: NeoWorkPr[];
  waiting: boolean;
}

export type NeoCardPhase =
  | 'proposed'
  | 'handed'
  | 'running'
  | 'needs_you'
  | 'checking'
  | 'abandoned'
  | 'stopped'
  | 'pr_open'
  | 'pr_setback'
  | 'merged'
  | 'reported'
  | 'failed'
  | 'cancelled';

export type NeoCardGroup = 'attention' | 'running' | 'outcomes';
export type NeoCardTone = 'accent' | 'warning' | 'success';
export type NeoCardAction = 'start' | 'cancel' | 'retry' | 'close' | 'done';

export interface NeoCardPrimary {
  kind: 'start' | 'retry' | 'close' | 'answer' | 'open' | 'chat' | 'none';
  label: string | null;
  link: string | null;
}

export interface NeoCardPrSummary {
  number: string;
  label: string;
  count: number;
  inProgress: boolean;
  setback: boolean;
  merged: string[];
}

export interface NeoCardOpenTarget {
  link: string | null;
  remoteLink: string | null;
  sessionId: string | null;
  daemon: string | null;
}

export interface NeoCardView {
  workId: string;
  phase: NeoCardPhase;
  group: NeoCardGroup;
  tone: NeoCardTone;
  label: string;
  hidden: boolean;
  primary: NeoCardPrimary;
  actions: NeoCardAction[];
  adapter: string | null;
  open: NeoCardOpenTarget;
  pr: NeoCardPrSummary | null;
  goal: string | null;
  doneWhen: string | null;
  continued: number;
  continuedMessage: string | null;
  pooled: boolean;
  superseded: boolean;
  uncheckedSince: number | null;
  unconfirmed: boolean;
  abandoned: boolean;
  retryable: boolean;
}

export interface NeoAskSessionView {
  key: string;
  title: string;
  adapter: string;
  status: NonNullable<NeoWorkDriverReceipt['status']>;
  kind: 'needs_you' | 'failed' | null;
  open: NeoCardOpenTarget;
}

export interface NeoAskView {
  askId: string;
  group: NeoCardGroup;
  label: string;
  settled: boolean;
  needsYou: boolean;
  done: number;
  total: number;
  workIds: string[];
  doneWorkIds: string[];
  summary: string | null;
  sessions?: NeoAskSessionView[];
  answer?: NeoAskAnswer | null;
  humanActions?: NeoAskHumanAction[];
}

export const NEO_ASK_OUTCOME_QUESTION = 'Did it work?';
export const NEO_ASK_OUTCOME_OPTIONS = ['Yes', 'No'];

export type NeoAskHumanAction =
  | { kind: 'start'; workId: string }
  | { kind: 'approve'; reason: 'expired' | 'stalled'; workIds?: string[] }
  | {
      kind: 'answer';
      itemId: string;
      step: string | null;
      question: string;
      options: string[];
    }
  | { kind: 'confirm'; itemId: string; step: string }
  | { kind: 'retry'; workId: string }
  | { kind: 'close'; workId: string };

export interface NeoAskAnswer {
  itemId: string;
  question: string;
  label: 'Answer in chat';
  options: string[];
  action?: string;
  kind?: NeoAskItemKind;
}

export interface NeoReceiptAskOrigin {
  kind: 'work' | 'consultation';
  id: string;
  origin: { sessionId: string; messageId: string } | null;
}

export interface NeoSessionNotice {
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
  notices: NeoSessionNotice[];
}

export interface NeoWaitingOnHuman {
  note: string;
  asks: { id: string; title: string; status: NeoAskStatus; question: string }[];
}

export interface NeoSnapshot {
  ok: true;
  rev?: string;
  scopedTo?: string;
  sessionId: string | null;
  concerns: NeoConcern[];
  publicAuthorBindings?: { sessionId: string; concernId: string; kind: 'concern' }[];
  askForwards?: NeoAskForwardView[];
  work: NeoWork[];
  consultations: NeoConsultation[];
  consultationWaiters?: NeoConsultationWaiter[];
  askOrigins?: NeoReceiptAskOrigin[];
  workResources?: NeoWorkResourceReceipt[];
  sessionNotices?: NeoSessionNotice[];
  sessionNoticeGroups?: NeoSessionNoticeGroup[];
  mutedSessions?: string[];
  standingRules?: string[];
  asks?: NeoAsk[];
  cards: NeoCardView[];
  sessionLoad?: NeoSessionLoad[];
  askViews: NeoAskView[];
  waitingOnHuman?: NeoWaitingOnHuman;
  preferences?: (NeoModelPreference & { saved: boolean }) | null;
  trimmed?: string;
}

export interface NeoSessionLoad {
  sessionId: string;
  liveCards: number;
  busy: boolean;
}

export type NeoResult<T> = T | { ok: false; reason: string };
