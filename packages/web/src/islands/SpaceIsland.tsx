import { lazy, Suspense } from 'preact/compat';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { AgentOverlayChat } from '../components/space/AgentOverlayChat';
import { SpaceCreateTaskDialog } from '../components/space/SpaceCreateTaskDialog';
import { GLASS_PRIMARY_BUTTON_CLASS, GlassRouteShell } from '../components/space/glass-workspace';
import { SpacePageHeader } from '../components/space/SpacePageHeader';
import { TaskAuxiliaryPanel } from '../components/space/TaskAuxiliaryPanel';
import { createSession } from '../lib/api-helpers';
import {
  closeOverlayHistory,
  navigateBack,
  navigateToSpace,
  navigateToSpaceSession,
  navigateToSpaceTask,
  pushOverlayHistory,
} from '../lib/router';
import { sessionStore } from '../lib/session-store';
import type { SpaceViewMode } from '../lib/signals';
import {
  currentSpaceAgentHandleSignal,
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceViewModeSignal,
  spaceOverlayAgentNameSignal,
  spaceOverlayHighlightMessageIdSignal,
  spaceOverlayPendingAgentNameSignal,
  spaceOverlayPendingTaskIdSignal,
  spaceOverlaySessionIdSignal,
  spaceOverlayTaskContextSignal,
} from '../lib/signals';
import { parseLongHorizonAgentSessionId } from '../lib/space-agent-session';
import { spaceStore } from '../lib/space-store';
import { toast } from '../lib/toast';
import ChatContainer from './ChatContainer';

const SpaceConfigurePage = lazy(() =>
  import('../components/space/SpaceConfigurePage').then((m) => ({ default: m.SpaceConfigurePage }))
);
const SpaceSessionsPage = lazy(() =>
  import('../components/space/SpaceSessionsPage').then((m) => ({ default: m.SpaceSessionsPage }))
);
const SpaceTasks = lazy(() =>
  import('../components/space/SpaceTasks').then((m) => ({ default: m.SpaceTasks }))
);
const SpaceGoals = lazy(() =>
  import('../components/space/SpaceGoals').then((m) => ({ default: m.SpaceGoals }))
);
const SpaceForge = lazy(() =>
  import('../components/space/SpaceForge').then((m) => ({ default: m.SpaceForge }))
);
const SpaceOverview = lazy(() =>
  import('../components/space/SpaceOverview').then((m) => ({ default: m.SpaceOverview }))
);
const SpaceTaskPane = lazy(() =>
  import('../components/space/SpaceTaskPane').then((m) => ({ default: m.SpaceTaskPane }))
);
const SpaceLongHorizonAgents = lazy(() =>
  import('../components/space/SpaceLongHorizonAgents').then((m) => ({
    default: m.SpaceLongHorizonAgents,
  }))
);
const SpaceMemories = lazy(() =>
  import('../components/space/SpaceMemories').then((m) => ({ default: m.SpaceMemories }))
);

const lazyFallback = (
  <div class="flex-1 flex items-center justify-center bg-app-content">
    <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
  </div>
);

interface SpaceIslandProps {
  spaceId: string;
  routeSpaceId?: string | null;
  viewMode: SpaceViewMode;
  sessionViewId?: string | null;
  taskViewId?: string | null;
}

export default function SpaceIsland({
  spaceId,
  routeSpaceId,
  viewMode,
  sessionViewId,
  taskViewId,
}: SpaceIslandProps) {
  const navigationSpaceId = routeSpaceId ?? spaceId;
  const stillOnThisRouteSpace = () => {
    const currentRouteSpaceId = currentSpaceIdSignal.value;
    if (currentRouteSpaceId !== navigationSpaceId) return false;
    const currentCanonicalId = currentSpaceCanonicalIdSignal.value;
    return currentCanonicalId === null || currentCanonicalId === spaceId;
  };
  const selectedAgentHandle = currentSpaceAgentHandleSignal.value;
  const overlaySessionId = spaceOverlaySessionIdSignal.value;
  const overlayAgentName = spaceOverlayAgentNameSignal.value;
  const overlayHighlightMessageId = spaceOverlayHighlightMessageIdSignal.value;
  const overlayTaskContext = spaceOverlayTaskContextSignal.value;
  const overlayPendingTaskId = spaceOverlayPendingTaskIdSignal.value;
  const overlayPendingAgentName = spaceOverlayPendingAgentNameSignal.value;
  const handleOverlayClose = useCallback(() => {
    closeOverlayHistory();
  }, []);

  const handleRefreshAgentRecord = useCallback(async () => {
    const viewedId = sessionViewId;
    if (!viewedId) return;
    await spaceStore.refreshLongHorizonAgents();
    if (!stillOnThisRouteSpace()) return;
    if (currentSpaceSessionIdSignal.value !== viewedId) return;
    const parsed = parseLongHorizonAgentSessionId(viewedId);
    const nextId = parsed
      ? (spaceStore.longHorizonAgents.value.find((a) => a.id === parsed.agentId)?.sessionId ?? null)
      : viewedId;
    if (nextId && nextId !== viewedId) {
      navigateToSpaceSession(navigationSpaceId, nextId, true);
    } else {
      sessionStore.select(viewedId);
    }
  }, [sessionViewId, navigationSpaceId, stillOnThisRouteSpace]);

  const overlay =
    overlayPendingTaskId && overlayPendingAgentName ? (
      <AgentOverlayChat
        agentName={overlayPendingAgentName}
        onClose={handleOverlayClose}
        pendingAgent={{
          taskId: overlayPendingTaskId,
          agentName: overlayPendingAgentName,
          ...(overlayTaskContext?.workflowNodeId
            ? { workflowNodeId: overlayTaskContext.workflowNodeId }
            : {}),
        }}
      />
    ) : overlaySessionId ? (
      <AgentOverlayChat
        sessionId={overlaySessionId}
        agentName={overlayAgentName ?? undefined}
        highlightMessageId={overlayHighlightMessageId ?? undefined}
        onClose={handleOverlayClose}
        taskContext={overlayTaskContext}
      />
    ) : null;

  const overlayActive = !!overlay;
  const baseLayerProps = overlayActive ? { inert: true, 'aria-hidden': true as const } : {};

  useEffect(() => {
    type OverlayApi = { open: (sessionId: string, agentName?: string) => void; close: () => void };
    const w = window as typeof window & { __hyperneo_space_overlay?: OverlayApi };
    w.__hyperneo_space_overlay = {
      open(sessionId, agentName) {
        pushOverlayHistory(sessionId, agentName);
      },
      close() {
        closeOverlayHistory();
      },
    };
    return () => {
      w.__hyperneo_space_overlay = undefined;
    };
  }, []);

  const error = spaceStore.error.value;
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [, setActiveSessionRequestId] = useState<number | null>(null);

  const space = spaceStore.space.value;

  useEffect(() => {
    spaceStore.selectSpace(spaceId).catch(() => {
      // Error is tracked in spaceStore.error
    });
  }, [spaceId]);

  useEffect(() => {
    if (!taskViewId) return;
    spaceStore.subscribeTaskMessageActivity(taskViewId).catch(() => {});
    return () => {
      spaceStore.unsubscribeTaskMessageActivity(taskViewId);
    };
  }, [taskViewId]);

  useEffect(() => {
    if (viewMode !== 'tasks') {
      setCreateTaskOpen(false);
    }
  }, [viewMode]);
  useEffect(() => {
    setCreateTaskOpen(false);
  }, [spaceId]);

  useEffect(() => {
    setCreatingSession(false);
    setActiveSessionRequestId(null);
  }, [spaceId]);

  const handleTaskPaneClose = useCallback(() => {
    navigateBack(() => navigateToSpace(navigationSpaceId));
  }, [navigationSpaceId]);

  const handleSessionBack = useCallback(() => {
    navigateBack(() => navigateToSpace(navigationSpaceId));
  }, [navigationSpaceId]);

  const handleCreateSession = useCallback(
    async (e: Event) => {
      e.stopPropagation();
      if (creatingSession) return;
      const requestId = Date.now();
      setCreatingSession(true);
      setActiveSessionRequestId(requestId);
      const originViewMode = viewMode;
      try {
        const response = await createSession({
          spaceId,
          workspacePath: space?.workspacePath,
        });
        if (stillOnThisRouteSpace() && currentSpaceViewModeSignal.value === originViewMode) {
          navigateToSpaceSession(navigationSpaceId, response.sessionId);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to create session');
      } finally {
        setActiveSessionRequestId((current) => {
          if (current === requestId) {
            setCreatingSession(false);
            return null;
          }
          return current;
        });
      }
    },
    [
      spaceId,
      navigationSpaceId,
      space?.workspacePath,
      creatingSession,
      viewMode,
      stillOnThisRouteSpace,
    ]
  );

  if (sessionViewId) {
    const isSpaceAgentSession = sessionViewId === `space:chat:${spaceId}`;
    const isAgentSession = isSpaceAgentSession || sessionViewId.startsWith('space:agent:');
    return (
      <>
        <div
          class="flex-1 min-h-0 flex flex-col"
          data-testid="space-base-session-layer"
          {...baseLayerProps}
        >
          <ChatContainer
            key={sessionViewId}
            sessionId={sessionViewId}
            titleOverride={isSpaceAgentSession ? 'Coordinator' : undefined}
            onBack={handleSessionBack}
            agentLabel={isSpaceAgentSession ? 'space' : undefined}
            onRefreshAgent={isAgentSession ? handleRefreshAgentRecord : undefined}
          />
        </div>
        {overlay}
      </>
    );
  }
  if (!space && !error) {
    return (
      <div class="flex-1 flex items-center justify-center bg-app-content">
        <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!space && error) {
    return (
      <div class="flex-1 flex items-center justify-center bg-app-content">
        <div class="text-center max-w-sm">
          <p class="text-sm text-red-400 mb-2">Failed to load space</p>
          <p class="text-xs text-gray-400">{error}</p>
        </div>
      </div>
    );
  }

  if (taskViewId) {
    const showInMiddle = spaceStore.hasTaskMessageActivity(taskViewId) === false;
    return (
      <>
        <div
          class="flex-1 flex flex-col overflow-hidden bg-app-content"
          data-testid="space-task-pane"
          {...baseLayerProps}
        >
          <Suspense fallback={lazyFallback}>
            {showInMiddle ? (
              <TaskAuxiliaryPanel
                spaceId={spaceId}
                navigationSpaceId={navigationSpaceId}
                taskId={taskViewId}
                onClose={handleTaskPaneClose}
              />
            ) : (
              <SpaceTaskPane
                taskId={taskViewId}
                spaceId={spaceId}
                navigationSpaceId={navigationSpaceId}
                onClose={handleTaskPaneClose}
              />
            )}
          </Suspense>
        </div>
        {overlay}
      </>
    );
  }

  if (viewMode === 'tasks' && space) {
    return (
      <>
        <GlassRouteShell
          pageTitle="Tasks"
          appearance="hero"
          surfaceKey="tasks"
          testId="space-tasks-view"
          baseLayerProps={baseLayerProps}
          fallback={lazyFallback}
          actions={
            <button
              type="button"
              onClick={() => setCreateTaskOpen(true)}
              class={`${GLASS_PRIMARY_BUTTON_CLASS} !h-9 !px-3 sm:!px-4`}
              aria-label="Create task"
            >
              <svg
                class="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              <span class="ml-1.5 hidden sm:inline">Create task</span>
            </button>
          }
        >
          <SpaceTasks
            spaceId={spaceId}
            navigationSpaceId={navigationSpaceId}
            onSelectTask={(taskId) => navigateToSpaceTask(navigationSpaceId, taskId)}
            onCreateTask={() => setCreateTaskOpen(true)}
          />
        </GlassRouteShell>
        <SpaceCreateTaskDialog
          isOpen={createTaskOpen}
          onClose={() => setCreateTaskOpen(false)}
          onCreated={(task) => {
            if (currentSpaceViewModeSignal.value === 'tasks' && stillOnThisRouteSpace()) {
              navigateToSpaceTask(navigationSpaceId, task.id);
            }
          }}
        />
        {overlay}
      </>
    );
  }

  if (viewMode === 'goals' && space) {
    return (
      <>
        <GlassRouteShell
          pageTitle="Goals"
          appearance="hero"
          surfaceKey="goals"
          testId="space-goals-view"
          baseLayerProps={baseLayerProps}
          fallback={lazyFallback}
        >
          <SpaceGoals spaceId={spaceId} navigationSpaceId={navigationSpaceId} />
        </GlassRouteShell>
        {overlay}
      </>
    );
  }

  if (viewMode === 'forge' && space) {
    return (
      <>
        <GlassRouteShell
          pageTitle="Evolve"
          appearance="hero"
          surfaceKey="forge"
          testId="space-forge-view"
          baseLayerProps={baseLayerProps}
          fallback={lazyFallback}
        >
          <SpaceForge spaceId={spaceId} />
        </GlassRouteShell>
        {overlay}
      </>
    );
  }

  if (viewMode === 'sessions' && space) {
    return (
      <>
        <GlassRouteShell
          pageTitle="Sessions"
          appearance="hero"
          surfaceKey="sessions"
          testId="space-sessions-view"
          baseLayerProps={baseLayerProps}
          fallback={lazyFallback}
          actions={
            <button
              type="button"
              onClick={handleCreateSession}
              disabled={creatingSession}
              class={`${GLASS_PRIMARY_BUTTON_CLASS} !h-9 !px-3 sm:!px-4 disabled:cursor-not-allowed disabled:opacity-50`}
              aria-label="Create session"
            >
              <svg
                class="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              <span class="ml-1.5 hidden sm:inline">New session</span>
            </button>
          }
        >
          <SpaceSessionsPage
            spaceId={spaceId}
            navigationSpaceId={navigationSpaceId}
            onCreateSession={handleCreateSession}
            creatingSession={creatingSession}
          />
        </GlassRouteShell>
        {overlay}
      </>
    );
  }

  if (viewMode === 'agents' && space) {
    return (
      <>
        <GlassRouteShell
          pageTitle="Agents"
          appearance="hero"
          surfaceKey="agents"
          testId="space-agents-view"
          baseLayerProps={baseLayerProps}
          fallback={lazyFallback}
        >
          <SpaceLongHorizonAgents
            spaceId={spaceId}
            navigationSpaceId={navigationSpaceId}
            selectedHandle={selectedAgentHandle}
          />
        </GlassRouteShell>
        {overlay}
      </>
    );
  }

  if (viewMode === 'memories' && space) {
    return (
      <>
        <GlassRouteShell
          pageTitle="Memories"
          appearance="hero"
          surfaceKey="memories"
          testId="space-memories-view"
          baseLayerProps={baseLayerProps}
          fallback={lazyFallback}
        >
          <SpaceMemories spaceId={spaceId} />
        </GlassRouteShell>
        {overlay}
      </>
    );
  }

  if (viewMode === 'configure' && space) {
    return (
      <>
        <div
          class="flex-1 flex flex-col overflow-hidden bg-app-content"
          data-testid="space-configure-view"
          {...baseLayerProps}
        >
          <SpacePageHeader pageTitle="Settings" />
          <div class="flex-1 min-w-0 overflow-hidden flex flex-col">
            <Suspense fallback={lazyFallback}>
              <SpaceConfigurePage space={space} />
            </Suspense>
          </div>
        </div>
        {overlay}
      </>
    );
  }

  return (
    <>
      {overlay}
      <GlassRouteShell
        pageTitle="Overview"
        subtitle="Space operations and recent activity"
        surfaceKey="overview"
        testId="space-overview-view"
        baseLayerProps={baseLayerProps}
        fallback={lazyFallback}
      >
        <SpaceOverview
          spaceId={spaceId}
          navigationSpaceId={navigationSpaceId}
          onSelectTask={(taskId) => navigateToSpaceTask(navigationSpaceId, taskId)}
        />
      </GlassRouteShell>
    </>
  );
}
