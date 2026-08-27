import { describe, expect, test } from 'bun:test';
import type { Space } from '@hyperneo/shared';
import type { SpaceWorkspaceRecord } from '../../../../src/storage/repositories/space-workspace-repository.ts';
import {
  SpaceWorkspaceManager,
  WorkspaceRegistrationError,
  WorkspaceRemovalBlockedError,
  type SpaceWorkspaceManagerDeps,
  type WorkspaceSessionReferences,
  type WorkspaceTaskReferences,
} from '../../../../src/lib/space/managers/space-workspace-manager.ts';
import type { WorkspaceValidationIo } from '../../../../src/lib/space/workspaces/workspace-validation-pipeline.ts';

const SPACE_A = 'space-a';
const SPACE_B = 'space-b';

function fakeSpace(
  id: string,
  workspacePath: string,
  status: 'active' | 'archived' = 'active'
): Space {
  return {
    id,
    slug: id,
    workspacePath,
    name: id,
    description: '',
    backgroundContext: '',
    instructions: '',
    sessionIds: [],
    status,
    paused: false,
    stopped: false,
    maxConcurrentTasks: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

function row(spaceId: string, path: string, id: string, isPrimary = false): SpaceWorkspaceRecord {
  return { id, spaceId, path, label: '', isPrimary, createdAt: 0, updatedAt: 0 };
}

class FakeSpaces {
  constructor(private readonly spaces: Space[]) {}
  getSpace(id: string): Space | null {
    return this.spaces.find((s) => s.id === id) ?? null;
  }
  listSpaces(includeArchived = false): Space[] {
    return this.spaces.filter((s) => includeArchived || s.status === 'active');
  }
}

class FakeWorkspaces {
  rows: SpaceWorkspaceRecord[];
  failCreateWith: Error | null = null;
  claimRacedBy: SpaceWorkspaceRecord | null = null;
  private nextId = 0;

  constructor(initial: SpaceWorkspaceRecord[] = []) {
    this.rows = [...initial];
  }

  create(params: {
    spaceId: string;
    path: string;
    label?: string;
    isPrimary?: boolean;
  }): SpaceWorkspaceRecord {
    if (this.failCreateWith) throw this.failCreateWith;
    const record: SpaceWorkspaceRecord = {
      id: `ws-${this.nextId++}`,
      spaceId: params.spaceId,
      path: params.path,
      label: params.label ?? '',
      isPrimary: params.isPrimary ?? false,
      createdAt: 0,
      updatedAt: 0,
    };
    this.rows.push(record);
    return record;
  }

  createUnclaimed(params: {
    spaceId: string;
    path: string;
    label?: string;
    isPrimary?: boolean;
  }): SpaceWorkspaceRecord | null {
    if (this.claimRacedBy) return null;
    return this.create(params);
  }

  findOwnerByPath(path: string): SpaceWorkspaceRecord | null {
    if (this.claimRacedBy) return this.claimRacedBy;
    return this.rows.find((r) => r.path === path) ?? null;
  }

  getById(id: string): SpaceWorkspaceRecord | null {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  listBySpace(spaceId: string): SpaceWorkspaceRecord[] {
    return this.rows.filter((r) => r.spaceId === spaceId);
  }

  delete(spaceId: string, workspaceId: string): boolean {
    const index = this.rows.findIndex((r) => r.id === workspaceId && r.spaceId === spaceId);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    return true;
  }
}

function fakeIo(overrides: Partial<WorkspaceValidationIo> = {}): WorkspaceValidationIo {
  return {
    realpath: async (path) => path,
    isDirectory: async () => true,
    isGitRepositoryRoot: async () => true,
    ...overrides,
  };
}

const noActiveSessions: WorkspaceSessionReferences = {
  countActiveSessionsByWorkspacePath: () => 0,
};

const noActiveTasks: WorkspaceTaskReferences = {
  countActiveTasksByWorkspacePath: () => 0,
};

function newManager(
  options: {
    spaces?: Space[];
    workspaces?: FakeWorkspaces;
    io?: WorkspaceValidationIo;
    sessionReferences?: WorkspaceSessionReferences;
    transaction?: <T>(fn: () => T) => T;
    taskReferences?: WorkspaceTaskReferences;
  } = {}
): { manager: SpaceWorkspaceManager; workspaces: FakeWorkspaces } {
  const workspaces = options.workspaces ?? new FakeWorkspaces();
  const deps: SpaceWorkspaceManagerDeps = {
    spaces: new FakeSpaces(options.spaces ?? [fakeSpace(SPACE_A, '/primary-a')]),
    workspaces,
    sessionReferences: options.sessionReferences ?? noActiveSessions,
    taskReferences: options.taskReferences ?? noActiveTasks,
    io: options.io ?? fakeIo(),
    transaction: options.transaction,
  };
  return { manager: new SpaceWorkspaceManager(deps), workspaces };
}

async function registrationError(
  manager: SpaceWorkspaceManager,
  rawPath: string
): Promise<WorkspaceRegistrationError> {
  const err = await manager.registerWorkspace(SPACE_A, rawPath).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkspaceRegistrationError);
  return err as WorkspaceRegistrationError;
}

describe('registerWorkspace', () => {
  test('creates a non-primary record from the canonicalized path', async () => {
    const { manager, workspaces } = newManager({
      io: fakeIo({ realpath: async () => '/canon/repo' }),
    });
    const record = await manager.registerWorkspace(SPACE_A, '/raw/repo', 'my label');
    expect(record.path).toBe('/canon/repo');
    expect(record.label).toBe('my label');
    expect(record.isPrimary).toBe(false);
    expect(workspaces.rows).toEqual([record]);
  });

  test('throws a plain error for an unknown space', async () => {
    const { manager } = newManager({ spaces: [] });
    const err = await manager.registerWorkspace('ghost', '/repo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WorkspaceRegistrationError);
    expect((err as Error).message).toBe('Space not found: ghost');
  });

  test('surfaces an io-driven rejection with its verdict', async () => {
    const { manager } = newManager({
      io: fakeIo({
        realpath: async () => {
          throw new Error('ENOENT');
        },
      }),
    });
    const err = await registrationError(manager, '/gone');
    expect(err.reason).toBe('path_not_found');
    expect(err.verdict.reason).toBe('path_not_found');
    expect(err.verdict.accepted).toBe(false);
  });

  test('rejects a path claimed as another space primary, including archived spaces', async () => {
    for (const status of ['active', 'archived'] as const) {
      const { manager } = newManager({
        spaces: [fakeSpace(SPACE_A, '/primary-a'), fakeSpace(SPACE_B, '/shared', status)],
      });
      const err = await registrationError(manager, '/shared');
      expect(err.reason).toBe('path_claimed_by_another_space');
      expect(err.verdict.conflictSpaceId).toBe(SPACE_B);
    }
  });

  test('rejects a duplicate of a registered workspace of the same space', async () => {
    const { manager } = newManager({
      workspaces: new FakeWorkspaces([row(SPACE_A, '/dup', 'w1')]),
    });
    const err = await registrationError(manager, '/dup');
    expect(err.reason).toBe('duplicate_of_registered_workspace');
  });

  test('rejects ambiguous nesting against the same space', async () => {
    const { manager } = newManager({
      workspaces: new FakeWorkspaces([row(SPACE_A, '/work', 'w1')]),
    });
    const err = await registrationError(manager, '/work/sub-repo');
    expect(err.reason).toBe('ambiguous_nesting');
    expect(err.verdict.nestingDirection).toBe('candidate_inside_existing');
  });

  test('rejects when the per-space cap is reached', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(SPACE_A, `/w${i}`, `w${i}`));
    const { manager } = newManager({ workspaces: new FakeWorkspaces(rows) });
    const err = await registrationError(manager, '/new-repo');
    expect(err.reason).toBe('workspace_cap_reached');
    expect(err.verdict.limit).toBe(8);
  });

  test('propagates insert failures untouched', async () => {
    const workspaces = new FakeWorkspaces();
    workspaces.failCreateWith = new Error('disk full');
    const { manager } = newManager({ workspaces });
    const err = await manager.registerWorkspace(SPACE_A, '/repo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WorkspaceRegistrationError);
    expect((err as Error).message).toBe('disk full');
  });

  test('rejects when another space claims the path after validation', async () => {
    const workspaces = new FakeWorkspaces();
    workspaces.claimRacedBy = row(SPACE_B, '/repo', 'stolen');
    const { manager } = newManager({ workspaces });
    const err = await registrationError(manager, '/repo');
    expect(err.reason).toBe('path_claimed_by_another_space');
    expect(err.verdict.conflictSpaceId).toBe(SPACE_B);
    expect(workspaces.rows).toHaveLength(0);
  });

  test('rejects when the same space claims the path after validation', async () => {
    const workspaces = new FakeWorkspaces();
    workspaces.claimRacedBy = row(SPACE_A, '/repo', 'stolen');
    const { manager } = newManager({ workspaces });
    const err = await registrationError(manager, '/repo');
    expect(err.reason).toBe('duplicate_of_registered_workspace');
    expect(workspaces.rows).toHaveLength(0);
  });

  test('rejects when a concurrent writer nests a workspace before the insert transaction', async () => {
    const workspaces = new FakeWorkspaces();
    const lateRow = row(SPACE_A, '/work', 'late');
    const { manager } = newManager({
      workspaces,
      transaction: (fn) => {
        workspaces.rows.push(lateRow);
        return fn();
      },
    });
    const err = await registrationError(manager, '/work/sub-repo');
    expect(err.reason).toBe('ambiguous_nesting');
    expect(workspaces.rows).toEqual([lateRow]);
  });
});

describe('removeWorkspace', () => {
  test('deletes a secondary workspace and returns true', () => {
    const workspaces = new FakeWorkspaces([
      row(SPACE_A, '/primary-a', 'primary', true),
      row(SPACE_A, '/sec', 'w2'),
    ]);
    const { manager } = newManager({ workspaces });
    expect(manager.removeWorkspace(SPACE_A, 'w2')).toBe(true);
    expect(workspaces.rows.map((r) => r.id)).toEqual(['primary']);
  });

  test('returns false for an unknown workspace id', () => {
    const { manager } = newManager();
    expect(manager.removeWorkspace(SPACE_A, 'ghost')).toBe(false);
  });

  test('returns false when the workspace belongs to another space', () => {
    const workspaces = new FakeWorkspaces([row(SPACE_B, '/sec', 'w2')]);
    const { manager } = newManager({ workspaces });
    expect(manager.removeWorkspace(SPACE_A, 'w2')).toBe(false);
    expect(workspaces.rows).toHaveLength(1);
  });

  test('blocks removal of the primary workspace', () => {
    const workspaces = new FakeWorkspaces([row(SPACE_A, '/primary-a', 'primary', true)]);
    const { manager } = newManager({ workspaces });
    let err: unknown;
    try {
      manager.removeWorkspace(SPACE_A, 'primary');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkspaceRemovalBlockedError);
    expect((err as WorkspaceRemovalBlockedError).reason).toBe('primary');
    expect(workspaces.rows).toHaveLength(1);
  });

  test('blocks removal while active sessions reference the workspace', () => {
    const workspaces = new FakeWorkspaces([row(SPACE_A, '/sec', 'w2')]);
    const calls: Array<[string, string]> = [];
    const { manager } = newManager({
      workspaces,
      sessionReferences: {
        countActiveSessionsByWorkspacePath: (spaceId, workspacePath) => {
          calls.push([spaceId, workspacePath]);
          return 2;
        },
      },
    });
    let err: unknown;
    try {
      manager.removeWorkspace(SPACE_A, 'w2');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkspaceRemovalBlockedError);
    expect((err as WorkspaceRemovalBlockedError).reason).toBe('active_sessions');
    expect(calls).toEqual([[SPACE_A, '/sec']]);
    expect(workspaces.rows).toHaveLength(1);
  });

  test('blocks removal while active tasks reference the workspace', () => {
    const workspaces = new FakeWorkspaces([row(SPACE_A, '/sec', 'w2')]);
    const calls: Array<[string, string]> = [];
    const { manager } = newManager({
      workspaces,
      taskReferences: {
        countActiveTasksByWorkspacePath: (spaceId, workspacePath) => {
          calls.push([spaceId, workspacePath]);
          return 3;
        },
      },
    });
    let err: unknown;
    try {
      manager.removeWorkspace(SPACE_A, 'w2');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkspaceRemovalBlockedError);
    expect((err as WorkspaceRemovalBlockedError).reason).toBe('active_tasks');
    expect(calls).toEqual([[SPACE_A, '/sec']]);
    expect(workspaces.rows).toHaveLength(1);
  });
});

describe('resolveRegisteredWorkspacePath', () => {
  test('resolves the primary path from space.workspacePath when no primary row exists', async () => {
    const { manager } = newManager();
    const resolved = await manager.resolveRegisteredWorkspacePath(SPACE_A, '/primary-a');
    expect(resolved).toBe('/primary-a');
  });

  test('resolves a secondary workspace path', async () => {
    const workspaces = new FakeWorkspaces([
      row(SPACE_A, '/primary-a', 'primary', true),
      row(SPACE_A, '/sec', 'w2'),
    ]);
    const { manager } = newManager({ workspaces });
    const resolved = await manager.resolveRegisteredWorkspacePath(SPACE_A, '/sec');
    expect(resolved).toBe('/sec');
  });

  test('canonicalizes the raw path through io.realpath before matching', async () => {
    const workspaces = new FakeWorkspaces([row(SPACE_A, '/canon', 'w1')]);
    const { manager } = newManager({
      workspaces,
      io: fakeIo({ realpath: async () => '/canon' }),
    });
    const resolved = await manager.resolveRegisteredWorkspacePath(SPACE_A, '/raw');
    expect(resolved).toBe('/canon');
  });

  test('rejects an unregistered path with a clear error', async () => {
    const { manager } = newManager();
    const err = await manager
      .resolveRegisteredWorkspacePath(SPACE_A, '/unregistered')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Workspace path is not registered to space: /unregistered');
  });
});

describe('listWorkspaces', () => {
  test('returns the repository rows of the space', () => {
    const workspaces = new FakeWorkspaces([
      row(SPACE_A, '/primary-a', 'primary', true),
      row(SPACE_B, '/other', 'w2'),
      row(SPACE_A, '/sec', 'w3'),
    ]);
    const { manager } = newManager({ workspaces });
    expect(manager.listWorkspaces(SPACE_A).map((r) => r.id)).toEqual(['primary', 'w3']);
  });

  test('throws for an unknown space', () => {
    const { manager } = newManager({ spaces: [] });
    expect(() => manager.listWorkspaces('ghost')).toThrow('Space not found: ghost');
  });
});
