/**
 * SpaceOverview Component
 *
 * Overview dashboard showing:
 * - Runtime state indicator with pause/resume/stop/start controls (when available)
 * - Task stats summary (active, review, done counts)
 * - Recent tasks feed (latest task updates)
 * - Recent sessions (latest active sessions)
 */

import { useState, useCallback } from 'preact/hooks';
import type {
  RuntimeState,
  SpaceTask,
  SpaceAutonomyLevel,
  SpaceWorkflowSummary,
} from '@neokai/shared';
import { MAX_SPACE_CONCURRENT_TASKS, MIN_SPACE_CONCURRENT_TASKS } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import {
  navigateToSpaceTask,
  navigateToSpaceSession,
  navigateToSpaceTasks,
} from '../../lib/router';
import { createSession } from '../../lib/api-helpers';
import { useSessionRename } from '../../hooks/useSessionRename';
import { RenameIcon } from '../icons/RenameIcon';
import { cn, getRelativeTime } from '../../lib/utils';
import { toast } from '../../lib/toast';
import { AUTONOMY_LABELS } from '../../lib/space-constants';
import { SpaceCreateTaskDialog } from './SpaceCreateTaskDialog';
import { ConfirmModal } from '../ui/ConfirmModal';
import { AutonomyWorkflowSummary } from './AutonomyWorkflowSummary';

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
      class={cn(
        'flex flex-col items-center gap-1 rounded-xl border px-5 py-4 transition-all',
        'bg-dark-850/80 hover:bg-dark-800',
        onClick ? 'cursor-pointer' : 'cursor-default',
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
        'flex items-center justify-between rounded-xl border px-5 py-4 transition-colors',
        style.bg,
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
              class="px-4 py-2 text-sm font-medium text-yellow-300 bg-yellow-900/30 hover:bg-yellow-900/50 border border-yellow-700/40 rounded-lg transition-colors disabled:opacity-40"
            >
              Pause
            </button>
            <button
              onClick={onStop}
              disabled={actionLoading}
              class="px-4 py-2 text-sm font-medium text-red-300 bg-red-900/20 hover:bg-red-900/40 border border-red-700/40 rounded-lg transition-colors disabled:opacity-40"
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
              class="px-4 py-2 text-sm font-medium text-green-300 bg-green-900/30 hover:bg-green-900/50 border border-green-700/40 rounded-lg transition-colors disabled:opacity-40"
            >
              Resume
            </button>
            <button
              onClick={onStop}
              disabled={actionLoading}
              class="px-4 py-2 text-sm font-medium text-red-300 bg-red-900/20 hover:bg-red-900/40 border border-red-700/40 rounded-lg transition-colors disabled:opacity-40"
            >
              Stop
            </button>
          </>
        )}
        {state === 'stopped' && (
          <button
            onClick={onStart}
            disabled={actionLoading}
            class="px-4 py-2 text-sm font-medium text-green-300 bg-green-900/30 hover:bg-green-900/50 border border-green-700/40 rounded-lg transition-colors disabled:opacity-40"
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
    <div class="rounded-xl border border-dark-700 bg-dark-850/80 px-5 py-4">
      <div class="flex items-center justify-between mb-2.5">
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
      <AutonomyWorkflowSummary level={level} workflows={workflows} compact class="mt-2.5" />
    </div>
  );
}

// ─── Concurrency Bar ──────────────────────────────────────────────────────

function ConcurrencyBar({ limit, onChange }: { limit: number; onChange: (n: number) => void }) {
  return (
    <div class="rounded-xl border border-dark-700 bg-dark-850/80 px-5 py-4">
      <div class="flex items-center justify-between mb-2.5">
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
  in_progress: 'text-blue-400',
  open: 'text-gray-400',
  blocked: 'text-amber-400',
  review: 'text-purple-400',
  done: 'text-green-400',
  cancelled: 'text-gray-400',
  archived: 'text-gray-400',
};

function RecentTaskItem({ task, onClick }: { task: SpaceTask; onClick?: () => void }) {
  const statusColor = STATUS_COLORS[task.status] ?? 'text-gray-400';

  return (
    <button
      type="button"
      onClick={onClick}
      class="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-dark-800/60 transition-colors text-left group"
    >
      <div class={cn('w-2 h-2 rounded-full flex-shrink-0', statusColor.replace('text-', 'bg-'))} />
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-sm text-gray-200 group-hover:text-gray-100 truncate block">
            {task.title}
          </span>
          <span class="inline-flex items-center text-xs font-mono font-medium text-gray-400 bg-dark-700 border border-dark-600 px-1.5 py-0.5 rounded flex-shrink-0">
            #{task.taskNumber}
          </span>
        </div>
      </div>
      <span class="text-xs text-gray-400 flex-shrink-0 tabular-nums">
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

  // Recent sessions — sorted by lastActiveAt, top 5 (computed before early returns)
  const recentSessions = [...spaceStore.sessions.value]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, 5);

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

  // Task counts
  const activeTasks = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress');
  const reviewTasks = tasks.filter((t) => t.status === 'blocked' || t.status === 'review');
  const doneTasks = tasks.filter(
    (t) => t.status === 'done' || t.status === 'cancelled' || t.status === 'archived'
  );

  // Recent tasks — sorted by updatedAt, top 5
  const recentTasks = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

  // Awaiting-approval count: tasks paused at a `submit_for_approval`
  // (`task_completion`) checkpoint. Predicate matches the SpaceTasks filter
  // chip exactly so the two surfaces agree.
  const awaitingApprovalCount = tasks.filter(
    (t) => t.pendingCheckpointType === 'task_completion'
  ).length;

  const handleTaskClick =
    onSelectTask ?? ((taskId: string) => navigateToSpaceTask(routeSpaceId, taskId));

  const handleAwaitingApprovalClick = () => {
    navigateToSpaceTasks(routeSpaceId, 'action');
  };

  return (
    <div class="flex-1 min-h-0 w-full px-4 py-4 sm:px-8 sm:py-6 overflow-y-auto">
      <div class="min-h-[calc(100%+1px)] space-y-6">
        <SpaceCreateTaskDialog isOpen={showCreateTask} onClose={() => setShowCreateTask(false)} />

        {/* Runtime state with pause/resume/stop/start controls */}
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

        {/* Autonomy level */}
        <AutonomyLevelBar
          level={space.autonomyLevel ?? 1}
          workflows={workflows}
          onChange={(l) => void handleAutonomyChange(l)}
        />

        {/* Concurrency limit */}
        <ConcurrencyBar
          limit={space.maxConcurrentTasks ?? MIN_SPACE_CONCURRENT_TASKS}
          onChange={(n) => void handleConcurrencyChange(n)}
        />

        {/* Stats strip */}
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

        {/* Awaiting-approval summary — surfaces tasks paused at a
				`submit_for_approval` checkpoint as a single click-through. Hidden when
				the count is zero so it doesn't add visual noise to happy-path
				dashboards. */}
        {awaitingApprovalCount > 0 && (
          <button
            type="button"
            onClick={handleAwaitingApprovalClick}
            data-testid="awaiting-approval-summary"
            class="w-full flex items-center justify-between rounded-xl border border-amber-800/40 bg-amber-900/20 px-5 py-3 text-left transition-colors hover:bg-amber-900/30"
          >
            <div class="flex items-center gap-3">
              <span class="text-lg" aria-hidden="true">
                ⏸
              </span>
              <div>
                <p class="text-sm font-semibold text-amber-200">
                  {awaitingApprovalCount} {awaitingApprovalCount === 1 ? 'task' : 'tasks'} awaiting
                  your approval
                </p>
                <p class="text-xs text-amber-300/70">Paused awaiting approval — click to review</p>
              </div>
            </div>
            <span class="text-amber-400/80 text-sm" aria-hidden="true">
              &rarr;
            </span>
          </button>
        )}

        {/* Recent Tasks */}
        <div>
          <div class="flex items-center justify-between mb-2 px-1">
            <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Recent Tasks
            </h3>
            <button
              type="button"
              onClick={() => setShowCreateTask(true)}
              class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
            >
              Create Task
            </button>
          </div>
          {recentTasks.length === 0 ? (
            <div class="flex flex-col items-center justify-center py-12 text-center">
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
              <p class="text-sm text-gray-400">No tasks yet</p>
              <p class="text-xs text-gray-400 mt-1">Create a task to get started</p>
            </div>
          ) : (
            <div class="rounded-xl border border-dark-700 bg-dark-900/50 divide-y divide-dark-700/50 overflow-hidden">
              {recentTasks.map((task) => (
                <RecentTaskItem
                  key={task.id}
                  task={task}
                  onClick={() => handleTaskClick(task.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Recent Sessions */}
        {recentSessions.length > 0 && (
          <div>
            <div class="flex items-center justify-between mb-2 px-1">
              <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Recent Sessions
              </h3>
              <button
                type="button"
                onClick={() => void handleNewSession()}
                class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
              >
                New Session
              </button>
            </div>
            <div class="rounded-xl border border-dark-700 bg-dark-900/50 divide-y divide-dark-700/50 overflow-hidden">
              {recentSessions.map((session) => (
                <RecentSessionRow
                  key={session.id}
                  session={session}
                  onOpen={() => navigateToSpaceSession(routeSpaceId, session.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Stop Confirmation */}
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

/**
 * Recent-session row on the Space overview. Supports inline rename (hover pencil
 * or double-click the title) alongside click-to-open.
 */
function RecentSessionRow({
  session,
  onOpen,
}: {
  session: { id: string; title: string; lastActiveAt: number };
  onOpen: () => void;
}) {
  const { isEditing, startEditing, inputProps } = useSessionRename(session.id, session.title);

  if (isEditing) {
    return (
      <input
        type="text"
        data-testid="space-session-rename-input"
        {...inputProps}
        class="w-full mx-4 my-1 px-2 py-2 text-sm bg-white/10 rounded-lg text-gray-100 outline-none ring-1 ring-blue-500/60"
      />
    );
  }

  return (
    <div
      class="group/row relative w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-dark-800/60 transition-colors text-left cursor-pointer"
      onClick={onOpen}
    >
      <div class="w-2 h-2 rounded-full flex-shrink-0 bg-indigo-400" />
      <div class="flex-1 min-w-0">
        <span
          class="text-sm text-gray-200 truncate block"
          onDblClick={startEditing}
          title="Double-click to rename"
        >
          {session.title || 'Untitled Session'}
        </span>
      </div>
      <span class="text-xs text-gray-400 flex-shrink-0 tabular-nums">
        {getRelativeTime(session.lastActiveAt)}
      </span>
      <button
        type="button"
        data-testid="space-session-rename"
        onClick={(event) => {
          event.stopPropagation();
          startEditing();
        }}
        title="Rename session"
        aria-label={`Rename ${session.title || 'session'}`}
        class="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 p-1 rounded text-gray-500 transition-colors hover:text-gray-100 hover:bg-white/10"
      >
        <RenameIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
