import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { SESSION_EVENT_SCOPE } from '../../../../src/lib/external-events/session-external-event-store';
import { createWatchedTable, insertWatchedRow } from '../../helpers/github-watched-read-fixture';

type Readers = {
  gitHubPollingCapabilityReads: DbOp<{ sessionScope: string }, boolean>;
  gitHubPollingTimerReads: DbOp<Record<string, never>, boolean>;
  hasPollingRows: (rows: readonly unknown[]) => boolean;
  hasPollingIntent: (count: number) => boolean;
  continueWhileUnused: (inUse: boolean) => { value: false } | { reason: true };
};
async function readers(): Promise<Readers> {
  const file = new URL(
    '../../../../src/storage/repositories/github-polling-usage-read.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Worker-backed polling usage readers are unavailable');
  return import(file.href);
}
describe('GitHub polling usage read commands', () => {
  let db: Database, gateway: DbGateway;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      "CREATE TABLE spaces(id TEXT PRIMARY KEY);INSERT INTO spaces VALUES('synthetic-space');CREATE TABLE space_github_source_settings(space_id TEXT PRIMARY KEY,enabled INTEGER,polling_intent INTEGER)"
    );
    createWatchedTable(db);
    gateway = new DbGateway(':memory:', db);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await gateway.close();
    db.close();
  });
  const capability = async () =>
    gateway.run((await readers()).gitHubPollingCapabilityReads, {
      sessionScope: SESSION_EVENT_SCOPE,
    });
  const timer = async () => gateway.run((await readers()).gitHubPollingTimerReads, {});
  test('named pure decisions preserve empty/nonempty and exact early-exit arms', async () => {
    const r = await readers();
    expect(r.hasPollingRows([])).toBe(false);
    expect(r.hasPollingRows([{}])).toBe(true);
    expect(r.hasPollingIntent(0)).toBe(false);
    expect(r.hasPollingIntent(1)).toBe(true);
    expect(r.continueWhileUnused(false)).toEqual({ value: false });
    expect(r.continueWhileUnused(true)).toEqual({ reason: true });
  });
  test('complete read command and dependency graph stays within the measured cap', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'polling-usage-measure-'));
    try {
      const output = join(temporary, 'measure.json');
      execFileSync(
        process.execPath,
        ['.claude/skills/verify/lane-c-github-polling-usage-measure.cjs', output],
        { cwd: fileURLToPath(new URL('../../../../../../', import.meta.url)) }
      );
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        fullOwnedGraphLines: 147,
        knownTotal: 154,
        excludedLines: 0,
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  test('both registered operations remain query-only and return booleans without notifications', async () => {
    const r = await readers(),
      changes = vi.fn();
    expect(DB_OPS.get(r.gitHubPollingCapabilityReads.name)).toBe(r.gitHubPollingCapabilityReads);
    expect(DB_OPS.get(r.gitHubPollingTimerReads.name)).toBe(r.gitHubPollingTimerReads);
    expect(r.gitHubPollingCapabilityReads.mode).toBe('read');
    expect(r.gitHubPollingTimerReads.mode).toBe('read');
    gateway.onChanges = changes;
    db.exec('PRAGMA query_only=ON');
    expect(await capability()).toBe(false);
    expect(await timer()).toBe(false);
    expect(changes).not.toHaveBeenCalled();
  });
  test('disabled configured rows keep capability while an unrelated malformed session is skipped', async () => {
    insertWatchedRow(db, { enabled: 0 });
    insertWatchedRow(db, { id: 'session', space_id: SESSION_EVENT_SCOPE, poll_cursor: '{broken' });
    db.exec('DROP TABLE space_github_source_settings');
    expect(await capability()).toBe(true);
    await expect(timer()).rejects.toThrow(/JSON|position|property|SyntaxError/);
  });
  test('recorded Space intent keeps capability without parsing skipped session cursors', async () => {
    db.exec("INSERT INTO space_github_source_settings VALUES('synthetic-space',0,1)");
    insertWatchedRow(db, { id: 'session', space_id: SESSION_EVENT_SCOPE, poll_cursor: '{broken' });
    expect(await capability()).toBe(true);
    db.exec('UPDATE space_github_source_settings SET polling_intent=0');
    await expect(capability()).rejects.toThrow(/JSON|position|property|SyntaxError/);
  });
  test('active session rows retain both uses; orphan Space intent is excluded', async () => {
    db.exec("INSERT INTO space_github_source_settings VALUES('orphan',1,1)");
    expect(await capability()).toBe(false);
    insertWatchedRow(db, { id: 'session', space_id: SESSION_EVENT_SCOPE });
    expect(await capability()).toBe(true);
    expect(await timer()).toBe(true);
  });
  test('active orphan rows keep the timer but cannot keep Space capability', async () => {
    insertWatchedRow(db, { space_id: 'orphan' });
    expect(await timer()).toBe(true);
    expect(await capability()).toBe(false);
    db.exec('DROP TABLE space_github_source_settings');
    expect(await timer()).toBe(true);
    await expect(capability()).rejects.toThrow(/no such table/);
  });
  test('malformed configured cursors fail before a positive intent can short-circuit', async () => {
    insertWatchedRow(db, { enabled: 0, poll_cursor: '{broken' });
    db.exec("INSERT INTO space_github_source_settings VALUES('synthetic-space',1,1)");
    await expect(capability()).rejects.toThrow(/JSON|position|property|SyntaxError/);
    expect(await timer()).toBe(false);
  });
});
