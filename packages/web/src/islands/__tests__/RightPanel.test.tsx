import { signal, type Signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/session-store', () => ({
  sessionStore: {
    activeSessionId: signal<string | null>(null),
    sessionState: signal(null),
    sessionInfo: signal(null),
  },
}));

vi.mock('../../components/space/TaskAuxiliaryPanel', () => ({
  TaskAuxiliaryPanel: (props: {
    spaceId: string;
    navigationSpaceId?: string;
    taskId: string;
    tab?: string;
  }) => (
    <div
      data-testid="task-auxiliary-panel"
      data-space-id={props.spaceId}
      data-navigation-space-id={props.navigationSpaceId ?? ''}
      data-task-id={props.taskId}
      data-tab={props.tab ?? ''}
    />
  ),
}));

vi.mock('../../components/space/GoalDetailPanel', () => ({
  GoalDetailPanel: (props: { spaceId: string; navigationSpaceId?: string; goalId: string }) => (
    <div
      data-testid="goal-detail-panel"
      data-space-id={props.spaceId}
      data-navigation-space-id={props.navigationSpaceId ?? ''}
      data-goal-id={props.goalId}
    />
  ),
}));

import {
  currentSpaceCanonicalIdSignal,
  currentSpaceGoalIdSignal,
  currentSpaceIdSignal,
  currentSpaceScopeIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
  navSectionSignal,
  rightPanelTargetSignal,
} from '../../lib/signals';
import { sessionStore } from '../../lib/session-store';
import type { Session } from '@hyperneo/shared';
import { RightPanel, RightPanelToggle } from '../RightPanel';

describe('RightPanelToggle', () => {
  beforeEach(() => {
    navSectionSignal.value = 'spaces';
    currentSpaceIdSignal.value = 'space-1';
    currentSpaceCanonicalIdSignal.value = null;
    currentSpaceViewModeSignal.value = 'goals';
    currentSpaceGoalIdSignal.value = null;
    currentSpaceScopeIdSignal.value = null;
    currentSpaceTaskIdSignal.value = null;
    rightPanelTargetSignal.value = null;
  });

  afterEach(() => {
    cleanup();
    rightPanelTargetSignal.value = null;
    currentSpaceCanonicalIdSignal.value = null;
    currentSpaceGoalIdSignal.value = null;
    currentSpaceScopeIdSignal.value = null;
    currentSpaceTaskIdSignal.value = null;
  });

  it('is hidden on the Goals view until a goal is selected', () => {
    const { container } = render(<RightPanelToggle />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('toggles the goal panel for the selected goal', () => {
    currentSpaceGoalIdSignal.value = 'goal-1';
    render(<RightPanelToggle />);

    fireEvent.click(screen.getByRole('button'));
    expect(rightPanelTargetSignal.value).toEqual({
      type: 'goal',
      spaceId: 'space-1',
      goalId: 'goal-1',
    });

    fireEvent.click(screen.getByRole('button'));
    expect(rightPanelTargetSignal.value).toBeNull();
  });

  it('uses the canonical space id for slug-routed panel targets', () => {
    currentSpaceIdSignal.value = 'space-slug';
    currentSpaceCanonicalIdSignal.value = 'space-1';
    currentSpaceGoalIdSignal.value = 'goal-1';
    render(<RightPanelToggle />);

    fireEvent.click(screen.getByRole('button'));
    expect(rightPanelTargetSignal.value).toEqual({
      type: 'goal',
      spaceId: 'space-1',
      goalId: 'goal-1',
    });
  });

  it('toggles the scope panel on the Forge view', () => {
    currentSpaceViewModeSignal.value = 'forge';
    currentSpaceScopeIdSignal.value = 'scope-1';
    render(<RightPanelToggle />);

    fireEvent.click(screen.getByRole('button'));
    expect(rightPanelTargetSignal.value).toEqual({
      type: 'scope',
      spaceId: 'space-1',
      scopeId: 'scope-1',
    });
  });

  it('toggles the task auxiliary panel on a task view', () => {
    currentSpaceViewModeSignal.value = 'overview';
    currentSpaceTaskIdSignal.value = 'task-1';
    render(<RightPanelToggle />);

    fireEvent.click(screen.getByRole('button'));
    expect(rightPanelTargetSignal.value).toEqual({
      type: 'task',
      spaceId: 'space-1',
      taskId: 'task-1',
      tab: 'details',
    });
  });

  it('passes the route space id to task panel navigation while keeping canonical targets', () => {
    currentSpaceIdSignal.value = 'space-slug';
    currentSpaceCanonicalIdSignal.value = 'space-1';
    rightPanelTargetSignal.value = {
      type: 'task',
      spaceId: 'space-1',
      taskId: 'task-1',
      tab: 'details',
    };

    render(<RightPanel />);

    const panel = screen.getByTestId('task-auxiliary-panel');
    expect(panel.getAttribute('data-space-id')).toBe('space-1');
    expect(panel.getAttribute('data-navigation-space-id')).toBe('space-slug');
  });

  it('passes the route space id to goal panel navigation while keeping canonical targets', () => {
    currentSpaceIdSignal.value = 'space-slug';
    currentSpaceCanonicalIdSignal.value = 'space-1';
    rightPanelTargetSignal.value = { type: 'goal', spaceId: 'space-1', goalId: 'goal-1' };

    render(<RightPanel />);

    const panel = screen.getByTestId('goal-detail-panel');
    expect(panel.getAttribute('data-space-id')).toBe('space-1');
    expect(panel.getAttribute('data-navigation-space-id')).toBe('space-slug');
  });

  it('retargets an open goal panel when the selected goal changes', async () => {
    currentSpaceGoalIdSignal.value = 'goal-1';
    rightPanelTargetSignal.value = { type: 'goal', spaceId: 'space-1', goalId: 'goal-1' };
    render(<RightPanelToggle />);

    currentSpaceGoalIdSignal.value = 'goal-2';

    await waitFor(() =>
      expect(rightPanelTargetSignal.value).toEqual({
        type: 'goal',
        spaceId: 'space-1',
        goalId: 'goal-2',
      })
    );
  });

  it('retargets an open scope panel when the selected scope changes', async () => {
    currentSpaceViewModeSignal.value = 'forge';
    currentSpaceScopeIdSignal.value = 'scope-1';
    rightPanelTargetSignal.value = { type: 'scope', spaceId: 'space-1', scopeId: 'scope-1' };
    render(<RightPanelToggle />);

    currentSpaceScopeIdSignal.value = 'scope-2';

    await waitFor(() =>
      expect(rightPanelTargetSignal.value).toEqual({
        type: 'scope',
        spaceId: 'space-1',
        scopeId: 'scope-2',
      })
    );
  });

  it('clears an open goal panel when navigating away from the Goals view', async () => {
    currentSpaceGoalIdSignal.value = 'goal-1';
    rightPanelTargetSignal.value = { type: 'goal', spaceId: 'space-1', goalId: 'goal-1' };
    render(<RightPanelToggle />);

    currentSpaceViewModeSignal.value = 'tasks';

    await waitFor(() => expect(rightPanelTargetSignal.value).toBeNull());
  });
});

describe('RightPanelToggle git target', () => {
  const mockSession = (id: string | null, info: Session | null, loaded = true) => {
    sessionStore.activeSessionId.value = id;
    (sessionStore.sessionState as unknown as Signal<unknown>).value = loaded
      ? { sessionInfo: info }
      : null;
    (sessionStore.sessionInfo as unknown as Signal<Session | null>).value = info;
  };

  beforeEach(() => {
    navSectionSignal.value = 'chats';
    currentSpaceIdSignal.value = null;
    currentSpaceCanonicalIdSignal.value = null;
    currentSpaceGoalIdSignal.value = null;
    currentSpaceScopeIdSignal.value = null;
    currentSpaceTaskIdSignal.value = null;
    rightPanelTargetSignal.value = null;
    mockSession(null, null);
  });

  afterEach(() => {
    cleanup();
    mockSession(null, null);
  });

  it('shows the git toggle for a direct-mode session with a workspace', () => {
    mockSession('s1', { id: 's1', workspacePath: '/repo' } as unknown as Session);
    const { container } = render(<RightPanelToggle />);
    expect(container.querySelector('button')).toBeTruthy();
  });

  it('toggles the git panel target for the active session', () => {
    mockSession('s1', { id: 's1', workspacePath: '/repo' } as unknown as Session);
    render(<RightPanelToggle />);

    fireEvent.click(screen.getByRole('button'));
    expect(rightPanelTargetSignal.value).toEqual({ type: 'git', sessionId: 's1' });

    fireEvent.click(screen.getByRole('button'));
    expect(rightPanelTargetSignal.value).toBeNull();
  });

  it('shows the git toggle for a worktree session even when features.worktree is false', () => {
    mockSession('s1', {
      id: 's1',
      workspacePath: '/repo',
      worktree: {
        isWorktree: true,
        worktreePath: '/wt',
        mainRepoPath: '/repo',
        branch: 'session/s1',
      },
      config: { features: { worktree: false } },
    } as unknown as Session);
    const { container } = render(<RightPanelToggle />);
    expect(container.querySelector('button')).toBeTruthy();
  });

  it('hides the git toggle when the session has no workspace', () => {
    mockSession('s1', { id: 's1', workspacePath: null } as unknown as Session);
    const { container } = render(<RightPanelToggle />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps the git toggle available while the next session metadata loads', () => {
    sessionStore.activeSessionId.value = 's1';
    (sessionStore.sessionState as unknown as Signal<unknown>).value = null;
    (sessionStore.sessionInfo as unknown as Signal<Session | null>).value = null;
    const { container } = render(<RightPanelToggle />);
    expect(container.querySelector('button')).toBeTruthy();
  });

  it('hides the git toggle on a terminal session load error', () => {
    mockSession('s1', null, true);
    const { container } = render(<RightPanelToggle />);
    expect(container.querySelector('button')).toBeNull();
  });
});
