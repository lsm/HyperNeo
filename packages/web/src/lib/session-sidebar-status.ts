import type { AgentProcessingState, SessionStatus, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { getSessionLifecycleStatusConfig } from './session-lifecycle-status.ts';
import {
  getAgentProcessingStateConfig,
  type SessionProcessingTone,
} from './session-processing-phase.ts';
import { getTaskStatusConfig } from './task-status.ts';

export interface SidebarSessionStatus {
  tone: SessionProcessingTone;
  label: string;
  pulse: boolean;
  kind?: string;
}

interface SessionActivitySource {
  status?: string;
  processingState?: unknown;
}

function parseState(session: SessionActivitySource | null | undefined): Record<string, unknown> {
  let state = session?.processingState;
  if (typeof state === 'string') {
    try {
      state = JSON.parse(state);
    } catch {
      state = null;
    }
  }
  return state && typeof state === 'object' && !Array.isArray(state)
    ? (state as Record<string, unknown>)
    : { status: 'idle' };
}

function resolveStatus(
  session: SessionActivitySource | null | undefined,
  state: Record<string, unknown>
): SidebarSessionStatus {
  if (!session) return { tone: 'neutral', label: 'Not started', pulse: false, kind: 'not_started' };
  const lifecycle = session.status ?? 'active';
  if (['pending_worktree_choice', 'paused', 'ended', 'archived'].includes(lifecycle)) {
    const config = getSessionLifecycleStatusConfig(lifecycle as SessionStatus);
    return {
      ...config,
      label: lifecycle === 'pending_worktree_choice' ? 'Needs worktree choice' : config.label,
      pulse: false,
      kind: lifecycle,
    };
  }
  if (state.status === 'error') {
    return { tone: 'danger', label: 'Error', pulse: false, kind: 'interrupted' };
  }
  const config = getAgentProcessingStateConfig(state as unknown as AgentProcessingState);
  return {
    ...config,
    label: state.status === 'waiting_for_input' ? 'Waiting for input' : config.label,
    pulse: state.status === 'processing',
    kind: typeof state.status === 'string' ? state.status : 'idle',
  };
}

export const getSessionSidebarStatus = (superpipe({})('session-sidebar-status') as PipelineAPI)
  .input(['session'])
  .pipe(parseState, 'session', 'state')
  .pipe(resolveStatus, ['session', 'state'], 'status')
  .end('status') as (session: SessionActivitySource | null | undefined) => SidebarSessionStatus;

const ACTIVITY_PRIORITY: Record<string, number> = {
  waiting_for_input: 6,
  pending_worktree_choice: 6,
  interrupted: 2,
  rate_limit_cooldown: 5,
  processing: 4,
  queued: 3,
};

function selectTaskActivity(
  task: Pick<SpaceTask, 'status'>,
  statuses: SidebarSessionStatus[]
): SidebarSessionStatus {
  const fallback = { ...getTaskStatusConfig(task.status), pulse: false, kind: task.status };
  if (['draft', 'review', 'done', 'cancelled', 'archived', 'stopped'].includes(task.status)) {
    return fallback;
  }
  return statuses.reduce<SidebarSessionStatus>((selected, status) => {
    const priority = ACTIVITY_PRIORITY[status.kind ?? ''] ?? 0;
    return priority > (ACTIVITY_PRIORITY[selected.kind ?? ''] ?? 0) ? status : selected;
  }, fallback);
}

export const getTaskSidebarStatus = (superpipe({})('task-sidebar-status') as PipelineAPI)
  .input(['task', 'sessions'])
  .pipe(
    (sessions: SessionActivitySource[]) => sessions.map(getSessionSidebarStatus),
    'sessions',
    'statuses'
  )
  .pipe(selectTaskActivity, ['task', 'statuses'], 'status')
  .end('status') as (
  task: Pick<SpaceTask, 'status'>,
  sessions: SessionActivitySource[]
) => SidebarSessionStatus;

export function conversationTitle(title: string, isClone: boolean): string {
  return (
    (isClone ? title.replace(/\s*·\s*分身(?=\s*\d*\s*$)/u, '') : title).trim() || 'New conversation'
  );
}

export function cloneConversationTitles(
  parentTitle: string,
  clones: ReadonlyArray<{ id: string; title: string }>
): Map<string, string> {
  const reference = conversationTitle(parentTitle, false);
  const titles = new Map<string, string>();
  let ordinal = 1;
  for (const clone of clones) {
    const stripped = conversationTitle(clone.title, true);
    if (stripped === reference) {
      ordinal += 1;
      titles.set(clone.id, `${stripped} ${ordinal}`);
    } else {
      titles.set(clone.id, stripped);
    }
  }
  return titles;
}
