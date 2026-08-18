import { useEffect, useState } from 'preact/hooks';
import { GitPanel } from '../components/GitPanel.tsx';
import { GoalDetailPanel } from '../components/space/GoalDetailPanel.tsx';
import { ScopeDetailPanel } from '../components/space/ScopeDetailPanel.tsx';
import { TaskAuxiliaryPanel } from '../components/space/TaskAuxiliaryPanel.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import { sessionStore } from '../lib/session-store.ts';
import {
  currentSpaceCanonicalIdSignal,
  currentSpaceGoalIdSignal,
  currentSpaceIdSignal,
  currentSpaceScopeIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
  navSectionSignal,
  type RightPanelTarget,
  rightPanelTargetSignal,
} from '../lib/signals.ts';
import { cn } from '../lib/utils.ts';

const TRANSITION_MS = 200;
const DEFAULT_PANEL_WIDTH = 440;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 820;
const PANEL_WIDTH_STORAGE_KEY = 'hyperneo_right_panel_width';

function getMaxPanelWidth(): number {
  if (typeof window === 'undefined') return MAX_PANEL_WIDTH;
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.floor(window.innerWidth * 0.6)));
}

function clampPanelWidth(width: number): number {
  return Math.min(getMaxPanelWidth(), Math.max(MIN_PANEL_WIDTH, Math.round(width)));
}

function readStoredPanelWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_PANEL_WIDTH;
  try {
    const stored = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
    const width = stored ? Number(stored) : DEFAULT_PANEL_WIDTH;
    return Number.isFinite(width) ? clampPanelWidth(width) : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

function storePanelWidth(width: number) {
  try {
    window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(clampPanelWidth(width)));
  } catch {
    // Ignore storage failures; resizing should still work for this session.
  }
}

function useIsDesktopPanel(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.matchMedia('(min-width: 1024px)').matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsDesktop(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);

  return isDesktop;
}

function useToggleTarget(): RightPanelTarget | null {
  const activeSessionId = sessionStore.activeSessionId.value;
  const sessionState = sessionStore.sessionState.value;
  const session = sessionStore.sessionInfo.value;
  const activeSession = session?.id === activeSessionId ? session : null;
  const hasWorkspace = activeSessionId
    ? sessionState === null || Boolean(activeSession?.workspacePath || activeSession?.worktree)
    : false;

  const routeSpaceId = currentSpaceIdSignal.value;
  const inSpace = navSectionSignal.value === 'spaces' && routeSpaceId !== null;
  const spaceId = currentSpaceCanonicalIdSignal.value ?? routeSpaceId;
  const viewMode = currentSpaceViewModeSignal.value;
  const goalId = currentSpaceGoalIdSignal.value;
  const scopeId = currentSpaceScopeIdSignal.value;
  const taskId = currentSpaceTaskIdSignal.value;

  if (activeSessionId && hasWorkspace) {
    return { type: 'git', sessionId: activeSessionId };
  }
  if (inSpace && spaceId && taskId) {
    return { type: 'task', spaceId, taskId, tab: 'details' };
  }
  if (inSpace && spaceId && viewMode === 'goals' && goalId) {
    return { type: 'goal', spaceId, goalId };
  }
  if (inSpace && spaceId && viewMode === 'forge' && scopeId) {
    return { type: 'scope', spaceId, scopeId };
  }
  return null;
}

function targetMatchesContext(target: RightPanelTarget, toggleTarget: RightPanelTarget | null) {
  if (!toggleTarget) return false;
  if (target.type !== toggleTarget.type) return false;
  if (target.type === 'git') {
    return toggleTarget.type === 'git' && target.sessionId === toggleTarget.sessionId;
  }
  if (target.type === 'goal') {
    return (
      toggleTarget.type === 'goal' &&
      target.spaceId === toggleTarget.spaceId &&
      target.goalId === toggleTarget.goalId
    );
  }
  if (target.type === 'task') {
    return (
      toggleTarget.type === 'task' &&
      target.spaceId === toggleTarget.spaceId &&
      target.taskId === toggleTarget.taskId
    );
  }
  return (
    toggleTarget.type === 'scope' &&
    target.spaceId === toggleTarget.spaceId &&
    target.scopeId === toggleTarget.scopeId
  );
}

export function RightPanelToggle() {
  const target = rightPanelTargetSignal.value;
  const toggleTarget = useToggleTarget();
  const rightPanelOpen = target !== null && targetMatchesContext(target, toggleTarget);

  useEffect(() => {
    if (!target) return;
    if (!toggleTarget) {
      rightPanelTargetSignal.value = null;
      return;
    }
    if (!targetMatchesContext(target, toggleTarget)) {
      rightPanelTargetSignal.value = toggleTarget.type === target.type ? toggleTarget : null;
    }
  }, [target, toggleTarget]);

  if (!toggleTarget) return null;

  const handleToggle = () => {
    rightPanelTargetSignal.value = rightPanelOpen ? null : toggleTarget;
  };

  return (
    <IconButton
      title={rightPanelOpen ? 'Hide right panel' : 'Show right panel'}
      onClick={handleToggle}
      class={cn(
        'absolute right-3 top-2 z-40 bg-dark-900/80 backdrop-blur',
        rightPanelOpen && 'bg-white/10 text-gray-100 hover:bg-white/10'
      )}
    >
      <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={1.8}
          d="M4.75 5.75A2 2 0 016.75 3.75h10.5a2 2 0 012 2v12.5a2 2 0 01-2 2H6.75a2 2 0 01-2-2V5.75zM14.5 4v16"
        />
      </svg>
    </IconButton>
  );
}

export function RightPanel() {
  const target = rightPanelTargetSignal.value;
  const [renderedTarget, setRenderedTarget] = useState<RightPanelTarget | null>(target);
  const [open, setOpen] = useState(target !== null);
  const [panelWidth, setPanelWidth] = useState(readStoredPanelWidth);
  const [resizing, setResizing] = useState(false);
  const isDesktop = useIsDesktopPanel();

  useEffect(() => {
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (target) {
      setRenderedTarget(target);
      frame = requestAnimationFrame(() => setOpen(true));
    } else {
      setOpen(false);
      timer = setTimeout(() => setRenderedTarget(null), TRANSITION_MS);
    }

    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, [target]);

  useEffect(() => {
    const handleResize = () => {
      setPanelWidth((width) => clampPanelWidth(width));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const panelWidthValue = isDesktop ? `${panelWidth}px` : 'min(100vw, 420px)';

  const handleResizeStart = (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = panelWidth;
    let latestWidth = startWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      latestWidth = clampPanelWidth(startWidth + startX - moveEvent.clientX);
      setPanelWidth(latestWidth);
    };

    const handleMouseUp = () => {
      setResizing(false);
      storePanelWidth(latestWidth);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleResizeKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 48 : 16;
    let nextWidth: number | null = null;

    if (event.key === 'ArrowLeft') {
      nextWidth = clampPanelWidth(panelWidth + step);
    } else if (event.key === 'ArrowRight') {
      nextWidth = clampPanelWidth(panelWidth - step);
    } else if (event.key === 'Home') {
      nextWidth = MIN_PANEL_WIDTH;
    } else if (event.key === 'End') {
      nextWidth = getMaxPanelWidth();
    }

    if (nextWidth === null) return;
    event.preventDefault();
    setPanelWidth(nextWidth);
    storePanelWidth(nextWidth);
  };

  return (
    <>
      <div
        class={cn(
          'fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px] transition-opacity duration-200 lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
        onClick={() => {
          rightPanelTargetSignal.value = null;
        }}
      />
      <div
        class={cn(
          'fixed right-0 top-0 z-30 h-safe-screen overflow-hidden bg-transparent lg:relative lg:top-auto lg:z-auto lg:h-full lg:flex-shrink-0 lg:bg-app-content',
          !resizing && 'transition-[width] duration-200 ease-out'
        )}
        style={{ width: open && renderedTarget ? panelWidthValue : '0px' }}
      >
        <div
          class={cn(
            'relative h-full overflow-hidden rounded-l-[28px] border-l border-dark-700 bg-dark-800 pt-safe shadow-2xl transition-transform duration-200 ease-out lg:pt-0 lg:shadow-none',
            open ? 'translate-x-0' : 'translate-x-full'
          )}
          style={{ width: panelWidthValue }}
        >
          <div
            role="separator"
            aria-label="Resize right panel"
            aria-orientation="vertical"
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={getMaxPanelWidth()}
            aria-valuenow={panelWidth}
            tabIndex={0}
            onMouseDown={handleResizeStart}
            onKeyDown={handleResizeKeyDown}
            class="group absolute left-0 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none outline-none lg:block"
          >
            <div class="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-white/20 group-focus-visible:bg-white/30" />
          </div>
          {renderedTarget?.type === 'git' && <GitPanel sessionId={renderedTarget.sessionId} />}
          {renderedTarget?.type === 'goal' && (
            <GoalDetailPanel
              spaceId={renderedTarget.spaceId}
              navigationSpaceId={currentSpaceIdSignal.value ?? renderedTarget.spaceId}
              goalId={renderedTarget.goalId}
            />
          )}
          {renderedTarget?.type === 'scope' && (
            <ScopeDetailPanel spaceId={renderedTarget.spaceId} scopeId={renderedTarget.scopeId} />
          )}
          {renderedTarget?.type === 'task' && (
            <TaskAuxiliaryPanel
              spaceId={renderedTarget.spaceId}
              navigationSpaceId={currentSpaceIdSignal.value ?? renderedTarget.spaceId}
              taskId={renderedTarget.taskId}
              focusSection={renderedTarget.tab ?? undefined}
            />
          )}
        </div>
      </div>
    </>
  );
}
