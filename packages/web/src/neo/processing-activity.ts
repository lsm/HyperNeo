import type { AgentProcessingState, ChatMessage, SessionState } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export type NeoProcessingActivity = { label: string; messageId: string | null } | 'inactive';

type ActivityCandidate = Exclude<NeoProcessingActivity, 'inactive'>;
type VisibleInput = ChatMessage & {
  inputKind?: unknown;
  session_id?: unknown;
};

export function selectNeoProcessingStatus(
  sessionState: SessionState | null,
  fallbackState: AgentProcessingState
): { value: ActivityCandidate } | { reason: 'inactive' } {
  const state = sessionState?.agentState ?? fallbackState;
  if (
    state.status !== 'queued' &&
    state.status !== 'processing' &&
    state.status !== 'rate_limit_cooldown'
  )
    return { reason: 'inactive' };
  const label =
    state.status === 'rate_limit_cooldown'
      ? 'Neo is waiting to retry…'
      : state.status === 'processing' && state.phase !== 'initializing'
        ? 'Neo is working on a reply…'
        : 'Neo is getting ready…';
  const messageId =
    'messageId' in state && typeof state.messageId === 'string' && state.messageId.trim()
      ? state.messageId
      : null;
  return { value: { label, messageId } };
}

export function scopeNeoProcessingStatus(
  activity: ActivityCandidate,
  sessionId: string,
  activeSessionId: string | null,
  sessionState: SessionState | null,
  connected: boolean,
  recovering: boolean
): { value: ActivityCandidate } {
  const current =
    !!sessionId.trim() &&
    !!activity.messageId?.trim() &&
    connected &&
    !recovering &&
    activeSessionId === sessionId &&
    sessionState?.sessionInfo?.id === sessionId &&
    !sessionState.error;
  return {
    value: current && activity.messageId ? activity : { ...activity, messageId: null },
  };
}

export function scopeNeoProcessingAsk(
  activity: ActivityCandidate,
  sessionId: string,
  messages: readonly ChatMessage[]
): { value: ActivityCandidate } {
  if (!activity.messageId?.trim()) return { value: { ...activity, messageId: null } };
  const matches = messages.filter((message) => message.uuid === activity.messageId);
  if (matches.length !== 1) return { value: { ...activity, messageId: null } };
  const input = matches[0] as VisibleInput;
  return {
    value:
      input.type === 'user' &&
      (input.parent_tool_use_id === undefined || input.parent_tool_use_id === null) &&
      input.inputKind === 'human' &&
      (input.session_id === undefined ||
        input.session_id === null ||
        input.session_id === sessionId)
        ? activity
        : { ...activity, messageId: null },
  };
}

export const projectNeoProcessingActivity = (
  superpipe({})('neo-processing-activity') as PipelineAPI
)
  .input([
    'sessionId',
    'activeSessionId',
    'sessionState',
    'fallbackState',
    'connected',
    'recovering',
    'messages',
  ])
  .pipe(selectNeoProcessingStatus, ['sessionState', 'fallbackState'], 'result:activity')
  .pipe(
    scopeNeoProcessingStatus,
    ['activity', 'sessionId', 'activeSessionId', 'sessionState', 'connected', 'recovering'],
    'result:activity'
  )
  .pipe(scopeNeoProcessingAsk, ['activity', 'sessionId', 'messages'], 'result:activity')
  .end('activity') as (
  sessionId: string,
  activeSessionId: string | null,
  sessionState: SessionState | null,
  fallbackState: AgentProcessingState,
  connected: boolean,
  recovering: boolean,
  messages: readonly ChatMessage[]
) => NeoProcessingActivity;
