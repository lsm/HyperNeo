import type { SpaceTask, SpaceTaskStatus, SpaceWorkspace } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { getTaskWorkspaceLabel } from './space-task-helpers.js';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    title: 'T',
    description: '',
    status: 'open',
    dependsOn: [],
    assignedToSessionId: null,
    reportedByAgentName: null,
    result: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as SpaceTask;
}

describe('getTaskWorkspaceLabel', () => {
  it('returns null when the workspace list is empty and no primary fallback is provided', () => {
    const task = makeTask({ workspacePath: '/spaces/s1/docs' });
    expect(getTaskWorkspaceLabel(task, [])).toBeNull();
  });

  it('returns null for the primary workspace', () => {
    const task = makeTask({ workspacePath: '/spaces/s1/primary' });
    const workspaces: SpaceWorkspace[] = [
      {
        id: 'ws-1',
        spaceId: 'space-1',
        path: '/spaces/s1/primary',
        label: 'Main',
        isPrimary: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    expect(getTaskWorkspaceLabel(task, workspaces)).toBeNull();
  });

  it('uses the provided primary path fallback and falls back to the path basename', () => {
    const task = makeTask({ workspacePath: '/spaces/s1/docs' });
    expect(getTaskWorkspaceLabel(task, [], '/spaces/s1/primary')).toBe('docs');
  });

  it('splits Windows-style paths for the basename fallback', () => {
    const task = makeTask({ workspacePath: 'C:\\projects\\docs' });
    expect(getTaskWorkspaceLabel(task, [], 'C:\\projects\\primary')).toBe('docs');
  });

  it('prefers the workspace label over the basename for a non-primary path', () => {
    const task = makeTask({ workspacePath: '/spaces/s1/docs' });
    const workspaces: SpaceWorkspace[] = [
      {
        id: 'ws-1',
        spaceId: 'space-1',
        path: '/spaces/s1/primary',
        label: 'Main',
        isPrimary: true,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'ws-2',
        spaceId: 'space-1',
        path: '/spaces/s1/docs',
        label: 'Docs',
        isPrimary: false,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    expect(getTaskWorkspaceLabel(task, workspaces)).toBe('Docs');
  });
});
