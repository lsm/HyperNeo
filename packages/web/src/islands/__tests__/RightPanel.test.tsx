import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the session/git branch inactive so these tests exercise the Space
// goal/scope toggle behavior in isolation.
vi.mock('../../lib/session-store', () => ({
  sessionStore: {
    activeSessionId: signal<string | null>(null),
    sessionInfo: signal(null),
  },
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
import { RightPanelToggle } from '../RightPanel';

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
