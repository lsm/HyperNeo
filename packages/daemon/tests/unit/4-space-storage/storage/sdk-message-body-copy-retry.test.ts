import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DatabaseCore } from '../../../../src/storage/database-core';
import { reserveSdkBodyBackupPath } from '../../../../src/storage/sdk-message-body-backup';
import * as backupCopy from '../../../../src/storage/backup-copy';
import { configureLogger, LogLevel, subscribeToStructuredLogs } from '../../../../src/lib/logger';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureLogger({ level: LogLevel.SILENT });
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function location() {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-copy-retry-'));
  directories.push(directory);
  return join(directory, 'daemon.db');
}

describe('SDK body copy retry safety', () => {
  test('retains one backup destination across failures before a first chunk and a restart', async () => {
    const path = location(),
      signal = new AbortController().signal;
    let db = new Database(path);
    db.exec('CREATE TABLE migration_markers(key TEXT PRIMARY KEY,applied_at INTEGER)');
    try {
      const first = await reserveSdkBodyBackupPath(db, path, signal);
      expect(dirname(first)).toBe(join(dirname(path), 'backups', 'sdk-message-bodies-v1'));
      expect(await reserveSdkBodyBackupPath(db, path, signal)).toBe(first);
      db.close();
      db = new Database(path);
      expect(await reserveSdkBodyBackupPath(db, path, signal)).toBe(first);
      expect(db.prepare('SELECT key FROM migration_markers').all()).toHaveLength(1);
      expect(existsSync(first)).toBe(false);
    } finally {
      db.close();
    }
  });

  test('an aborted backup reservation creates no destination or marker', async () => {
    const path = location(),
      abort = new AbortController();
    const db = new Database(path);
    db.exec('CREATE TABLE migration_markers(key TEXT PRIMARY KEY,applied_at INTEGER)');
    abort.abort();
    try {
      await expect(reserveSdkBodyBackupPath(db, path, abort.signal)).rejects.toThrow('cancelled');
      expect(db.prepare('SELECT key FROM migration_markers').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('unknown runtime capacity logs a refusal without creating a backup or changing bodies', async () => {
    const path = location(),
      core = new DatabaseCore(path);
    await core.initialize();
    configureLogger({ level: LogLevel.INFO });
    const logs: string[] = [];
    const unsubscribe = subscribeToStructuredLogs((event) => logs.push(event.message));
    vi.spyOn(backupCopy, 'freeBytesAt').mockReturnValue(Number.POSITIVE_INFINITY);
    vi.stubGlobal('Worker', class {});
    try {
      core.startSdkMessageBodyCopy();
      for (let n = 0; n < 20 && !logs.some((line) => line.includes('"phase":"refused"')); n++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(logs.some((line) => line.includes('"phase":"refused"'))).toBe(true);
      expect(logs.some((line) => line.includes('deferred'))).toBe(false);
      expect(existsSync(join(dirname(path), 'backups', 'sdk-message-bodies-v1'))).toBe(false);
      expect(
        core
          .getDb()
          .prepare(
            "SELECT key FROM migration_markers WHERE key GLOB 'sdk_message_bodies_copy_v1:*'"
          )
          .all()
      ).toEqual([]);
    } finally {
      unsubscribe();
      core.close();
    }
  });

  test('a runtime without workers logs an explicit refusal without starting maintenance', async () => {
    const path = location(),
      core = new DatabaseCore(path);
    await core.initialize();
    configureLogger({ level: LogLevel.INFO });
    const logs: string[] = [];
    const unsubscribe = subscribeToStructuredLogs((event) => logs.push(event.message));
    vi.stubGlobal('Worker', undefined);
    try {
      core.startSdkMessageBodyCopy();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(
        logs.some(
          (line) => line.includes('"phase":"refused"') && line.includes('worker_unavailable')
        )
      ).toBe(true);
      expect(logs.some((line) => line.includes('deferred'))).toBe(false);
      expect(existsSync(join(dirname(path), 'backups', 'sdk-message-bodies-v1'))).toBe(false);
    } finally {
      unsubscribe();
      core.close();
    }
  });
});
