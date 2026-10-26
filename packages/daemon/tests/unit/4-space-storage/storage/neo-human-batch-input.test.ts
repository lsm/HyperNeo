import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, createTestSession } from '../../../helpers/database';
import { neoIntakeMessage } from '../../../../src/lib/neo/intake';
import { createMailboxEntry, type MailboxMessageContent } from '../../../../src/lib/mailbox/entry';
import { boundDeliveryContent } from '../../../../src/lib/handoffs/bound-delivery';
import { NeoWakeQueueRepository } from '../../../../src/storage/repositories/neo-wake-queue-repository';
import {
  NeoConversationAskRepository,
  prepareNeoIntakeAsk,
  persistNeoIntakeTransaction,
} from '../../../../src/storage/repositories/neo-conversation-ask-repository';
import { NeoSessionMessageRepository } from '../../../../src/storage/repositories/neo-session-message-repository';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';

const conversationId = '10000000-0000-4000-8000-000000008723';
const sessionId = `neo:${conversationId}`;
const requestId = '20000000-0000-4000-8000-000000008723';

describe('worker batches before human intake', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let root: string;
  let previous: string | undefined;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'neo-human-batch-'));
    previous = process.env.HYPERNEO_DATA_DIR;
    process.env.HYPERNEO_DATA_DIR = root;
    db = await createTestDb();
    await db.createSession(createTestSession(sessionId));
    new NeoRepository(db.getDatabase()).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  });
  afterEach(() => {
    db.close();
    if (previous === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  const hold = (content: MailboxMessageContent) =>
    new NeoWakeQueueRepository(db.getDatabase()).hold(
      createMailboxEntry({
        to: { kind: 'session', sessionId },
        origin: 'session:synthetic-worker',
        messageUuid: crypto.randomUUID(),
        message: { type: 'user', parent_tool_use_id: null, message: { content } },
      })
    );
  const accept = (content: string) => {
    const prompt = neoIntakeMessage({ sessionId, requestId, content });
    const ledger = new NeoConversationAskRepository(db.getDatabase());
    expect(
      ledger.acceptPromptSync(
        conversationId,
        prompt,
        'immediate',
        db.getSDKMessageRepo(),
        db.getJobQueueRepo()
      )
    ).toMatchObject({ accepted: true });
    return { prompt, ledger };
  };

  test('a separately labelled input precedes the byte-identical human prompt and retries once', async () => {
    hold('Worker note A');
    hold('Worker note B');
    const human = '  Keep my words inline, exactly.\n第二行。  ';
    const { prompt, ledger } = accept(human);
    expect(
      db.getJobQueueRepo().listActiveByPayload('message_delivery', { sessionId })
    ).toHaveLength(2);
    expect(db.getSDKMessageRepo().getStoredPromptsByUuid(sessionId, requestId)).toEqual([prompt]);
    const queue = db.getJobQueueRepo();
    const [batchJob] = queue.dequeueSessionFifo('message_delivery', 1);
    expect(batchJob.payload.messageUuid).not.toBe(requestId);
    const batch = db
      .getSDKMessageRepo()
      .getDeliveryContent(sessionId, String(batchJob.payload.messageUuid))!;
    expect(batch.inputKind).toBe('system');
    expect(JSON.stringify(batch.content)).toContain('System-forwarded worker messages');
    expect(JSON.stringify(batch.content)).toContain('Worker note A');
    expect(JSON.stringify(batch.content)).toContain('Worker note B');
    expect(JSON.stringify(batch.content)).not.toContain(human);
    await boundDeliveryContent(db.getDatabase(), batchJob, batch);
    db.getSDKMessageRepo().markDeliveryConsumedByUuid(
      sessionId,
      String(batchJob.payload.messageUuid)
    );
    queue.complete(batchJob.id, {}, batchJob.claimToken);
    const humanJob = queue.dequeueSessionFifo('message_delivery', 1)[0];
    expect(humanJob.payload.messageUuid).toBe(requestId);
    db.getSDKMessageRepo().markDeliveryConsumedByUuid(sessionId, requestId);
    queue.complete(humanJob.id, {}, humanJob.claimToken);
    expect(db.getSDKMessageRepo().getSDKMessages(sessionId, 100).messages).toHaveLength(2);
    expect(
      new NeoSessionMessageRepository(db.getDatabase()).get(
        conversationId,
        String(batchJob.payload.messageUuid)
      )
    ).toEqual(expect.objectContaining({ text: expect.stringContaining('Worker note A') }));
    expect(
      ledger.acceptPromptSync(conversationId, prompt, 'immediate', db.getSDKMessageRepo(), queue)
    ).toMatchObject({ accepted: true, created: false });
    expect(db.getSDKMessageRepo().getSDKMessages(sessionId, 100).messages).toHaveLength(2);
  });

  test('worker images reach Neo without leaking base64 or raw block JSON into public text', async () => {
    const image = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: 'd29ya2VyLWltYWdl',
      },
    };
    hold([{ type: 'text', text: 'Worker image context' }, image]);
    accept('Human words unchanged');
    const [job] = db.getJobQueueRepo().dequeueSessionFifo('message_delivery', 1);
    const delivered = db
      .getSDKMessageRepo()
      .getDeliveryContent(sessionId, String(job.payload.messageUuid))!;
    expect(delivered.content).toContainEqual(image);
    await boundDeliveryContent(db.getDatabase(), job, delivered);
    const row = new NeoSessionMessageRepository(db.getDatabase()).get(
      conversationId,
      String(job.payload.messageUuid)
    )!;
    expect(row.text).toContain('Worker image context');
    expect(row.text).not.toContain(image.source.data);
    expect(row.text).not.toContain('"type":"image"');
  });

  test('oversized worker content is bounded independently of the inline human message', async () => {
    hold('worker-only-' + 'x'.repeat(70 * 1024));
    const human = 'Human text must stay inline.';
    const { prompt } = accept(human);
    const queue = db.getJobQueueRepo();
    const jobs = queue.listActiveByPayload('message_delivery', { sessionId });
    expect(jobs).toHaveLength(2);
    const batchJob = jobs.find((job) => job.payload.messageUuid !== requestId)!;
    const humanJob = jobs.find((job) => job.payload.messageUuid === requestId)!;
    const sdk = db.getSDKMessageRepo();
    const bounded = await boundDeliveryContent(
      db.getDatabase(),
      batchJob,
      sdk.getDeliveryContent(sessionId, String(batchJob.payload.messageUuid))!
    );
    expect(Buffer.byteLength(JSON.stringify(bounded.content))).toBeLessThan(65536);
    expect(JSON.stringify(bounded.content)).toContain('handoffFiles');
    const publicRows = new NeoSessionMessageRepository(db.getDatabase());
    const row = publicRows.get(conversationId, String(batchJob.payload.messageUuid))!;
    expect(Buffer.byteLength(row.text)).toBeLessThan(65536);
    const publicText =
      typeof bounded.content === 'string'
        ? bounded.content
        : bounded.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('\n\n');
    expect(row.text).toBe(publicText);
    const retry = await boundDeliveryContent(
      db.getDatabase(),
      queue.getJob(batchJob.id)!,
      sdk.getDeliveryContent(sessionId, String(batchJob.payload.messageUuid))!
    );
    expect(retry.content).toEqual(bounded.content);
    expect(publicRows.get(conversationId, row.messageId)).toEqual(row);
    const inline = await boundDeliveryContent(
      db.getDatabase(),
      humanJob,
      sdk.getDeliveryContent(sessionId, requestId)!
    );
    expect(inline.content).toEqual(prompt.message.content);
    expect(JSON.stringify(inline.content)).not.toContain('handoffFiles');
  });

  test('a rolled-back intake leaves worker notes available for the next accepted human input', () => {
    hold('Worker note survives rollback');
    const message = neoIntakeMessage({ sessionId, requestId, content: 'Human after rollback' });
    const ask = prepareNeoIntakeAsk(conversationId, message);
    if (!('value' in ask)) throw new Error('invalid fixture');
    const ledger = new NeoConversationAskRepository(db.getDatabase());
    expect(() =>
      db.getDatabase().transaction(() => {
        persistNeoIntakeTransaction(
          ask.value,
          message,
          'immediate',
          db.getDatabase(),
          ledger,
          db.getSDKMessageRepo(),
          db.getJobQueueRepo(),
          () => {}
        );
        throw new Error('rollback');
      })()
    ).toThrow('rollback');
    expect(ledger.list(conversationId)).toEqual([]);
    expect(new NeoSessionMessageRepository(db.getDatabase()).latest(conversationId, 10)).toEqual(
      []
    );
    expect(db.getSDKMessageRepo().getStoredPromptsByUuid(sessionId, requestId)).toEqual([]);
    accept('Human after rollback');
    const [job] = db.getJobQueueRepo().dequeueSessionFifo('message_delivery', 1);
    expect(
      JSON.stringify(
        db.getSDKMessageRepo().getDeliveryContent(sessionId, String(job.payload.messageUuid))
          ?.content
      )
    ).toContain('Worker note survives rollback');
  });
});
