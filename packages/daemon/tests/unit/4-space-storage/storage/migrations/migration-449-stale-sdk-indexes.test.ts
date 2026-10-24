import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration113 } from '../../../../../src/storage/schema/migrations.ts';

test('a legacy migration replay cannot recreate the retired expression index', () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      'CREATE TABLE sdk_messages(id TEXT,session_id TEXT,send_status TEXT,sdk_message TEXT,timestamp TEXT)'
    );
    runMigration113(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='idx_sdk_messages_uuid_status'").get()
    ).toBeNull();
  } finally {
    db.close();
  }
});

test('an isolated daemon repairs marked old indexes and discloses a failed save', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'stale-sdk-indexes-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../../.claude/skills/verify/stale-sdk-message-indexes.ts',
            import.meta.url
          )
        ),
        run,
      ],
      {
        env: {
          HOME: join(run, 'home'),
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
          LOG_LEVEL: 'error',
        },
        timeout: 45000,
        stdio: 'pipe',
      }
    );
    const proof = JSON.parse(readFileSync(join(run, 'evidence/indexes.json'), 'utf8'));
    expect(proof.verified).toBe(true);
    expect(proof.before).toHaveLength(2);
    expect(proof.after).toEqual([]);
    expect(proof.failed.send_status).toBe('failed');
    expect(proof.failureLogs.length).toBeGreaterThan(0);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
