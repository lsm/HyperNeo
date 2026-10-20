import { describe, expect, test } from 'bun:test';
import {
  BACKGROUND_TASK_METADATA_SQL,
  MESSAGES_BY_SESSION_SQL,
} from '../../../../../src/lib/live-query/queries/messages.ts';
import { SDKMessageRepository } from '../../../../../src/storage/repositories/sdk-message-repository.ts';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration409 } from '../../../../../src/storage/schema/m409-sdk-messages-covering-indexes.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const plan = (db: Database, sql: string, ...params: unknown[]) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
    .map((row) => row.detail)
    .join('\n');

function visibleCountPlan(db: Database): string {
  const plans: string[] = [];
  const prepare = db.prepare.bind(db);
  new SDKMessageRepository(
    Object.assign(Object.create(db), {
      prepare: (sql: string) => {
        if (sql.includes('COUNT(*) AS n FROM sdk_messages')) plans.push(plan(db, sql, 's1'));
        return prepare(sql);
      },
    })
  ).recomputeVisibleMessageCount('s1');
  return plans.join('\n');
}

describe('runMigration409', () => {
  test('session counts, the shutdown boundary and task metadata read indexes, not message rows', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    runMigration409(db);
    runMigration409(db);
    expect(visibleCountPlan(db)).toContain('COVERING INDEX idx_sdk_messages_session_visible');
    expect(plan(db, MESSAGES_BY_SESSION_SQL, 's1', 200)).toContain(
      'SEARCH sdk_messages USING COVERING INDEX idx_sdk_messages_session_visible'
    );
    expect(
      plan(db, BACKGROUND_TASK_METADATA_SQL, 's1', 's1', 's1', 's1', 's1', 's1', 's1')
    ).toContain('idx_sdk_messages_session_subtype_time');
    db.close();
  });
});
