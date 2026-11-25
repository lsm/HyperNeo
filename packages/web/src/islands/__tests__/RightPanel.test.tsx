import { signal, type Signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLanguage } from '../../lib/i18n/index.ts';

vi.mock('../../lib/session-store', () => ({
  sessionStore: {
    activeSessionId: signal<string | null>(null),
    sessionState: signal(null),
    sessionInfo: signal(null),
    sdkMessages: signal([]),
    backgroundTaskMessages: signal([]),
  },
}));

vi.mock('../../components/SessionSchedules.tsx', () => ({
  SessionSchedules: (props: { sessionId: string }) => (
    <div data-testid="session-schedules" data-session-id={props.sessionId} />
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

import { navSectionSignal, rightPanelTargetSignal } from '../../lib/signals';
import {
  currentSpaceCanonicalIdSignal,
  currentSpaceGoalIdSignal,
  currentSpaceIdSignal,
  currentSpaceScopeIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
} from '../../lib/space-signals';
import { sessionStore } from '../../lib/session-store';
import type { Session } from '@hyperneo/shared';
import { RightPanel, RightPanelToggle } from '../RightPanel';
import { spaceWebExtension } from '../../lib/space-web-extension';
import { registerWebExtension } from '../../lib/web-extensions';

registerWebExtension('space', spaceWebExtension);

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
      type: 'extension',
      panel: 'goal',
      owner: 'space-1',
      item: 'goal-1',
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
      type: 'extension',
      panel: 'goal',
      owner: 'space-1',
      item: 'goal-1',
    });
  });

  it('toggles the scope panel on the Forge view', () => {
    currentSpaceViewModeSignal.value = 'forge';
    currentSpaceScopeIdSignal.value = 'scope-1';
    render(<RightPanelToggle />);

    fireEvent.click(screen.getByRole('button'));
    expect(rightPanelTargetSignal.value).toEqual({
      type: 'extension',
      panel: 'scope',
      owner: 'space-1',
      item: 'scope-1',
    });
  });

  it('shows no toggle on a task view', () => {
    currentSpaceViewModeSignal.value = 'overview';
    currentSpaceTaskIdSignal.value = 'task-1';
    render(<RightPanelToggle />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('passes the route space id to goal panel navigation while keeping canonical targets', () => {
    currentSpaceIdSignal.value = 'space-slug';
    currentSpaceCanonicalIdSignal.value = 'space-1';
    rightPanelTargetSignal.value = {
      type: 'extension',
      panel: 'goal',
      owner: 'space-1',
      item: 'goal-1',
    };

    render(<RightPanel />);

    const panel = screen.getByTestId('goal-detail-panel');
    expect(panel.getAttribute('data-space-id')).toBe('space-1');
    expect(panel.getAttribute('data-navigation-space-id')).toBe('space-slug');
  });

  it('retargets an open goal panel when the selected goal changes', async () => {
    currentSpaceGoalIdSignal.value = 'goal-1';
    rightPanelTargetSignal.value = {
      type: 'extension',
      panel: 'goal',
      owner: 'space-1',
      item: 'goal-1',
    };
    render(<RightPanelToggle />);

    currentSpaceGoalIdSignal.value = 'goal-2';

    await waitFor(() =>
      expect(rightPanelTargetSignal.value).toEqual({
        type: 'extension',
        panel: 'goal',
        owner: 'space-1',
        item: 'goal-2',
      })
    );
  });

  it('retargets an open scope panel when the selected scope changes', async () => {
    currentSpaceViewModeSignal.value = 'forge';
    currentSpaceScopeIdSignal.value = 'scope-1';
    rightPanelTargetSignal.value = {
      type: 'extension',
      panel: 'scope',
      owner: 'space-1',
      item: 'scope-1',
    };
    render(<RightPanelToggle />);

    currentSpaceScopeIdSignal.value = 'scope-2';

    await waitFor(() =>
      expect(rightPanelTargetSignal.value).toEqual({
        type: 'extension',
        panel: 'scope',
        owner: 'space-1',
        item: 'scope-2',
      })
    );
  });

  it('clears an open goal panel when navigating away from the Goals view', async () => {
    currentSpaceGoalIdSignal.value = 'goal-1';
    rightPanelTargetSignal.value = {
      type: 'extension',
      panel: 'goal',
      owner: 'space-1',
      item: 'goal-1',
    };
    render(<RightPanelToggle />);

    currentSpaceViewModeSignal.value = 'tasks';

    await waitFor(() => expect(rightPanelTargetSignal.value).toBeNull());
  });
});

describe('RightPanelToggle and schedules target', () => {
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

  it('shows no floating toggle for a chat; the header Schedules button owns the panel', () => {
    mockSession('s1', { id: 's1', workspacePath: '/repo' } as unknown as Session);
    const { container } = render(<RightPanelToggle />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders the schedules list for a schedules target', async () => {
    mockSession('s1', { id: 's1', workspacePath: '/repo' } as unknown as Session);
    rightPanelTargetSignal.value = { type: 'schedules', sessionId: 's1' };
    render(<RightPanel />);
    await waitFor(() => expect(screen.getByTestId('session-schedules')).toBeTruthy());
    expect(screen.getByTestId('schedules-panel').textContent).toContain('Schedules');
  });

  it('localizes the schedules panel header and close button', async () => {
    mockSession('s1', { id: 's1', workspacePath: '/repo' } as unknown as Session);
    applyLanguage('zh-Hans');
    try {
      rightPanelTargetSignal.value = { type: 'schedules', sessionId: 's1' };
      render(<RightPanel />);
      await waitFor(() => expect(screen.getByTestId('schedules-panel')).toBeTruthy());

      expect(screen.getByTestId('schedules-panel').textContent).toContain('定时检查');
      expect(screen.getByTestId('schedules-panel-close').getAttribute('title')).toBe(
        '关闭定时检查'
      );
    } finally {
      applyLanguage('en');
    }
  });

  it('closes the schedules panel when the active session changes', async () => {
    mockSession('s1', { id: 's1', workspacePath: '/repo' } as unknown as Session);
    rightPanelTargetSignal.value = { type: 'schedules', sessionId: 's1' };
    render(<RightPanelToggle />);
    mockSession('s2', { id: 's2', workspacePath: '/repo' } as unknown as Session);
    await waitFor(() => expect(rightPanelTargetSignal.value).toBeNull());
  });
});
