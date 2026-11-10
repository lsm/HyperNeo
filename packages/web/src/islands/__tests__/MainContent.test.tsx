// @ts-nocheck
import type { SpaceTask } from '@hyperneo/shared';
import { signal } from '@preact/signals';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpacesWithTasks = signal<unknown[]>([]);

vi.mock('../../lib/space-store', () => ({
  get spaceStore() {
    return {
      spacesWithTasks: mockSpacesWithTasks,
      initGlobalList: vi.fn(async () => {}),
    };
  },
}));

vi.mock('../../lib/space-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../lib/router')),
}));
vi.mock('../../lib/router', () => ({
  navigateToSessions: vi.fn(),
  navigateToSpace: vi.fn(),
  navigateToSpaceTask: vi.fn(),
  navigateToSpaceSession: vi.fn(),
}));

vi.mock('../../components/space/SpaceCreateDialog', () => ({
  SpaceCreateDialog: () => null,
}));

vi.mock('../BottomTabBar', () => ({
  BottomTabBar: () => null,
}));

vi.mock('../../components/voice/VoiceRecordingIndicator', () => ({
  VoiceRecordingIndicator: () => null,
}));

vi.mock('../../components/ui/MobileMenuButton', () => ({
  MobileMenuButton: () => null,
}));

vi.mock('../../hooks/useVoiceRecorder', () => ({
  VoiceSurfaceContext: {
    Provider: ({ children }: { children: unknown }) => children,
  },
}));

import MainContent from '../MainContent';
import { currentSessionIdSignal, navSectionSignal } from '../../lib/signals';
import { currentSpaceCanonicalIdSignal, currentSpaceIdSignal } from '../../lib/space-signals';
import { declareExtensionNav, registerWebExtension } from '../../lib/web-extensions';
import { spaceNav } from '../../components/space/space-nav';
import { navigateToSessions } from '../../lib/router';

function makeTask(id: string, status: SpaceTask['status'], title = `Task ${id}`): SpaceTask {
  return {
    id,
    spaceId: 'space-1',
    taskNumber: 1,
    title,
    description: '',
    status,
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    archivedAt: null,
  };
}

function makeSpace(tasks: SpaceTask[]) {
  return {
    id: 'space-1',
    name: 'Alpha Space',
    slug: 'alpha',
    status: 'active',
    tasks,
    sessions: [],
  };
}

declareExtensionNav(spaceNav);

describe('SpacesHome running list', () => {
  beforeEach(async () => {
    navSectionSignal.value = 'spaces';
    currentSessionIdSignal.value = null;
    currentSpaceIdSignal.value = null;
    currentSpaceCanonicalIdSignal.value = null;
    mockSpacesWithTasks.value = [];

    const { spaceWebExtension } = await import('../../lib/space-web-extension');
    const { spaceStore } = await import('../../lib/space-store');
    registerWebExtension('space', { ...spaceWebExtension, store: spaceStore });
  });

  afterEach(() => {
    cleanup();
  });

  it('lists running tasks under In Progress', () => {
    mockSpacesWithTasks.value = [makeSpace([makeTask('t1', 'in_progress')])];
    render(<MainContent />);
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(screen.getByText('Task t1')).toBeTruthy();
  });

  it('does not list stopped tasks under In Progress', () => {
    mockSpacesWithTasks.value = [
      makeSpace([makeTask('t1', 'in_progress'), makeTask('t2', 'stopped')]),
    ];
    render(<MainContent />);
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(screen.getByText('Task t1')).toBeTruthy();
    expect(screen.queryByText('Task t2')).toBeNull();
    expect(screen.queryByText('stopped')).toBeNull();
  });

  it('treats a space with only stopped tasks as quiet on the home screen', () => {
    mockSpacesWithTasks.value = [makeSpace([makeTask('t1', 'stopped')])];
    render(<MainContent />);
    expect(screen.getByText(/All quiet — no active work across your spaces/)).toBeTruthy();
    expect(screen.queryAllByText('In Progress').length).toBe(0);
    expect(screen.queryByText('Task t1')).toBeNull();
  });
});

describe('MainContent without Space', () => {
  afterEach(() => {
    cleanup();
  });

  it('sends Space routes to chats when the daemon does not provide Space', () => {
    registerWebExtension('space', null);
    navSectionSignal.value = 'spaces';
    currentSessionIdSignal.value = null;
    currentSpaceIdSignal.value = 'space-1';
    render(<MainContent />);
    expect(navigateToSessions).toHaveBeenCalledWith(true);
  });
});
