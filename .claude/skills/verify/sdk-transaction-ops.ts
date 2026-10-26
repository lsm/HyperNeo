import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { Database } from '../../../packages/daemon/src/storage/index.ts';
import { createReactiveDatabase } from '../../../packages/daemon/src/storage/reactive-database.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import { prepareNeoIntakeAsk } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';
import { sdkMessageWrites } from '../../../packages/daemon/src/storage/repositories/sdk-message-writes.ts';
import { sdkPromptEnsure, sdkPromptActivate, sdkPromptRetry, sdkNeoIntake, sdkDeliveryTeardown, sdkMailboxFailure, sdkColumnBackfillChunk, sdkColumnBackfillComplete, sdkDeliveryFencedStatus } from '../../../packages/daemon/src/storage/repositories/sdk-message-transactions.ts';
import { selectSdkBodyWriteMode } from '../../../packages/daemon/src/storage/sdk-message-body-admission.ts';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../../packages/daemon/src/lib/mailbox/enqueue.ts';
import { DEFAULT_MAILBOX_ENTRY_POLICY } from '../../../packages/daemon/src/lib/mailbox/entry.ts';
import { createUlid } from '../../../packages/daemon/src/lib/mailbox/ulid.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const db = new Database(join(run, 'data/daemon.db'), { messageSearchIndexFlushIntervalMs: 0 });
const reactive = createReactiveDatabase(db);
const sid = 'synthetic-op-worker', rollbackSid = 'synthetic-rollback';
const conversationId = '10000000-0000-4000-8000-000000000001', neoId = `neo:${conversationId}`;
const user = (uuid: string, session = sid) => ({ type: 'user', uuid, session_id: session, parent_tool_use_id: null, inputKind: 'human', message: { role: 'user', content: uuid } }) as SDKUserMessage;
const evidence: Record<string, unknown> = {};
try {
  await db.initialize(reactive);
  for (const id of [sid, rollbackSid, neoId]) await db.createSession({ id, title: 'Synthetic op proof', workspacePath: run,
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { model: 'fictional' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const main = db.getDatabase(), messages = new SDKMessageRepository(main), jobs = db.getJobQueueRepo();
  const legacyId = messages.saveUserMessage(sid, user('legacy'), 'enqueued');
  main.prepare('UPDATE sdk_messages SET input_kind=NULL WHERE id=?').run(legacyId);
  main.prepare('DELETE FROM migration_markers WHERE key=?').run('sdk_message_columns_backfilled_v2');
  jobs.enqueue({ queue: 'message_delivery', payload: { sessionId: sid, messageUuid: 'kickoff' } });
  const claim = jobs.dequeue('message_delivery', 1)[0];
  const mailbox = (uuid: string, session = sid) => enqueueMailboxEntry(jobs, { id: createUlid(), to: { kind: 'session', sessionId: session },
    origin: 'chat', messageUuid: uuid, message: { type: 'user', parent_tool_use_id: null, message: { content: uuid } },
    status: 'enqueued', deliveryMode: 'defer', policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY } });
  mailbox('standalone-failure'); const failedJob = jobs.dequeue(MAILBOX_LANE, 1)[0];
  mailbox('teardown'); mailbox('rollback-failure', rollbackSid);
  main.exec("CREATE TRIGGER fail_synthetic_row BEFORE INSERT ON sdk_messages WHEN NEW.sdk_uuid='rollback-failure' BEGIN SELECT RAISE(ABORT,'synthetic rollback fault'); END");
  main.prepare('INSERT INTO migration_markers(key,applied_at) VALUES (?,?)').run('sdk_message_bodies_copy_v1:complete', Date.now());
  evidence.mode = await selectSdkBodyWriteMode(main);
  assert.equal((evidence.mode as { mode: string }).mode, 'side-only');
  main.exec('PRAGMA query_only=ON');
  evidence.backfill = await db.gateway.run(sdkColumnBackfillChunk, { after: 0, ceiling: 1 });
  await db.gateway.run(sdkColumnBackfillComplete, undefined);
  assert.equal((main.prepare("SELECT COUNT(*) AS n FROM migration_markers WHERE key GLOB 'sdk_message_columns_backfill_v2:*'").get() as { n: number }).n, 0);
  assert(main.prepare("SELECT 1 FROM migration_markers WHERE key='sdk_message_columns_backfilled_v2'").get());
  const ensured = await db.gateway.run(sdkPromptEnsure, { sessionId: sid, message: user('outbox'), hold: 'manual', delivery: { origin: 'chat' } });
  assert.equal((main.prepare('SELECT sdk_message FROM sdk_messages WHERE id=?').get(ensured.dbMessageId) as { sdk_message: string }).sdk_message, '');
  evidence.sideOnly = true;
  evidence.activation = await db.gateway.run(sdkPromptActivate, { sessionId: sid, messageUuids: ['outbox'], origin: 'chat' });
  await db.gateway.call(sdkMessageWrites, 'markDeliveryFailedByUuid', sid, 'outbox');
  evidence.retry = await db.gateway.run(sdkPromptRetry, { sessionId: sid, messageUuid: 'outbox', origin: 'chat' });
  const message = user('20000000-0000-4000-8000-000000000001', neoId), prepared = prepareNeoIntakeAsk(conversationId, message);
  assert('value' in prepared);
  evidence.neo = await db.gateway.run(sdkNeoIntake, { ask: prepared.value, message, hold: 'immediate' });
  evidence.fenced = await db.gateway.run(sdkDeliveryFencedStatus, { sessionId: sid, kickoffUuid: 'kickoff', claimToken: claim.claimToken!, uuids: ['legacy'], fromStatus: 'enqueued', toStatus: 'submitted' });
  assert.deepEqual(evidence.fenced, ['legacy']);
  const failed = await db.gateway.run(sdkMailboxFailure, { job: failedJob }); assert(failed.failedId);
  const result = await db.gateway.run(sdkDeliveryTeardown, { sessionId: sid, options: { deliveries: { failEnqueued: true, failDeferred: true } } });
  evidence.failedIds = result.failedDbIds;
  await assert.rejects(db.gateway.run(sdkDeliveryTeardown, { sessionId: rollbackSid }), /synthetic rollback fault/);
  assert.equal((main.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE queue='mailbox' AND json_extract(payload,'$.to.sessionId')=?").get(rollbackSid) as { n: number }).n, 1);
  assert.equal(messages.getStoredPromptsByUuid(rollbackSid, 'rollback-failure').length, 0);
  evidence.rollback = true;
  await db.gateway.call(sdkMessageWrites, 'recordDeliveryTurnEnd', 'missing', 'missing', new Date().toISOString());
  assert.equal((main.prepare("SELECT COUNT(*) AS n FROM delivery_turn_end WHERE session_id='missing'").get() as { n: number }).n, 0);
  evidence.mainQueryOnly = main.prepare('PRAGMA query_only').get();
  assert.equal((evidence.mainQueryOnly as { query_only: number }).query_only, 1);
  assert.equal(messages.getStoredPromptsByUuid(sid, 'outbox').length, 1);
  assert.equal(messages.getStoredPromptsByUuid(sid, 'legacy').length, 1);
  evidence.pass = true;
} finally {
  writeFileSync(join(run, 'evidence/sdk-transaction-ops.json'), JSON.stringify(evidence, null, 2));
  await db.close();
}
assert.equal(evidence.pass, true);
console.log(`PASS: worker transaction ops with read-only main; ${run}/evidence/sdk-transaction-ops.json`);
