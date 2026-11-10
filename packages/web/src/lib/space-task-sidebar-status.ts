import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  getSessionSidebarStatus,
  type SessionActivitySource,
  type SidebarSessionStatus,
} from './session-sidebar-status.ts';
import { getTaskStatusConfig } from './space-task-status.ts';

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
  if (
    [
      'draft',
      'review',
      'done',
      'cancelled',
      'archived',
      'stopped',
      'blocked',
      'rate_limited',
      'usage_limited',
    ].includes(task.status)
  ) {
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
