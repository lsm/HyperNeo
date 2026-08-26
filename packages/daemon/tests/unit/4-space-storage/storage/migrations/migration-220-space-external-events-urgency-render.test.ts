import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat';
import { ExternalEventStore } from '../../../../../src/lib/external-events/external-event-store';
import type { ExternalEvent } from '../../../../../src/lib/external-events/types';
import { createTables, runMigrations } from '../../../../../src/storage/schema';
import { runMigration220 } from '../../../../../src/storage/schema/m220-space-external-events-urgency-render';

const SPACE_ID = 'sp-evt-220';

function columnNames(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

function insertSpace(db: Database): void {
  db.exec(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
     VALUES ('${SPACE_ID}', '${SPACE_ID}', '/tmp/${SPACE_ID}', 'Test Space', 1, 1)`
  );
}

function insertLegacyEvent(db: Database): void {
  db.exec(
    `INSERT INTO space_external_events (
				id, space_id, source, topic, dedupe_key,
				occurred_at, ingested_at, summary, payload_json,
				state, created_at, updated_at
			) VALUES (
				'evt-legacy', '${SPACE_ID}', 'github', 'github/lsm/neokai/pull_request/1.opened', 'dk-legacy',
				1_700_000_000_000, 1_700_000_001_000, 'PR #1 opened', '{}',
				'published', 1, 1
			)`
  );
}

describe('migration 220 — space_external_events urgency + render', () => {
  test('adds nullable urgency and render, leaves existing rows NULL, and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE space_external_events (id TEXT PRIMARY KEY, summary TEXT NOT NULL)`);
    db.exec(`INSERT INTO space_external_events (id, summary) VALUES ('evt-1', 'legacy')`);

    runMigration220(db);
    runMigration220(db);

    expect(columnNames(db, 'space_external_events')).toContain('urgency');
    expect(columnNames(db, 'space_external_events')).toContain('render');
    expect(columnNames(db, 'space_external_events').filter((c) => c === 'urgency')).toHaveLength(1);
    const row = db
      .prepare(`SELECT urgency, render FROM space_external_events WHERE id = 'evt-1'`)
      .get() as { urgency: string | null; render: string | null };
    expect(row).toEqual({ urgency: null, render: null });
    db.close();
  });

  test('fresh DB gets the columns through the full migration chain and records the marker', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);

    expect(columnNames(db, 'space_external_events')).toContain('urgency');
    expect(columnNames(db, 'space_external_events')).toContain('render');
    expect(
      db.prepare(`SELECT 1 FROM migration_markers WHERE key = 'migration_220'`).get()
    ).toBeDefined();
    db.close();
  });

  test('daemon boot on a pre-migration DB adds the columns and keeps legacy rows NULL', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    db.exec(`ALTER TABLE space_external_events DROP COLUMN urgency`);
    db.exec(`ALTER TABLE space_external_events DROP COLUMN render`);
    db.prepare(`DELETE FROM migration_markers WHERE key = 'migration_220'`).run();
    insertSpace(db);
    insertLegacyEvent(db);

    expect(() => {
      runMigrations(db, () => {});
      createTables(db);
    }).not.toThrow();

    expect(columnNames(db, 'space_external_events')).toContain('urgency');
    expect(columnNames(db, 'space_external_events')).toContain('render');
    const row = db
      .prepare(`SELECT urgency, render FROM space_external_events WHERE id = 'evt-legacy'`)
      .get() as { urgency: string | null; render: string | null };
    expect(row).toEqual({ urgency: null, render: null });
    db.close();
  });

  test('round-trips urgency and render through ExternalEventStore', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    insertSpace(db);
    insertLegacyEvent(db);
    const store = new ExternalEventStore(db);

    const event: ExternalEvent = {
      id: 'evt-rt',
      spaceId: SPACE_ID,
      source: 'github',
      topic: 'github/lsm/neokai/pull_request/42.review_submitted',
      occurredAt: 1_700_000_000_000,
      ingestedAt: 1_700_000_001_000,
      dedupeKey: 'github:pr:42:review_submitted:12345',
      summary: 'PR #42 review submitted',
      payload: { review_id: 12345 },
      urgency: 'immediate',
      render: 'PR #42 review submitted (APPROVED)',
    };

    const stored = store.store(event);
    expect(stored.event.urgency).toBe('immediate');
    const rec = store.getById('evt-rt');
    expect(rec?.event.urgency).toBe('immediate');
    expect(rec?.event.render).toBe('PR #42 review submitted (APPROVED)');
    const byDedupe = store.getByDedupe(SPACE_ID, 'github', event.dedupeKey);
    expect(byDedupe?.event.urgency).toBe('immediate');

    const legacy = store.getByDedupe(SPACE_ID, 'github', 'dk-legacy');
    expect(legacy?.event.urgency).toBeUndefined();
    expect(legacy?.event.render).toBeUndefined();

    store.registerExpectedDelivery('evt-rt', 'dk-rt', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    const log = store.listDeliveryLog({ spaceId: SPACE_ID, eventId: 'evt-rt' });
    expect(log).toHaveLength(1);
    expect(log[0].event.urgency).toBe('immediate');
    expect(log[0].event.render).toBe('PR #42 review submitted (APPROVED)');
    db.close();
  });
});
