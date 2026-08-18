import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration53 } from '../../../../../src/storage/schema/migrations.ts';
import { SpaceWorkflowRepository } from '../../../../../src/storage/repositories/space-workflow-repository.ts';

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return info.some((c) => c.name === column);
}

function createMinimalWorkflowsTable(db: BunDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			start_node_id TEXT,
			config TEXT,
			layout TEXT,
			max_iterations INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
}

describe('Migration 53: channels column on space_workflows', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-53', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('space_workflows has channels column after migration', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_workflows', 'channels')).toBe(true);
  });

  test('migration is idempotent — running twice does not throw', () => {
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
  });

  test('new rows without channels have NULL in the channels column', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-no-ch', 'm53a', '/workspace/m53a', 'Space A', ${now}, ${now})`
    );
    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-no-ch', 'sp-no-ch', 'No Channels', ${now}, ${now})`
    );

    const row = db.prepare(`SELECT channels FROM space_workflows WHERE id = 'wf-no-ch'`).get() as {
      channels: string | null;
    };
    expect(row.channels).toBeNull();
  });

  test('channels round-trip correctly via repository create and get', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-rt', 'm53b', '/workspace/m53b', 'Space B', ${now}, ${now})`
    );

    const repo = new SpaceWorkflowRepository(db);
    const wf = repo.createWorkflow({
      spaceId: 'sp-rt',
      name: 'Round-Trip',
      nodes: [
        { id: 'node-a', name: 'Alpha' },
        { id: 'node-b', name: 'Beta' },
      ],
      channels: [
        { id: 'ch-1', from: 'node-a', to: 'node-b', label: 'alpha to beta' },
        { id: 'ch-2', from: 'node-b', to: 'node-a' },
      ],
      completionAutonomyLevel: 3,
    });

    const raw = db.prepare(`SELECT channels FROM space_workflows WHERE id = ?`).get(wf.id) as {
      channels: string | null;
    };
    expect(raw.channels).not.toBeNull();
    const stored = JSON.parse(raw.channels!) as unknown[];
    expect(stored).toHaveLength(2);

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.channels).toHaveLength(2);
    expect(fetched!.channels![0]).toMatchObject({
      from: 'node-a',
      to: 'node-b',
      label: 'alpha to beta',
    });
    expect(fetched!.channels![1]).toMatchObject({
      from: 'node-b',
      to: 'node-a',
    });
  });

  test('tags column exists after full migration (added by M74)', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-cfg', 'm53c', '/workspace/m53c', 'Space C', ${now}, ${now})`
    );

    const repo = new SpaceWorkflowRepository(db);
    const wf = repo.createWorkflow({
      spaceId: 'sp-cfg',
      name: 'Config Check',
      completionAutonomyLevel: 3,
    });

    expect(columnExists(db, 'space_workflows', 'config')).toBe(false);
    expect(columnExists(db, 'space_workflows', 'tags')).toBe(true);
    const raw = db.prepare(`SELECT tags FROM space_workflows WHERE id = ?`).get(wf.id) as {
      tags: string;
    };
    expect(raw.tags).toBe('[]');
  });

  test('updating channels via repository writes to the channels column', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-upd', 'm53d', '/workspace/m53d', 'Space D', ${now}, ${now})`
    );

    const repo = new SpaceWorkflowRepository(db);
    const wf = repo.createWorkflow({
      spaceId: 'sp-upd',
      name: 'Update Test',
      completionAutonomyLevel: 3,
    });

    repo.updateWorkflow(wf.id, {
      channels: [
        { id: 'ch-1', from: 'node-x', to: 'node-y' },
        { id: 'ch-2', from: 'node-y', to: 'node-x', label: 'reply' },
      ],
    });

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched!.channels).toHaveLength(2);
    expect(fetched!.channels![1].label).toBe('reply');
  });

  test('setting channels to null clears the channels column', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-clr', 'm53e', '/workspace/m53e', 'Space E', ${now}, ${now})`
    );

    const repo = new SpaceWorkflowRepository(db);
    const wf = repo.createWorkflow({
      spaceId: 'sp-clr',
      name: 'Clear Test',
      completionAutonomyLevel: 3,
    });

    repo.updateWorkflow(wf.id, { channels: null });

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched!.channels).toBeUndefined();

    const raw = db.prepare(`SELECT channels FROM space_workflows WHERE id = ?`).get(wf.id) as {
      channels: string | null;
    };
    expect(raw.channels).toBeNull();
  });

  test('data migration: existing rows with channels in config JSON are migrated to the channels column', () => {
    createMinimalWorkflowsTable(db);

    const now = Date.now();
    const legacyConfig = JSON.stringify({
      tags: ['legacy'],
      rules: [],
      channels: [{ id: 'ch-1', from: 'old-a', to: 'old-b', label: 'legacy link' }],
    });
    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, config, created_at, updated_at)
			 VALUES ('wf-legacy', 'sp-legacy', 'Legacy WF', '${legacyConfig}', ${now}, ${now})`
    );

    expect(columnExists(db, 'space_workflows', 'channels')).toBe(false);

    runMigration53(db);

    expect(columnExists(db, 'space_workflows', 'channels')).toBe(true);

    const raw = db.prepare(`SELECT channels FROM space_workflows WHERE id = 'wf-legacy'`).get() as {
      channels: string | null;
    };

    expect(raw.channels).not.toBeNull();
    const migratedChannels = JSON.parse(raw.channels!) as Array<Record<string, unknown>>;
    expect(migratedChannels).toHaveLength(1);
    expect(migratedChannels[0]).toMatchObject({
      from: 'old-a',
      to: 'old-b',
      label: 'legacy link',
    });
  });

  test('data migration: rows without channels in config are left with NULL in channels column', () => {
    createMinimalWorkflowsTable(db);

    const now = Date.now();
    const configNoCh = JSON.stringify({ tags: ['no-channels'], rules: [] });
    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, config, created_at, updated_at)
			 VALUES ('wf-noch', 'sp-noch', 'No Ch WF', '${configNoCh}', ${now}, ${now})`
    );

    runMigration53(db);

    const raw = db.prepare(`SELECT channels FROM space_workflows WHERE id = 'wf-noch'`).get() as {
      channels: string | null;
    };
    expect(raw.channels).toBeNull();
  });
});
