import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, Space } from '@hyperneo/shared';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { WorkspaceRemovalBlockedError } from '../../../../src/lib/space/managers/space-workspace-manager';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceWorkspaceRepository } from '../../../../src/storage/repositories/space-workspace-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('SpaceManager', () => {
  let db: Database;
  let manager: SpaceManager;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    manager = new SpaceManager(db as any);

    tmpDir = mkdtempSync(join(tmpdir(), 'space-manager-test-'));
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {}
  });

  describe('createSpace', () => {
    it('creates a space for a valid directory', async () => {
      const space = await manager.createSpace({
        workspacePath: tmpDir,
        name: 'My Project',
      });

      expect(space.id).toBeDefined();
      expect(space.name).toBe('My Project');
      expect(space.workspacePath).toBeTruthy();
      expect(space.status).toBe('active');
    });

    it('resolves symlinks and stores the real path', async () => {
      const realDir = mkdtempSync(join(tmpdir(), 'real-dir-'));
      const linkPath = join(tmpDir, 'link');
      symlinkSync(realDir, linkPath);

      try {
        const space = await manager.createSpace({ workspacePath: linkPath, name: 'Linked' });
        const expectedRealPath = realpathSync(realDir);
        expect(space.workspacePath).toBe(expectedRealPath);
      } finally {
        rmSync(realDir, { recursive: true });
      }
    });

    it('throws for a non-existent path', async () => {
      await expect(
        manager.createSpace({ workspacePath: '/nonexistent/path/xyz', name: 'X' })
      ).rejects.toThrow('does not exist');
    });

    it('throws if path is not a directory (is a file)', async () => {
      const filePath = join(tmpDir, 'somefile.txt');
      writeFileSync(filePath, 'hello');

      await expect(manager.createSpace({ workspacePath: filePath, name: 'X' })).rejects.toThrow(
        'not a directory'
      );
    });

    it('throws if workspace path is already used by an active space', async () => {
      await manager.createSpace({ workspacePath: tmpDir, name: 'First' });

      await expect(manager.createSpace({ workspacePath: tmpDir, name: 'Second' })).rejects.toThrow(
        'already exists'
      );
    });

    it('throws if workspace path is used by an archived space (paths are permanent identifiers)', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'First' });
      await manager.archiveSpace(space.id);

      await expect(manager.createSpace({ workspacePath: tmpDir, name: 'Second' })).rejects.toThrow(
        'already exists'
      );
    });

    it('throws if the same repo is claimed through a different symlink alias', async () => {
      await manager.createSpace({ workspacePath: tmpDir, name: 'First' });
      const aliasPath = join(tmpDir, 'repo-alias');
      symlinkSync(tmpDir, aliasPath);

      await expect(
        manager.createSpace({ workspacePath: aliasPath, name: 'Second' })
      ).rejects.toThrow('already exists');
    });

    it('registers the resolved workspace path as the new space claim (findable via getSpaceByPath)', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'Claimed' });
      const repo = new SpaceRepository(db as any);
      const found = repo.getSpaceByPath(space.workspacePath!);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(space.id);
    });

    it('persists a primary workspace row for the new space', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'Primary Row' });
      const workspaceRepo = new SpaceWorkspaceRepository(db as any);
      const workspaces = workspaceRepo.listBySpace(space.id);

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.path).toBe(space.workspacePath);
      expect(workspaces[0]!.isPrimary).toBe(true);
    });

    it('throws if the workspace path is already a secondary workspace in another space', async () => {
      const other = await manager.createSpace({ workspacePath: tmpDir, name: 'Other' });
      const workspaceRepo = new SpaceWorkspaceRepository(db as any);
      const rawSubDir = join(tmpDir, 'sub-workspace');
      mkdirSync(rawSubDir);
      const subDir = realpathSync(rawSubDir);
      workspaceRepo.create({ spaceId: other.id, path: subDir });

      await expect(
        manager.createSpace({ workspacePath: subDir, name: 'Collision' })
      ).rejects.toThrow('already claimed');
    });

    it('creates a space with autonomy level 1 (supervised)', async () => {
      const space = await manager.createSpace({
        workspacePath: tmpDir,
        name: 'Supervised Space',
        autonomyLevel: 1,
      });

      expect(space.autonomyLevel).toBe(1);
    });

    it('creates a space with autonomy level 3 (semi-autonomous)', async () => {
      const space = await manager.createSpace({
        workspacePath: tmpDir,
        name: 'Semi-Auto Space',
        autonomyLevel: 3,
      });

      expect(space.autonomyLevel).toBe(3);
    });

    it('defaults autonomy level to 1 when not specified', async () => {
      const space = await manager.createSpace({
        workspacePath: tmpDir,
        name: 'Default Autonomy Space',
      });

      expect(space.autonomyLevel).toBe(1);
    });
  });

  describe('createSpace with additionalWorkspaces', () => {
    function gitRepo(name: string): string {
      const dir = mkdtempSync(join(tmpdir(), `space-create-${name}-`));
      execSync('git init -q', { cwd: dir });
      return realpathSync(dir);
    }

    function plainDir(name: string): string {
      return realpathSync(mkdtempSync(join(tmpdir(), `space-create-${name}-`)));
    }

    function workspaceRowCount(): number {
      return (db.prepare('SELECT COUNT(*) AS c FROM space_workspaces').get() as { c: number }).c;
    }

    it('registers the primary and every additional workspace', async () => {
      const repoA = gitRepo('alpha');
      const repoB = gitRepo('beta');

      const space = await manager.createSpace({
        workspacePath: tmpDir,
        name: 'Multi',
        additionalWorkspaces: [{ path: repoA, label: 'Alpha' }, { path: repoB }],
      });

      const workspaces = manager.listWorkspaces(space.id);
      expect(workspaces).toHaveLength(3);
      expect(workspaces.find((w) => w.isPrimary)!.path).toBe(space.workspacePath);
      const secondaries = workspaces.filter((w) => !w.isPrimary);
      expect(secondaries.map((w) => w.path).sort()).toEqual([repoA, repoB].sort());
      expect(secondaries.find((w) => w.path === repoA)!.label).toBe('Alpha');
      expect(secondaries.find((w) => w.path === repoB)!.label).toBe('');
    });

    it('rejects the whole create when a secondary is invalid and persists nothing', async () => {
      const repoA = gitRepo('alpha');
      const plain = plainDir('plain');

      await expect(
        manager.createSpace({
          workspacePath: tmpDir,
          name: 'Bad Secondary',
          additionalWorkspaces: [{ path: repoA }, { path: plain }],
        })
      ).rejects.toThrow('not a git repository root');

      expect(await manager.listSpaces()).toHaveLength(0);
      expect(workspaceRowCount()).toBe(0);
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'Retry' });
      expect(manager.listWorkspaces(space.id)).toHaveLength(1);
    });

    it('rejects a secondary that duplicates the primary path', async () => {
      const primaryRepo = gitRepo('primary');
      await expect(
        manager.createSpace({
          workspacePath: primaryRepo,
          name: 'Dup Primary',
          additionalWorkspaces: [{ path: primaryRepo }],
        })
      ).rejects.toThrow('already registered to this space');
      expect(await manager.listSpaces()).toHaveLength(0);
    });

    it('rejects duplicate secondaries within the same create', async () => {
      const repo = gitRepo('dup');

      await expect(
        manager.createSpace({
          workspacePath: tmpDir,
          name: 'Dup Secondaries',
          additionalWorkspaces: [
            { path: repo, label: 'One' },
            { path: repo, label: 'Two' },
          ],
        })
      ).rejects.toThrow('already registered to this space');
      expect(await manager.listSpaces()).toHaveLength(0);
    });

    it('rejects a secondary already claimed by another space', async () => {
      const otherPrimary = plainDir('other-primary');
      const claimed = gitRepo('claimed');
      const first = await manager.createSpace({ workspacePath: claimed, name: 'First' });
      expect(first.workspacePath).toBe(claimed);

      await expect(
        manager.createSpace({
          workspacePath: otherPrimary,
          name: 'Second',
          additionalWorkspaces: [{ path: claimed }],
        })
      ).rejects.toThrow('already claimed');
      expect((await manager.listSpaces()).map((s) => s.name)).toEqual(['First']);
    });

    it('rolls back the created space when workspace validation throws unexpectedly', async () => {
      const repoA = gitRepo('alpha');

      await expect(
        manager.createSpace({
          workspacePath: tmpDir,
          name: 'Unexpected',
          additionalWorkspaces: [{ path: 123 as unknown as string }, { path: repoA }],
        })
      ).rejects.toThrow();

      expect(await manager.listSpaces()).toHaveLength(0);
      expect(workspaceRowCount()).toBe(0);
    });
  });

  describe('getSpace', () => {
    it('returns space by ID', async () => {
      const created = await manager.createSpace({ workspacePath: tmpDir, name: 'P' });
      const found = await manager.getSpace(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null for unknown ID', async () => {
      expect(await manager.getSpace('nonexistent')).toBeNull();
    });
  });

  describe('listSpaces', () => {
    it('lists active spaces', async () => {
      const dir2 = mkdtempSync(join(tmpdir(), 'space-list-test-'));
      try {
        await manager.createSpace({ workspacePath: tmpDir, name: 'A' });
        const b = await manager.createSpace({ workspacePath: dir2, name: 'B' });
        await manager.archiveSpace(b.id);

        const spaces = await manager.listSpaces();
        expect(spaces).toHaveLength(1);
        expect(spaces[0].name).toBe('A');
      } finally {
        rmSync(dir2, { recursive: true });
      }
    });
  });

  describe('updateSpace', () => {
    it('updates space fields', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'Old' });
      const updated = await manager.updateSpace(space.id, { name: 'New', description: 'Desc' });
      expect(updated.name).toBe('New');
      expect(updated.description).toBe('Desc');
    });

    it('throws for unknown space', async () => {
      await expect(manager.updateSpace('nonexistent', { name: 'X' })).rejects.toThrow('not found');
    });

    it('updates autonomy level to 3 (semi-autonomous)', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'A' });
      const updated = await manager.updateSpace(space.id, { autonomyLevel: 3 });
      expect(updated.autonomyLevel).toBe(3);
    });

    it('updates autonomy level back to 1 (supervised)', async () => {
      const space = await manager.createSpace({
        workspacePath: tmpDir,
        name: 'A',
        autonomyLevel: 3,
      });
      const updated = await manager.updateSpace(space.id, { autonomyLevel: 1 });
      expect(updated.autonomyLevel).toBe(1);
    });

    it('does not change autonomy level when not provided in update', async () => {
      const space = await manager.createSpace({
        workspacePath: tmpDir,
        name: 'A',
        autonomyLevel: 3,
      });
      const updated = await manager.updateSpace(space.id, { name: 'B' });
      expect(updated.autonomyLevel).toBe(3);
    });
  });

  describe('archiveSpace', () => {
    it('archives a space', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'A' });
      const archived = await manager.archiveSpace(space.id);
      expect(archived.status).toBe('archived');
    });

    it('throws for unknown space', async () => {
      await expect(manager.archiveSpace('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('deleteSpace', () => {
    it('deletes a space', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'A' });
      expect(await manager.deleteSpace(space.id)).toBe(true);
      expect(await manager.getSpace(space.id)).toBeNull();
    });

    it('returns false for unknown space', async () => {
      expect(await manager.deleteSpace('nonexistent')).toBe(false);
    });
  });

  describe('addSession / removeSession', () => {
    it('adds and removes sessions', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'A' });

      const withSession = await manager.addSession(space.id, 'sess-1');
      expect(withSession.sessionIds).toContain('sess-1');

      const without = await manager.removeSession(space.id, 'sess-1');
      expect(without.sessionIds).not.toContain('sess-1');
    });

    it('throws for unknown space', async () => {
      await expect(manager.addSession('nonexistent', 's1')).rejects.toThrow('not found');
      await expect(manager.removeSession('nonexistent', 's1')).rejects.toThrow('not found');
    });
  });

  describe('workspace delegation', () => {
    function spaceSession(id: string, spaceId: string, workspacePath: string): Session {
      return {
        id,
        title: id,
        workspacePath,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {},
        metadata: {},
        context: { spaceId },
      } as unknown as Session;
    }

    async function spaceWithSecondaryWorkspace(name: string): Promise<{
      space: Space;
      repoPath: string;
      recordId: string;
    }> {
      const space = await manager.createSpace({ workspacePath: tmpDir, name });
      const repoDir = mkdtempSync(join(tmpdir(), 'space-workspace-repo-'));
      execSync('git init -q', { cwd: repoDir });
      const repoPath = realpathSync(repoDir);
      const record = await manager.registerWorkspace(space.id, repoPath, 'secondary');
      return { space, repoPath, recordId: record.id };
    }

    it('blocks removal of the primary workspace', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'Primary Guard' });
      const primary = manager.listWorkspaces(space.id).find((w) => w.isPrimary)!;

      let blocked: unknown;
      try {
        manager.removeWorkspace(space.id, primary.id);
      } catch (e) {
        blocked = e;
      }
      expect(blocked).toBeInstanceOf(WorkspaceRemovalBlockedError);
      expect((blocked as WorkspaceRemovalBlockedError).reason).toBe('primary');
    });

    it('holds removal guards end-to-end with real sessions', async () => {
      const sessionRepo = new SessionRepository(db as any);
      const { space, repoPath, recordId } = await spaceWithSecondaryWorkspace('Guarded');
      expect(manager.listWorkspaces(space.id)).toHaveLength(2);

      sessionRepo.createSession(spaceSession('sess-direct', space.id, repoPath));
      sessionRepo.createSession({
        ...spaceSession('sess-worktree', space.id, `${repoPath}-wt`),
        worktree: {
          isWorktree: true,
          worktreePath: `${repoPath}-wt`,
          mainRepoPath: repoPath,
          branch: 'session/x',
        },
      });

      let blocked: unknown;
      try {
        manager.removeWorkspace(space.id, recordId);
      } catch (e) {
        blocked = e;
      }
      expect(blocked).toBeInstanceOf(WorkspaceRemovalBlockedError);
      expect((blocked as WorkspaceRemovalBlockedError).reason).toBe('active_sessions');

      sessionRepo.archiveSession('sess-direct');
      sessionRepo.updateSession('sess-worktree', { status: 'ended' });

      expect(manager.removeWorkspace(space.id, recordId)).toBe(true);
      expect(manager.listWorkspaces(space.id)).toHaveLength(1);
    });

    it('notifies space_workspaces subscribers when deleting a space cascades its rows away', async () => {
      const notifications: Array<{ table: string; scope?: { spaceId?: string } }> = [];
      const notifyingManager = new SpaceManager(
        db as any,
        {
          notifyChange: (table: string, scope?: { spaceId?: string }) => {
            notifications.push({ table, scope });
          },
        } as never
      );
      const space = await notifyingManager.createSpace({
        workspacePath: tmpDir,
        name: 'Doomed',
      });

      const beforeDelete = notifications.length;
      await expect(notifyingManager.deleteSpace(space.id)).resolves.toBe(true);
      expect(notifications.slice(beforeDelete)).toEqual([
        { table: 'space_workspaces', scope: { spaceId: space.id } },
      ]);
    });
  });

  describe('onSpaceResumedRegister', () => {
    it('invokes registered callbacks on resume and start', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'A' });
      const calls: string[] = [];
      manager.onSpaceResumedRegister((spaceId) => calls.push(spaceId));

      await manager.pauseSpace(space.id);
      await manager.resumeSpace(space.id);
      expect(calls).toContain(space.id);

      calls.length = 0;
      await manager.stopSpace(space.id);
      await manager.startSpace(space.id);
      expect(calls).toContain(space.id);
    });

    it('returns an unsubscribe that removes the callback', async () => {
      const space = await manager.createSpace({ workspacePath: tmpDir, name: 'A' });
      const calls: string[] = [];
      const unsubscribe = manager.onSpaceResumedRegister((spaceId) => calls.push(spaceId));

      unsubscribe();
      await manager.pauseSpace(space.id);
      await manager.resumeSpace(space.id);
      expect(calls).toHaveLength(0);
    });
  });
});
