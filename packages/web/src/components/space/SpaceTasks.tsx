/**
 * SpaceTasks — tabbed task list for a space.
 *
 * Tabs: Action (review + blocked, grouped by reason),
 *       Active (open + in_progress + approved — see `task-filters.ts` for why
 *       `approved` belongs here),
 *       Completed (done + cancelled + archived), Scheduled.
 *
 * Within each tab, tasks are grouped by status/reason in TaskGroup cards,
 * matching the RoomTasks component style.
 */

import type { SpaceBlockReason, SpaceTask, SpaceTaskStatus, TaskSchedule } from '@hyperneo/shared';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { navigateToSpaceTasks } from '../../lib/router';
import { currentSpaceTasksFilterTabSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { isActionRequired, isActiveTask, isDraftTask } from '../../lib/task-filters';
import { getTaskStatusConfig } from '../../lib/task-status';
import { ActivitySpinner } from '../ui/ActivitySpinner';
import { Dropdown } from '../ui/Dropdown';
import { StatusBadge } from '../ui/StatusBadge';
import { formatRelativeFuture, getRelativeTime } from '../../lib/utils';

type TaskFilterTab = 'action' | 'active' | 'draft' | 'completed' | 'scheduled';
type LegacyTaskFilterTab = TaskFilterTab | 'archived';

/** Block reasons that indicate a task needs human attention */
const ATTENTION_BLOCK_REASONS: SpaceBlockReason[] = ['human_input_requested', 'gate_rejected'];

/**
 * Per-tab membership predicates. The `action` and `active` predicates are
 * the shared helpers from `task-filters.ts`, which are the single source
 * of truth also used by the sidebar in `SpaceDetailPanel` (Tasks-nav
 * badge, "Active"/"Action" sub-tabs). Both surfaces import from the same
 * helper so the lists and the badge counts cannot drift apart — see the
 * `task-filters.ts` doc comments for why `approved` belongs in Active.
 *
 * Exported for tests that assert the tasks-view's `active` predicate
 * matches the sidebar's `isActiveTask` exactly. Keeping this exported is
 * a regression guard: if someone later re-inlines the predicate here,
 * the parity test in `task-filters.test.ts` will fail.
 */
// Note: 'scheduled' tab is handled separately in the component (schedules, not tasks)
export const TAB_PREDICATES: Record<
  Exclude<TaskFilterTab, 'scheduled'>,
  (task: SpaceTask) => boolean
> = {
  action: isActionRequired,
  active: isActiveTask,
  draft: isDraftTask,
  completed: (t) => ['done', 'cancelled', 'archived'].includes(t.status),
};

/** Status group definitions within each tab */
interface StatusGroupDef {
  status: SpaceTaskStatus;
  title: string;
  variant: 'default' | 'yellow' | 'purple' | 'green' | 'red' | 'gray';
  /**
   * Optional secondary `block_reason` filter applied server-side. Used by
   * the Action tab to split blocked rows into "Needs Input" /
   * "Gate Pending" / generic-"Blocked" groups via the same paginated
   * `spaceTask.list` RPC. Tri-state: `undefined` = ignore the column,
   * `null` = match rows with no reason set, value = match exactly.
   */
  blockReason?: SpaceBlockReason | null;
  /**
   * Optional negative `block_reason` filter applied server-side. Mutually
   * exclusive with `blockReason`. Used by the Action tab's generic
   * "Blocked" bucket to include every blocked row whose reason is NOT one
   * of the attention-required values, plus rows with no reason set —
   * mirroring the legacy client-side filter.
   */
  blockReasonNotIn?: SpaceBlockReason[];
  /**
   * Local predicate run against the full `tasks` signal, used only to
   * compute the badge count shown in the group header. Mirrors the
   * server-side filter exactly so badge counts match the page total
   * the server returns. Defaults to a status-only match.
   */
  matchFn?: (task: SpaceTask) => boolean;
}

const ACTION_GROUPS: StatusGroupDef[] = [
  {
    status: 'blocked',
    title: 'Needs Input',
    variant: 'red',
    blockReason: 'human_input_requested',
    matchFn: (t) =>
      t.status === 'blocked' && (t.blockReason as SpaceBlockReason) === 'human_input_requested',
  },
  {
    status: 'blocked',
    title: 'Gate Pending',
    variant: 'red',
    blockReason: 'gate_rejected',
    matchFn: (t) =>
      t.status === 'blocked' && (t.blockReason as SpaceBlockReason) === 'gate_rejected',
  },
  { status: 'review', title: 'Awaiting Review', variant: 'purple' },
  {
    status: 'blocked',
    title: 'Blocked',
    variant: 'yellow',
    // Server-side: include every blocked row whose reason is NOT one of the
    // attention-required values (plus null reasons). Mirrors the legacy
    // client-side `!ATTENTION_BLOCK_REASONS.includes(...)` filter so the
    // totals stay disjoint from the two attention buckets above.
    blockReasonNotIn: ATTENTION_BLOCK_REASONS,
    matchFn: (t) =>
      t.status === 'blocked' &&
      !ATTENTION_BLOCK_REASONS.includes(t.blockReason as SpaceBlockReason),
  },
  // Paused on a rate/usage cap (Part C): the worker is in cooldown and
  // auto-resumes when the cap lifts (`restrictions.resetAt`), but the state
  // is surfaced here so it stays visible with its manual Resume/Cancel
  // actions while waiting.
  { status: 'rate_limited', title: 'Rate Limited', variant: 'yellow' },
  { status: 'usage_limited', title: 'Usage Limited', variant: 'yellow' },
];

const ACTIVE_GROUPS: StatusGroupDef[] = [
  { status: 'in_progress', title: 'In Progress', variant: 'yellow' },
  // `approved` is a transient state — the post-approval sub-session runs,
  // then `mark_complete` transitions the task to `done`. Surface it in
  // Active so a task stuck in `approved` (post-approval dispatch failed,
  // `postApprovalBlockedReason` populated) stays visible.
  { status: 'approved', title: 'Post-Approval Running', variant: 'green' },
  { status: 'open', title: 'Open', variant: 'default' },
];

const COMPLETED_GROUPS: StatusGroupDef[] = [
  { status: 'done', title: 'Done', variant: 'green' },
  { status: 'cancelled', title: 'Cancelled', variant: 'gray' },
  { status: 'archived', title: 'Archived', variant: 'gray' },
];

const DRAFT_GROUPS: StatusGroupDef[] = [{ status: 'draft', title: 'Drafts', variant: 'default' }];

const TAB_GROUPS_DEF: Record<Exclude<TaskFilterTab, 'scheduled'>, StatusGroupDef[]> = {
  action: ACTION_GROUPS,
  active: ACTIVE_GROUPS,
  draft: DRAFT_GROUPS,
  completed: COMPLETED_GROUPS,
};

type TabVariant = 'default' | 'amber' | 'purple' | 'green' | 'red' | 'gray';

interface TabConfig {
  key: TaskFilterTab;
  label: string;
  count: number;
  variant?: TabVariant;
}

function TabButton({
  label,
  count,
  isActive,
  onClick,
  variant = 'default',
}: {
  label: string;
  count: number;
  isActive: boolean;
  onClick: () => void;
  variant?: TabVariant;
}) {
  const baseClasses =
    'px-4 py-2 text-sm font-medium transition-colors relative flex items-center gap-1.5';

  const variantClasses: Record<string, string> = {
    default: isActive
      ? 'text-blue-400 border-b-2 border-blue-400'
      : 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent',
    amber: isActive
      ? 'text-amber-400 border-b-2 border-amber-400'
      : 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent',
    purple: isActive
      ? 'text-purple-400 border-b-2 border-purple-400'
      : 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent',
    green: isActive
      ? 'text-green-400 border-b-2 border-green-400'
      : 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent',
    red: isActive
      ? 'text-red-400 border-b-2 border-red-400'
      : 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent',
    gray: isActive
      ? 'text-gray-400 border-b-2 border-gray-500'
      : 'text-gray-400 hover:text-gray-400 border-b-2 border-transparent',
  };

  return (
    <button class={`${baseClasses} ${variantClasses[variant]}`} onClick={onClick}>
      {label}
      {count > 0 && (
        <span
          class={`text-xs px-1.5 py-0.5 rounded ${
            variant === 'amber'
              ? 'bg-amber-900/30'
              : variant === 'purple'
                ? 'bg-purple-900/30'
                : variant === 'green'
                  ? 'bg-green-900/30'
                  : variant === 'red'
                    ? 'bg-red-900/30'
                    : variant === 'gray'
                      ? 'bg-dark-800'
                      : 'bg-dark-700'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function MoreTabsDropdown({
  tabs,
  activeTab,
  navigationSpaceId,
}: {
  tabs: TabConfig[];
  activeTab: TaskFilterTab;
  navigationSpaceId: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const moreIsActive = tabs.some((tab) => tab.key === activeTab);

  return (
    <Dropdown
      position="left"
      items={[]}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      customContent={
        <div class="py-1 bg-dark-850 border border-dark-700 rounded-lg min-w-[160px]">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="menuitem"
              class="w-full px-4 py-2 text-left text-sm flex items-center justify-between gap-3 text-gray-300 hover:bg-dark-800 hover:text-gray-100 transition-colors"
              onClick={() => {
                navigateToSpaceTasks(navigationSpaceId, tab.key);
                setIsOpen(false);
              }}
            >
              <span>{tab.label}</span>
              {tab.count > 0 && (
                <span class="text-xs px-1.5 py-0.5 rounded bg-dark-700 text-gray-300">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      }
      trigger={
        <button
          type="button"
          class={`px-4 py-2 text-sm font-medium transition-colors relative flex items-center gap-1.5 ${
            moreIsActive
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent'
          }`}
          aria-label="More task tabs"
        >
          ⋯
        </button>
      }
    />
  );
}

function EmptyTabState({ tab }: { tab: TaskFilterTab }) {
  const messages: Record<TaskFilterTab, { title: string; description: string }> = {
    action: {
      title: 'No tasks needing action',
      description: 'Tasks requiring human input, review, or unblocking will appear here',
    },
    active: { title: 'No active tasks', description: 'Active tasks will appear here' },
    draft: { title: 'No draft tasks', description: 'Tasks created as drafts will appear here' },
    completed: {
      title: 'No completed tasks',
      description: 'Completed, cancelled, and archived tasks will appear here',
    },
    scheduled: {
      title: 'No scheduled tasks',
      description: 'Recurring and one-shot scheduled tasks will appear here',
    },
  };

  const { title, description } = messages[tab];

  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <p class="text-sm text-gray-400 font-medium">{title}</p>
      <p class="text-xs text-gray-400 mt-1">{description}</p>
    </div>
  );
}

/** Max dependency badges to render inline before collapsing into a "+N" overflow chip. */
const MAX_VISIBLE_DEPENDENCY_BADGES = 3;

/**
 * Inline dependency badges for a task. Each badge is a clickable pill showing
 * the prerequisite task number, coloured green when the dep is `done` and
 * gray otherwise. Deps not found in the loaded task list render as a gray
 * badge with a "task not found" tooltip. Shows at most
 * `MAX_VISIBLE_DEPENDENCY_BADGES` badges inline; any remainder is folded into
 * a non-interactive `+N` overflow chip.
 *
 * The dep lookup (`taskById`) is built once by the parent and passed in, so
 * the map construction is O(N) per render of the list — not per row.
 */
function TaskDependencyBadges({
  dependsOnIds,
  taskById,
  onSelectDependency,
}: {
  dependsOnIds: string[];
  taskById: ReadonlyMap<string, SpaceTask>;
  onSelectDependency?: (taskId: string) => void;
}) {
  if (dependsOnIds.length === 0) return null;

  const visible = dependsOnIds.slice(0, MAX_VISIBLE_DEPENDENCY_BADGES);
  const overflow = dependsOnIds.length - visible.length;

  return (
    <div class="flex items-center gap-1 flex-wrap mt-1" data-testid="task-dependency-badges">
      <span class="text-xs text-gray-400 mr-0.5">deps:</span>
      {visible.map((depId) => {
        const dep = taskById.get(depId);
        const isDone = dep?.status === 'done';
        const isMissing = !dep;

        const label = dep ? `#${dep.taskNumber}` : '#?';
        const tooltip = dep ? dep.title : 'task not found';

        const interactive = !isMissing && !!onSelectDependency;

        // Hover classes only applied when the badge is interactive —
        // disabled buttons shouldn't carry hover state, even though
        // browsers would ignore it.
        const colorClasses = isDone
          ? `text-green-300 bg-green-900/40 border-green-700/60${interactive ? ' hover:bg-green-900/60' : ''}`
          : `text-gray-300 bg-dark-700 border-dark-600${interactive ? ' hover:bg-dark-600' : ''}`;

        return (
          <button
            type="button"
            key={depId}
            data-testid="task-dependency-badge"
            data-dep-id={depId}
            data-dep-status={dep?.status ?? 'missing'}
            title={tooltip}
            disabled={!interactive}
            onClick={(e) => {
              e.stopPropagation();
              if (interactive) onSelectDependency(depId);
            }}
            class={`inline-flex items-center gap-0.5 text-xs font-mono font-medium px-1.5 py-0.5 rounded border flex-shrink-0 transition-colors ${colorClasses} ${interactive ? 'cursor-pointer' : 'cursor-default'}`}
          >
            {isMissing && (
              <span aria-hidden="true" class="text-amber-400">
                ⚠
              </span>
            )}
            {label}
          </button>
        );
      })}
      {overflow > 0 && (
        <span
          data-testid="task-dependency-overflow"
          class="inline-flex items-center text-xs font-mono font-medium text-gray-400 bg-dark-700 border border-dark-600 px-1.5 py-0.5 rounded flex-shrink-0"
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

/** Page size for per-group pagination in the Tasks view. */
const TASK_GROUP_PAGE_SIZE = 10;

/** Task group card with colored header, matching RoomTasks.TaskGroup style */
function TaskGroup({
  title,
  count,
  variant,
  tasks,
  taskById,
  onTaskClick,
  pagination,
  loading,
  error,
}: {
  title: string;
  count: number;
  variant: 'default' | 'yellow' | 'purple' | 'green' | 'red' | 'gray';
  tasks: SpaceTask[];
  taskById: ReadonlyMap<string, SpaceTask>;
  onTaskClick?: (taskId: string) => void;
  /**
   * Optional pagination footer rendered when the group's total exceeds the
   * page size. Encapsulates Prev/Next/range-text so the parent group wrapper
   * owns offset state while this card stays presentation-only.
   */
  pagination?: {
    offset: number;
    limit: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
    isLoading?: boolean;
  };
  /**
   * `true` while a paginated fetch is in flight. Used to render a loading
   * placeholder in place of (potentially stale) rows so the user can't
   * click into a task that no longer belongs to the visible page range.
   */
  loading?: boolean;
  /**
   * Error state for paginated groups. When set, an inline banner replaces
   * the rows and surfaces a Retry control. Pagination footer is preserved
   * so the user retains a navigation path even after a failed fetch.
   */
  error?: { message: string; onRetry?: () => void } | null;
}) {
  const headerStyles: Record<string, string> = {
    default: '',
    yellow: 'bg-yellow-900/20',
    purple: 'bg-purple-900/20',
    green: 'bg-green-900/20',
    red: 'bg-red-900/20',
    gray: 'bg-dark-800',
  };

  const titleStyles: Record<string, string> = {
    default: 'text-gray-100',
    yellow: 'text-yellow-400',
    purple: 'text-purple-400',
    green: 'text-green-400',
    red: 'text-red-400',
    gray: 'text-gray-400',
  };

  const borderStyles: Record<string, string> = {
    default: 'border-dark-700',
    yellow: 'border-dark-700',
    purple: 'border-dark-700',
    green: 'border-dark-700',
    red: 'border-red-800/60',
    gray: 'border-dark-700',
  };

  const showPagination = !!pagination && pagination.total > pagination.limit;

  // Body precedence: error > loading-without-rows > rows. We deliberately
  // render the loading placeholder when `tasks.length === 0` because the
  // parent (`PaginatedTaskGroup`) clears the row list while a new page is
  // fetching to prevent click-through to stale rows.
  const body = error ? (
    <div
      class="px-4 py-6 text-sm text-red-400 flex items-center justify-between gap-3"
      data-testid="task-group-error"
      role="alert"
    >
      <span>{error.message}</span>
      {error.onRetry && (
        <button
          type="button"
          class="px-2 py-1 text-xs rounded text-gray-300 hover:bg-dark-700"
          onClick={error.onRetry}
          data-testid="task-group-retry"
        >
          Retry
        </button>
      )}
    </div>
  ) : loading && tasks.length === 0 ? (
    <div class="px-4 py-6 text-xs text-gray-400" data-testid="task-group-loading" aria-busy="true">
      Loading…
    </div>
  ) : (
    <div class="divide-y divide-dark-700">
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} taskById={taskById} onClick={onTaskClick} />
      ))}
    </div>
  );

  return (
    <div class={`bg-dark-850 border rounded-xl overflow-hidden ${borderStyles[variant]}`}>
      <div
        class={`px-4 py-3 border-b ${borderStyles[variant]} ${headerStyles[variant]} flex items-center gap-1`}
      >
        <h3 class={`font-semibold ${titleStyles[variant]}`}>
          {title} ({count})
        </h3>
      </div>
      {body}
      {showPagination && pagination && (
        <TaskGroupPagination
          offset={pagination.offset}
          limit={pagination.limit}
          total={pagination.total}
          pageSize={tasks.length}
          onPrev={pagination.onPrev}
          onNext={pagination.onNext}
          isLoading={pagination.isLoading}
        />
      )}
    </div>
  );
}

/**
 * Footer row rendered below a paginated `TaskGroup` when the total row count
 * exceeds the page size. Shows "Showing X–Y of Z" with Prev/Next buttons.
 *
 * `pageSize` is the actual length of the current page (may be < `limit` on
 * the last page); used to compute the "Y" of "X–Y of Z" exactly without
 * needing an extra round-trip to the server.
 */
export function TaskGroupPagination({
  offset,
  limit,
  total,
  pageSize,
  onPrev,
  onNext,
  isLoading,
}: {
  offset: number;
  limit: number;
  total: number;
  pageSize: number;
  onPrev: () => void;
  onNext: () => void;
  isLoading?: boolean;
}) {
  const start = pageSize === 0 ? 0 : offset + 1;
  const end = offset + pageSize;
  const prevDisabled = offset === 0 || isLoading;
  const nextDisabled = offset + limit >= total || isLoading;

  const buttonClass =
    'px-2 py-1 text-xs rounded text-gray-300 hover:bg-dark-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent';

  return (
    <div
      data-testid="task-group-pagination"
      class="flex items-center justify-between px-4 py-2 border-t border-dark-700 bg-dark-900/30"
    >
      <button
        type="button"
        class={buttonClass}
        disabled={prevDisabled}
        data-testid="task-group-prev"
        onClick={onPrev}
      >
        ← Prev
      </button>
      <span class="text-xs text-gray-400" data-testid="task-group-range">
        Showing {start}–{end} of {total}
      </span>
      <button
        type="button"
        class={buttonClass}
        disabled={nextDisabled}
        data-testid="task-group-next"
        onClick={onNext}
      >
        Next →
      </button>
    </div>
  );
}

/** Individual task item — status conveyed by the unified StatusBadge, with an
 *  activity spinner when an in-progress task has a live workflow run behind it. */
function TaskItem({
  task,
  taskById,
  onClick,
}: {
  task: SpaceTask;
  taskById: ReadonlyMap<string, SpaceTask>;
  onClick?: (taskId: string) => void;
}) {
  const isClickable = !!onClick;
  const statusConfig = getTaskStatusConfig(task.status);
  // Show activity when a task is in_progress and either it's standalone (no
  // workflow run to gate on, so trust the status) or its workflow run is
  // genuinely live. Workflow tasks whose run has ended/crashed but whose status
  // lags don't spin; standalone tasks aren't blocked by the missing run.
  const showsActivity =
    task.status === 'in_progress' &&
    (!task.workflowRunId || spaceStore.activeRuns.value.some((r) => r.id === task.workflowRunId));

  return (
    <div
      data-testid="space-task-item"
      class={`px-4 py-3 ${isClickable ? 'cursor-pointer hover:bg-dark-800/50 transition-colors' : ''}`}
      onClick={isClickable ? () => onClick(task.id) : undefined}
    >
      <div class="flex items-start justify-between">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h4 class="text-sm font-medium text-gray-100 truncate">{task.title}</h4>
            <span class="inline-flex items-center text-xs font-mono font-medium text-gray-400 bg-dark-700 border border-dark-600 px-1.5 py-0.5 rounded flex-shrink-0">
              #{task.taskNumber}
            </span>
          </div>
          <div class="flex items-center gap-2 mt-1">
            <StatusBadge tone={statusConfig.tone} label={statusConfig.label} />
            {showsActivity && <ActivitySpinner tone="info" />}
            {task.updatedAt > 0 && (
              <span class="text-xs text-gray-400">{getRelativeTime(task.updatedAt)}</span>
            )}
          </div>
          <TaskDependencyBadges
            dependsOnIds={task.dependsOn}
            taskById={taskById}
            onSelectDependency={onClick}
          />
          {task.status === 'blocked' && task.result && (
            <p class="mt-1 text-xs text-amber-400/80 truncate" data-testid="task-blocked-reason">
              {task.result}
            </p>
          )}
        </div>
        <div class="ml-4 flex items-center flex-shrink-0">
          {isClickable && <span class="text-xs text-gray-400">&rarr;</span>}
        </div>
      </div>
    </div>
  );
}

interface SpaceTasksProps {
  spaceId: string;
  navigationSpaceId?: string;
  onSelectTask?: (taskId: string) => void;
}

export function SpaceTasks({ spaceId, navigationSpaceId, onSelectTask }: SpaceTasksProps) {
  const tasks = spaceStore.tasks.value;
  const schedules = spaceStore.schedules.value;
  const rawActiveTab = currentSpaceTasksFilterTabSignal.value as LegacyTaskFilterTab;
  const activeTab: TaskFilterTab = rawActiveTab === 'archived' ? 'completed' : rawActiveTab;
  const routeSpaceId = navigationSpaceId ?? spaceId;

  // Load schedules when the tab is switched to 'scheduled' or the active space changes.
  // Including spaceId in deps prevents stale schedules from a previous space lingering
  // when the user navigates between spaces while staying on the scheduled tab.
  useEffect(() => {
    if (activeTab === 'scheduled' && spaceId) {
      spaceStore.listSchedules().catch(() => {});
    }
  }, [activeTab, spaceId]);

  const counts = useMemo(() => {
    const c: Record<TaskFilterTab, number> = {
      action: 0,
      active: 0,
      draft: 0,
      completed: 0,
      scheduled: schedules.filter((s) => s.status !== 'completed').length,
    };
    for (const task of tasks) {
      for (const [tab, predicate] of Object.entries(TAB_PREDICATES) as [
        Exclude<TaskFilterTab, 'scheduled'>,
        (t: SpaceTask) => boolean,
      ][]) {
        if (predicate(task)) {
          c[tab]++;
          break;
        }
      }
    }
    return c;
  }, [tasks, schedules]);

  const filteredTasks = useMemo(() => {
    if (activeTab === 'scheduled') return [];
    const predicate = TAB_PREDICATES[activeTab as Exclude<TaskFilterTab, 'scheduled'>];
    if (!predicate) return [];
    // Used only to drive the tab-empty-state decision; the per-group
    // content is fetched server-side by `PaginatedTaskGroup`.
    return tasks.filter(predicate);
  }, [tasks, activeTab]);

  // Build the dep lookup once per render of the list — O(N) total rather
  // than O(N) per row inside the badge component.
  const taskById = useMemo(() => {
    const map = new Map<string, SpaceTask>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  // Empty-state guard is tab-aware: the Scheduled tab can have content even
  // when `tasks` is empty (a freshly-created schedule that hasn't fired yet).
  // Falling through to the global "No tasks yet" placeholder would hide the
  // schedule list, leaving users with no way to view/manage their schedules.
  // We always render the tab strip so users can navigate to the Scheduled tab
  // even when no tasks have been spawned yet.
  const showGlobalEmpty = tasks.length === 0 && activeTab !== 'scheduled';

  const draftTab: TabConfig | null =
    counts.draft > 0 ? { key: 'draft', label: 'Drafts', count: counts.draft } : null;
  const scheduledTab: TabConfig = { key: 'scheduled', label: 'Scheduled', count: counts.scheduled };
  const completedTab: TabConfig = {
    key: 'completed',
    label: 'Completed',
    count: counts.completed,
    variant: 'green',
  };
  const primaryTabs: TabConfig[] = [
    { key: 'action', label: 'Action', count: counts.action, variant: 'amber' },
    { key: 'active', label: 'Active', count: counts.active },
  ];
  const allTabs: TabConfig[] = [
    ...primaryTabs,
    ...(draftTab ? [draftTab] : []),
    scheduledTab,
    completedTab,
  ];

  // JS-driven mobile tab count — avoids Tailwind arbitrary-breakpoint ordering issues
  const [mobileTabCount, setMobileTabCount] = useState(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 0;
    return w > 420 ? 4 : w > 320 ? 3 : 2;
  });

  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      setMobileTabCount(w > 420 ? 4 : w > 320 ? 3 : 2);
    };
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const mobileTabs = allTabs.slice(0, mobileTabCount);
  const mobileOverflowTabs = allTabs.slice(mobileTabCount);

  return (
    <div class="flex-1 min-h-0 w-full px-4 py-4 sm:px-8 sm:py-6 overflow-y-auto">
      <div class="min-h-[calc(100%+1px)] space-y-6">
        <div class="flex border-b border-dark-700">
          {/* Mobile (<640px): JS-driven count */}
          <div class="flex sm:hidden">
            {mobileTabs.map((tab) => (
              <TabButton
                key={tab.key}
                label={tab.label}
                count={tab.count}
                isActive={activeTab === tab.key}
                onClick={() => navigateToSpaceTasks(routeSpaceId, tab.key)}
                variant={tab.variant}
              />
            ))}
            {mobileOverflowTabs.length > 0 && (
              <MoreTabsDropdown
                tabs={mobileOverflowTabs}
                activeTab={activeTab}
                navigationSpaceId={routeSpaceId}
              />
            )}
          </div>
          {/* Desktop (640px+): all tabs inline */}
          <div class="hidden sm:flex">
            {allTabs.map((tab) => (
              <TabButton
                key={tab.key}
                label={tab.label}
                count={tab.count}
                isActive={activeTab === tab.key}
                onClick={() => navigateToSpaceTasks(routeSpaceId, tab.key)}
                variant={tab.variant}
              />
            ))}
          </div>
        </div>

        {showGlobalEmpty ? (
          <div class="flex flex-col items-center justify-center py-16 text-center">
            <svg
              class="w-10 h-10 text-gray-400 mb-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={1.5}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            <p class="text-sm text-gray-400 font-medium">No tasks yet</p>
            <p class="text-xs text-gray-400 mt-1">Create a task to get started</p>
          </div>
        ) : activeTab === 'scheduled' ? (
          schedules.length === 0 ? (
            <EmptyTabState tab="scheduled" />
          ) : (
            <ScheduleList
              schedules={schedules}
              onPause={(id) => spaceStore.pauseSchedule(id).catch(() => {})}
              onResume={(id) => spaceStore.resumeSchedule(id).catch(() => {})}
              onDelete={(id) => spaceStore.deleteSchedule(id)}
            />
          )
        ) : filteredTasks.length === 0 ? (
          <EmptyTabState tab={activeTab} />
        ) : (
          <TaskGroupList
            tasks={tasks}
            taskById={taskById}
            tab={activeTab as Exclude<TaskFilterTab, 'scheduled'>}
            spaceId={spaceId}
            onTaskClick={onSelectTask}
          />
        )}
      </div>
    </div>
  );
}

/** Schedule list for the Scheduled tab */
function ScheduleList({
  schedules,
  onPause,
  onResume,
  onDelete,
}: {
  schedules: TaskSchedule[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => Promise<unknown>;
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = (id: string) => {
    setDeletingId(id);
    // Always clear `deletingId` once the RPC settles so a transient failure
    // (network blip, daemon restart) doesn't permanently disable the row's
    // Delete button for the rest of the session. The store throws on failure;
    // we swallow it here because the user-visible feedback is the row staying
    // in place — a follow-up retry just clicks Delete again.
    onDelete(id)
      .catch(() => {
        /* silently ignore — UI state stays as-is, user can retry */
      })
      .finally(() => {
        setDeletingId((curr) => (curr === id ? null : curr));
      });
  };

  const formatNextRun = (nextRunAt: number | null) => {
    if (!nextRunAt) return 'N/A';
    return formatRelativeFuture(nextRunAt);
  };

  const formatTrigger = (s: TaskSchedule) => {
    if (s.triggerType === 'cron') return s.cronExpression ?? 'cron';
    if (s.runAt) return `once at ${new Date(s.runAt).toLocaleString()}`;
    return 'one-shot';
  };

  return (
    <div class="space-y-2">
      {schedules.map((s) => (
        <div
          key={s.id}
          class="flex items-start gap-3 rounded-lg border border-dark-700 bg-dark-800 p-3"
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-gray-200 truncate">{s.title}</span>
              <span
                class={`text-xs px-1.5 py-0.5 rounded ${
                  s.status === 'active'
                    ? 'bg-green-900/40 text-green-400'
                    : s.status === 'paused'
                      ? 'bg-amber-900/40 text-amber-400'
                      : 'bg-gray-800 text-gray-400'
                }`}
              >
                {s.status}
              </span>
            </div>
            <div class="mt-1 flex items-center gap-3 text-xs text-gray-400">
              <span title="Trigger">{formatTrigger(s)}</span>
              {s.nextRunAt && s.status === 'active' && (
                <span>next: {formatNextRun(s.nextRunAt)}</span>
              )}
              {s.lastRunAt && <span>last: {getRelativeTime(s.lastRunAt)}</span>}
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            {s.status === 'active' && (
              <button
                class="px-2 py-1 text-xs rounded text-amber-400 hover:bg-amber-900/20"
                onClick={() => onPause(s.id)}
              >
                Pause
              </button>
            )}
            {s.status === 'paused' && (
              <button
                class="px-2 py-1 text-xs rounded text-green-400 hover:bg-green-900/20"
                onClick={() => onResume(s.id)}
              >
                Resume
              </button>
            )}
            <button
              class="px-2 py-1 text-xs rounded text-red-400 hover:bg-red-900/20"
              onClick={() => handleDelete(s.id)}
              disabled={deletingId === s.id}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Groups tasks by status within the selected tab, rendering TaskGroup cards */
function TaskGroupList({
  tasks,
  taskById,
  tab,
  spaceId,
  onTaskClick,
}: {
  tasks: SpaceTask[];
  taskById: ReadonlyMap<string, SpaceTask>;
  tab: Exclude<TaskFilterTab, 'scheduled'>;
  spaceId: string;
  onTaskClick?: (taskId: string) => void;
}) {
  const groups = TAB_GROUPS_DEF[tab];

  return (
    <div class="space-y-4">
      {groups.map((group) => {
        // Compute the badge count from the full `tasks` signal so it stays
        // in sync with real-time updates (e.g. a task transitions from
        // `open` to `in_progress` — the new "In Progress" badge updates
        // before the paginated fetch lands). The actual page contents are
        // fetched server-side from `PaginatedTaskGroup`.
        const matchFn = group.matchFn ?? ((t: SpaceTask) => t.status === group.status);
        const matching = tasks.filter(matchFn);
        const localCount = matching.length;

        // Skip rendering empty groups, mirroring the legacy behaviour.
        // Using the local count here means we don't fire a network
        // request just to learn there's nothing to show.
        if (localCount === 0) return null;

        // Content signature over the displayed fields of every task in this
        // group. Excludes only `updatedAt`: it advances on every running-task
        // step (the original re-fetch storm), while the fields below are stable
        // during stepping. `result` is included — the daemon writes it only on
        // discrete lifecycle transitions (done/blocked, outcome resolution,
        // gate rejection, reactivation), never during in_progress steps — so it
        // refreshes the blocked-row reason TaskItem renders without
        // reintroducing the churn. Sorted so update order within `tasks`
        // doesn't churn the signature.
        const contentSig = matching
          .map((t) =>
            [
              t.id,
              t.title,
              t.status,
              t.result ?? '',
              t.blockReason ?? '',
              t.pendingCheckpointType ?? '',
              (t.dependsOn ?? []).join(','),
            ].join(':')
          )
          .sort()
          .join('|');

        return (
          <PaginatedTaskGroup
            key={`${tab}-${group.title}`}
            spaceId={spaceId}
            group={group}
            localCount={localCount}
            contentSig={contentSig}
            taskById={taskById}
            onTaskClick={onTaskClick}
          />
        );
      })}
    </div>
  );
}

/**
 * Wrapper that owns per-group pagination state. Fetches a single page of
 * tasks for the group's status (and optional `blockReason` filter) on mount,
 * on group/space identity changes, on Prev/Next clicks, and whenever the
 * group's `contentSig` changes — i.e. a task was added/removed or a displayed
 * field (title/status/result/blockReason/pendingCheckpointType/dependsOn) was
 * edited.
 *
 * `contentSig` deliberately excludes `updatedAt`: a running task advances it
 * on every step, and wiring that into the deps re-fetched every visible
 * group's page on each step (the bug this corrects). Because the sig still
 * captures membership + displayed fields, both the row content and the
 * `page.total`-backed header count stay live on add/edit.
 */
function PaginatedTaskGroup({
  spaceId,
  group,
  localCount,
  contentSig,
  taskById,
  onTaskClick,
}: {
  spaceId: string;
  group: StatusGroupDef;
  localCount: number;
  /**
   * Signature over the stable, displayed fields of every task in the group
   * (ids + title/status/result/blockReason/pendingCheckpointType/dependsOn).
   * Excludes only `updatedAt`. A change re-runs the fetch so adds, removes,
   * and visible edits land in the page without refetching on every running-
   * task step.
   */
  contentSig: string;
  taskById: ReadonlyMap<string, SpaceTask>;
  onTaskClick?: (taskId: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ tasks: SpaceTask[]; total: number }>({
    tasks: [],
    total: 0,
  });
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  // Tracks whether the in-flight fetch was triggered by a Prev/Next click.
  // Only those should clear the visible rows so the user can't open a task
  // that no longer belongs to the page range shown in the footer.
  const [pageChanging, setPageChanging] = useState(false);
  // Bumped by the Retry button to force the fetch effect to rerun on the
  // same offset. Avoids hand-rolling an out-of-effect fetcher with its own
  // cancellation logic.
  const [retryNonce, setRetryNonce] = useState(0);

  // Reset offset to 0 when the group identity changes (tab switch, or — more
  // importantly — when the user navigates between spaces while staying on
  // the Tasks view: a stable `(title, status, blockReason)` triple across
  // spaces would otherwise leak rows from the previous space's first page
  // until something else churned the deps).
  const groupKey = `${spaceId}-${group.title}-${group.status}-${group.blockReason ?? ''}`;
  useEffect(() => {
    setOffset(0);
  }, [groupKey]);

  // Re-fetch when:
  //  - `groupKey` changes — different group/space identity
  //  - `offset` changes — Prev/Next clicks
  //  - `contentSig` changes — a task entered/left the group or a displayed
  //    field was edited. `updatedAt` is intentionally excluded so a running
  //    task stepping doesn't re-fetch every visible group on each step.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    spaceStore
      .fetchTaskGroup(group.status, {
        blockReason: group.blockReason,
        blockReasonNotIn: group.blockReasonNotIn,
        limit: TASK_GROUP_PAGE_SIZE,
        offset,
      })
      .then((result) => {
        if (cancelled) return;
        setHasError(false);
        setPage(result);

        // Clamp offset if total shrank (e.g. tasks moved to another
        // status while the user was on a deeper page). If the current
        // offset now points past the end, jump back one page so the
        // user keeps seeing content rather than an empty card.
        if (result.total > 0 && offset >= result.total) {
          const lastPageOffset =
            Math.max(0, Math.ceil(result.total / TASK_GROUP_PAGE_SIZE) - 1) * TASK_GROUP_PAGE_SIZE;
          setOffset(lastPageOffset);
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Keep the previous page's `total` so Prev/Next remain visible
        // and the user can click them to retry — collapsing to zero
        // would strand the user on a blank card with no in-UI recovery
        // after a transient RPC/network failure. Visible rows are
        // dropped (they may now be stale) and an inline error banner
        // is rendered in their place.
        setHasError(true);
        setPage((prev) => ({ tasks: [], total: prev.total }));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setPageChanging(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupKey, offset, contentSig, retryNonce]);

  // Use the server total once we have it; before the first fetch resolves,
  // fall back to the local count so the header doesn't flash "(0)" for
  // non-empty groups during initial load.
  const headerCount = page.total || localCount;

  // Manual retry handler used by the inline error banner. Bumps a nonce so
  // the fetch effect reruns on the same `offset` without duplicating
  // fetch/cancellation logic.
  const retry = () => {
    setHasError(false);
    setRetryNonce((n) => n + 1);
  };

  return (
    <TaskGroup
      title={group.title}
      count={headerCount}
      variant={group.variant}
      // While a Prev/Next page change is in flight (or after an error),
      // hide the previous page's rows so the user can't open a task that
      // no longer belongs to the range shown in the footer ("Showing
      // 11–20" with rows 1–10 still on screen would mismatch click
      // targets).
      tasks={pageChanging || hasError ? [] : page.tasks}
      taskById={taskById}
      onTaskClick={onTaskClick}
      loading={pageChanging}
      error={hasError ? { message: 'Failed to load tasks.', onRetry: retry } : null}
      pagination={{
        offset,
        limit: TASK_GROUP_PAGE_SIZE,
        total: page.total,
        onPrev: () => {
          setPageChanging(true);
          setOffset((o) => Math.max(0, o - TASK_GROUP_PAGE_SIZE));
        },
        onNext: () => {
          setPageChanging(true);
          setOffset((o) => o + TASK_GROUP_PAGE_SIZE);
        },
        isLoading: loading,
      }}
    />
  );
}
