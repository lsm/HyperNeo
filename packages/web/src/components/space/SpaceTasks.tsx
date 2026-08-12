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
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { navigateToSpaceTasks } from '../../lib/router';
import { currentSpaceTasksFilterTabSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { isActionRequired, isActiveTask, isDraftTask } from '../../lib/task-filters';
import { toast } from '../../lib/toast';
import { getTaskStatusConfig } from '../../lib/task-status';
import { ActivitySpinner } from '../ui/ActivitySpinner';
import { StatusBadge } from '../ui/StatusBadge';
import { formatRelativeFuture, getRelativeTime } from '../../lib/utils';
import {
  FLAT_SURFACE,
  GLASS_CONTENT_CONTAINER_CLASS,
  GLASS_PRIMARY_BUTTON_CLASS,
  GLASS_SURFACE,
} from './glass-workspace';

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
  const activeTint: Record<TabVariant, string> = {
    default: 'bg-white/10 text-gray-50',
    amber: 'bg-amber-400/15 text-amber-100',
    purple: 'bg-purple-400/15 text-purple-100',
    green: 'bg-green-400/15 text-green-100',
    red: 'bg-red-400/15 text-red-100',
    gray: 'bg-white/10 text-gray-200',
  };
  return (
    <button
      type="button"
      class={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition sm:flex-none ${
        isActive ? activeTint[variant] : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
      }`}
      onClick={onClick}
      aria-pressed={isActive}
    >
      {label}
      {count > 0 && (
        <span
          class={`rounded px-1.5 py-0.5 text-xs ${
            isActive ? 'bg-black/20 text-current' : 'bg-white/10 text-gray-400'
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
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreIsActive = tabs.some((tab) => tab.key === activeTab);

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [isOpen]);

  // Move focus into the menu on open so arrow/Escape work immediately. Restored
  // to the trigger explicitly on Escape and after a selection (below); together
  // these match the keyboard behavior of the Dropdown this replaced.
  useEffect(() => {
    if (!isOpen) return;
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    firstItem?.focus();
  }, [isOpen]);

  const focusItemAt = (index: number) => {
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;
    items[(index + items.length) % items.length].focus();
  };

  const activeIndex = () => {
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!items) return -1;
    return Array.from(items).findIndex((item) => item === document.activeElement);
  };

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    // Open with the arrow keys in addition to the native Enter/Space toggle.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIsOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItemAt(activeIndex() + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const i = activeIndex();
      focusItemAt(i <= 0 ? 0 : i - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItemAt(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
      focusItemAt(items ? items.length - 1 : 0);
    }
  };

  return (
    <div ref={rootRef} class="relative flex-1 sm:flex-none">
      <button
        ref={triggerRef}
        type="button"
        class={`flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition sm:w-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/50 ${
          moreIsActive
            ? 'bg-white/10 text-gray-50'
            : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
        }`}
        aria-label={
          moreIsActive
            ? `More task tabs, ${tabs.find((tab) => tab.key === activeTab)?.label} selected`
            : 'More task tabs'
        }
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={onTriggerKeyDown}
      >
        <span>{moreIsActive ? tabs.find((tab) => tab.key === activeTab)?.label : 'More'}</span>
        <span aria-hidden="true">···</span>
      </button>
      {isOpen && (
        <div
          ref={menuRef}
          class={`absolute right-0 top-full z-50 mt-2 min-w-[180px] rounded-xl border p-1.5 ${FLAT_SURFACE}`}
          role="menu"
          onKeyDown={onMenuKeyDown}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="menuitem"
              aria-current={activeTab === tab.key ? 'page' : undefined}
              class="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-white/[0.07] hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/50"
              onClick={() => {
                triggerRef.current?.focus();
                setIsOpen(false);
                navigateToSpaceTasks(navigationSpaceId, tab.key);
              }}
            >
              <span>{tab.label}</span>
              {tab.count > 0 && (
                <span class="rounded bg-white/10 px-1.5 py-0.5 text-xs text-gray-300">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskStatePanel({
  title,
  description,
  icon = '○',
  role = 'status',
  action,
}: {
  title: string;
  description: string;
  icon?: string;
  role?: 'status' | 'alert';
  action?: ComponentChildren;
}) {
  return (
    <div
      class={`flex min-h-44 flex-col items-center justify-center rounded-2xl border px-6 py-10 text-center ${FLAT_SURFACE}`}
      role={role}
      data-testid="task-state-panel"
    >
      <span
        class="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-lg text-gray-400"
        aria-hidden="true"
      >
        {icon}
      </span>
      <p class="text-sm font-semibold text-gray-100">{title}</p>
      <p class="mt-1 max-w-md text-xs leading-5 text-gray-400">{description}</p>
      {action && <div class="mt-5">{action}</div>}
    </div>
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

  return <TaskStatePanel title={title} description={description} />;
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
            aria-label={
              isMissing
                ? 'Dependency task not found'
                : `${interactive ? 'Open dependency' : 'Dependency'} ${label}: ${tooltip}`
            }
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
          aria-label={`${overflow} more dependencies`}
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
  const accentStyles: Record<string, string> = {
    default: 'bg-sky-300/80',
    yellow: 'bg-amber-300/80',
    purple: 'bg-purple-300/80',
    green: 'bg-emerald-300/80',
    red: 'bg-red-300/80',
    gray: 'bg-gray-400/80',
  };

  const showPagination = !!pagination && pagination.total > pagination.limit;

  // Multi-word titles ("In Progress", "Post-Approval Running") must collapse to
  // a single valid ID token — `aria-labelledby` splits on whitespace, so a raw
  // title would make assistive tech look up several nonexistent IDs instead of
  // the actual heading.
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'group';

  // Body precedence: error > loading-without-rows > rows. We deliberately
  // render the loading placeholder when `tasks.length === 0` because the
  // parent (`PaginatedTaskGroup`) clears the row list while a new page is
  // fetching to prevent click-through to stale rows.
  const body = error ? (
    <div
      class="flex items-center justify-between gap-3 px-5 py-7 text-sm text-red-300"
      data-testid="task-group-error"
      role="alert"
    >
      <span>{error.message}</span>
      {error.onRetry && (
        <button
          type="button"
          class="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-gray-200 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/50"
          onClick={error.onRetry}
          data-testid="task-group-retry"
        >
          Retry
        </button>
      )}
    </div>
  ) : loading && tasks.length === 0 ? (
    <div
      class="flex items-center gap-2 px-5 py-7 text-xs text-gray-400"
      data-testid="task-group-loading"
      aria-busy="true"
      role="status"
    >
      <ActivitySpinner tone="info" />
      Loading tasks…
    </div>
  ) : (
    <div class="divide-y divide-white/10">
      {tasks.map((task) => (
        <TaskItem
          key={task.id}
          task={task}
          taskById={taskById}
          onClick={onTaskClick}
          showStatus={false}
        />
      ))}
    </div>
  );

  return (
    <section class="space-y-2" data-testid="task-group" aria-labelledby={`task-group-${slug}`}>
      <div class="flex items-center gap-2 px-1">
        <span class={`h-1.5 w-1.5 rounded-full ${accentStyles[variant]}`} aria-hidden="true" />
        <h3
          id={`task-group-${slug}`}
          class="text-xs font-semibold uppercase tracking-[0.14em] text-gray-300"
        >
          {title} ({count})
        </h3>
      </div>
      <div
        class={`overflow-hidden rounded-2xl border ${FLAT_SURFACE}`}
        data-testid="task-group-list"
      >
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
    </section>
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
    'rounded-lg px-2.5 py-1 text-xs text-gray-300 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div
      data-testid="task-group-pagination"
      class="flex items-center justify-between border-t border-white/10 bg-black/10 px-4 py-2"
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
      <span class="text-xs text-gray-400" data-testid="task-group-range" aria-live="polite">
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
  showStatus = true,
}: {
  task: SpaceTask;
  taskById: ReadonlyMap<string, SpaceTask>;
  onClick?: (taskId: string) => void;
  showStatus?: boolean;
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

  const activate = () => onClick?.(task.id);

  return (
    <div class="px-5 py-4">
      <div
        data-testid="space-task-item"
        class={`group flex items-start justify-between gap-4 outline-none transition ${
          isClickable
            ? 'cursor-pointer hover:bg-white/[0.045] focus-visible:bg-white/[0.045] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-200/55'
            : ''
        }`}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
        aria-label={isClickable ? `Open task #${task.taskNumber}: ${task.title}` : undefined}
        onClick={isClickable ? activate : undefined}
        onKeyDown={
          isClickable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  activate();
                }
              }
            : undefined
        }
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <h4 class="truncate text-[15px] font-semibold text-gray-50">{task.title}</h4>
            <span class="shrink-0 font-mono text-[11px] text-gray-500">#{task.taskNumber}</span>
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {showStatus && <StatusBadge tone={statusConfig.tone} label={statusConfig.label} />}
            {showsActivity && <ActivitySpinner tone="info" />}
            {task.updatedAt > 0 && (
              <span class="text-xs text-gray-500">Updated {getRelativeTime(task.updatedAt)}</span>
            )}
          </div>
        </div>
        {isClickable && (
          <svg
            class="mt-1 h-4 w-4 shrink-0 text-gray-600 transition group-hover:translate-x-0.5 group-hover:text-gray-300 group-focus-visible:translate-x-0.5 group-focus-visible:text-amber-200"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M7.21 14.77a.75.75 0 010-1.06L10.94 10 7.21 6.29a.75.75 0 111.06-1.06l4.25 4.24a.75.75 0 010 1.06l-4.25 4.24a.75.75 0 01-1.06 0z"
              clip-rule="evenodd"
            />
          </svg>
        )}
      </div>
      {/* Dependency pills are siblings of the row's button (not descendants):
          interactive elements inside role="button" are invalid ARIA and can be
          suppressed by assistive tech, so the badges render outside it. */}
      <TaskDependencyBadges
        dependsOnIds={task.dependsOn}
        taskById={taskById}
        onSelectDependency={onClick}
      />
      {task.status === 'blocked' && task.result && (
        <p
          class="mt-2 truncate text-xs leading-5 text-amber-200/75"
          data-testid="task-blocked-reason"
          title={task.result}
        >
          {task.result}
        </p>
      )}
    </div>
  );
}

interface SpaceTasksProps {
  spaceId: string;
  navigationSpaceId?: string;
  onSelectTask?: (taskId: string) => void;
  onCreateTask?: () => void;
}

export function SpaceTasks({
  spaceId,
  navigationSpaceId,
  onSelectTask,
  onCreateTask,
}: SpaceTasksProps) {
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

  // The middle column can stay narrow (mobile, or desktop with both side panels
  // open). Cap the compact strip at two inline tabs so the strip shows three
  // controls total (two tabs + the overflow trigger) and never overflows on
  // 320–420 px screens; the full set renders inline only at xl, where the
  // column has enough room.
  const compactTabCount = 2;
  const compactTabs = allTabs.slice(0, compactTabCount);
  const compactOverflowTabs = allTabs.slice(compactTabCount);

  return (
    <div class="flex-1 min-h-0 w-full overflow-y-auto">
      <div class={`${GLASS_CONTENT_CONTAINER_CLASS} space-y-4`}>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/80">
              Operational queue
            </p>
            <p class="mt-1 text-sm text-gray-400">
              Review attention, active execution, schedules, and completed outcomes.
            </p>
          </div>
          <p class="text-xs tabular-nums text-gray-500">
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} tracked
          </p>
        </div>
        <div
          class={`flex w-full gap-1 rounded-2xl border p-1.5 sm:w-auto sm:self-start ${GLASS_SURFACE}`}
        >
          {/* Compact middle column: priority tabs plus an overflow menu. */}
          <div class="flex w-full gap-1 sm:w-auto xl:hidden">
            {compactTabs.map((tab) => (
              <TabButton
                key={tab.key}
                label={tab.label}
                count={tab.count}
                isActive={activeTab === tab.key}
                onClick={() => navigateToSpaceTasks(routeSpaceId, tab.key)}
                variant={tab.variant}
              />
            ))}
            {compactOverflowTabs.length > 0 && (
              <MoreTabsDropdown
                tabs={compactOverflowTabs}
                activeTab={activeTab}
                navigationSpaceId={routeSpaceId}
              />
            )}
          </div>
          {/* Wide middle column: all tabs inline. */}
          <div class="hidden gap-1 xl:flex">
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
          <TaskStatePanel
            title="No tasks yet"
            description="Create a task to get started"
            icon="◇"
            action={
              onCreateTask ? (
                <button type="button" class={GLASS_PRIMARY_BUTTON_CLASS} onClick={onCreateTask}>
                  Create task
                </button>
              ) : undefined
            }
          />
        ) : activeTab === 'scheduled' ? (
          schedules.length === 0 ? (
            <EmptyTabState tab="scheduled" />
          ) : (
            <ScheduleList
              schedules={schedules}
              onPause={(id) => spaceStore.pauseSchedule(id)}
              onResume={(id) => spaceStore.resumeSchedule(id)}
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
  onPause: (id: string) => Promise<unknown>;
  onResume: (id: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}) {
  const [pendingAction, setPendingAction] = useState<{ id: string; action: string } | null>(null);

  const runAction = (id: string, action: string, operation: () => Promise<unknown>) => {
    setPendingAction({ id, action });
    operation()
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : `Failed to ${action} schedule`);
      })
      .finally(() => {
        setPendingAction((current) =>
          current?.id === id && current.action === action ? null : current
        );
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
    <section class="space-y-2" aria-labelledby="scheduled-tasks-heading">
      <div class="flex items-center gap-2 px-1">
        <span class="h-1.5 w-1.5 rounded-full bg-sky-300/80" aria-hidden="true" />
        <h3
          id="scheduled-tasks-heading"
          class="text-xs font-semibold uppercase tracking-[0.14em] text-gray-300"
        >
          Schedules
        </h3>
        <span class="text-xs tabular-nums text-gray-500">{schedules.length}</span>
      </div>
      <div class={`divide-y divide-white/10 overflow-hidden rounded-2xl border ${FLAT_SURFACE}`}>
        {schedules.map((s) => {
          const isPending = pendingAction?.id === s.id;
          return (
            <div key={s.id} class="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate text-[15px] font-semibold text-gray-50">{s.title}</span>
                  <span
                    class={`rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ${
                      s.status === 'active'
                        ? 'bg-emerald-400/10 text-emerald-200'
                        : s.status === 'paused'
                          ? 'bg-amber-400/10 text-amber-200'
                          : 'bg-white/[0.06] text-gray-400'
                    }`}
                  >
                    {s.status}
                  </span>
                </div>
                <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                  <span title="Trigger">Trigger · {formatTrigger(s)}</span>
                  {s.nextRunAt && s.status === 'active' && (
                    <span>Next · {formatNextRun(s.nextRunAt)}</span>
                  )}
                  {s.lastRunAt && <span>Last · {getRelativeTime(s.lastRunAt)}</span>}
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                {s.status === 'active' && (
                  <button
                    type="button"
                    class="rounded-lg px-2.5 py-1.5 text-xs text-amber-200 transition hover:bg-amber-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/50 disabled:opacity-40"
                    onClick={() => runAction(s.id, 'pause', () => onPause(s.id))}
                    disabled={isPending}
                    aria-label={`Pause schedule ${s.title}`}
                  >
                    Pause
                  </button>
                )}
                {s.status === 'paused' && (
                  <button
                    type="button"
                    class="rounded-lg px-2.5 py-1.5 text-xs text-emerald-200 transition hover:bg-emerald-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200/50 disabled:opacity-40"
                    onClick={() => runAction(s.id, 'resume', () => onResume(s.id))}
                    disabled={isPending}
                    aria-label={`Resume schedule ${s.title}`}
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  class="rounded-lg px-2.5 py-1.5 text-xs text-red-300 transition hover:bg-red-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/50 disabled:opacity-40"
                  onClick={() => runAction(s.id, 'delete', () => onDelete(s.id))}
                  disabled={isPending}
                  aria-label={`Delete schedule ${s.title}`}
                >
                  {pendingAction?.id === s.id && pendingAction.action === 'delete'
                    ? 'Deleting…'
                    : 'Delete'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
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
      loading={loading && (pageChanging || page.tasks.length === 0)}
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
