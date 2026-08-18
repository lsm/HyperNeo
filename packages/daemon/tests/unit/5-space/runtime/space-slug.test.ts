import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { runMigration63 } from '../../../../src/storage/schema/migrations';
import { slugify } from '../../../../src/lib/space/slug';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
		CREATE TABLE spaces (
			id TEXT PRIMARY KEY,
			workspace_path TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			background_context TEXT NOT NULL DEFAULT '',
			instructions TEXT NOT NULL DEFAULT '',
			default_model TEXT,
			allowed_models TEXT NOT NULL DEFAULT '[]',
			session_ids TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'archived')),
			autonomy_level TEXT DEFAULT 'supervised',
			max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
			config TEXT,
			task_agent_config TEXT,
			setting_sources TEXT DEFAULT NULL,
			slug TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug ON spaces(slug)`);
  return db;
}

describe('SpaceRepository — slug operations', () => {
  let db: InstanceType<typeof Database>;
  let repo: SpaceRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SpaceRepository(db);
  });

  test('createSpace stores slug', () => {
    const space = repo.createSpace({
      workspacePath: '/tmp/test-ws',
      name: 'My Project',
      slug: 'my-project',
    });

    expect(space.slug).toBe('my-project');
  });

  test('getSpace returns slug', () => {
    const created = repo.createSpace({
      workspacePath: '/tmp/test-ws',
      name: 'My Project',
      slug: 'my-project',
    });

    const fetched = repo.getSpace(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.slug).toBe('my-project');
  });

  test('getSpaceBySlug finds space by slug', () => {
    repo.createSpace({
      workspacePath: '/tmp/test-ws',
      name: 'My Project',
      slug: 'my-project',
    });

    const found = repo.getSpaceBySlug('my-project');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('My Project');
  });

  test('getSpaceBySlug returns null for unknown slug', () => {
    expect(repo.getSpaceBySlug('nonexistent')).toBeNull();
  });

  test('updateSlug changes the slug', () => {
    const space = repo.createSpace({
      workspacePath: '/tmp/test-ws',
      name: 'My Project',
      slug: 'my-project',
    });

    const updated = repo.updateSlug(space.id, 'new-slug');
    expect(updated).not.toBeNull();
    expect(updated!.slug).toBe('new-slug');
  });

  test('updateSlug enforces uniqueness', () => {
    repo.createSpace({
      workspacePath: '/tmp/ws-1',
      name: 'Space One',
      slug: 'space-one',
    });
    const space2 = repo.createSpace({
      workspacePath: '/tmp/ws-2',
      name: 'Space Two',
      slug: 'space-two',
    });

    expect(() => repo.updateSlug(space2.id, 'space-one')).toThrow();
  });

  test('getAllSlugs returns all slugs', () => {
    repo.createSpace({
      workspacePath: '/tmp/ws-1',
      name: 'Space One',
      slug: 'space-one',
    });
    repo.createSpace({
      workspacePath: '/tmp/ws-2',
      name: 'Space Two',
      slug: 'space-two',
    });

    const slugs = repo.getAllSlugs();
    expect(slugs).toContain('space-one');
    expect(slugs).toContain('space-two');
    expect(slugs).toHaveLength(2);
  });

  test('listSpaces includes slug in results', () => {
    repo.createSpace({
      workspacePath: '/tmp/ws-1',
      name: 'First',
      slug: 'first',
    });
    repo.createSpace({
      workspacePath: '/tmp/ws-2',
      name: 'Second',
      slug: 'second',
    });

    const spaces = repo.listSpaces();
    expect(spaces).toHaveLength(2);
    expect(spaces.every((s) => s.slug.length > 0)).toBe(true);
  });
});

describe('slugify — collision handling with repository', () => {
  test('generates unique slugs for spaces with same name', () => {
    const existing = ['my-project'];
    const slug1 = slugify('My Project', existing);
    expect(slug1).toBe('my-project-2');

    existing.push(slug1);
    const slug2 = slugify('My Project', existing);
    expect(slug2).toBe('my-project-3');
  });

  test('generates unique slug when existing list is empty', () => {
    expect(slugify('My Project', [])).toBe('my-project');
  });
});

describe('Migration 61 — slug backfill', () => {
  test('adds slug column and backfills existing spaces', () => {
    const db = new Database(':memory:');
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active',
				autonomy_level TEXT DEFAULT 'supervised',
				max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('s1', '/tmp/ws-1', 'HyperNeo Dev', now, now);
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('s2', '/tmp/ws-2', 'My Project', now, now);

    runMigration63(db);

    const rows = db.prepare('SELECT id, slug FROM spaces ORDER BY id').all() as Array<{
      id: string;
      slug: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].slug).toBe('hyperneo-dev');
    expect(rows[1].slug).toBe('my-project');
  });

  test('handles collision during backfill', () => {
    const db = new Database(':memory:');
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active',
				autonomy_level TEXT DEFAULT 'supervised',
				max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('s1', '/tmp/ws-1', 'My Project', now, now);
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('s2', '/tmp/ws-2', 'My Project', now, now);

    runMigration63(db);

    const rows = db.prepare('SELECT id, slug FROM spaces ORDER BY id').all() as Array<{
      id: string;
      slug: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].slug).toBe('my-project');
    expect(rows[1].slug).toBe('my-project-2');
  });

  test('enforces NOT NULL constraint on slug after migration', () => {
    const db = new Database(':memory:');
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active',
				autonomy_level TEXT DEFAULT 'supervised',
				max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    runMigration63(db);

    const tableInfo = db.prepare('PRAGMA table_info(spaces)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const slugCol = tableInfo.find((col) => col.name === 'slug');
    expect(slugCol).toBeDefined();
    expect(slugCol!.notnull).toBe(1);

    const now = Date.now();
    expect(() => {
      db.prepare(
        `INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).run('s-null', '/tmp/ws-null', 'Null Slug', now, now);
    }).toThrow();
  });

  test('is idempotent — running twice does not error', () => {
    const db = new Database(':memory:');
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active',
				autonomy_level TEXT DEFAULT 'supervised',
				max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    runMigration63(db);
    runMigration63(db);
  });
});
