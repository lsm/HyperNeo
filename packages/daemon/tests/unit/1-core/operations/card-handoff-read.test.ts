import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailboxTestDb } from '../../../helpers/mailbox-test-db.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration288 } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import {
  publishHandoff,
  publicHandoffReference,
  readPublicHandoff,
} from '../../../../src/lib/handoffs/outbox.ts';
import { createCardHandoffRead } from '../../../../src/lib/handoffs/card-read.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

test('card handoff reads require an exact stored reference and sanitize HTML', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'card-handoff-')));
  const mailbox = createMailboxTestDb();
  try {
    createNeoTables(mailbox.db);
    runMigration283(mailbox.db);
    runMigration288(mailbox.db);
    const conversation = '10000000-0000-4000-8000-000000000001';
    const sessionId = `neo:${conversation}`;
    mailbox.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sessionId);
    const neo = new NeoRepository(mailbox.db);
    neo.reserveBinding({ sessionId, kind: 'neo', projectId: null });
    expect(neo.conversationId()).toBe(conversation);
    mailbox.db.exec(
      "CREATE TABLE neo_asks(id TEXT PRIMARY KEY); CREATE TABLE neo_questions(id TEXT PRIMARY KEY, ask_id TEXT, artifacts_json TEXT); INSERT INTO neo_asks(id) VALUES ('ask'); INSERT INTO neo_questions(id, ask_id) VALUES ('question', 'ask');"
    );
    const drafts = join(root, 'handoffs', 'worker', 'drafts');
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(drafts, 'report.html'), '<h1>Safe report</h1><script>window.bad=1</script>');
    const published = await publishHandoff(root, 'worker', 'report.html');
    if (published.kind !== 'published') throw new Error('publish failed');
    const reference = publicHandoffReference(published.reference);
    mailbox.db
      .prepare('UPDATE neo_questions SET artifacts_json = ? WHERE id = ?')
      .run(JSON.stringify([reference]), 'question');
    mailbox.db
      .prepare(
        'INSERT INTO neo_publications(conversation_id,publication_id,payload_json,created_at) VALUES (?,?,?,?)'
      )
      .run(
        conversation,
        'publication',
        JSON.stringify({ artifacts: [reference] }),
        '2026-01-01T00:00:00.000Z'
      );
    const registry = createOperationRegistry([createCardHandoffRead(() => mailbox.db, root)]);
    const invoke = async (
      source: { kind: 'question' | 'publication'; id: string },
      ref = reference
    ) => {
      const result = await invokeOperation(
        registry,
        'file.handoff.read',
        { source, reference: ref },
        { source: 'rpc', principal: 'local' }
      );
      if (result.kind !== 'completed') throw new Error(JSON.stringify(result));
      return result.value as { accepted: boolean; reason?: string; data?: string; kind?: string };
    };
    for (const source of [
      { kind: 'question' as const, id: 'question' },
      { kind: 'publication' as const, id: 'publication' },
    ]) {
      const result = await invoke(source);
      expect({ source, ...result }).toMatchObject({ source, accepted: true, kind: 'html' });
      expect(Buffer.from(result.data!, 'base64').toString()).toContain('Safe report');
      expect(Buffer.from(result.data!, 'base64').toString()).not.toContain('<script>');
      expect(JSON.stringify(result)).not.toContain(root);
    }
    expect((await invoke({ kind: 'question', id: 'missing' })).reason).toBe('forbidden');
    mailbox.db
      .prepare(
        'INSERT INTO neo_publications(conversation_id,publication_id,payload_json,created_at) VALUES (?,?,?,?)'
      )
      .run(
        'foreign-conversation',
        'outside',
        JSON.stringify({ artifacts: [reference] }),
        '2026-01-01T00:00:00.000Z'
      );
    expect((await invoke({ kind: 'publication', id: 'outside' })).reason).toBe('forbidden');
    expect(
      (await invoke({ kind: 'question', id: 'question' }, { ...reference, name: 'other.html' }))
        .reason
    ).toBe('forbidden');
    expect(
      (
        await invoke(
          { kind: 'question', id: 'question' },
          { ...reference, daemonId: '00000000-0000-4000-8000-000000000000' }
        )
      ).reason
    ).toBe('forbidden');
    const foreign = { ...reference, daemonId: '00000000-0000-4000-8000-000000000000' };
    mailbox.db
      .prepare('UPDATE neo_questions SET artifacts_json = ? WHERE id = ?')
      .run(JSON.stringify([foreign]), 'question');
    expect((await invoke({ kind: 'question', id: 'question' }, foreign)).reason).toBe(
      'owner_unavailable'
    );
    mailbox.db
      .prepare('UPDATE neo_questions SET artifacts_json = ? WHERE id = ?')
      .run(JSON.stringify([reference]), 'question');
    const workerRead = await invokeOperation(
      registry,
      'file.handoff.read',
      { source: { kind: 'question', id: 'question' }, reference },
      { source: 'mcp', sessionId: 'worker' }
    );
    expect(
      workerRead.kind === 'completed' && (workerRead.value as { accepted: boolean }).accepted
    ).toBe(false);
    writeFileSync(join(drafts, 'report.md'), '# Markdown snapshot\n');
    const markdown = await publishHandoff(root, 'worker', 'report.md');
    if (markdown.kind !== 'published') throw new Error('publish failed');
    const markdownRef = publicHandoffReference(markdown.reference);
    mailbox.db
      .prepare('UPDATE neo_questions SET artifacts_json = ? WHERE id = ?')
      .run(JSON.stringify([reference, markdownRef]), 'question');
    const markdownRead = await invoke({ kind: 'question', id: 'question' }, markdownRef);
    expect(markdownRead.kind).toBe('markdown');
    expect(Buffer.from(markdownRead.data!, 'base64').toString()).toBe('# Markdown snapshot\n');
    const chunked = async (offset: number, version?: string) =>
      invokeOperation(
        registry,
        'file.handoff.read',
        {
          source: { kind: 'question', id: 'question' },
          reference: markdownRef,
          offset,
          maxBytes: 5,
          ...(version ? { version } : {}),
        },
        { source: 'rpc', principal: 'local' }
      );
    const first = await chunked(0);
    if (first.kind !== 'completed') throw new Error('first chunk failed');
    const head = first.value as { version: string; nextOffset: number; data: string };
    expect((await chunked(head.nextOffset)).kind).toBe('failed');
    const changed = await chunked(head.nextOffset, '0'.repeat(64));
    expect(changed.kind === 'completed' && changed.value).toEqual({
      accepted: false,
      reason: 'file_changed',
    });
    const second = await chunked(head.nextOffset, head.version);
    expect(second.kind === 'completed' && (second.value as { data: string }).data).toBe(
      Buffer.from('kdown').toString('base64')
    );
    const longText = `# ${'x'.repeat(300_000)}`;
    writeFileSync(join(drafts, 'large.md'), longText);
    const large = await publishHandoff(root, 'worker', 'large.md');
    if (large.kind !== 'published') throw new Error('publish failed');
    const largeRef = publicHandoffReference(large.reference);
    mailbox.db
      .prepare('UPDATE neo_questions SET artifacts_json = ? WHERE id = ?')
      .run(JSON.stringify([reference, markdownRef, largeRef]), 'question');
    const reads: { offset: number | undefined; length: number | undefined }[] = [];
    const countingReader: typeof readPublicHandoff = async (...args) => {
      reads.push({ offset: args[2], length: args[3] });
      return readPublicHandoff(...args);
    };
    const countingRegistry = createOperationRegistry([
      createCardHandoffRead(() => mailbox.db, root, countingReader),
    ]);
    const largeRead = (offset: number, version?: string) =>
      invokeOperation(
        countingRegistry,
        'file.handoff.read',
        {
          source: { kind: 'question', id: 'question' },
          reference: largeRef,
          offset,
          ...(version ? { version } : {}),
        },
        { source: 'rpc', principal: 'local' }
      );
    const largeFirst = await largeRead(0);
    if (largeFirst.kind !== 'completed') throw new Error('large read failed');
    const largeHead = largeFirst.value as {
      accepted: boolean;
      nextOffset: number;
      version: string;
      data: string;
    };
    expect(largeHead.accepted).toBe(true);
    expect(reads).toEqual([{ offset: 0, length: largeRef.byteLength }]);
    const largeSecond = await largeRead(largeHead.nextOffset, largeHead.version);
    if (largeSecond.kind !== 'completed') throw new Error('large continuation failed');
    expect(
      Buffer.concat([
        Buffer.from(largeHead.data, 'base64'),
        Buffer.from((largeSecond.value as { data: string }).data, 'base64'),
      ]).toString()
    ).toBe(longText);
    expect(reads).toEqual([
      { offset: 0, length: largeRef.byteLength },
      { offset: 0, length: largeRef.byteLength },
    ]);
    const incompleteReader: typeof readPublicHandoff = async (...args) => {
      const read = await readPublicHandoff(...args);
      return read.kind === 'read' ? { ...read, complete: false } : read;
    };
    const incompleteRegistry = createOperationRegistry([
      createCardHandoffRead(() => mailbox.db, root, incompleteReader),
    ]);
    const incomplete = await invokeOperation(
      incompleteRegistry,
      'file.handoff.read',
      { source: { kind: 'question', id: 'question' }, reference: largeRef },
      { source: 'rpc', principal: 'local' }
    );
    expect(incomplete.kind === 'completed' && incomplete.value).toEqual({
      accepted: false,
      reason: 'file_changed',
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldReader: typeof readPublicHandoff = async (...args) => {
      entered();
      await proceed;
      return readPublicHandoff(...args);
    };
    const heldRegistry = createOperationRegistry([
      createCardHandoffRead(() => mailbox.db, root, heldReader),
    ]);
    const pending = invokeOperation(
      heldRegistry,
      'file.handoff.read',
      { source: { kind: 'question', id: 'question' }, reference },
      { source: 'rpc', principal: 'local' }
    );
    await started;
    mailbox.db
      .prepare('UPDATE neo_questions SET artifacts_json = NULL WHERE id = ?')
      .run('question');
    release();
    const revoked = await pending;
    expect(revoked.kind === 'completed' && revoked.value).toEqual({
      accepted: false,
      reason: 'forbidden',
    });
    mailbox.db
      .prepare('UPDATE neo_questions SET artifacts_json = ? WHERE id = ?')
      .run(JSON.stringify([reference]), 'question');
    chmodSync(published.reference.path, 0o600);
    writeFileSync(published.reference.path, 'tampered');
    expect((await invoke({ kind: 'question', id: 'question' })).reason).toBe('file_changed');
  } finally {
    mailbox.close();
    rmSync(root, { recursive: true, force: true });
  }
});
