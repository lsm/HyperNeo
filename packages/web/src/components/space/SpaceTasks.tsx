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

const ATTENTION_BLOCK_REASONS: SpaceBlockReason[] = ['human_input_requested'];

export const TAB_PREDICATES: Record<
  Exclude<TaskFilterTab, 'scheduled'>,
  (task: SpaceTask) => boolean
> = {
  action: isActionRequired,
  active: isActiveTask,
  draft: isDraftTask,
  completed: (t) => ['done', 'cancelled', 'archived'].includes(t.status),
};

interface StatusGroupDef {
  status: SpaceTaskStatus;
  title: string;
  variant: 'default' | 'yellow' | 'purple' | 'green' | 'red' | 'gray';
  blockReason?: SpaceBlockReason | null;
  blockReasonNotIn?: SpaceBlockReason[];
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
  { status: 'review', title: 'Awaiting Review', variant: 'purple' },
  {
    status: 'blocked',
    title: 'Blocked',
    variant: 'yellow',
    blockReasonNotIn: ATTENTION_BLOCK_REASONS,
    matchFn: (t) =>
      t.status === 'blocked' &&
      !ATTENTION_BLOCK_REASONS.includes(t.blockReason as SpaceBlockReason),
  },
  { status: 'rate_limited', title: 'Rate Limited', variant: 'yellow' },
  { status: 'usage_limited', title: 'Usage Limited', variant: 'yellow' },
];

const ACTIVE_GROUPS: StatusGroupDef[] = [
  { status: 'in_progress', title: 'In Progress', variant: 'yellow' },
  { status: 'approved', title: 'Post-Approval Running', variant: 'green' },
  { status: 'open', title: 'Open', variant: 'default' },
  { status: 'stopped', title: 'Stopped', variant: 'gray' },
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

const MAX_VISIBLE_DEPENDENCY_BADGES = 3;

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

const TASK_GROUP_PAGE_SIZE = 10;

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
  pagination?: {
    offset: number;
    limit: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
    isLoading?: boolean;
  };
  loading?: boolean;
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

  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'group';

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
    return tasks.filter(predicate);
  }, [tasks, activeTab]);

  const taskById = useMemo(() => {
    const map = new Map<string, SpaceTask>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

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
        const matchFn = group.matchFn ?? ((t: SpaceTask) => t.status === group.status);
        const matching = tasks.filter(matchFn);
        const localCount = matching.length;

        if (localCount === 0) return null;

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
  const [pageChanging, setPageChanging] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const groupKey = `${spaceId}-${group.title}-${group.status}-${group.blockReason ?? ''}`;
  useEffect(() => {
    setOffset(0);
  }, [groupKey]);

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

        if (result.total > 0 && offset >= result.total) {
          const lastPageOffset =
            Math.max(0, Math.ceil(result.total / TASK_GROUP_PAGE_SIZE) - 1) * TASK_GROUP_PAGE_SIZE;
          setOffset(lastPageOffset);
        }
      })
      .catch(() => {
        if (cancelled) return;
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

  const headerCount = page.total || localCount;

  const retry = () => {
    setHasError(false);
    setRetryNonce((n) => n + 1);
  };

  return (
    <TaskGroup
      title={group.title}
      count={headerCount}
      variant={group.variant}
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
