import { decisionRun } from '../../lib/space/runtime/decision-pipeline';

export const MESSAGE_SEARCH_TERMINAL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ROOM_SESSION_PREFIXES = [
  'room:chat:',
  'planner:',
  'coder:',
  'leader:',
  'general:',
] as const;
export const ROOM_SESSION_TYPES = ['room_chat', 'planner', 'coder', 'leader', 'general'] as const;
export const TERMINAL_SPACE_TASK_STATUSES = ['done', 'cancelled', 'completed'] as const;
export const SEARCHABLE_MESSAGE_TYPES = ['system', 'user', 'assistant'] as const;

const ROOM_SESSION_TYPE_SET = new Set<string>(ROOM_SESSION_TYPES);
const TERMINAL_SPACE_TASK_STATUS_SET = new Set<string>(TERMINAL_SPACE_TASK_STATUSES);
const SEARCHABLE_MESSAGE_TYPE_SET = new Set<string>(SEARCHABLE_MESSAGE_TYPES);

export function isOlderThanMessageSearchTtl(
  value: string | number | null | undefined,
  now: number
): boolean {
  if (value === null || value === undefined) return false;
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp < now - MESSAGE_SEARCH_TERMINAL_SESSION_TTL_MS;
}

export interface MessageSearchEligibilityRow {
  session_id: string;
  session_status: string | null;
  session_type: string | null;
  session_last_active_at: string | null;
  session_room_id: string | null;
  task_status: string | null;
  task_completed_at: number | null;
  task_updated_at: number | null;
}

export function isMessageSearchIndexEligible(
  row: MessageSearchEligibilityRow,
  now: number
): boolean {
  if (ROOM_SESSION_PREFIXES.some((prefix) => row.session_id.startsWith(prefix))) {
    return false;
  }

  if (row.session_status === 'archived') return false;
  if (
    row.session_status === 'ended' &&
    isOlderThanMessageSearchTtl(row.session_last_active_at, now)
  ) {
    return false;
  }

  if (row.session_type && ROOM_SESSION_TYPE_SET.has(row.session_type)) return false;
  if (row.session_room_id) return false;

  const isSpaceSession =
    row.session_id.startsWith('space:') ||
    row.session_type === 'space_chat' ||
    row.session_type === 'space_task_agent';
  const isNormalSession =
    !row.session_id.includes(':') && (!row.session_type || row.session_type === 'worker');
  if (!isSpaceSession && !isNormalSession) return false;

  if (row.task_status === 'archived') return false;
  if (
    row.task_status &&
    TERMINAL_SPACE_TASK_STATUS_SET.has(row.task_status) &&
    isOlderThanMessageSearchTtl(row.task_completed_at ?? row.task_updated_at, now)
  ) {
    return false;
  }

  return true;
}

export type MessageSearchSkipReason =
  | 'superseded'
  | 'non_searchable_type'
  | 'ineligible'
  | 'empty_body'
  | 'user_status_not_searchable';

export type MessageSearchAdmissionDecision =
  | { action: 'skip'; reason: MessageSearchSkipReason }
  | { action: 'index' };

export type MessageSearchAdmissionFact = boolean | (() => boolean);

export interface MessageSearchAdmissionCtx {
  messageType: string;
  body: string;
  now: number;
  eligibility: MessageSearchEligibilityRow;
  isSuperseded: MessageSearchAdmissionFact;
  isSearchableUserStatus: MessageSearchAdmissionFact;
  decision: MessageSearchAdmissionDecision | null;
}

export type MessageSearchAdmissionInput = Omit<MessageSearchAdmissionCtx, 'decision'>;

function decided(
  ctx: MessageSearchAdmissionCtx,
  decision: MessageSearchAdmissionDecision
): MessageSearchAdmissionCtx {
  return { ...ctx, decision };
}

function readAdmissionFact(value: MessageSearchAdmissionFact): boolean {
  return typeof value === 'function' ? value() : value;
}

export function applySupersededGate(ctx: MessageSearchAdmissionCtx): MessageSearchAdmissionCtx {
  return readAdmissionFact(ctx.isSuperseded)
    ? decided(ctx, { action: 'skip', reason: 'superseded' })
    : ctx;
}

export function applySearchableTypeGate(ctx: MessageSearchAdmissionCtx): MessageSearchAdmissionCtx {
  return SEARCHABLE_MESSAGE_TYPE_SET.has(ctx.messageType)
    ? ctx
    : decided(ctx, { action: 'skip', reason: 'non_searchable_type' });
}

export function applyEligibilityGate(ctx: MessageSearchAdmissionCtx): MessageSearchAdmissionCtx {
  return isMessageSearchIndexEligible(ctx.eligibility, ctx.now)
    ? ctx
    : decided(ctx, { action: 'skip', reason: 'ineligible' });
}

export function applyBodyNonemptyGate(ctx: MessageSearchAdmissionCtx): MessageSearchAdmissionCtx {
  return ctx.body.length > 0 ? ctx : decided(ctx, { action: 'skip', reason: 'empty_body' });
}

export function applyUserStatusGate(ctx: MessageSearchAdmissionCtx): MessageSearchAdmissionCtx {
  return ctx.messageType === 'user' && !readAdmissionFact(ctx.isSearchableUserStatus)
    ? decided(ctx, { action: 'skip', reason: 'user_status_not_searchable' })
    : ctx;
}

export function applyIndexGate(ctx: MessageSearchAdmissionCtx): MessageSearchAdmissionCtx {
  return decided(ctx, { action: 'index' });
}

const messageSearchAdmissionRun = decisionRun('message-search-admission', [
  applySupersededGate,
  applySearchableTypeGate,
  applyEligibilityGate,
  applyBodyNonemptyGate,
  applyUserStatusGate,
  applyIndexGate,
]);

export function decideMessageSearchAdmission(
  input: MessageSearchAdmissionInput
): MessageSearchAdmissionDecision {
  return messageSearchAdmissionRun(input).decision ?? { action: 'index' };
}
