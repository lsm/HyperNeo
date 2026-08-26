import { beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';
import { SpaceWorkspaceRepository } from '../../../../src/storage/repositories/space-workspace-repository';
import {
  SpaceWorkspaceManager,
  WorkspaceRegistrationError,
  WorkspaceRemovalBlockedError,
} from '../../../../src/lib/space/managers/space-workspace-manager';
import {
  MAX_WORKSPACES_PER_SPACE,
  type WorkspaceValidationIo,
} from '../../../../src/lib/space/workspaces/workspace-validation-pipeline';

const SPACE_A = 'space-a';
const SPACE_B = 'space-b';

function fakeIo(overrides: Partial<WorkspaceValidationIo> = {}): WorkspaceValidationIo {
  return {
    realpath: async (path) => path,
    isDirectory: async () => true,
    isGitRepositoryRoot: async () => true,
    ...overrides,
  };
}

function insertSpace(
  db: BunDatabase,
  id: string,
  workspacePath: string,
  name = `Space ${id}`
): void {
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, description, background_context,
       instructions, allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
  ).run(id, id, workspacePath, name, Date.now(), Date.now());
}

function insertSession(
  db: BunDatabase,
  id: string,
  spaceId: string,
  workspacePath: string,
  status: string,
  mainRepoPath?: string
): void {
  db.prepare(
    `INSERT INTO sessions (id, title, workspace_path, main_repo_path, created_at, last_active_at,
       status, config, metadata, type, session_context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `Session ${id}`,
    workspacePath,
    mainRepoPath ?? null,
    new Date().toISOString(),
    new Date().toISOString(),
    status,
    JSON.stringify({ provider: 'anthropic', model: 'claude', maxTokens: 100, temperature: 0 }),
    JSON.stringify({}),
    'worker',
    JSON.stringify({ spaceId })
  );
}

describe('SpaceWorkspaceManager', () => {
  let db: BunDatabase;
  let manager: SpaceWorkspaceManager;
  let workspaceRepo: SpaceWorkspaceRepository;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    manager = new SpaceWorkspaceManager(db, fakeIo());
    workspaceRepo = new SpaceWorkspaceRepository(db);

    insertSpace(db, SPACE_A, '/repo/a');
    insertSpace(db, SPACE_B, '/repo/b');
  });

  describe('registerWorkspace', () => {
    test('registers a secondary workspace with a label', async () => {
      const record = await manager.registerWorkspace(SPACE_A, '/repo/a-secondary', 'Secondary');

      expect(record.spaceId).toBe(SPACE_A);
      expect(record.path).toBe('/repo/a-secondary');
      expect(record.label).toBe('Secondary');
      expect(record.isPrimary).toBe(false);
    });

    test('rejects an unknown space', async () => {
      await expect(manager.registerWorkspace('missing', '/repo/x')).rejects.toThrow(
        'Space not found'
      );
    });

    test('surfaces path_not_found when the path cannot be resolved', async () => {
      const failing = new SpaceWorkspaceManager(
        db,
        fakeIo({
          realpath: async () => {
            throw new Error('ENOENT');
          },
        })
      );

      await expect(failing.registerWorkspace(SPACE_A, '/gone')).rejects.toThrow(
        WorkspaceRegistrationError
      );
      try {
        await failing.registerWorkspace(SPACE_A, '/gone');
      } catch (err) {
        expect((err as WorkspaceRegistrationError).reason).toBe('path_not_found');
      }
    });

    test('surfaces path_not_a_directory', async () => {
      const failing = new SpaceWorkspaceManager(db, fakeIo({ isDirectory: async () => false }));

      try {
        await failing.registerWorkspace(SPACE_A, '/repo/file');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceRegistrationError);
        expect((err as WorkspaceRegistrationError).reason).toBe('path_not_a_directory');
      }
    });

    test('surfaces not_a_git_repository_root', async () => {
      const failing = new SpaceWorkspaceManager(
        db,
        fakeIo({ isGitRepositoryRoot: async () => false })
      );

      try {
        await failing.registerWorkspace(SPACE_A, '/repo/plain');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceRegistrationError);
        expect((err as WorkspaceRegistrationError).reason).toBe('not_a_git_repository_root');
      }
    });

    test('surfaces path_claimed_by_another_space', async () => {
      workspaceRepo.create({ spaceId: SPACE_B, path: '/repo/foreign' });

      try {
        await manager.registerWorkspace(SPACE_A, '/repo/foreign');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceRegistrationError);
        expect((err as WorkspaceRegistrationError).reason).toBe('path_claimed_by_another_space');
        expect((err as WorkspaceRegistrationError).verdict.conflictSpaceId).toBe(SPACE_B);
      }
    });

    test('surfaces duplicate_of_registered_workspace for the primary path', async () => {
      workspaceRepo.create({ spaceId: SPACE_A, path: '/repo/a', isPrimary: true });

      try {
        await manager.registerWorkspace(SPACE_A, '/repo/a');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceRegistrationError);
        expect((err as WorkspaceRegistrationError).reason).toBe(
          'duplicate_of_registered_workspace'
        );
      }
    });

    test('surfaces ambiguous_nesting when the candidate contains an existing workspace', async () => {
      workspaceRepo.create({ spaceId: SPACE_A, path: '/repo/work/sub' });

      try {
        await manager.registerWorkspace(SPACE_A, '/repo/work');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceRegistrationError);
        expect((err as WorkspaceRegistrationError).reason).toBe('ambiguous_nesting');
        expect((err as WorkspaceRegistrationError).verdict.nestingDirection).toBe(
          'existing_inside_candidate'
        );
      }
    });

    test('surfaces workspace_cap_reached', async () => {
      workspaceRepo.create({ spaceId: SPACE_A, path: '/repo/a', isPrimary: true });
      for (let i = 0; i < MAX_WORKSPACES_PER_SPACE - 1; i++) {
        workspaceRepo.create({ spaceId: SPACE_A, path: `/repo/secondary-${i}` });
      }

      try {
        await manager.registerWorkspace(SPACE_A, '/repo/overflow');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceRegistrationError);
        expect((err as WorkspaceRegistrationError).reason).toBe('workspace_cap_reached');
        expect((err as WorkspaceRegistrationError).verdict.limit).toBe(MAX_WORKSPACES_PER_SPACE);
      }
    });
  });

  describe('listWorkspaces', () => {
    test('returns a space primary before secondaries', async () => {
      const secondary = workspaceRepo.create({
        spaceId: SPACE_A,
        path: '/repo/a-secondary',
      });
      const primary = workspaceRepo.create({
        spaceId: SPACE_A,
        path: '/repo/a',
        isPrimary: true,
      });

      const rows = await manager.listWorkspaces(SPACE_A);
      expect(rows[0]!.id).toBe(primary.id);
      expect(rows[1]!.id).toBe(secondary.id);
    });

    test('does not include another space workspaces', async () => {
      workspaceRepo.create({ spaceId: SPACE_A, path: '/repo/a' });
      workspaceRepo.create({ spaceId: SPACE_B, path: '/repo/b' });

      const rows = await manager.listWorkspaces(SPACE_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.path).toBe('/repo/a');
    });
  });

  describe('removeWorkspace', () => {
    test('returns false for a missing workspace', async () => {
      expect(await manager.removeWorkspace(SPACE_A, 'no-such-id')).toBe(false);
    });

    test('blocks removal of the primary workspace', async () => {
      const primary = workspaceRepo.create({
        spaceId: SPACE_A,
        path: '/repo/a',
        isPrimary: true,
      });

      await expect(manager.removeWorkspace(SPACE_A, primary.id)).rejects.toThrow(
        WorkspaceRemovalBlockedError
      );
      try {
        await manager.removeWorkspace(SPACE_A, primary.id);
      } catch (err) {
        expect((err as WorkspaceRemovalBlockedError).reason).toBe('primary');
      }
    });

    test('blocks removal while active sessions reference the workspace', async () => {
      const secondary = workspaceRepo.create({
        spaceId: SPACE_A,
        path: '/repo/a-secondary',
      });
      insertSession(db, 'session-1', SPACE_A, '/repo/a-secondary', 'active');

      await expect(manager.removeWorkspace(SPACE_A, secondary.id)).rejects.toThrow(
        WorkspaceRemovalBlockedError
      );
      try {
        await manager.removeWorkspace(SPACE_A, secondary.id);
      } catch (err) {
        expect((err as WorkspaceRemovalBlockedError).reason).toBe('active_sessions');
      }
    });

    test('blocks removal for active worktree sessions tied to the workspace', async () => {
      const secondary = workspaceRepo.create({
        spaceId: SPACE_A,
        path: '/repo/a-secondary',
      });
      insertSession(
        db,
        'session-worktree',
        SPACE_A,
        '/repo/a-secondary/worktree',
        'active',
        '/repo/a-secondary'
      );

      await expect(manager.removeWorkspace(SPACE_A, secondary.id)).rejects.toThrow(
        WorkspaceRemovalBlockedError
      );
      try {
        await manager.removeWorkspace(SPACE_A, secondary.id);
      } catch (err) {
        expect((err as WorkspaceRemovalBlockedError).reason).toBe('active_sessions');
      }
    });

    test('blocks removal for paused and pending_worktree_choice sessions', async () => {
      const secondary = workspaceRepo.create({
        spaceId: SPACE_A,
        path: '/repo/a-secondary',
      });
      insertSession(db, 'session-paused', SPACE_A, '/repo/a-secondary', 'paused');

      await expect(manager.removeWorkspace(SPACE_A, secondary.id)).rejects.toThrow(
        WorkspaceRemovalBlockedError
      );
    });

    test('allows removal after active sessions end', async () => {
      const secondary = workspaceRepo.create({
        spaceId: SPACE_A,
        path: '/repo/a-secondary',
      });
      insertSession(db, 'session-1', SPACE_A, '/repo/a-secondary', 'active');
      db.prepare(`UPDATE sessions SET status = 'ended' WHERE id = ?`).run('session-1');

      expect(await manager.removeWorkspace(SPACE_A, secondary.id)).toBe(true);
      expect(workspaceRepo.getById(secondary.id)).toBeNull();
    });

    test('removes a secondary workspace with no active sessions', async () => {
      const secondary = workspaceRepo.create({
        spaceId: SPACE_A,
        path: '/repo/a-secondary',
      });

      expect(await manager.removeWorkspace(SPACE_A, secondary.id)).toBe(true);
      expect(workspaceRepo.getById(secondary.id)).toBeNull();
    });
  });
});
