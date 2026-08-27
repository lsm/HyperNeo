import { beforeEach, describe, expect, test } from 'bun:test';
import { SpaceWorkspaceRepository } from '../../../src/storage/repositories/space-workspace-repository';
import { createSpaceTables } from '../helpers/space-test-db';
import { Database as BunDatabase } from '../../../src/storage/sqlite-compat';

const SPACE_A = 'space-a';
const SPACE_B = 'space-b';

function makeRepo(): { repo: SpaceWorkspaceRepository; db: BunDatabase } {
  const db = new BunDatabase(':memory:');
  createSpaceTables(db);
  const now = Date.now();
  for (const id of [SPACE_A, SPACE_B]) {
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, id, `/repos/${id}`, id, now, now, 'active');
  }
  return { repo: new SpaceWorkspaceRepository(db), db };
}

describe('SpaceWorkspaceRepository', () => {
  let repo: SpaceWorkspaceRepository;
  let db: BunDatabase;

  beforeEach(() => {
    ({ repo, db } = makeRepo());
  });

  test('create persists a row and getById round-trips it', () => {
    const primary = repo.create({
      spaceId: SPACE_A,
      path: '/repos/alpha',
      label: 'alpha',
      isPrimary: true,
    });
    expect(primary.id).toBeTruthy();
    expect(primary.spaceId).toBe(SPACE_A);
    expect(primary.path).toBe('/repos/alpha');
    expect(primary.label).toBe('alpha');
    expect(primary.isPrimary).toBe(true);
    expect(primary.createdAt).toBeGreaterThan(0);
    expect(primary.updatedAt).toBeGreaterThan(0);
    expect(repo.getById(primary.id)).toEqual(primary);

    const secondary = repo.create({ spaceId: SPACE_A, path: '/repos/beta' });
    expect(secondary.label).toBe('');
    expect(secondary.isPrimary).toBe(false);
  });

  test('duplicate (space_id, path) violates UNIQUE(space_id, path) and surfaces as an error', () => {
    repo.create({ spaceId: SPACE_A, path: '/repos/alpha' });
    expect(() => repo.create({ spaceId: SPACE_A, path: '/repos/alpha' })).toThrow(
      /UNIQUE constraint/i
    );
    expect(repo.countBySpace(SPACE_A)).toBe(1);
  });

  test('a second primary in the same space violates the partial unique index', () => {
    repo.create({ spaceId: SPACE_A, path: '/repos/alpha', isPrimary: true });
    expect(() => repo.create({ spaceId: SPACE_A, path: '/repos/beta', isPrimary: true })).toThrow(
      /UNIQUE constraint/i
    );
    expect(repo.listBySpace(SPACE_A)).toHaveLength(1);
  });

  test('listBySpace puts the primary first, then orders by created_at', () => {
    const primary = repo.create({ spaceId: SPACE_A, path: '/repos/a', isPrimary: true });
    repo.create({ spaceId: SPACE_A, path: '/repos/b' });
    const lateSecondary = repo.create({ spaceId: SPACE_A, path: '/repos/c' });
    db.prepare(`UPDATE space_workspaces SET created_at = ? WHERE id = ?`).run(
      1000,
      lateSecondary.id
    );

    const rows = repo.listBySpace(SPACE_A);
    expect(rows.map((r) => r.path)).toEqual(['/repos/a', '/repos/c', '/repos/b']);
    expect(rows[0]!.isPrimary).toBe(true);
    expect(rows[0]!.id).toBe(primary.id);
  });

  test('listBySpace breaks created_at ties on id so the order is stable', () => {
    const first = repo.create({ spaceId: SPACE_A, path: '/repos/a' });
    const second = repo.create({ spaceId: SPACE_A, path: '/repos/b' });
    const third = repo.create({ spaceId: SPACE_A, path: '/repos/c' });
    db.prepare(`UPDATE space_workspaces SET created_at = ? WHERE space_id = ?`).run(1000, SPACE_A);

    const expected = [first.id, second.id, third.id].sort();
    for (let i = 0; i < 3; i++) {
      const rows = repo.listBySpace(SPACE_A);
      expect(rows.map((r) => r.id)).toEqual(expected);
    }
  });

  test('getByPath matches exact stored strings within one space only', () => {
    const inA = repo.create({ spaceId: SPACE_A, path: '/repos/shared' });
    const inB = repo.create({ spaceId: SPACE_B, path: '/repos/shared' });

    expect(repo.getByPath(SPACE_A, '/repos/shared')!.id).toBe(inA.id);
    expect(repo.getByPath(SPACE_B, '/repos/shared')!.id).toBe(inB.id);
    expect(repo.getByPath(SPACE_A, '/repos/shared/')).toBeNull();
    expect(repo.getByPath(SPACE_A, '/repos/other')).toBeNull();
  });

  test('findOwnerByPath resolves primary and secondary rows across spaces', () => {
    const primaryInA = repo.create({ spaceId: SPACE_A, path: '/repos/alpha', isPrimary: true });
    const secondaryInB = repo.create({ spaceId: SPACE_B, path: '/repos/beta' });

    expect(repo.findOwnerByPath('/repos/alpha')).toEqual(primaryInA);
    expect(repo.findOwnerByPath('/repos/beta')).toEqual(secondaryInB);
    expect(repo.findOwnerByPath('/repos/missing')).toBeNull();
  });

  test('findOwnerByPath prefers the primary row when multiple spaces share a path', () => {
    const secondaryInA = repo.create({ spaceId: SPACE_A, path: '/repos/shared' });
    const primaryInB = repo.create({ spaceId: SPACE_B, path: '/repos/shared', isPrimary: true });

    const owner = repo.findOwnerByPath('/repos/shared');
    expect(owner!.id).toBe(primaryInB.id);
    expect(owner!.id).not.toBe(secondaryInA.id);
  });

  test('findOwnerByPath breaks created_at ties on id so the winner is stable', () => {
    const inA = repo.create({ spaceId: SPACE_A, path: '/repos/shared' });
    const inB = repo.create({ spaceId: SPACE_B, path: '/repos/shared' });
    db.prepare(`UPDATE space_workspaces SET created_at = ?`).run(1000);

    const expected = [inA.id, inB.id].sort()[0]!;
    for (let i = 0; i < 3; i++) {
      expect(repo.findOwnerByPath('/repos/shared')!.id).toBe(expected);
    }
  });

  test('updateLabel changes only the target row and bumps updated_at', () => {
    const inA = repo.create({ spaceId: SPACE_A, path: '/repos/alpha' });
    const inB = repo.create({ spaceId: SPACE_B, path: '/repos/beta' });
    const before = repo.getById(inA.id)!;

    expect(repo.updateLabel(SPACE_A, inA.id, 'renamed')).toBe(true);
    const after = repo.getById(inA.id)!;
    expect(after.label).toBe('renamed');
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);

    expect(repo.updateLabel(SPACE_B, inA.id, 'cross-space')).toBe(false);
    expect(repo.updateLabel(SPACE_A, inB.id, 'wrong-id')).toBe(false);
    expect(repo.getById(inA.id)!.label).toBe('renamed');
  });

  test('delete removes only the space-scoped row and frees the primary slot', () => {
    const primary = repo.create({ spaceId: SPACE_A, path: '/repos/alpha', isPrimary: true });
    repo.create({ spaceId: SPACE_B, path: '/repos/beta' });

    expect(repo.delete(SPACE_B, primary.id)).toBe(false);
    expect(repo.countBySpace(SPACE_A)).toBe(1);

    expect(repo.delete(SPACE_A, primary.id)).toBe(true);
    expect(repo.getById(primary.id)).toBeNull();
    expect(repo.countBySpace(SPACE_A)).toBe(0);

    const replacement = repo.create({ spaceId: SPACE_A, path: '/repos/gamma', isPrimary: true });
    expect(replacement.isPrimary).toBe(true);
  });

  test('countBySpace counts only its own space', () => {
    repo.create({ spaceId: SPACE_A, path: '/repos/a1' });
    repo.create({ spaceId: SPACE_A, path: '/repos/a2' });
    repo.create({ spaceId: SPACE_B, path: '/repos/b1' });
    expect(repo.countBySpace(SPACE_A)).toBe(2);
    expect(repo.countBySpace(SPACE_B)).toBe(1);
  });

  test('createUnclaimed inserts and returns the record when the path is free', () => {
    const record = repo.createUnclaimed({ spaceId: SPACE_A, path: '/repos/alpha', label: 'a' });
    expect(record).not.toBeNull();
    expect(record!.path).toBe('/repos/alpha');
    expect(record!.label).toBe('a');
    expect(record!.isPrimary).toBe(false);
    expect(repo.countBySpace(SPACE_A)).toBe(1);
  });

  test('createUnclaimed returns null when any space already holds the path', () => {
    repo.create({ spaceId: SPACE_B, path: '/repos/alpha' });
    expect(repo.createUnclaimed({ spaceId: SPACE_A, path: '/repos/alpha' })).toBeNull();
    expect(repo.createUnclaimed({ spaceId: SPACE_B, path: '/repos/alpha' })).toBeNull();
    expect(repo.countBySpace(SPACE_A)).toBe(0);
    expect(repo.countBySpace(SPACE_B)).toBe(1);
  });
});
