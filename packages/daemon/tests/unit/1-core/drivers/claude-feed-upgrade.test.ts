import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachNativeFeedWriter } from '../../../helpers/native-feed-enqueue-writer';
import { claudeFeedSource, runClaudeFeed } from '../../../../src/lib/drivers/claude-feed';
import { feedWorkFiles, listFeedFilesAsync } from '../../../../src/lib/drivers/work-feed';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { readWorkInputTurn } from '../../../../src/storage/work-turns';

test('upgrade recovers an accepted peer answer from an unchanged already-indexed transcript', async () => {
  const run = mkdtempSync(join(tmpdir(), 'claude-answer-upgrade-'));
  const root = join(run, 'projects');
  const path = join(run, 'daemon.db');
  const marker = '[worker-answer:accepted-before-upgrade]';
  let db = new Database(path);
  try {
    runMigrations(db, () => {});
    createTables(db);
    db.exec("DELETE FROM migration_markers WHERE key = 'migration_468'");
    mkdirSync(join(root, 'project'), { recursive: true });
    writeFileSync(
      join(root, 'project', 'worker.jsonl'),
      [
        {
          type: 'user',
          uuid: 'accepted',
          isMeta: true,
          origin: { kind: 'peer', body: `${marker}\nProduction` },
        },
        { type: 'user', uuid: 'later', message: { content: 'Later ordinary input' } },
      ]
        .map((record) =>
          JSON.stringify({
            ...record,
            cwd: '/synthetic-project',
            timestamp: '1990-01-01T00:00:00Z',
          })
        )
        .join('\n') + '\n'
    );
    const source = claudeFeedSource(new Set());
    await feedWorkFiles(db, await listFeedFilesAsync(root, 0, 2), {
      ...source,
      turns: (lines, meta) =>
        source.turns(lines, meta).filter((turn) => !turn.text.startsWith(marker)),
    });
    expect(readWorkInputTurn(db, 'worker', 'claude', marker)).toBeNull();
    db.close();
    db = new Database(path);
    runMigrations(db, () => {});
    createTables(db);
    const queue = attachNativeFeedWriter({ enqueueUniquePending: () => {} }) as never;
    await runClaudeFeed(queue, db, root, Date.now());
    expect(readWorkInputTurn(db, 'worker', 'claude', marker)).toMatchObject({
      messageId: 'accepted',
      role: 'user',
      text: `${marker}\nProduction`,
    });
    db.close();
    db = new Database(path);
    runMigrations(db, () => {});
    createTables(db);
    expect(await runClaudeFeed(queue, db, root, Date.now())).toEqual({ files: 0, turns: 0 });
    expect(readWorkInputTurn(db, 'worker', 'claude', marker)?.messageId).toBe('accepted');
  } finally {
    db.close();
    rmSync(run, { recursive: true, force: true });
  }
});
