import type { SpaceLongHorizonAgent } from '@neokai/shared';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { spaceStore } from '../../lib/space-store';
import {
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
  navSectionSignal,
} from '../../lib/signals';
import { BottomTabBar } from '../BottomTabBar';

vi.mock('../../lib/router', () => ({
  navigateToSessions: vi.fn(),
  navigateToSettings: vi.fn(),
  navigateToSpaces: vi.fn(),
  navigateToSpace: vi.fn(),
  navigateToSpaceTasks: vi.fn(),
  navigateToSpaceSessions: vi.fn(),
  navigateToSpaceAgent: vi.fn(),
  navigateToSpaceConfigure: vi.fn(),
}));

const makeLongHorizonAgent = (sessionId: string): SpaceLongHorizonAgent => ({
  id: 'agent-1',
  spaceId: 'space-1',
  handle: 'reviewer',
  displayName: 'Reviewer',
  templateKey: null,
  status: 'active',
  sessionId,
  instructions: '',
  autonomyLevel: null,
  model: null,
  thinkingLevel: null,
  provider: null,
  settingSources: null,
  toolPermissions: {},
  createdAt: 1,
  updatedAt: 1,
});

function selectedTabLabel(): string {
  return screen.getByRole('tab', { selected: true }).getAttribute('aria-label') ?? '';
}

describe('BottomTabBar space active tab', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    navSectionSignal.value = 'spaces';
    currentSpaceIdSignal.value = 'space-1';
    currentSpaceCanonicalIdSignal.value = null;
    currentSpaceViewModeSignal.value = 'overview';
    currentSpaceTaskIdSignal.value = null;
    currentSpaceSessionIdSignal.value = null;
    spaceStore.longHorizonAgents.value = [];
  });

  afterEach(() => {
    cleanup();
    currentSpaceIdSignal.value = null;
    currentSpaceCanonicalIdSignal.value = null;
    currentSpaceTaskIdSignal.value = null;
    currentSpaceSessionIdSignal.value = null;
    spaceStore.longHorizonAgents.value = [];
  });

  it('selects Overview for space overview', () => {
    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Overview');
  });

  it('selects Sessions for ad-hoc space session chat', () => {
    currentSpaceSessionIdSignal.value = 'session-1';

    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Sessions');
  });

  it('selects Tasks for task view', () => {
    currentSpaceTaskIdSignal.value = 'task-1';

    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Tasks');
  });

  it('selects Agents for coordinator chat', () => {
    currentSpaceSessionIdSignal.value = 'space:chat:space-1';

    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Agents');
  });

  it('selects Agents for slug-routed coordinator chat', () => {
    currentSpaceIdSignal.value = 'space-slug';
    currentSpaceCanonicalIdSignal.value = 'space-1';
    currentSpaceSessionIdSignal.value = 'space:chat:space-1';

    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Agents');
  });

  it('selects Agents for long-horizon agent chat', () => {
    currentSpaceSessionIdSignal.value = 'session-agent-1';
    spaceStore.longHorizonAgents.value = [makeLongHorizonAgent('session-agent-1')];

    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Agents');
  });

  it('selects Agents for direct long-horizon agent session routes before config loads', () => {
    currentSpaceSessionIdSignal.value = 'space:agent:space-1:agent-1';
    spaceStore.longHorizonAgents.value = [];

    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Agents');
  });

  it('updates highlight when space subview signals change', () => {
    const { rerender } = render(<BottomTabBar />);
    expect(selectedTabLabel()).toBe('Overview');

    currentSpaceTaskIdSignal.value = 'task-1';
    rerender(<BottomTabBar />);
    expect(selectedTabLabel()).toBe('Tasks');

    currentSpaceTaskIdSignal.value = null;
    currentSpaceSessionIdSignal.value = 'session-1';
    rerender(<BottomTabBar />);
    expect(selectedTabLabel()).toBe('Sessions');

    currentSpaceSessionIdSignal.value = 'space:chat:space-1';
    rerender(<BottomTabBar />);
    expect(selectedTabLabel()).toBe('Agents');
  });
});
