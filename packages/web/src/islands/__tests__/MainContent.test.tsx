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

vi.mock('../../lib/router', () => ({
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
import {
  currentSessionIdSignal,
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  navSectionSignal,
} from '../../lib/signals';

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

describe('SpacesHome running list', () => {
  beforeEach(() => {
    navSectionSignal.value = 'spaces';
    currentSessionIdSignal.value = null;
    currentSpaceIdSignal.value = null;
    currentSpaceCanonicalIdSignal.value = null;
    mockSpacesWithTasks.value = [];
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
