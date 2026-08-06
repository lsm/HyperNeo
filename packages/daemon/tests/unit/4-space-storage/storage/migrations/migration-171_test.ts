/**
 * Migration 171 Tests — Backfill Post-Approval ↔ Review channels.
 *
 * Covers:
 *   - Adds Post-Approval → Review and Review → Post-Approval to each built-in
 *     merge-capable workflow (Coding / Research / Coding with QA) that lacks them.
 *   - Idempotent: running twice leaves channels unchanged (no duplicates).
 *   - Custom (non-built-in) workflows are never touched.
 *   - No-op on a DB without space_workflows.
 */

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

// Pre-redesign Coding/Research channels (no Post-Approval ↔ Review).
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
			tags, channels, gates, created_at, updated_at, template_name, template_hash
		 ) VALUES (?, ?, ?, '', NULL, NULL, '[]', ?, '[]', ?, ?, ?, NULL)`
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
      // Original channels are preserved.
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
    // Exactly one Post-Approval → Review entry.
    expect(afterSecond.filter((c) => c.from === 'Post-Approval' && c.to === 'Review')).toHaveLength(
      1
    );
  });

  test('does not touch custom workflows, even one reusing a built-in display name', () => {
    // template_name is NULL → not a confirmed built-in, even though the display
    // name matches 'Coding Workflow' (e.g. the real built-in was renamed and a
    // custom workflow took the freed name). Strict template_name matching must
    // skip it.
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
});
