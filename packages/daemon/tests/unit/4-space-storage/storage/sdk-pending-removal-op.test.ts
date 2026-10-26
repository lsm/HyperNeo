import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import type { TableChange } from '../../../../src/storage/db-gateway/db-op';
import { sdkPendingRemoval } from '../../../../src/storage/repositories/sdk-message-transactions';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const sid = 'synthetic-withdrawal';
let fixture: MailboxTestDb;
let gateway: DbGateway;
let changes: TableChange[];
beforeEach(() => {
  fixture = createMailboxTestDb();
  fixture.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sid);
  gateway = new DbGateway(':memory:', fixture.db);
  bindGateway(fixture.db, gateway);
  changes = [];
  gateway.onChanges = (recorded) => changes.push(...recorded);
});
afterEach(async () => {
  await gateway.close();
  fixture.close();
});
function seed(status: 'deferred' | 'enqueued' | 'consumed' = 'deferred') {
  const id = fixture.sdkMessageRepo.saveUserMessage(
    sid,
    {
      type: 'user',
      uuid: 'input',
      session_id: sid,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'retain exact input bytes' },
    } as never,
    status
  );
  const delivery = fixture.jobQueue.enqueue({
    queue: 'message_delivery',
    payload: { sessionId: sid, messageUuid: 'input' },
  });
  const withdrawal = fixture.jobQueue.enqueue({ queue: 'mailbox', payload: { id: 'owned-input' } });
  fixture.db.prepare("UPDATE job_queue SET status='completed' WHERE id=?").run(withdrawal.id);
  return { id, delivery: delivery.id, withdrawal: withdrawal.id };
}
const remove = (id: string, withdrawalJobId?: string) =>
  gateway.run(sdkPendingRemoval, {
    sessionId: sid,
    messageDbId: id,
    mode: 'remove',
    expectedStatus: 'deferred',
    withdrawalJobId,
  });

describe('SDK pending removal transactions', () => {
  test('registers the build-only write op', () => {
    expect(DB_OPS.get('sdk_messages.pendingRemoval')).toBe(sdkPendingRemoval);
    expect(sdkPendingRemoval.mode).toBe('write');
  });
  test('commits SDK deletion, withdrawal tombstone and delivery cancellation together', async () => {
    const { id, delivery, withdrawal } = seed();
    expect(await remove(id, withdrawal)).toMatchObject({
      dbId: id,
      uuid: 'input',
      status: 'deferred',
    });
    expect(fixture.sdkRows()).toEqual([]);
    expect(fixture.jobQueue.getJob(withdrawal)).toMatchObject({
      status: 'dead',
      error: 'driver_input_withdrawn',
    });
    expect(fixture.jobQueue.getJob(delivery)).toBeNull();
    expect(changes.filter((change) => change.table === 'sdk_messages')).toEqual([
      { table: 'sdk_messages', scope: { sessionId: sid } },
    ]);
    expect(changes).toContainEqual({ table: 'job_queue', scope: { sessionId: sid } });
    expect(await remove(id, withdrawal)).toBeNull();
  });
  test('defers enqueued input without changing its body and cancels delivery', async () => {
    const { id, delivery } = seed('enqueued');
    const body = fixture.sdkRows()[0].sdk_message;
    expect(
      await gateway.run(sdkPendingRemoval, { sessionId: sid, messageDbId: id, mode: 'defer' })
    ).toEqual({ dbId: id, uuid: 'input' });
    expect(fixture.sdkRows()[0]).toMatchObject({ sdk_message: body, send_status: 'deferred' });
    expect(fixture.jobQueue.getJob(delivery)).toBeNull();
    expect(changes.filter((change) => change.table === 'sdk_messages')).toHaveLength(1);
  });
  test('a superseded withdrawal rolls back SDK deletion and delivery cancellation', async () => {
    const { id, delivery, withdrawal } = seed();
    fixture.db.prepare("UPDATE job_queue SET status='processing' WHERE id=?").run(withdrawal);
    await expect(remove(id, withdrawal)).rejects.toThrow('superseded');
    expect(fixture.sdkRows()[0]).toMatchObject({ id, send_status: 'deferred' });
    expect(fixture.jobQueue.getJob(delivery)?.status).toBe('pending');
    expect(changes).toEqual([]);
  });
  test('a tombstone storage fault rolls back the badge with the SDK row', async () => {
    const { id, delivery, withdrawal } = seed();
    const badge = fixture.db
      .prepare('SELECT visible_message_count FROM sessions WHERE id=?')
      .get(sid);
    fixture.db.exec(
      "CREATE TRIGGER fail_tombstone BEFORE UPDATE ON job_queue WHEN NEW.error='driver_input_withdrawn' BEGIN SELECT RAISE(ABORT,'synthetic tombstone fault'); END"
    );
    await expect(remove(id, withdrawal)).rejects.toThrow('synthetic tombstone fault');
    expect(fixture.sdkRows()[0].id).toBe(id);
    expect(
      fixture.db.prepare('SELECT visible_message_count FROM sessions WHERE id=?').get(sid)
    ).toEqual(badge);
    expect(fixture.jobQueue.getJob(delivery)?.status).toBe('pending');
    expect(fixture.jobQueue.getJob(withdrawal)?.status).toBe('completed');
    expect(changes).toEqual([]);
  });
  test.each(['enqueued', 'consumed'] as const)(
    'a deferred-only removal refuses a %s row',
    async (status) => {
      const { id, delivery, withdrawal } = seed(status);
      expect(await remove(id, withdrawal)).toBeNull();
      expect(fixture.sdkRows()[0].send_status).toBe(status);
      expect(fixture.jobQueue.getJob(delivery)?.status).toBe('pending');
      expect(fixture.jobQueue.getJob(withdrawal)?.status).toBe('completed');
      expect(changes).toEqual([]);
    }
  );
  test('a missing SDK row cannot tombstone a job', async () => {
    const { withdrawal } = seed();
    expect(await remove('missing', withdrawal)).toBeNull();
    expect(fixture.jobQueue.getJob(withdrawal)?.status).toBe('completed');
    expect(changes).toEqual([]);
  });
});

test('the pending removal op commits and rolls back on a real worker with read-only main', () => {
  const run = mkdtempSync(join(tmpdir(), 'sdk-withdrawal-worker-'));
  mkdirSync(join(run, 'home'));
  try {
    const child = spawnSync('bun', ['.claude/skills/verify/sdk-pending-removal.ts', run], {
      cwd: resolve(import.meta.dirname, '../../../../../..'),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: join(run, 'home'),
        NODE_ENV: 'test',
        HYPERNEO_DATA_DIR: join(run, 'data'),
        LOG_LEVEL: 'warn',
      },
    });
    expect({
      status: child.status,
      error: child.error?.message,
      stderr: child.stderr,
    }).toMatchObject({ status: 0 });
    expect(
      JSON.parse(readFileSync(join(run, 'evidence/sdk-pending-removal.json'), 'utf8'))
    ).toMatchObject({
      pass: true,
      dualWrite: {
        mainQueryOnly: true,
        atomicRemoval: true,
        retainedBody: true,
        rollback: true,
        scopedCommits: 2,
      },
      sideOnly: {
        mainQueryOnly: true,
        atomicRemoval: true,
        retainedBody: true,
        rollback: true,
        scopedCommits: 2,
      },
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 30_000);
