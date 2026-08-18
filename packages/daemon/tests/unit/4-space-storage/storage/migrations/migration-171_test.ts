import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration171 } from '../../../../../src/storage/schema/m171-backfill-post-approval-review-channels';

interface ChannelRow {
  from?: string;
  to?: string | string[];
}

const OLD_CHANNELS: ChannelRow[] = [
  { from: 'Coding', to: 'Review' },
  { from: 'Review', to: 'Coding' },
  { from: 'Post-Approval', to: 'Coding' },
  { from: 'Coding', to: 'Post-Approval' },
];

function insertSpace(db: BunDatabase, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, id, '/ws', id, now, now);
}

function insertWorkflow(
  db: BunDatabase,
  opts: {
    id: string;
    spaceId: string;
    name: string;
    channels: ChannelRow[];
    templateName?: string | null;
  }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflows (
			id, space_id, name, description, start_node_id, end_node_id,
			tags, channels, created_at, updated_at, template_name, template_hash
		 ) VALUES (?, ?, ?, '', NULL, NULL, '[]', ?, ?, ?, ?, NULL)`
  ).run(
    opts.id,
    opts.spaceId,
    opts.name,
    JSON.stringify(opts.channels),
    now,
    now,
    opts.templateName ?? null
  );
}

function getChannels(db: BunDatabase, id: string): ChannelRow[] {
  const row = db.prepare(`SELECT channels FROM space_workflows WHERE id = ?`).get(id) as
    | { channels: string | null }
    | undefined;
  if (!row || !row.channels) return [];
  try {
    const parsed = JSON.parse(row.channels);
    return Array.isArray(parsed) ? (parsed as ChannelRow[]) : [];
  } catch {
    return [];
  }
}

function hasChannel(channels: ChannelRow[], from: string, to: string): boolean {
  return channels.some((c) => c.from === from && c.to === to);
}

describe('Migration 171: backfill Post-Approval ↔ Review channels', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', `m171-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    runMigrations(db, () => {});
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  test('adds Post-Approval ↔ Review channels to built-in merge-capable workflows', () => {
    insertSpace(db, 'sp-1');
    insertWorkflow(db, {
      id: 'wf-coding',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      templateName: 'Coding Workflow',
      channels: OLD_CHANNELS,
    });
    insertWorkflow(db, {
      id: 'wf-research',
      spaceId: 'sp-1',
      name: 'Research Workflow',
      templateName: 'Research Workflow',
      channels: OLD_CHANNELS,
    });
    insertWorkflow(db, {
      id: 'wf-qa',
      spaceId: 'sp-1',
      name: 'Coding with QA Workflow',
      templateName: 'Coding with QA Workflow',
      channels: OLD_CHANNELS,
    });

    runMigration171(db);

    for (const id of ['wf-coding', 'wf-research', 'wf-qa']) {
      const channels = getChannels(db, id);
      expect(hasChannel(channels, 'Post-Approval', 'Review')).toBe(true);
      expect(hasChannel(channels, 'Review', 'Post-Approval')).toBe(true);
      expect(hasChannel(channels, 'Coding', 'Review')).toBe(true);
    }
  });

  test('idempotent — running twice does not duplicate channels', () => {
    insertSpace(db, 'sp-1');
    insertWorkflow(db, {
      id: 'wf-coding',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      templateName: 'Coding Workflow',
      channels: OLD_CHANNELS,
    });

    runMigration171(db);
    const afterFirst = getChannels(db, 'wf-coding');
    runMigration171(db);
    const afterSecond = getChannels(db, 'wf-coding');

    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(hasChannel(afterSecond, 'Post-Approval', 'Review')).toBe(true);
    expect(afterSecond.filter((c) => c.from === 'Post-Approval' && c.to === 'Review')).toHaveLength(
      1
    );
  });

  test('does not touch custom workflows, even one reusing a built-in display name', () => {
    insertSpace(db, 'sp-1');
    insertWorkflow(db, {
      id: 'wf-custom',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      channels: OLD_CHANNELS,
    });

    runMigration171(db);

    const channels = getChannels(db, 'wf-custom');
    expect(channels).toHaveLength(OLD_CHANNELS.length);
    expect(hasChannel(channels, 'Post-Approval', 'Review')).toBe(false);
  });

  test('no-op when channels already backfilled', () => {
    insertSpace(db, 'sp-1');
    insertWorkflow(db, {
      id: 'wf-coding',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      templateName: 'Coding Workflow',
      channels: [
        ...OLD_CHANNELS,
        { from: 'Post-Approval', to: 'Review' },
        { from: 'Review', to: 'Post-Approval' },
      ],
    });

    runMigration171(db);

    const channels = getChannels(db, 'wf-coding');
    expect(channels).toHaveLength(6);
    expect(channels.filter((c) => c.from === 'Post-Approval' && c.to === 'Review')).toHaveLength(1);
  });

  test('remaps endpoints to renamed persisted nodes via agent slots', () => {
    insertSpace(db, 'sp-1');
    insertWorkflow(db, {
      id: 'wf-coding',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      templateName: 'Coding Workflow',
      channels: OLD_CHANNELS,
    });
    const insertNode = db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, description, config, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?)`
    );
    const now = Date.now();
    insertNode.run(
      'n-coder',
      'wf-coding',
      'Coders',
      JSON.stringify({ agents: [{ name: 'coder' }] }),
      now,
      now
    );
    insertNode.run(
      'n-review',
      'wf-coding',
      'Code Review',
      JSON.stringify({ agents: [{ name: 'reviewer' }] }),
      now,
      now
    );
    insertNode.run(
      'n-merger',
      'wf-coding',
      'Merge Step',
      JSON.stringify({ agents: [{ name: 'merger' }] }),
      now,
      now
    );

    runMigration171(db);

    const channels = getChannels(db, 'wf-coding');
    expect(hasChannel(channels, 'Merge Step', 'Code Review')).toBe(true);
    expect(hasChannel(channels, 'Code Review', 'Merge Step')).toBe(true);
    expect(hasChannel(channels, 'Post-Approval', 'Review')).toBe(false);
    expect(hasChannel(channels, 'Review', 'Post-Approval')).toBe(false);
  });

  test('does not throw on a partial schema lacking space_workflow_nodes', () => {
    insertSpace(db, 'sp-1');
    insertWorkflow(db, {
      id: 'wf-coding',
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      templateName: 'Coding Workflow',
      channels: OLD_CHANNELS,
    });
    db.exec(`DROP TABLE space_workflow_nodes`);

    expect(() => runMigration171(db)).not.toThrow();

    const channels = getChannels(db, 'wf-coding');
    expect(hasChannel(channels, 'Post-Approval', 'Review')).toBe(true);
    expect(hasChannel(channels, 'Review', 'Post-Approval')).toBe(true);
  });
});
