import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handoffDraftDirectory,
  HandoffReference,
  publishHandoff,
  readHandoff,
} from '../../../../src/lib/handoffs/outbox.ts';
import { createSendMessageOperation } from '../../../../src/lib/messaging/message-send.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

describe('simple message.send worker handoff', () => {
  let root: string;
  let before: string | undefined;
  let mailbox: MailboxTestDb;
  const sender = 'worker-report';
  const report = 'Synthetic report\n'.padEnd(8192, 'x');
  const caller = { source: 'mcp' as const, sessionId: sender };
  const registry = () =>
    createOperationRegistry([
      createSendMessageOperation(mailbox.jobQueue, (id) =>
        [sender, 'neo:root', 'neo:second', 'ordinary-target'].includes(id) ? 'active' : null
      ),
    ]);
  const send = (input: unknown, catalog = registry()) =>
    invokeOperation(catalog, 'message.send', input, caller);
  const accepted = async (input: unknown, catalog = registry()) => {
    const result = await send(input, catalog);
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error(JSON.stringify(result));
    expect(result.value).toMatchObject({ kind: 'accepted' });
    return result.value as {
      kind: string;
      mailboxId: string;
      messageId: string;
      files?: unknown[];
    };
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'simple-send-')));
    before = process.env.HYPERNEO_DATA_DIR;
    process.env.HYPERNEO_DATA_DIR = root;
    mailbox = createMailboxTestDb();
  });
  afterEach(() => {
    mailbox.close();
    if (before === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = before;
    rmSync(root, { recursive: true, force: true });
  });

  test.each(['done', 'blocked', 'question', 'failed'])(
    'a structured %s report survives the mailbox boundary',
    async (kind) => {
      await accepted({ to: 'neo:root', text: 'Ordinary words.', kind });
      expect(JSON.parse(mailbox.rows()[0].payload).message.workerReportKind).toBe(kind);
    }
  );

  test('unknown report kinds are refused rather than silently becoming free text', async () => {
    expect(await send({ to: 'neo:root', text: 'Done.', kind: 'progress' })).not.toMatchObject({
      kind: 'completed',
      value: { kind: 'accepted' },
    });
    expect(mailbox.rows()).toHaveLength(0);
  });

  test.each(['neo:root', 'ordinary-target'])(
    'session messages to %s retain their envelope without a human id',
    async (to) => {
      await accepted({ to, text: 'Synthetic agent report.' });
      const entry = JSON.parse(mailbox.rows()[0].payload);
      expect(entry.message.inputKind).toBe('task');
      expect(JSON.stringify(entry.message.message.content)).toContain('Synthetic agent report.');
      expect(JSON.stringify(entry.message.message.content)).toContain(sender);
      expect(JSON.stringify(entry.message.message.content)).not.toContain('[message id:');
    }
  );

  test('one 8KB report call reaches Neo as a complete hash-checked file reference', async () => {
    const receipt = await accepted({ to: 'neo:root', text: report });
    expect(receipt.files).toHaveLength(1);
    const ref = HandoffReference.parse(receipt.files![0]);
    expect(ref).toMatchObject({
      sessionId: sender,
      byteLength: 8192,
      sha256: createHash('sha256').update(report).digest('hex'),
    });
    expect(readFileSync(ref.path, 'utf8')).toBe(report);
    const read = await readHandoff(root, ref);
    expect(read.kind).toBe('read');
    if (read.kind !== 'read') throw new Error('report not readable');
    expect(Buffer.from(read.data, 'base64').toString()).toBe(report);
    const entry = JSON.parse(mailbox.rows()[0].payload);
    expect(entry.to).toEqual({ kind: 'session', sessionId: 'neo:root' });
    expect(entry.origin).toBe(`session:${sender}`);
    expect(entry.message.inputKind).toBe('task');
    expect(JSON.stringify(entry.message)).toContain(ref.sha256);
    expect(JSON.stringify(entry.message)).toContain(ref.path);
    expect(JSON.stringify(entry.message)).not.toContain(report);
  });

  test.each([4096, 4097])('the inline limit is UTF8 bytes, at %i bytes', async (bytes) => {
    const text = '🔬'.repeat(1024) + (bytes === 4097 ? 'x' : '');
    const receipt = await accepted({ to: 'neo:root', text });
    if (bytes === 4096) {
      expect(receipt.files).toBeUndefined();
      expect(JSON.stringify(JSON.parse(mailbox.rows()[0].payload).message)).toContain(text);
    } else {
      const ref = HandoffReference.parse(receipt.files![0]);
      expect(ref.byteLength).toBe(bytes);
      expect(readFileSync(ref.path, 'utf8')).toBe(text);
    }
  });

  test('an interrupted older spill cannot poison future sends of the same report', async () => {
    const path = join(
      handoffDraftDirectory(root, sender),
      `message-${createHash('sha256').update(report).digest('hex')}.txt`
    );
    writeFileSync(path, report.slice(0, 32));
    const receipt = await accepted({ to: 'neo:root', text: report });
    const ref = HandoffReference.parse(receipt.files![0]);
    expect(readFileSync(ref.path, 'utf8')).toBe(report);
    expect(readFileSync(path, 'utf8')).toBe(report.slice(0, 32));
  });

  test('concurrent reports to different recipients both retain every byte', async () => {
    const shared = registry();
    const receipts = await Promise.all(
      ['neo:root', 'neo:second'].map((to) => accepted({ to, text: report }, shared))
    );
    for (const receipt of receipts) {
      const ref = HandoffReference.parse(receipt.files![0]);
      expect(readFileSync(ref.path, 'utf8')).toBe(report);
      expect(ref.byteLength).toBe(8192);
    }
    expect(mailbox.rows()).toHaveLength(2);
  });

  test('at most 20 explicit references are accepted per send, with a useful limit error', async () => {
    writeFileSync(join(handoffDraftDirectory(root, sender), 'limits.txt'), 'Synthetic attachment');
    const published = await publishHandoff(root, sender, 'limits.txt');
    if (published.kind !== 'published') throw new Error('fixture publication failed');
    const files = Array.from({ length: 20 }, () => published.reference);
    expect(
      (await accepted({ to: 'neo:root', text: 'Twenty attachments', files })).files
    ).toHaveLength(20);
    expect(
      await send({
        to: 'neo:root',
        text: 'Too many attachments',
        files: [...files, published.reference],
      })
    ).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
      message: expect.stringContaining('20'),
    });
    expect(mailbox.rows()).toHaveLength(1);
  });

  test('the old nested SDK envelope retains its content and accepted result shape', async () => {
    const receipt = await accepted({
      sessionId: 'neo:root',
      message: { type: 'user', message: { content: report }, parent_tool_use_id: null },
    });
    expect(Object.keys(receipt).sort()).toEqual(['kind', 'mailboxId', 'messageId']);
    expect(JSON.stringify(JSON.parse(mailbox.rows()[0].payload).message)).toContain(
      report.replaceAll('\n', '\\n')
    );
    expect(existsSync(join(root, 'handoffs'))).toBe(false);
  });

  test('schema errors show a working simple shape and the full legacy envelope', async () => {
    const result = await send({ sessionId: 'neo:root', message: { message: { content: report } } });
    expect(result).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    if (result.kind !== 'failed') throw new Error('expected schema failure');
    for (const field of ['"to"', '"text"', '"type"', '"parent_tool_use_id"'])
      expect(result.message).toContain(field);
    expect(mailbox.rows()).toHaveLength(0);
  });

  test('attached references are explicit, verified and retain their SHA256', async () => {
    const draft = join(handoffDraftDirectory(root, sender), 'evidence.md');
    writeFileSync(draft, 'Synthetic evidence');
    const published = await publishHandoff(root, sender, 'evidence.md');
    if (published.kind !== 'published') throw new Error('fixture publication failed');
    const receipt = await accepted({
      to: 'neo:root',
      text: 'Evidence attached',
      files: [published.reference],
    });
    expect(receipt.files).toEqual([published.reference]);
    chmodSync(published.reference.path, 0o600);
    writeFileSync(published.reference.path, 'tampered');
    expect(
      await send({ to: 'neo:root', text: 'Changed evidence', files: [published.reference] })
    ).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected', reason: expect.stringContaining('tampered') },
    });
    expect(mailbox.rows()).toHaveLength(1);
  });

  test('a worker cannot attach another session artifact or forge human provenance', async () => {
    writeFileSync(
      join(handoffDraftDirectory(root, 'other-worker'), 'report.txt'),
      'Private worker result'
    );
    const published = await publishHandoff(root, 'other-worker', 'report.txt');
    if (published.kind !== 'published') throw new Error('fixture publication failed');
    expect(
      await send({ to: 'neo:root', text: 'Forward', files: [published.reference], from: 'chat' })
    ).toMatchObject({ kind: 'completed', value: { kind: 'rejected', reason: 'session_scope' } });
    await accepted({ to: 'neo:root', text: 'Trusted sender', from: 'chat' });
    expect(JSON.parse(mailbox.rows()[0].payload).origin).toBe(`session:${sender}`);
  });

  test('mixed and arbitrary-path attachment shapes are rejected with examples', async () => {
    for (const input of [
      { to: 'neo:root', text: 'Mixed', sessionId: 'other' },
      { to: 'neo:root', text: 'Path', files: ['/private/report.txt'] },
    ])
      expect(await send(input)).toMatchObject({
        kind: 'failed',
        code: 'invalid_input',
        message: expect.stringContaining('Valid examples:'),
      });
    expect(mailbox.rows()).toHaveLength(0);
  });

  test('a failed enqueue rolls back its receipt so a retry can deliver', async () => {
    const input = { to: 'neo:root', text: report, idempotencyKey: 'failed-enqueue' };
    mailbox.db.exec(
      "CREATE TRIGGER fail_mailbox BEFORE INSERT ON job_queue BEGIN SELECT RAISE(ABORT, 'synthetic_disk_full'); END"
    );
    expect(await send(input)).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected', reason: expect.stringContaining('synthetic_disk_full') },
    });
    expect(mailbox.rows()).toHaveLength(0);
    expect(mailbox.db.prepare('SELECT COUNT(*) AS n FROM message_send_receipts').get()).toEqual({
      n: 0,
    });
    mailbox.db.exec('DROP TRIGGER fail_mailbox');
    await accepted(input);
    expect(mailbox.rows()).toHaveLength(1);
  });

  test('admission rejects a rate-limited large report before publishing it', async () => {
    const shared = registry();
    for (let n = 0; n < 6; n++) await accepted({ to: 'neo:root', text: `short-${n}` }, shared);
    expect(await send({ to: 'neo:root', text: report }, shared)).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected', reason: expect.stringContaining('rate_limited') },
    });
    expect(existsSync(join(root, 'handoffs'))).toBe(false);
  });

  test('an unknown target causes no spill or mailbox side effect', async () => {
    expect(await send({ to: 'missing', text: report })).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected' },
    });
    expect(existsSync(join(root, 'handoffs'))).toBe(false);
    expect(mailbox.rows()).toHaveLength(0);
  });

  test('remote file delivery is unavailable instead of reinterpreting local paths', async () => {
    expect(await send({ to: 'daemon:remote::session:target', text: report })).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected', reason: expect.stringContaining('unavailable') },
    });
    expect(existsSync(join(root, 'handoffs'))).toBe(false);
    expect(mailbox.rows()).toHaveLength(0);
  });

  test('an idempotency key replays a durable receipt after restart and completed-job cleanup', async () => {
    const input = { to: 'neo:root', text: report, idempotencyKey: 'incident-report-once' };
    const first = await accepted(input);
    expect(await accepted(input)).toEqual(first);
    expect(mailbox.rows()).toHaveLength(1);
    mailbox.db.exec('DELETE FROM job_queue');
    expect(await accepted(input)).toEqual(first);
    expect(mailbox.rows()).toHaveLength(0);
    expect(await send({ ...input, text: 'different report' })).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected', reason: expect.stringContaining('idempotency') },
    });
  });
});
