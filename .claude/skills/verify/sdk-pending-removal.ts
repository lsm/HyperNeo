import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { runMigrations, createTables } from '../../../packages/daemon/src/storage/schema/index.ts';
import { DbGateway, bindGateway } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { sdkPendingRemoval } from '../../../packages/daemon/src/storage/repositories/sdk-message-transactions.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import { JobQueueRepository } from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import { selectSdkBodyWriteMode } from '../../../packages/daemon/src/storage/sdk-message-body-admission.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};
for (const sideOnly of [false, true]) {
  const path = join(run, `data/${sideOnly ? 'side' : 'dual'}.db`);
  const main = new Database(path);
  runMigrations(main, () => {});
  createTables(main);
  const gateway = new DbGateway(path, null);
  bindGateway(main, gateway);
  const sid = 'synthetic-withdrawal';
  main.prepare("INSERT INTO sessions(id,title,created_at,last_active_at,status,config,metadata) VALUES (?,'Synthetic',datetime('now'),datetime('now'),'active','{}','{}')").run(sid);
  if (sideOnly) {
    main.prepare('INSERT OR REPLACE INTO migration_markers(key,applied_at) VALUES (?,?)').run('sdk_message_bodies_copy_v1:complete', Date.now());
    assert.equal((await selectSdkBodyWriteMode(main)).mode, 'side-only');
  }
  const messages = new SDKMessageRepository(main), jobs = new JobQueueRepository(main);
  const seed = (uuid: string, status: 'deferred' | 'enqueued') => {
    const dbId = messages.saveUserMessage(sid, { type: 'user', uuid, session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: `exact ${uuid} body\n kept` } } as never, status);
    const delivery = jobs.enqueue({ queue: 'message_delivery', payload: { sessionId: sid, messageUuid: uuid } });
    const withdrawal = jobs.enqueue({ queue: 'mailbox', payload: { id: uuid } });
    main.prepare("UPDATE job_queue SET status='completed' WHERE id=?").run(withdrawal.id);
    return { dbId, delivery: delivery.id, withdrawal: withdrawal.id };
  };
  const removed = seed('remove', 'deferred'), deferred = seed('defer', 'enqueued'), rollback = seed('rollback', 'deferred');
  const body = messages.getStoredPromptsByUuid(sid, 'defer');
  main.exec(`CREATE TRIGGER fail_synthetic_tombstone BEFORE UPDATE ON job_queue WHEN NEW.id='${rollback.withdrawal}' AND NEW.error='driver_input_withdrawn' BEGIN SELECT RAISE(ABORT,'synthetic tombstone fault'); END`);
  main.exec('PRAGMA query_only=ON');
  const seen: string[] = [];
  const replayErrors: string[] = [];
  gateway.onChanges = (changes) => {
    try {
    for (const change of changes) if (change.table === 'sdk_messages') {
      assert.equal(change.scope?.sessionId, sid);
      seen.push(change.table);
    }
    if (messages.getStoredPromptsByUuid(sid, 'remove').length === 0) {
      assert.equal(jobs.getJob(removed.withdrawal)?.error, 'driver_input_withdrawn');
      assert.equal(jobs.getJob(removed.delivery), null);
    }
    } catch (error) { replayErrors.push(String(error)); }
  };
  try {
    const receipt = await gateway.run(sdkPendingRemoval, { sessionId: sid, messageDbId: removed.dbId, mode: 'remove', expectedStatus: 'deferred', withdrawalJobId: removed.withdrawal });
    assert.equal(receipt?.uuid, 'remove');
    assert.equal(seen.length, 1);
    const held = await gateway.run(sdkPendingRemoval, { sessionId: sid, messageDbId: deferred.dbId, mode: 'defer' });
    assert.equal(held?.uuid, 'defer');
    assert.equal(jobs.getJob(deferred.delivery), null);
    assert.deepEqual(messages.getStoredPromptsByUuid(sid, 'defer'), body);
    assert.equal(messages.getDeliveryContent(sid, 'defer')?.sendStatus, 'deferred');
    assert.equal(seen.length, 2);
    await assert.rejects(gateway.run(sdkPendingRemoval, { sessionId: sid, messageDbId: rollback.dbId, mode: 'remove', expectedStatus: 'deferred', withdrawalJobId: rollback.withdrawal }), /synthetic tombstone fault/);
    assert.equal(messages.getDeliveryContent(sid, 'rollback')?.sendStatus, 'deferred');
    assert.equal(jobs.getJob(rollback.delivery)?.status, 'pending');
    assert.equal(jobs.getJob(rollback.withdrawal)?.status, 'completed');
    assert.equal(seen.length, 2);
    assert.equal((main.prepare('PRAGMA query_only').get() as { query_only: number }).query_only, 1);
    assert.equal((main.prepare('SELECT sdk_message FROM sdk_messages WHERE id=?').get(deferred.dbId) as { sdk_message: string }).sdk_message === '', sideOnly);
    assert.deepEqual(replayErrors, []);
    evidence[sideOnly ? 'sideOnly' : 'dualWrite'] = { mainQueryOnly: true, atomicRemoval: true, retainedBody: true, rollback: true, scopedCommits: seen.length };
  } finally {
    await gateway.close();
    main.close();
  }
}
evidence.pass = true;
writeFileSync(join(run, 'evidence/sdk-pending-removal.json'), JSON.stringify(evidence, null, 2));
console.log(`PASS: ${run}/evidence/sdk-pending-removal.json`);
