import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseCore } from '../../../../src/storage/database-core.ts';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function legacy() {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-backfill-'));
  directories.push(directory);
  const path = join(directory, 'daemon.db');
  const seed = new DatabaseCore(path);
  await seed.initialize();
  const db = seed.getDb();
  db.exec('PRAGMA foreign_keys=OFF');
  const insert =
    db.prepare(`INSERT INTO sdk_messages(id,session_id,message_type,sdk_message,timestamp,replacement_metadata_normalized)
    VALUES (?,'old-session','user',?,'2026-10-23T00:00:00Z',1)`);
  const body = JSON.stringify({
    type: 'user',
    inputKind: 'task',
    message: { content: [{ type: 'text', text: 'retained synthetic history' }] },
  });
  db.transaction(() => {
    for (let i = 0; i < 1024; i++) insert.run(`synthetic-${i}`, body);
    db.exec("DELETE FROM migration_markers WHERE key='sdk_message_columns_backfilled_v2'");
  })();
  seed.close();
  const core = new DatabaseCore(path);
  await core.initialize();
  return { core, path, body };
}

describe('Startup SDK history preparation', () => {
  test('new sessions proceed while old history waits for a complete projection', async () => {
    const { core, body } = await legacy();
    try {
      expect(core.getDataMigrationStatus().state).toBe('pending');
      await core.waitForSdkMessageColumns('new-session');
      let read = false;
      const waiting = core.waitForSdkMessageColumns('old-session').then(() => {
        read = true;
      });
      await new Promise((done) => setTimeout(done, 10));
      expect(read).toBe(false);
      expect(await core.startSdkMessageColumnsBackfill()).toBe(true);
      await waiting;
      expect(read).toBe(true);
      expect(
        core
          .getDb()
          .prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE user_status_eligible=1')
          .get()
      ).toEqual({ n: 1024 });
      expect(core.getDb().prepare('SELECT sdk_message FROM sdk_messages LIMIT 1').get()).toEqual({
        sdk_message: body,
      });
    } finally {
      core.close();
    }
  });

  test('public reads report preparation promptly instead of waiting past the client deadline', async () => {
    const { core } = await legacy();
    const request = (core.waitForSdkMessageColumns as (id: string, wait: boolean) => Promise<void>)(
      'old-session',
      false
    ).then(
      () => 'empty history',
      (error: Error) => error.message
    );
    try {
      expect(
        await Promise.race([
          request,
          new Promise((resolve) => setTimeout(() => resolve('client deadline'), 50)),
        ])
      ).toContain('being prepared');
    } finally {
      core.close();
      await request;
    }
  });

  test('shutdown preserves a committed cursor and restart resumes without changing bodies', async () => {
    const { core, path, body } = await legacy();
    expect(await core.startSdkMessageColumnsBackfill(() => core.close())).toBe(false);
    const next = new DatabaseCore(path);
    await next.initialize();
    try {
      const saved = next.getDataMigrationStatus();
      expect(saved.state).toBe('pending');
      expect(saved.through).toBe(512);
      expect(await next.startSdkMessageColumnsBackfill()).toBe(true);
      expect(
        next
          .getDb()
          .prepare(
            'SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_message=? AND user_status_eligible=1'
          )
          .get(body)
      ).toEqual({ n: 1024 });
      expect(next.getDataMigrationStatus().state).toBe('complete');
    } finally {
      next.close();
    }
  });

  test('a failed background pass stays visible and refuses history instead of returning empty data', async () => {
    const { core } = await legacy();
    try {
      core
        .getDb()
        .exec(
          "CREATE TRIGGER fail_projection BEFORE UPDATE OF input_kind ON sdk_messages BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
        );
      expect(await core.startSdkMessageColumnsBackfill()).toBe(false);
      expect(core.getDataMigrationStatus().state).toBe('failed');
      await expect(core.waitForSdkMessageColumns('old-session')).rejects.toThrow(
        'preparation failed'
      );
      await core.waitForSdkMessageColumns('new-session');
      expect(core.getDb().prepare('SELECT COUNT(*) AS n FROM sdk_messages').get()).toEqual({
        n: 1024,
      });
    } finally {
      core.close();
    }
  });
});
