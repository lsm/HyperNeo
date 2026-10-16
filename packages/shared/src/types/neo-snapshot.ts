import type { DaemonInventoryLink } from './daemon-snapshot.ts';
import type { NeoProject, NeoConsultation, NeoConsultationWaiter, NeoWork } from './neo-context.ts';
import type { NeoModelPreference } from './settings.ts';

export interface NeoWorkResourceReceipt {
  workId: string;
  refs: DaemonInventoryLink[] | null;
}

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

export interface NeoAskItem {
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

export interface NeoCardWaiting {
  workId: string;
  title: string;
  reason: string;
  items: { id: string; text: string }[];
}

export interface NeoCardControlFailure {
  operation: 'stop' | 'withdraw';
  reason: 'unsupported' | 'unavailable';
  detail: string;
  at: number;
}

export interface NeoCardView {
  waitingFor?: NeoCardWaiting[];
  autoStart?: boolean;
  uncertain?: boolean;
  model?: string;
  effort?: string;
  talk?: string;
  replyUnverified?: string;
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
  checkedAt: number | null;
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
  idle?: true;
  idleReason?: string;
  done: number;
  total: number;
  workIds: string[];
  doneWorkIds: string[];
  summary: string | null;
  sessions?: NeoAskSessionView[];
  humanActions?: NeoAskHumanAction[];
}

export interface NeoAskHumanAction {
  kind: 'question';
  itemId: string;
  question: string;
  options: string[];
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

export interface NeoRouteFailure {
  at: number;
  signal: string;
  cause: string;
}

export interface NeoWaitingOnHuman {
  note: string;
  asks: { id: string; title: string; status: NeoAskStatus; question: string }[];
}

export interface NeoSnapshotConsultation extends NeoConsultation {
  summarized?: true;
}

export interface NeoSnapshotWork extends NeoWork {
  summarized?: true;
  askId?: string;
  phase?: NeoCardPhase;
  label?: string;
}

export interface NeoSnapshot {
  ok: true;
  rev?: string;
  scopedTo?: string;
  sessionId: string | null;
  projects: NeoProject[];
  projectRedirects?: { sourceId: string; targetId: string }[];
  projectFacts?: { reference: string; projectId?: string | null }[];
  publicAuthorBindings?: { sessionId: string; projectId: string; kind: 'project' }[];
  askForwards?: NeoAskForwardView[];
  work: NeoSnapshotWork[];
  consultations: NeoSnapshotConsultation[];
  consultationWaiters?: NeoConsultationWaiter[];
  askOrigins?: NeoReceiptAskOrigin[];
  workResources?: NeoWorkResourceReceipt[];
  sessionNotices?: NeoSessionNotice[];
  sessionNoticeGroups?: NeoSessionNoticeGroup[];
  mutedSessions?: string[];
  standingRules?: string[];
  asks?: NeoAsk[];
  told?: { publicationId: string; at: string; shortText: string; triggerId?: string }[];
  moreSettled?: boolean;
  omitted?: { work?: number; asks?: number };
  cards: NeoCardView[];
  sessionLoad?: NeoSessionLoad[];
  working?: NeoWorkingSession[];
  askViews: NeoAskView[];
  waitingOnHuman?: NeoWaitingOnHuman;
  routeFailure?: NeoRouteFailure;
  preferences?: (NeoModelPreference & { saved: boolean }) | null;
  trimmed?: string;
}

export type NeoWorkingStatus = 'queued' | 'processing' | 'rate_limit_cooldown';

export interface NeoWorkingSession {
  sessionId: string;
  projectId: string | null;
  title: string;
  status: NeoWorkingStatus;
}

export interface NeoWorkingEvent {
  working: NeoWorkingSession[];
}

export interface NeoSessionLoad {
  sessionId: string;
  liveCards: number;
  busy: boolean;
}

export type NeoResult<T> = T | { ok: false; reason: string };
