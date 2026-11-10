import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { runMigrations } from '../../../../src/storage/schema/migrations.ts';
import { SessionExternalEventStore } from '../../../../src/lib/external-events/session-external-event-store.ts';
import {
  hasTopicSearches,
  legacyBindings,
  legacySql,
  observeLatestPrState,
  seedPrHistory,
  subject,
  topicIndex,
} from '../../helpers/latest-pr-state-fixture.ts';

describe('latestPrState', () => {
  test('a watched PR finds its latest state without scanning the GitHub event table', () => {
    const db = new Database(':memory:');
    try {
      seedPrHistory(db);
      runMigrations(db, () => {});
      expect(db.prepare('SELECT count(*) AS count FROM session_external_events').get()).toEqual({
        count: 26608,
      });
      const plans: string[][] = [];
      for (const [suffix, id] of [
        ['', 'unfamiliar'],
        ['1', 'poll-only'],
        ['2', 'opened-only'],
        ['3', 'reopened-only'],
        ['4', 'tie-last'],
        ['5', 'later-sync'],
        ['99999', null],
      ]) {
        const value = `${subject}${suffix}`.toUpperCase();
        const observed = observeLatestPrState(db, value);
        const legacy = db.prepare(legacySql).get(...legacyBindings(value)) as { id: string } | null;
        expect(observed.record?.event.id ?? null).toBe(id);
        expect(observed.record?.event.id ?? null).toBe(legacy?.id ?? null);
        expect(observed.record).toEqual(id ? new SessionExternalEventStore(db).getById(id) : null);
        plans.push(observed.plan);
      }
      const legacyPlan = db
        .prepare(`EXPLAIN QUERY PLAN ${legacySql}`)
        .all(...legacyBindings(subject)) as { detail: string }[];
      expect(hasTopicSearches(legacyPlan.map((row) => row.detail))).toBe(false);
      expect(plans.every(hasTopicSearches)).toBe(true);
    } finally {
      db.close();
    }
  });

  test('clean bootstrap installs the topic index and records its migration once', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, () => {});
      runMigrations(db, () => {});
      expect(
        db
          .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
          .get('index', topicIndex)
      ).toEqual({ name: topicIndex });
      expect(
        db
          .prepare("SELECT count(*) AS count FROM migration_markers WHERE key = 'migration_498'")
          .get()
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
