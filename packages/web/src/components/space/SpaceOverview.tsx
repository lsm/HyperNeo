/**
 * SpaceOverview Component
 *
 * Overview dashboard showing:
 * - Runtime state indicator with pause/resume/stop/start controls (when available)
 * - Task stats summary (active, review, done counts)
 * - Recent tasks feed (latest task updates)
 * - Recent sessions (latest active sessions)
 */

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
import { ConfirmModal } from '../ui/ConfirmModal';
import { AutonomyWorkflowSummary } from './AutonomyWorkflowSummary';
import { FLAT_SURFACE, GLASS_SURFACE } from './glass-workspace';

// ─── Stat Card ───────────────────────────────────────────────────────────────

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
        GLASS_SURFACE,
        onClick
          ? 'cursor-pointer hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70'
          : 'cursor-default',
        color
      )}
    >
      <span class="text-2xl font-bold tabular-nums">{count}</span>
      <span class="text-xs text-gray-400 font-medium uppercase tracking-wider">{label}</span>
    </button>
  );
}

// ─── Runtime Controls ────────────────────────────────────────────────────────

const RUNTIME_STYLES: Record<
  RuntimeState,
  { bg: string; border: string; dot: string; label: string }
> = {
  running: {
    bg: 'bg-green-950/30',
    border: 'border-green-800/40',
    dot: 'bg-green-400',
    label: 'Running',
  },
  paused: {
    bg: 'bg-yellow-950/30',
    border: 'border-yellow-800/40',
    dot: 'bg-yellow-400',
    label: 'Paused',
  },
  stopped: {
    bg: 'bg-dark-850',
    border: 'border-dark-600',
    dot: 'bg-gray-500',
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
        GLASS_SURFACE,
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
          <span class="text-sm font-semibold text-gray-100">{style.label}</span>
          {actionLoading && <span class="ml-2 text-xs text-gray-400 italic">Processing...</span>}
        </div>
      </div>
      <div class="flex items-center gap-2">
        {state === 'running' && (
          <>
            <button
              onClick={onPause}
              disabled={actionLoading}
              class="px-3 py-1.5 text-xs font-medium text-yellow-300 bg-yellow-900/30 hover:bg-yellow-900/50 border border-yellow-700/40 rounded-lg transition-colors disabled:opacity-40"
            >
              Pause
            </button>
            <button
              onClick={onStop}
              disabled={actionLoading}
              class="px-3 py-1.5 text-xs font-medium text-red-300 bg-red-900/20 hover:bg-red-900/40 border border-red-700/40 rounded-lg transition-colors disabled:opacity-40"
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
              class="px-3 py-1.5 text-xs font-medium text-green-300 bg-green-900/30 hover:bg-green-900/50 border border-green-700/40 rounded-lg transition-colors disabled:opacity-40"
            >
              Resume
            </button>
            <button
              onClick={onStop}
              disabled={actionLoading}
              class="px-3 py-1.5 text-xs font-medium text-red-300 bg-red-900/20 hover:bg-red-900/40 border border-red-700/40 rounded-lg transition-colors disabled:opacity-40"
            >
              Stop
            </button>
          </>
        )}
        {state === 'stopped' && (
          <button
            onClick={onStart}
            disabled={actionLoading}
            class="px-3 py-1.5 text-xs font-medium text-green-300 bg-green-900/30 hover:bg-green-900/50 border border-green-700/40 rounded-lg transition-colors disabled:opacity-40"
          >
            Start
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Autonomy Level ─────────────────────────────────────────────────────────

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
    <div class={cn('min-h-[5.25rem] rounded-xl border px-4 py-3.5', GLASS_SURFACE)}>
      <div class="mb-2 flex items-center justify-between">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Autonomy</span>
        <span class="text-xs text-gray-400">{AUTONOMY_LABELS[level]}</span>
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
              'flex-1 rounded-full transition-colors py-1 focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none',
              l <= level
                ? l <= 2
                  ? 'bg-blue-500'
                  : l <= 4
                    ? 'bg-amber-500'
                    : 'bg-red-500'
                : 'bg-dark-600 hover:bg-dark-500'
            )}
          />
        ))}
      </div>
      <AutonomyWorkflowSummary level={level} workflows={workflows} compact class="mt-2" />
    </div>
  );
}

// ─── Concurrency Bar ──────────────────────────────────────────────────────

function ConcurrencyBar({ limit, onChange }: { limit: number; onChange: (n: number) => void }) {
  return (
    <div class={cn('min-h-[5.25rem] rounded-xl border px-4 py-3.5', GLASS_SURFACE)}>
      <div class="mb-2 flex items-center justify-between">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Concurrency
        </span>
        <span class="text-xs text-gray-400">
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
        class="w-full h-2 rounded-full appearance-none cursor-pointer bg-dark-700 accent-blue-500"
      />
    </div>
  );
}

// ─── Recent Tasks ─────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  in_progress: 'bg-blue-400/80 ring-blue-300/20',
  open: 'bg-gray-400/65 ring-gray-300/15',
  blocked: 'bg-amber-400/80 ring-amber-300/20',
  review: 'bg-purple-400/80 ring-purple-300/20',
  done: 'bg-green-400/75 ring-green-300/20',
  cancelled: 'bg-gray-500/60 ring-gray-400/15',
  archived: 'bg-gray-500/60 ring-gray-400/15',
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
      class="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-white/[0.055] focus-visible:bg-white/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/60"
    >
      <span
        class={cn(
          'h-1.5 w-1.5 flex-none rounded-full ring-2',
          STATUS_COLORS[task.status] ?? STATUS_COLORS.open
        )}
        aria-hidden="true"
      />
      <span class="sr-only">{STATUS_LABELS[task.status] ?? task.status}: </span>
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">{task.title}</span>
      <span class="flex-none font-mono text-[11px] font-medium text-gray-500">
        #{task.taskNumber}
      </span>
      <span class="flex-none text-xs tabular-nums text-gray-400">
        {getRelativeTime(task.updatedAt)}
      </span>
    </button>
  );
}

// ─── Main Dashboard ──────────────────────────────────────────────────────────

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

  const handleNewSession = useCallback(async () => {
    const space = spaceStore.space.value;
    const response = await createSession({ spaceId, workspacePath: space?.workspacePath });
    navigateToSpaceSession(routeSpaceId, response.sessionId);
  }, [spaceId, routeSpaceId]);

  const loading = spaceStore.loading.value;
  const space = spaceStore.space.value;
  const tasks = spaceStore.tasks.value;
  const workflows = spaceStore.workflows.value;
  const runtimeState = spaceStore.runtimeState.value;
  const sessions = spaceStore.sessions.value;

  // Memoize the full-array derivations so an unrelated signal tick (runtime
  // state, autonomy, concurrency) doesn't re-run every task pass + the
  // sessions sort on each render. All derivations are computed before the
  // early returns so the hook order stays stable across renders.
  const recentSessions = useMemo(
    () => [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 5),
    [sessions]
  );

  // Task counts
  const activeTasks = useMemo(
    () => tasks.filter((t) => t.status === 'open' || t.status === 'in_progress'),
    [tasks]
  );
  // Matches the Action-tab predicate (isActionRequired) so the overview count
  // and the Action list can't drift — rate/usage-limited tasks count here too.
  const reviewTasks = useMemo(() => tasks.filter(isActionRequired), [tasks]);
  const doneTasks = useMemo(
    () =>
      tasks.filter(
        (t) => t.status === 'done' || t.status === 'cancelled' || t.status === 'archived'
      ),
    [tasks]
  );

  // Recent tasks — sorted by updatedAt, top 5
  const recentTasks = useMemo(
    () => [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
    [tasks]
  );

  if (loading) {
    return (
      <div class="flex h-full items-center justify-center">
        <div class="text-center">
          <div class="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <p class="text-sm text-gray-400">Loading space...</p>
        </div>
      </div>
    );
  }

  if (!space) {
    return (
      <div class="flex h-full items-center justify-center">
        <p class="text-sm text-gray-400">Space not found</p>
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

        {/* Runtime state stays visible without delaying the operational summary. */}
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

        {/* Task state is the primary first-screen summary. */}
        <div class="grid grid-cols-3 gap-3">
          <StatCard
            label="Active"
            count={activeTasks.length}
            color="border-blue-800/30 text-blue-400"
            onClick={() => navigateToSpaceTasks(routeSpaceId, 'active')}
          />
          <StatCard
            label="Review"
            count={reviewTasks.length}
            color="border-purple-800/30 text-purple-400"
            onClick={() => navigateToSpaceTasks(routeSpaceId, 'action')}
          />
          <StatCard
            label="Done"
            count={doneTasks.length}
            color="border-green-800/30 text-green-400"
            onClick={() => navigateToSpaceTasks(routeSpaceId, 'completed')}
          />
        </div>

        {/* Configuration remains accessible but secondary to current state. */}
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
          {/* Recent Tasks */}
          <section
            class={cn(
              'h-full overflow-hidden rounded-2xl border',
              FLAT_SURFACE,
              recentSessions.length === 0 && 'xl:col-span-2'
            )}
            data-testid="overview-recent-tasks"
          >
            <div class="flex items-center justify-between border-b border-white/15 bg-white/[0.025] px-4 py-3.5 sm:px-5">
              <div>
                <h3 class="text-base font-semibold tracking-tight text-gray-50">Recent Tasks</h3>
                <p class="mt-0.5 text-[11px] text-gray-500">Latest work across this Space</p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateTask(true)}
                class="text-xs font-medium text-blue-300/85 underline-offset-4 transition-colors hover:text-blue-200 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
              >
                Create Task
              </button>
            </div>
            {recentTasks.length === 0 ? (
              <div class="flex flex-col items-center justify-center px-4 py-10 text-center">
                <svg
                  class="mb-3 h-9 w-9 text-gray-500"
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
                <p class="text-sm font-medium text-gray-200">No tasks yet</p>
                <p class="mt-1 text-xs text-gray-400">Create a task to get started</p>
              </div>
            ) : (
              <div class="divide-y divide-white/[0.08]">
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

          {/* Recent Sessions */}
          {recentSessions.length > 0 && (
            <section
              class={cn('h-full overflow-hidden rounded-2xl border', FLAT_SURFACE)}
              data-testid="overview-recent-sessions"
            >
              <div class="flex items-center justify-between border-b border-white/15 bg-white/[0.025] px-4 py-3.5 sm:px-5">
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-gray-50">
                    Recent Sessions
                  </h3>
                  <p class="mt-0.5 text-[11px] text-gray-500">Continue recent conversations</p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleNewSession()}
                  class="text-xs font-medium text-indigo-300/85 underline-offset-4 transition-colors hover:text-indigo-200 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70"
                >
                  New Session
                </button>
              </div>
              <div class="divide-y divide-white/[0.08]">
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

        {/* Stop Confirmation */}
        <ConfirmModal
          isOpen={showStopConfirm}
          onClose={() => setShowStopConfirm(false)}
          onConfirm={() => void handleStop()}
          title="Stop Space"
          message="Stopping will pause scheduling and interrupt active agent sessions. In-progress workflow work is preserved and resumes when you start the space again; standalone in-progress tasks pause and may need a manual restart. The space will not restart automatically."
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
      class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.055] focus-visible:bg-white/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60"
      onClick={onOpen}
    >
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">
        {session.title || 'Untitled Session'}
      </span>
      <span class="flex-none text-xs tabular-nums text-gray-400">
        {getRelativeTime(session.lastActiveAt)}
      </span>
    </button>
  );
}
