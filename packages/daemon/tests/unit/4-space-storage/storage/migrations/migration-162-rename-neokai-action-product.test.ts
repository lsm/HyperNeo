import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration162 } from '../../../../../src/storage/schema/migrations';

describe('Migration 162: rename neokai_action / neokai_product to hyperneo_*', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  test('rewrites neokai_action message_type to hyperneo_action', () => {
    db.exec(`
      CREATE TABLE sdk_messages (
        id TEXT PRIMARY KEY,
        message_type TEXT NOT NULL,
        sdk_message TEXT
      );
    `);
    db.prepare(`INSERT INTO sdk_messages (id, message_type, sdk_message) VALUES (?, ?, ?)`).run(
      'a',
      'neokai_action',
      '{}'
    );
    db.prepare(`INSERT INTO sdk_messages (id, message_type, sdk_message) VALUES (?, ?, ?)`).run(
      'b',
      'result',
      '{}'
    );
    db.prepare(`INSERT INTO sdk_messages (id, message_type, sdk_message) VALUES (?, ?, ?)`).run(
      'c',
      'neokai_action',
      '{}'
    );

    runMigration162(db);

    const rows = db.prepare(`SELECT id, message_type FROM sdk_messages ORDER BY id`).all() as {
      id: string;
      message_type: string;
    }[];
    expect(rows).toEqual([
      { id: 'a', message_type: 'hyperneo_action' },
      { id: 'b', message_type: 'result' },
      { id: 'c', message_type: 'hyperneo_action' },
    ]);
  });

  test('also rewrites the type discriminator inside the sdk_message JSON blob', () => {
    db.exec(`
      CREATE TABLE sdk_messages (
        id TEXT PRIMARY KEY,
        message_type TEXT NOT NULL,
        sdk_message TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO sdk_messages (id, message_type, sdk_message) VALUES (?, ?, ?)`).run(
      'a',
      'neokai_action',
      JSON.stringify({ type: 'neokai_action', uuid: 'u1', action: 'sdk_resume_choice' })
    );
    db.prepare(`INSERT INTO sdk_messages (id, message_type, sdk_message) VALUES (?, ?, ?)`).run(
      'b',
      'assistant',
      JSON.stringify({ type: 'assistant', content: [] })
    );

    runMigration162(db);

    const actionRow = db.prepare(`SELECT sdk_message FROM sdk_messages WHERE id = 'a'`).get() as {
      sdk_message: string;
    };
    expect(JSON.parse(actionRow.sdk_message)).toEqual({
      type: 'hyperneo_action',
      uuid: 'u1',
      action: 'sdk_resume_choice',
    });
    const otherRow = db.prepare(`SELECT sdk_message FROM sdk_messages WHERE id = 'b'`).get() as {
      sdk_message: string;
    };
    expect(JSON.parse(otherRow.sdk_message).type).toBe('assistant');
  });

  test('retags neokai_product domain inside evolution_episodes.findings_json', () => {
    db.exec(`
      CREATE TABLE evolution_episodes (
        id TEXT PRIMARY KEY,
        findings_json TEXT NOT NULL DEFAULT '[]'
      );
    `);
    db.prepare(`INSERT INTO evolution_episodes (id, findings_json) VALUES (?, ?)`).run(
      'e1',
      JSON.stringify([
        { domain: 'neokai_product', kind: 'bug' },
        { domain: 'workflow', kind: 'friction' },
      ])
    );

    runMigration162(db);

    const row = db
      .prepare(`SELECT findings_json FROM evolution_episodes WHERE id = 'e1'`)
      .get() as { findings_json: string };
    expect(JSON.parse(row.findings_json)).toEqual([
      { domain: 'hyperneo_product', kind: 'bug' },
      { domain: 'workflow', kind: 'friction' },
    ]);
  });

  test('is idempotent (running twice is a no-op)', () => {
    db.exec(`
      CREATE TABLE sdk_messages (id TEXT PRIMARY KEY, message_type TEXT NOT NULL);
      CREATE TABLE evolution_episodes (id TEXT PRIMARY KEY, findings_json TEXT NOT NULL DEFAULT '[]');
    `);
    db.prepare(`INSERT INTO sdk_messages (id, message_type) VALUES (?, ?)`).run(
      'a',
      'neokai_action'
    );

    runMigration162(db);
    runMigration162(db);

    const row = db.prepare(`SELECT message_type FROM sdk_messages WHERE id = 'a'`).get() as {
      message_type: string;
    };
    expect(row.message_type).toBe('hyperneo_action');
  });

  test('is a no-op when the tables do not exist (fresh/partial schema)', () => {
    expect(() => runMigration162(db)).not.toThrow();
  });
});
