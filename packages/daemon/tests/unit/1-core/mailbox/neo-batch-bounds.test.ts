import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundDeliveryContent } from '../../../../src/lib/handoffs/bound-delivery.ts';
import { HandoffReference, readHandoff } from '../../../../src/lib/handoffs/outbox.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

describe('bounded complete Neo batches', () => {
  let mailbox: MailboxTestDb;
  let root: string;
  let previous: string | undefined;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    root = mkdtempSync(join(tmpdir(), 'neo-batch-bound-'));
    previous = process.env.HYPERNEO_DATA_DIR;
    process.env.HYPERNEO_DATA_DIR = root;
  });
  afterEach(() => {
    mailbox.close();
    if (previous === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  test('an oversized batch uses a complete hash-checked reference that survives a retry', async () => {
    const job = mailbox.jobQueue.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: 'neo:bounded', messageUuid: 'report' },
    });
    const loaded = {
      content: Array.from({ length: 120 }, (_, index) => ({
        type: 'text' as const,
        text: `${index}:${'x'.repeat(2048)}`,
      })),
      sendStatus: 'enqueued',
      neoBatch: true as const,
    };
    const first = await boundDeliveryContent(mailbox.db, job, loaded);
    expect(Buffer.byteLength(JSON.stringify(first.content))).toBeLessThan(65536);
    const block = Array.isArray(first.content) ? first.content[1] : null;
    if (block?.type !== 'text') throw new Error('missing handoff reference');
    const reference = HandoffReference.parse(JSON.parse(block.text).handoffFiles[0]);
    const read = await readHandoff(root, reference, 0, 256 * 1024);
    if (read.kind !== 'read') throw new Error(read.kind);
    expect(read.complete).toBe(true);
    expect(JSON.parse(Buffer.from(read.data, 'base64').toString())).toEqual(loaded.content);
    expect(
      await boundDeliveryContent(mailbox.db, mailbox.jobQueue.getJob(job.id)!, loaded)
    ).toEqual(first);
  });
});
