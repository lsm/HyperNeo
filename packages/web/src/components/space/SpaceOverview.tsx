import { useState, useCallback, useMemo } from 'preact/hooks';
import type {
  RuntimeState,
  SpaceTask,
  SpaceAutonomyLevel,
  SpaceWorkflowSummary,
} from '@hyperneo/shared';
import { MAX_SPACE_CONCURRENT_TASKS, MIN_SPACE_CONCURRENT_TASKS } from '@hyperneo/shared';
import { spaceStore } from '../../lib/space-store';
import {
  navigateToSpaceTask,
  navigateToSpaceSession,
  navigateToSpaceTasks,
} from '../../lib/router';
import { createSession } from '../../lib/api-helpers';
import { cn, getRelativeTime } from '../../lib/utils';
import { toast } from '../../lib/toast';
import { AUTONOMY_LABELS } from '../../lib/space-constants';
import { isActionRequired } from '../../lib/task-filters';
import { SpaceCreateTaskDialog } from './SpaceCreateTaskDialog';
import { useSpaceWorkspaceChoice } from './SpaceWorkspacePicker';
import { ConfirmModal } from '../ui/ConfirmModal';
import { AutonomyWorkflowSummary } from './AutonomyWorkflowSummary';

function StatCard({
  label,
  count,
  color,
  onClick,
}: {
  label: string;
  count: number;
  color: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} tasks: ${count}`}
      class={cn(
        'flex flex-col items-center gap-1 rounded-xl border px-5 py-4 transition-all duration-200',
        'glass-surface',
        onClick
          ? 'cursor-pointer hover:-translate-y-0.5 hover:border-line-strong hover:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70'
          : 'cursor-default',
        color
      )}
    >
      <span class="text-2xl font-bold tabular-nums">{count}</span>
      <span class="text-xs text-fg-muted font-medium uppercase tracking-wider">{label}</span>
    </button>
  );
}

const RUNTIME_STYLES: Record<
  RuntimeState,
  { bg: string; border: string; dot: string; label: string }
> = {
  running: {
    bg: 'bg-green-950/30',
    border: 'border-green-800/40',
    dot: 'bg-success',
    label: 'Running',
  },
  paused: {
    bg: 'bg-yellow-950/30',
    border: 'border-yellow-800/40',
    dot: 'bg-warning',
    label: 'Paused',
  },
  stopped: {
    bg: 'bg-surface-overlay',
    border: 'border-line-strong',
    dot: 'bg-fg-faint',
    label: 'Stopped',
  },
};

function RuntimeControlBar({
  state,
  actionLoading,
  onPause,
  onResume,
  onStop,
  onStart,
}: {
  state: RuntimeState;
  actionLoading: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onStart: () => void;
}) {
  const style = RUNTIME_STYLES[state];

  return (
    <div
      class={cn(
        'flex items-center justify-between rounded-xl border px-4 py-3 transition-colors sm:px-5',
        'glass-surface',
        style.border
      )}
    >
      <div class="flex items-center gap-3">
        <div class="relative">
          <div class={cn('w-3.5 h-3.5 rounded-full', style.dot)} />
          {state === 'running' && (
            <div
              class={cn(
                'absolute inset-0 w-3.5 h-3.5 rounded-full animate-ping opacity-40',
                style.dot
              )}
            />
          )}
        </div>
        <div>
          <span class="text-sm font-semibold text-fg">{style.label}</span>
          {actionLoading && <span class="ml-2 text-xs text-fg-muted italic">Processing...</span>}
        </div>
      </div>
      <div class="flex items-center gap-2">
        {state === 'running' && (
          <>
            <button
              onClick={onPause}
              disabled={actionLoading}
              class="px-3 py-1.5 text-xs font-medium text-warning-soft bg-yellow-900/30 hover:bg-yellow-900/50 border border-yellow-700/40 rounded-lg transition-colors disabled:opacity-40"
            >
              Pause
            </button>
            <button
              onClick={onStop}
              disabled={actionLoading}
              class="px-3 py-1.5 text-xs font-medium text-danger-soft bg-danger/20 hover:bg-danger/40 border border-danger/40 rounded-lg transition-colors disabled:opacity-40"
            >
              Stop
            </button>
          </>
        )}
        {state === 'paused' && (
          <>
            <button
              onClick={onResume}
              disabled={actionLoading}
              class="px-3 py-1.5 text-xs font-medium text-success-soft bg-success/15 hover:bg-success/25 border border-success/40 rounded-lg transition-colors disabled:opacity-40"
            >
              Resume
            </button>
            <button
              onClick={onStop}
              disabled={actionLoading}
              class="px-3 py-1.5 text-xs font-medium text-danger-soft bg-danger/20 hover:bg-danger/40 border border-danger/40 rounded-lg transition-colors disabled:opacity-40"
            >
              Stop
            </button>
          </>
        )}
        {state === 'stopped' && (
          <button
            onClick={onStart}
            disabled={actionLoading}
            class="px-3 py-1.5 text-xs font-medium text-success-soft bg-success/15 hover:bg-success/25 border border-success/40 rounded-lg transition-colors disabled:opacity-40"
          >
            Start
          </button>
        )}
      </div>
    </div>
  );
}

function AutonomyLevelBar({
  level,
  workflows,
  onChange,
}: {
  level: SpaceAutonomyLevel;
  workflows: SpaceWorkflowSummary[];
  onChange: (level: SpaceAutonomyLevel) => void;
}) {
  return (
    <div class={cn('min-h-[5.25rem] rounded-xl border px-4 py-3.5', 'glass-surface')}>
      <div class="mb-2 flex items-center justify-between">
        <span class="text-xs font-semibold text-fg-muted uppercase tracking-wider">Autonomy</span>
        <span class="text-xs text-fg-muted">{AUTONOMY_LABELS[level]}</span>
      </div>
      <div class="flex gap-1.5">
        {([1, 2, 3, 4, 5] as SpaceAutonomyLevel[]).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => onChange(l)}
            data-testid={`overview-autonomy-${l}`}
            title={`Level ${l}: ${AUTONOMY_LABELS[l]}`}
            aria-label={AUTONOMY_LABELS[l]}
            class={cn(
              'flex-1 rounded-full transition-colors py-1 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
              l <= level
                ? l <= 2
                  ? 'bg-accent'
                  : l <= 4
                    ? 'bg-warning'
                    : 'bg-danger'
                : 'bg-line-strong hover:bg-fill-strong'
            )}
          />
        ))}
      </div>
      <AutonomyWorkflowSummary level={level} workflows={workflows} compact class="mt-2" />
    </div>
  );
}

function ConcurrencyBar({ limit, onChange }: { limit: number; onChange: (n: number) => void }) {
  return (
    <div class={cn('min-h-[5.25rem] rounded-xl border px-4 py-3.5', 'glass-surface')}>
      <div class="mb-2 flex items-center justify-between">
        <span class="text-xs font-semibold text-fg-muted uppercase tracking-wider">
          Concurrency
        </span>
        <span class="text-xs text-fg-muted">
          {limit} task{limit !== 1 ? 's' : ''}
        </span>
      </div>
      <input
        type="range"
        min={MIN_SPACE_CONCURRENT_TASKS}
        max={MAX_SPACE_CONCURRENT_TASKS}
        step={1}
        value={limit}
        data-testid="concurrency-slider"
        onChange={(e) => onChange(Number((e.target as HTMLInputElement).value))}
        class="w-full h-2 rounded-full appearance-none cursor-pointer bg-fill-strong accent-blue-500"
      />
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  in_progress: 'bg-accent-soft/80 ring-blue-300/20',
  open: 'bg-fg-muted/65 ring-gray-300/15',
  blocked: 'bg-warning/80 ring-warning/20',
  review: 'bg-cat-purple/80 ring-cat-purple/20',
  done: 'bg-success/75 ring-green-300/20',
  cancelled: 'bg-fg-faint/60 ring-fg-muted/15',
  archived: 'bg-fg-faint/60 ring-fg-muted/15',
};

const STATUS_LABELS: Record<string, string> = {
  in_progress: 'In progress',
  open: 'Open',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

function RecentTaskItem({ task, onClick }: { task: SpaceTask; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      class="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-fill-soft focus-visible:bg-fill-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
    >
      <span
        class={cn(
          'h-1.5 w-1.5 flex-none rounded-full ring-2',
          STATUS_COLORS[task.status] ?? STATUS_COLORS.open
        )}
        aria-hidden="true"
      />
      <span class="sr-only">{STATUS_LABELS[task.status] ?? task.status}: </span>
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-fg">{task.title}</span>
      <span class="flex-none font-mono text-[11px] font-medium text-fg-faint">
        #{task.taskNumber}
      </span>
      <span class="flex-none text-xs tabular-nums text-fg-muted">
        {getRelativeTime(task.updatedAt)}
      </span>
    </button>
  );
}

interface SpaceOverviewProps {
  spaceId: string;
  navigationSpaceId?: string;
  onSelectTask?: (taskId: string) => void;
}

export function SpaceOverview({ spaceId, navigationSpaceId, onSelectTask }: SpaceOverviewProps) {
  const routeSpaceId = navigationSpaceId ?? spaceId;
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const workspaceChoice = useSpaceWorkspaceChoice(spaceId, spaceStore.space.value?.workspacePath);

  const handlePause = useCallback(async () => {
    setActionLoading(true);
    try {
      await spaceStore.pauseSpace();
    } finally {
      setActionLoading(false);
    }
  }, []);

  const handleResume = useCallback(async () => {
    setActionLoading(true);
    try {
      await spaceStore.resumeSpace();
    } finally {
      setActionLoading(false);
    }
  }, []);

  const handleStop = useCallback(async () => {
    setActionLoading(true);
    try {
      await spaceStore.stopSpace();
    } finally {
      setActionLoading(false);
      setShowStopConfirm(false);
    }
  }, []);

  const handleStart = useCallback(async () => {
    setActionLoading(true);
    try {
      await spaceStore.startSpace();
    } finally {
      setActionLoading(false);
    }
  }, []);

  const handleAutonomyChange = useCallback(async (level: SpaceAutonomyLevel) => {
    if (level === spaceStore.space.value?.autonomyLevel) return;
    try {
      await spaceStore.updateSpace({ autonomyLevel: level });
      toast.success(`Autonomy: ${AUTONOMY_LABELS[level]}`);
    } catch {
      toast.error('Failed to update autonomy level');
    }
  }, []);

  const handleConcurrencyChange = useCallback(async (limit: number) => {
    const current = spaceStore.space.value?.maxConcurrentTasks ?? MIN_SPACE_CONCURRENT_TASKS;
    if (limit === current) return;
    try {
      await spaceStore.updateSpace({ maxConcurrentTasks: limit });
    } catch {
      toast.error('Failed to update concurrency');
    }
  }, []);

  const handleNewSession = useCallback(
    async (workspacePath?: string, worktreeMode?: 'worktree' | 'direct') => {
      const response = await createSession({ spaceId, workspacePath, worktreeMode });
      navigateToSpaceSession(routeSpaceId, response.sessionId);
    },
    [spaceId, routeSpaceId]
  );

  const loading = spaceStore.loading.value;
  const space = spaceStore.space.value;
  const tasks = spaceStore.tasks.value;
  const workflows = spaceStore.workflows.value;
  const runtimeState = spaceStore.runtimeState.value;
  const sessions = spaceStore.sessions.value;

  const recentSessions = useMemo(
    () => [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 5),
    [sessions]
  );

  const activeTasks = useMemo(
    () => tasks.filter((t) => t.status === 'open' || t.status === 'in_progress'),
    [tasks]
  );
  const reviewTasks = useMemo(() => tasks.filter(isActionRequired), [tasks]);
  const doneTasks = useMemo(
    () =>
      tasks.filter(
        (t) => t.status === 'done' || t.status === 'cancelled' || t.status === 'archived'
      ),
    [tasks]
  );

  const recentTasks = useMemo(
    () => [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
    [tasks]
  );

  if (loading) {
    return (
      <div class="flex h-full items-center justify-center">
        <div class="text-center">
          <div class="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p class="text-sm text-fg-muted">Loading space...</p>
        </div>
      </div>
    );
  }

  if (!space) {
    return (
      <div class="flex h-full items-center justify-center">
        <p class="text-sm text-fg-muted">Space not found</p>
      </div>
    );
  }

  const handleTaskClick =
    onSelectTask ?? ((taskId: string) => navigateToSpaceTask(routeSpaceId, taskId));

  return (
    <div
      class="flex-1 min-h-0 w-full overflow-y-auto px-4 py-4 sm:px-8 sm:py-6"
      data-testid="space-overview-dashboard"
    >
      <div class="mx-auto min-h-[calc(100%+1px)] max-w-6xl space-y-6">
        <SpaceCreateTaskDialog isOpen={showCreateTask} onClose={() => setShowCreateTask(false)} />
        {workspaceChoice.dialog}

        {runtimeState && (
          <RuntimeControlBar
            state={runtimeState}
            actionLoading={actionLoading}
            onPause={() => void handlePause()}
            onResume={() => void handleResume()}
            onStop={() => setShowStopConfirm(true)}
            onStart={() => void handleStart()}
          />
        )}

        <div class="grid grid-cols-3 gap-3">
          <StatCard
            label="Active"
            count={activeTasks.length}
            color="border-accent/30 text-accent"
            onClick={() => navigateToSpaceTasks(routeSpaceId, 'active')}
          />
          <StatCard
            label="Review"
            count={reviewTasks.length}
            color="border-purple-800/30 text-cat-purple"
            onClick={() => navigateToSpaceTasks(routeSpaceId, 'action')}
          />
          <StatCard
            label="Done"
            count={doneTasks.length}
            color="border-green-800/30 text-success"
            onClick={() => navigateToSpaceTasks(routeSpaceId, 'completed')}
          />
        </div>

        <div class="grid gap-3 lg:grid-cols-2">
          <AutonomyLevelBar
            level={space.autonomyLevel ?? 1}
            workflows={workflows}
            onChange={(l) => void handleAutonomyChange(l)}
          />
          <ConcurrencyBar
            limit={space.maxConcurrentTasks ?? MIN_SPACE_CONCURRENT_TASKS}
            onChange={(n) => void handleConcurrencyChange(n)}
          />
        </div>

        <div class="grid items-stretch gap-4 xl:grid-cols-2">
          <section
            class={cn(
              'h-full overflow-hidden rounded-2xl border',
              'flat-surface',
              recentSessions.length === 0 && 'xl:col-span-2'
            )}
            data-testid="overview-recent-tasks"
          >
            <div class="flex items-center justify-between border-b border-line bg-fill-soft px-4 py-3.5 sm:px-5">
              <div>
                <h3 class="text-base font-semibold tracking-tight text-fg">Recent Tasks</h3>
                <p class="mt-0.5 text-[11px] text-fg-faint">Latest work across this Space</p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateTask(true)}
                class="text-xs font-medium text-accent-soft/85 underline-offset-4 transition-colors hover:text-accent-soft hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                Create Task
              </button>
            </div>
            {recentTasks.length === 0 ? (
              <div class="flex flex-col items-center justify-center px-4 py-10 text-center">
                <svg
                  class="mb-3 h-9 w-9 text-fg-faint"
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
                <p class="text-sm font-medium text-fg-soft">No tasks yet</p>
                <p class="mt-1 text-xs text-fg-muted">Create a task to get started</p>
              </div>
            ) : (
              <div class="divide-y divide-line">
                {recentTasks.map((task) => (
                  <RecentTaskItem
                    key={task.id}
                    task={task}
                    onClick={() => handleTaskClick(task.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {recentSessions.length > 0 && (
            <section
              class={cn('h-full overflow-hidden rounded-2xl border', 'flat-surface')}
              data-testid="overview-recent-sessions"
            >
              <div class="flex items-center justify-between border-b border-line bg-fill-soft px-4 py-3.5 sm:px-5">
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-fg">Recent Sessions</h3>
                  <p class="mt-0.5 text-[11px] text-fg-faint">Continue recent conversations</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    workspaceChoice.chooseWorkspace(
                      (workspacePath, worktreeMode) =>
                        void handleNewSession(workspacePath, worktreeMode)
                    )
                  }
                  class="text-xs font-medium text-cat-indigo/85 underline-offset-4 transition-colors hover:text-cat-indigo hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cat-indigo/70"
                >
                  New Session
                </button>
              </div>
              <div class="divide-y divide-line">
                {recentSessions.map((session) => (
                  <RecentSessionRow
                    key={session.id}
                    session={session}
                    onOpen={() => navigateToSpaceSession(routeSpaceId, session.id)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        <ConfirmModal
          isOpen={showStopConfirm}
          onClose={() => setShowStopConfirm(false)}
          onConfirm={() => void handleStop()}
          title="Stop Space"
          message="Stopping will immediately terminate all active sessions and cancel in-progress work. The space will not restart automatically. You can start it again at any time."
          confirmText="Stop Space"
          isLoading={actionLoading}
        />
      </div>
    </div>
  );
}

function RecentSessionRow({
  session,
  onOpen,
}: {
  session: { title: string; lastActiveAt: number };
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-fill-soft focus-visible:bg-fill-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cat-indigo/60"
      onClick={onOpen}
    >
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-fg">
        {session.title || 'Untitled Session'}
      </span>
      <span class="flex-none text-xs tabular-nums text-fg-muted">
        {getRelativeTime(session.lastActiveAt)}
      </span>
    </button>
  );
}
