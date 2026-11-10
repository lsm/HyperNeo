import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { spaceStore } from '../../lib/space-store';
import { navSectionSignal } from '../../lib/signals';
import {
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
} from '../../lib/space-signals';
import { BottomTabBar } from '../BottomTabBar';
import {
  declareExtensionNav,
  registerWebExtension,
  type SpaceWebExtension,
} from '../../lib/web-extensions';
import { spaceNav } from '../../components/space/space-nav';

declareExtensionNav(spaceNav);

vi.mock('../../lib/space-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../lib/router')),
}));
vi.mock('../../lib/router', () => ({
  navigateToSessions: vi.fn(),
  navigateToSettings: vi.fn(),
  navigateToSpaces: vi.fn(),
  navigateToSpace: vi.fn(),
  navigateToSpaceTasks: vi.fn(),
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
    spaceStore.agents.value = [];
  });

  afterEach(() => {
    cleanup();
    currentSpaceIdSignal.value = null;
    currentSpaceCanonicalIdSignal.value = null;
    currentSpaceTaskIdSignal.value = null;
    currentSpaceSessionIdSignal.value = null;
    spaceStore.agents.value = [];
  });

  it('selects Overview for space overview', () => {
    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Overview');
  });

  it('selects Agents for a space session chat', () => {
    currentSpaceSessionIdSignal.value = 'session-1';

    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Agents');
  });

  it('selects Tasks for task view', () => {
    currentSpaceTaskIdSignal.value = 'task-1';

    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Tasks');
  });

  it('selects Agents for long-horizon agent chat', () => {
    currentSpaceSessionIdSignal.value = 'session-agent-1';
    spaceStore.agents.value = [makeLongHorizonAgent('session-agent-1')];

    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Agents');
  });

  it('selects Agents for a clone of a long-horizon agent session', () => {
    currentSpaceSessionIdSignal.value = 'clone-1';
    spaceStore.agents.value = [makeLongHorizonAgent('session-agent-1')];
    spaceStore.sessions.value = [
      {
        id: 'clone-1',
        title: 'clone',
        status: 'active',
        lastActiveAt: 0,
        parentSessionId: 'session-agent-1',
      },
    ];

    render(<BottomTabBar />);

    expect(selectedTabLabel()).toBe('Agents');
    spaceStore.sessions.value = [];
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
    expect(selectedTabLabel()).toBe('Agents');

    spaceStore.agents.value = [makeLongHorizonAgent('session-agent-1')];
    currentSpaceSessionIdSignal.value = 'session-agent-1';
    rerender(<BottomTabBar />);
    expect(selectedTabLabel()).toBe('Agents');
  });
});

describe('BottomTabBar without Space', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    navSectionSignal.value = 'chats';
    currentSpaceIdSignal.value = null;
  });

  afterEach(() => {
    cleanup();
    registerWebExtension('space', { store: spaceStore } as unknown as SpaceWebExtension);
  });

  it('shows no Spaces tab when the daemon does not provide Space', () => {
    registerWebExtension('space', null);
    render(<BottomTabBar />);
    const tabs = screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'));
    expect(tabs).toEqual(['Chats', 'Settings']);
  });
});
