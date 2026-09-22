import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { LH_TASK_MANAGER_INSTRUCTIONS } from '@hyperneo/prompts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import {
  PRE_GOAL_TASK_TRIGGER_TASK_MANAGER_SHA256,
  runMigration269,
} from '../../../../../src/storage/schema/m269-restamp-goal-task-trigger.ts';

function retired(): string {
  return LH_TASK_MANAGER_INSTRUCTIONS.replaceAll('goal.task.trigger', 'goal.triggerTask');
}

function seed(): Database {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE space_long_horizon_agents (id TEXT PRIMARY KEY, handle TEXT, template_key TEXT, instructions TEXT)`
  );
  return db;
}

describe('migration 269', () => {
  test('the recorded hash is the current text with the rename reversed', () => {
    const value = retired();
    expect(value).not.toBe(LH_TASK_MANAGER_INSTRUCTIONS);
    expect(value).toContain('goal.triggerTask');
    expect(createHash('sha256').update(value).digest('hex')).toBe(
      PRE_GOAL_TASK_TRIGGER_TASK_MANAGER_SHA256
    );
  });

  test('restamps a pristine task-manager and leaves an edited one alone', () => {
    const db = seed();
    try {
      const edited = `${retired()}\n\nOperator note: keep an eye on stale reviews.`;
      db.prepare(`INSERT INTO space_long_horizon_agents VALUES (?, ?, ?, ?)`).run(
        'a1',
        'task-manager',
        'task-manager.default',
        retired()
      );
      db.prepare(`INSERT INTO space_long_horizon_agents VALUES (?, ?, ?, ?)`).run(
        'a2',
        'task-manager',
        'task-manager.default',
        edited
      );

      runMigration269(db);

      const rows = db
        .prepare(`SELECT id, instructions FROM space_long_horizon_agents ORDER BY id`)
        .all() as Array<{ id: string; instructions: string }>;
      expect(rows[0]!.instructions).toBe(LH_TASK_MANAGER_INSTRUCTIONS);
      expect(rows[1]!.instructions).toBe(edited);
    } finally {
      db.close();
    }
  });

  test('restamps a template copy whose handle was overridden or suffixed', () => {
    const db = seed();
    try {
      db.prepare(`INSERT INTO space_long_horizon_agents VALUES (?, ?, ?, ?)`).run(
        'renamed',
        'triage-bot',
        'task-manager.default',
        retired()
      );
      db.prepare(`INSERT INTO space_long_horizon_agents VALUES (?, ?, ?, ?)`).run(
        'second',
        'task-manager-2',
        'task-manager.default',
        retired()
      );

      runMigration269(db);

      const rows = db.prepare(`SELECT instructions FROM space_long_horizon_agents`).all() as Array<{
        instructions: string;
      }>;
      for (const row of rows) {
        expect(row.instructions).toBe(LH_TASK_MANAGER_INSTRUCTIONS);
      }
    } finally {
      db.close();
    }
  });

  test('is a no-op without the table', () => {
    const db = new Database(':memory:');
    try {
      expect(() => runMigration269(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
