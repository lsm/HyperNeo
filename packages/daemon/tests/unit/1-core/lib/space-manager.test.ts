import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
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
    } catch {
      // ignore cleanup errors
    }
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
