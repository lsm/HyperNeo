import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

const LIVE_STATS: [string, string][] = [
  ['idx_sdk_messages_parent_tool_use_id', '99652 243 122'],
  ['idx_sdk_messages_session_timestamp_id', '99652 243 1 1'],
];

function subagentPlan(db: Database): string {
  const plans: string[] = [];
  const prepare = db.prepare.bind(db);
  new SDKMessageRepository(
    Object.assign(Object.create(db), {
      prepare: (sql: string) => {
        if (sql.includes('parent_tool_use_id IN'))
          plans.push(
            ...(prepare(`EXPLAIN QUERY PLAN ${sql}`).all('s1', 'tu1') as { detail: string }[]).map(
              (row) => row.detail
            )
          );
        return prepare(sql);
      },
    })
  ).getSDKMessages('s1', 50);
  return plans.join('\n');
}

describe('SDKMessageRepository.getSDKMessages', () => {
  test('finds a page’s subagent rows by tool use id, not by walking the whole session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-plan-'));
    const path = join(dir, 'd.db');
    const seed = new Database(path);
    runMigrations(seed, () => {});
    createTables(seed);
    seed.exec('PRAGMA foreign_keys = OFF');
    const insert = seed.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, parent_tool_use_id)
       VALUES (?, 's1', ?, ?, ?, ?)`
    );
    const at = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();
    seed.transaction(() => {
      for (let i = 0; i < 45_000; i++)
        insert.run(
          `m${i}`,
          'assistant',
          '{"type":"assistant","message":{"content":[]}}',
          at(i),
          null
        );
      insert.run(
        'tool',
        'assistant',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Task","input":{}}]}}',
        at(45_000),
        null
      );
      for (let i = 0; i < 3; i++)
        insert.run(
          `child${i}`,
          'assistant',
          '{"type":"assistant","message":{"content":[]}}',
          at(45_001 + i),
          'tu1'
        );
    })();
    seed.exec('ANALYZE');
    const stale = seed.prepare(
      "UPDATE sqlite_stat1 SET stat = ? WHERE tbl = 'sdk_messages' AND idx = ?"
    );
    for (const [idx, stat] of LIVE_STATS) stale.run(stat, idx);
    seed.close();

    const db = new Database(path);
    const plan = subagentPlan(db);
    expect(plan).toContain(
      'idx_sdk_messages_parent_tool_use_id (session_id=? AND parent_tool_use_id=?)'
    );
    expect(plan).not.toContain('idx_sdk_messages_session_timestamp_id');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
