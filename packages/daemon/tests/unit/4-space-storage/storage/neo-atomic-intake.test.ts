import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import { neoIntakeMessage } from '../../../../src/lib/neo/intake.ts';
import { ensurePrompt } from '../../../../src/lib/agent/message-delivery-outbox.ts';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants.ts';
import {
  NeoConversationAskRepository,
  prepareNeoIntakeAsk,
} from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const sessionId = `neo:${conversationId}`;
const requestId = '20000000-0000-4000-8000-000000000001';
const prompt = (
  content: Parameters<typeof neoIntakeMessage>[0]['content'] = '  Keep this fictional draft.  ',
  uuid = requestId
) => neoIntakeMessage({ sessionId, requestId: uuid, content });
const photo = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'ZmljdGlvbmFs' },
};

describe('atomic public ask intake primitive', () => {
  let mailbox: MailboxTestDb;
  let ledger: NeoConversationAskRepository;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration289(mailbox.db);
    mailbox.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sessionId);
    ledger = new NeoConversationAskRepository(mailbox.db);
  });
  afterEach(() => mailbox.close());
  const accepted = (
    message = prompt(),
    hold: 'immediate' | 'manual' = 'immediate',
    id = conversationId
  ) => ledger.acceptPrompt(id, message, hold, mailbox.sdkMessageRepo, mailbox.jobQueue);
  const legacy = (message = prompt()) =>
    ensurePrompt({
      db: mailbox.db,
      sdkMessageRepo: mailbox.sdkMessageRepo,
      jobQueue: mailbox.jobQueue,
      sessionId,
      message,
      delivery: { origin: 'chat' },
    });

  test('prepares only the existing human prompt shape without treating it as caller authority', () => {
    const message = prompt();
    expect(prepareNeoIntakeAsk(conversationId, message)).toEqual({
      value: {
        conversationId,
        requestId,
        askOrigin: { sessionId, messageId: requestId },
        content: message.message.content,
      },
    });
    for (const inputKind of [undefined, 'consultation', 'work-report', true])
      expect(prepareNeoIntakeAsk(conversationId, { ...message, inputKind })).toEqual({
        reason: { accepted: false, reason: 'invalid_ask' },
      });
    expect(prepareNeoIntakeAsk('legacy', message)).toHaveProperty('reason');
    expect(
      prepareNeoIntakeAsk(conversationId, { ...message, session_id: undefined })
    ).toHaveProperty('reason');
    expect(prepareNeoIntakeAsk(conversationId, { ...message, uuid: undefined })).toHaveProperty(
      'reason'
    );
  });

  test('commits stable public ask, SDK prompt and exactly one queued delivery synchronously', () => {
    const receipt = accepted();
    expect(receipt).not.toBeInstanceOf(Promise);
    expect(receipt).toMatchObject({
      accepted: true,
      created: true,
      ask: {
        requestId,
        conversationId,
        askOrigin: { sessionId, messageId: requestId },
        content: prompt().message.content,
      },
    });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(1);
    expect(JSON.parse(mailbox.sdkRows()[0].sdk_message)).toEqual(prompt());
    expect(JSON.parse(mailbox.rows()[0].payload)).toMatchObject({
      sessionId,
      messageUuid: requestId,
      origin: 'chat',
      released: true,
    });
  });

  test('identical retries keep the original public time/sequence and prompt/job receipt', () => {
    const first = accepted();
    expect(accepted()).toEqual({ ...first, created: false });
    expect(accepted()).toEqual({ ...first, created: false });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.rows()).toHaveLength(1);
  });

  test('a changed retry refuses without rewriting or notifying', () => {
    const first = accepted();
    const notify = spyOn(mailbox.sdkMessageRepo, 'runPostSaveSideEffects');
    expect(accepted(prompt('Different ask'))).toEqual({ accepted: false, reason: 'ask_conflict' });
    expect(first.accepted && ledger.list(conversationId)).toEqual(
      first.accepted ? [first.ask] : false
    );
    expect(JSON.parse(mailbox.sdkRows()[0].sdk_message)).toEqual(prompt());
    expect(mailbox.rows()).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
  });

  test('photos, attachments as text and whitespace remain unchanged in both records', () => {
    const content = [photo, { type: 'text' as const, text: '```txt\nfile notes\n```' }];
    expect(accepted(prompt(content))).toMatchObject({ accepted: true, ask: { content } });
    expect(JSON.parse(mailbox.sdkRows()[0].sdk_message).message.content).toEqual(content);
    expect(accepted(prompt([photo], crypto.randomUUID()))).toMatchObject({
      accepted: true,
      ask: { content: [photo] },
    });
    expect(accepted(prompt(' ', crypto.randomUUID()))).toMatchObject({
      accepted: true,
      ask: { content: [{ type: 'text', text: ' ' }] },
    });
    expect(mailbox.rows()).toHaveLength(3);
  });

  test('keeps manual prompts and delivery jobs held', () => {
    expect(accepted(prompt(), 'manual')).toMatchObject({ accepted: true });
    expect(mailbox.sdkRows()[0].send_status).toBe('deferred');
    expect(JSON.parse(mailbox.rows()[0].payload).released).toBe(false);
    expect(accepted(prompt(), 'immediate')).toMatchObject({ accepted: true, created: false });
    expect(mailbox.sdkRows()[0].send_status).toBe('deferred');
    expect(JSON.parse(mailbox.rows()[0].payload).released).toBe(false);
  });

  test('retry preserves a currently processing job without starting new work', () => {
    accepted();
    const [job] = mailbox.jobQueue.dequeue(MESSAGE_DELIVERY, 1);
    expect(accepted()).toMatchObject({ accepted: true, created: false });
    expect(mailbox.jobQueue.getJob(job.id)?.status).toBe('processing');
    expect(mailbox.rows()).toHaveLength(1);
  });

  test('a consumed ask stays consumed on retry', () => {
    accepted();
    const [job] = mailbox.jobQueue.dequeue(MESSAGE_DELIVERY, 1);
    mailbox.jobQueue.complete(job.id, {}, job.claimToken);
    mailbox.db
      .prepare("UPDATE sdk_messages SET send_status='consumed', consumed_seq=1 WHERE sdk_uuid=?")
      .run(requestId);
    expect(accepted()).toMatchObject({ accepted: true, created: false });
    expect(mailbox.sdkRows()[0].send_status).toBe('consumed');
    expect(mailbox.rows()).toHaveLength(1);
    expect(mailbox.rows()[0].status).toBe('completed');
  });

  test('surviving public receipt prevents re-execution after SDK transcript removal', () => {
    const first = accepted();
    mailbox.db.exec('DELETE FROM sdk_messages; DELETE FROM job_queue');
    expect(accepted()).toEqual({ ...first, created: false });
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
    expect(ledger.list(conversationId)).toHaveLength(1);
  });

  test('matching legacy intake backfills only the public record', () => {
    const previous = legacy();
    expect(ledger.list(conversationId)).toEqual([]);
    expect(accepted()).toMatchObject({ accepted: true, created: false });
    expect(mailbox.sdkRows()[0].id).toBe(previous.dbMessageId);
    expect(mailbox.rows()).toHaveLength(1);
    expect(ledger.list(conversationId)).toHaveLength(1);
  });

  test('conflicting legacy intake rolls back the new public record', () => {
    legacy(prompt('Previously accepted content'));
    expect(accepted()).toEqual({ accepted: false, reason: 'ask_conflict' });
    expect(ledger.list(conversationId)).toEqual([]);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.rows()).toHaveLength(1);
  });

  test.each(['sdk_messages', 'job_queue'])(
    'a failing %s insert rolls all records back without notification',
    (table) => {
      mailbox.db.exec(
        `CREATE TRIGGER fail_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture fault'); END`
      );
      const notify = spyOn(mailbox.sdkMessageRepo, 'runPostSaveSideEffects');
      expect(() => accepted()).toThrow('fixture fault');
      expect(ledger.list(conversationId)).toEqual([]);
      expect(mailbox.sdkRows()).toEqual([]);
      expect(mailbox.rows()).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      notify.mockRestore();
    }
  );

  test('missing public storage fails before SDK or job persistence', () => {
    mailbox.db.exec('DROP TABLE neo_conversation_asks');
    expect(() => accepted()).toThrow();
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
  });

  test('corrupt SDK storage surfaces a fault rather than empty replay acceptance', () => {
    accepted();
    mailbox.db
      .prepare("UPDATE sdk_messages SET sdk_message='invalid-json' WHERE sdk_uuid=?")
      .run(requestId);
    expect(() => accepted()).toThrow();
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(mailbox.rows()).toHaveLength(1);
  });

  test('invalid preparation never writes any of the three records', () => {
    expect(accepted(prompt(), 'immediate', 'not-a-uuid')).toEqual({
      accepted: false,
      reason: 'invalid_ask',
    });
    expect(accepted(prompt(''))).toEqual({ accepted: false, reason: 'invalid_ask' });
    expect(ledger.list(conversationId)).toEqual([]);
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
  });

  test('refuses a nested outer transaction before any write or notification', () => {
    const notify = spyOn(mailbox.sdkMessageRepo, 'runPostSaveSideEffects');
    mailbox.db.transaction(() => {
      expect(() => accepted()).toThrow('must own its commit boundary');
    })();
    expect(ledger.list(conversationId)).toEqual([]);
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
  });

  test('notification failure never reverses committed receipt or prompt/job persistence', () => {
    const notify = spyOn(mailbox.sdkMessageRepo, 'runPostSaveSideEffects').mockImplementation(
      () => {
        throw new Error('notification unavailable');
      }
    );
    expect(accepted()).toMatchObject({ accepted: true, created: true });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.rows()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    notify.mockRestore();
  });

  test('the default native outbox still publishes once and can explicitly defer its notification', () => {
    const notify = spyOn(mailbox.sdkMessageRepo, 'runPostSaveSideEffects');
    legacy();
    expect(notify).toHaveBeenCalledTimes(1);
    let publish = () => {};
    ensurePrompt({
      db: mailbox.db,
      sdkMessageRepo: mailbox.sdkMessageRepo,
      jobQueue: mailbox.jobQueue,
      sessionId,
      message: prompt('Next', crypto.randomUUID()),
      delivery: { origin: 'chat' },
      deferPostSaveSideEffects: (effect) => {
        publish = effect;
      },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    publish();
    expect(notify).toHaveBeenCalledTimes(2);
    notify.mockRestore();
  });
});

test('joint intake publishes only once all three records are visible from another connection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'neo-atomic-intake-'));
  const path = join(directory, 'fixture.db');
  const writer = new Database(path);
  const reader = new Database(path);
  try {
    createTables(writer);
    new SessionRepository(writer).createSession({
      id: sessionId,
      title: 'Fictional',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'fictional' },
      metadata: {},
    } as Session);
    const sdk = new SDKMessageRepository(writer as never);
    const jobs = new JobQueueRepository(writer);
    const ledger = new NeoConversationAskRepository(writer);
    const observed: number[][] = [];
    const notify = spyOn(sdk, 'runPostSaveSideEffects').mockImplementation(() => {
      observed.push(
        ['neo_conversation_asks', 'sdk_messages', 'job_queue'].map(
          (table) =>
            (reader.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
              .count
        )
      );
    });
    expect(ledger.acceptPrompt(conversationId, prompt(), 'immediate', sdk, jobs)).toMatchObject({
      accepted: true,
      created: true,
    });
    expect(observed).toEqual([[1, 1, 1]]);
    expect(ledger.acceptPrompt(conversationId, prompt(), 'immediate', sdk, jobs)).toMatchObject({
      accepted: true,
      created: false,
    });
    expect(observed).toEqual([[1, 1, 1]]);
    notify.mockRestore();
  } finally {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
