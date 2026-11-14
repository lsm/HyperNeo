import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { subscribeToStructuredLogs, type StructuredLogEvent } from '@hyperneo/shared';
import {
  createNeoPublisher,
  createNeoPublicationOperation,
} from '../../../../src/lib/neo/publication-operation.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration288 } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishHandoff, publicHandoffReference } from '../../../../src/lib/handoffs/outbox.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = { sessionId: `neo:${conversationId}`, kind: 'neo' as const, projectId: null };
const draft = { requestId: 'send-one', text: 'Ready', details: 'The comparison is ready.' };
const report = {
  daemonId: '30000000-0000-4000-8000-000000000001',
  artifactId: 'comparison',
  title: 'Comparison',
  kind: 'html' as const,
  byteLength: 100,
};
const video = { ...report, artifactId: 'video', kind: 'video' as const };
const caller = { source: 'mcp' as const, sessionId: root.sessionId, role: 'neo' as const };

describe('Neo publication without runtime input attribution', () => {
  let mailbox: MailboxTestDb;
  let ledger: NeoPublicationRepository;
  let publish: ReturnType<typeof createNeoPublisher>;
  const notify = vi.fn();
  let held: Promise<void> | null;
  let failWrite: boolean;
  let sourceSession: string | undefined;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration283(mailbox.db);
    runMigration288(mailbox.db);
    const repo = new NeoRepository(mailbox.db);
    mailbox.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(root.sessionId);
    repo.reserveBinding(root);
    repo.saveProject({ id: 'garden', title: 'Garden', summary: '', context: '' }, 0);
    ledger = new NeoPublicationRepository(mailbox.db);
    notify.mockClear();
    held = null;
    failWrite = false;
    sourceSession = undefined;
    publish = createNeoPublisher({
      receivedHumanInput: () => false,
      currentHumanInputs: () => [],
      getBinding: (id) => repo.getBindingBySession(id),
      getRootBinding: () => repo.defaultBinding(),
      hasProject: (id) => !!repo.getProject(id),
      publication: (conversation: string, id: string) => ledger.get(conversation, id),
      lookupSession: (id: string) =>
        id === 'worker' || id === root.sessionId ? 'found' : 'not_found',
      sourceSession: () => sourceSession,
      append: async (input) => {
        if (held) await held;
        if (failWrite) throw new Error('writer failed');
        return ledger.append(input);
      },
      speech: async () => ({ listening: 'no', spokenDelivered: false }),
      notify,
      artifact: (id, who) =>
        who.sessionId === root.sessionId
          ? ([report, video].find((ref) => ref.artifactId === id) ?? null)
          : null,
    });
  });
  afterEach(() => mailbox.close());
  const rawPayload = () =>
    (
      mailbox.db.prepare('SELECT payload_json FROM neo_publications').get() as {
        payload_json: string;
      }
    ).payload_json;

  test('retains verified worker handoffs and refuses forged, foreign or altered ones without writing', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'publication-handoff-')));
    const prior = process.env.HYPERNEO_DATA_DIR;
    process.env.HYPERNEO_DATA_DIR = dir;
    try {
      const drafts = join(dir, 'handoffs', 'worker', 'drafts');
      mkdirSync(drafts, { recursive: true });
      writeFileSync(join(drafts, 'report.md'), '# Synthetic report\n');
      const snapshot = await publishHandoff(dir, 'worker', 'report.md');
      if (snapshot.kind !== 'published') throw new Error('publish failed');
      const reference = publicHandoffReference(snapshot.reference);
      for (const invalid of [
        { ...reference, daemonId: '00000000-0000-4000-8000-000000000000' },
        { ...reference, name: 'other.md' },
        { ...reference, byteLength: reference.byteLength + 1 },
        { ...reference, sha256: '0'.repeat(64) },
      ]) {
        const rejected = await publish({ ...draft, artifacts: [report, invalid] }, caller);
        expect(rejected).toMatchObject({ accepted: false, reason: 'invalid_artifact_reference' });
        expect(ledger.list(conversationId)).toHaveLength(0);
      }
      const withPath = await publish(
        { ...draft, artifacts: [{ ...reference, path: snapshot.reference.path }] },
        caller
      );
      expect(withPath).toMatchObject({ accepted: false });
      expect(ledger.list(conversationId)).toHaveLength(0);
      const accepted = await publish({ ...draft, artifacts: [report, reference] }, caller);
      expect(accepted).toMatchObject({
        accepted: true,
        publication: { artifacts: [report, reference] },
      });
      expect(rawPayload()).not.toContain(dir);
      expect(await publish({ ...draft, artifacts: [report, reference] }, caller)).toMatchObject({
        accepted: true,
        created: false,
      });
      chmodSync(snapshot.reference.path, 0o600);
      writeFileSync(snapshot.reference.path, 'tampered');
      expect(
        await publish({ ...draft, requestId: 'tampered', artifacts: [reference] }, caller)
      ).toMatchObject({ accepted: false, reason: 'invalid_artifact_reference' });
      expect(ledger.list(conversationId)).toHaveLength(1);
    } finally {
      if (prior === undefined) delete process.env.HYPERNEO_DATA_DIR;
      else process.env.HYPERNEO_DATA_DIR = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('published and retried messages tell the model no assistant text is needed unless a record was requested', async () => {
    const handler = createOperationMcpHandler(
      createOperationRegistry([createNeoPublicationOperation(publish)]),
      () => caller
    );
    const send = (input = draft) => handler({ name: 'neo.publication.publish', input });
    const first = JSON.parse((await send()).content[0].text);
    expect(first).toMatchObject({
      accepted: true,
      created: true,
      guidance:
        'Already shown to the user; no assistant text this turn except a requested transcript/record or required scheduled-wake summary.',
    });
    const retry = JSON.parse((await send()).content[0].text);
    expect(retry).toMatchObject({ accepted: true, created: false, guidance: first.guidance });
    expect(ledger.list(conversationId)).toHaveLength(1);
    const conflict = JSON.parse(
      (await send({ ...draft, details: 'A different message.' })).content[0].text
    );
    expect(conflict.accepted).toBe(false);
    expect(conflict.guidance).toBeUndefined();
  });

  test('timestamps publication after the durable write without logging its text', async () => {
    const logs: StructuredLogEvent[] = [];
    const unsubscribe = subscribeToStructuredLogs((event) => {
      if (event.message === 'voice.publication.persisted') logs.push(event);
    });
    let release = () => {};
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const pending = publish(draft, caller);
      await Promise.resolve();
      expect(logs).toHaveLength(0);
      release();
      const receipt = await pending;
      expect(receipt.accepted).toBe(true);
      await publish(draft, caller);
      expect(logs).toHaveLength(1);
      expect(logs[0].metadata).toMatchObject({
        sessionId: root.sessionId,
        requestId: draft.requestId,
        atMs: expect.any(Number),
      });
      expect(JSON.stringify(logs)).not.toContain(draft.details);
    } finally {
      release();
      unsubscribe();
    }
  });

  test('publication notifications wait for the durable write receipt', async () => {
    let release = () => {};
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = publish(draft, caller);
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    expect(ledger.list(conversationId)).toHaveLength(0);
    release();
    expect(await pending).toMatchObject({ accepted: true, created: true });
    expect(notify).toHaveBeenCalledOnce();
    expect(ledger.list(conversationId)).toHaveLength(1);
  });

  test('a failed writer does not announce an unpersisted publication', async () => {
    failWrite = true;
    await expect(publish(draft, caller)).rejects.toThrow('writer failed');
    expect(notify).not.toHaveBeenCalled();
    expect(ledger.list(conversationId)).toHaveLength(0);
  });

  test('publishes without a holder and leaves answered input unspecified', async () => {
    const receipt = await publish(draft, caller);
    expect(receipt).toMatchObject({ accepted: true, created: true });
    expect(receipt).not.toHaveProperty('answered');
    expect(ledger.list(conversationId)).toEqual([expect.objectContaining({ shortText: 'Ready' })]);
    const stored = ledger.list(conversationId)![0];
    expect(stored.askOrigin).toBeUndefined();
    expect(stored.producerInput).toBeUndefined();
    expect(notify).toHaveBeenCalledOnce();
  });

  test('retries the same request without duplicating or rewriting the publication', async () => {
    expect(await publish(draft, caller)).toMatchObject({ accepted: true, created: true });
    expect(await publish(draft, caller)).toMatchObject({ accepted: true, created: false });
    expect(await publish({ ...draft, text: 'Changed' }, caller)).toMatchObject({
      accepted: false,
      reason: 'publication_conflict',
    });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(await publish({ ...draft, requestId: 'send-two' }, caller)).toMatchObject({
      accepted: true,
      created: true,
    });
  });

  test.each(['worker', 'ordinary', 'neo:foreign'])(
    'refuses a foreign publisher %s',
    async (sessionId) => {
      expect(await publish(draft, { ...caller, sessionId })).toMatchObject({
        accepted: false,
        reason: 'avatar_required',
      });
      expect(ledger.list(conversationId)).toHaveLength(0);
    }
  );

  test('refuses a human transport even with the Neo session id', async () => {
    expect(await publish(draft, { ...caller, source: 'rpc' })).toMatchObject({ accepted: false });
  });

  test.each([
    { ...report, artifactId: 'missing' },
    { ...report, byteLength: report.byteLength + 1 },
    { ...report, daemonId: '40000000-0000-4000-8000-000000000001' },
  ])(
    'rejects an unavailable or mismatched artifact without publishing and allows a corrected retry',
    async (invalid) => {
      expect(await publish({ ...draft, artifacts: [report, invalid] }, caller)).toMatchObject({
        accepted: false,
        reason: 'invalid_artifact_reference',
      });
      expect(ledger.list(conversationId)).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
      expect(await publish({ ...draft, artifacts: [report] }, caller)).toMatchObject({
        accepted: true,
        created: true,
        publication: { artifacts: [report] },
      });
    }
  );

  test('withholds registered video without poisoning an existing publication page', async () => {
    expect(await publish({ ...draft, artifacts: [report] }, caller)).toMatchObject({
      accepted: true,
    });
    const before = ledger.list(conversationId);
    notify.mockClear();
    expect(
      await publish({ ...draft, requestId: 'video', artifacts: [video] }, caller)
    ).toMatchObject({
      accepted: false,
      reason: 'invalid_artifact_reference',
    });
    expect(ledger.list(conversationId)).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });

  test.each(['work', 'consultation'])('rejects %s links at the publish input schema', (kind) => {
    const operation = createNeoPublicationOperation(publish);
    expect(
      operation.inputSchema.safeParse({ ...draft, links: [{ kind, id: 'old', label: 'Old' }] })
        .success
    ).toBe(false);
  });

  test('rejects an unknown project without saving and accepts a corrected retry', async () => {
    expect(
      await publish(
        { ...draft, links: [{ kind: 'project', id: 'missing', label: 'Missing' }] },
        caller
      )
    ).toEqual({
      accepted: false,
      reason: 'unknown_project',
      detail: 'Unknown project link: missing (Missing)',
    });
    expect(ledger.list(conversationId)).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    const links = [{ kind: 'project' as const, id: 'garden', label: 'Garden' }];
    expect(await publish({ ...draft, links }, caller)).toMatchObject({
      accepted: true,
      created: true,
      publication: { links },
    });
    expect(ledger.list(conversationId)).toEqual([expect.objectContaining({ links })]);
  });

  test('session null is the same as no session', async () => {
    const handler = createOperationMcpHandler(
      createOperationRegistry([createNeoPublicationOperation(publish)]),
      () => caller
    );
    const reply = JSON.parse(
      (await handler({ name: 'neo.publication.publish', input: { ...draft, session: null } }))
        .content[0].text
    );
    expect(reply).toMatchObject({ accepted: true, created: true });
    expect(ledger.list(conversationId)[0].session).toBeUndefined();
  });

  test('Open never points at Neo: its own session is dropped, a worker is kept', async () => {
    const own = await publish({ ...draft, session: root.sessionId }, caller);
    expect(own).toMatchObject({ accepted: true, created: true });
    expect(ledger.list(conversationId)[0].session).toBeUndefined();

    sourceSession = root.sessionId;
    await publish({ ...draft, requestId: 'send-two' }, caller);
    expect(ledger.list(conversationId)[1].session).toBeUndefined();

    await publish({ ...draft, requestId: 'send-three', session: 'worker' }, caller);
    expect(ledger.list(conversationId)[2].session).toBe('worker');
  });

  test('a stored Neo session is hidden from readers and left in the row', async () => {
    await publish({ ...draft, session: 'worker' }, caller);
    const stored = JSON.stringify({ ...JSON.parse(rawPayload()), session: root.sessionId });
    mailbox.db.prepare('UPDATE neo_publications SET payload_json = ?').run(stored);

    expect(ledger.list(conversationId)[0].session).toBeUndefined();
    expect(JSON.parse(rawPayload()).session).toBe(root.sessionId);
  });

  test('a retry of a row that stored a Neo session is the same send', async () => {
    await publish(draft, caller);
    const stored = JSON.stringify({ ...JSON.parse(rawPayload()), session: root.sessionId });
    mailbox.db.prepare('UPDATE neo_publications SET payload_json = ?').run(stored);

    expect(await publish(draft, caller)).toMatchObject({ accepted: true, created: false });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(rawPayload()).toBe(stored);
  });

  test('rejects an unknown session without saving and accepts a corrected retry', async () => {
    expect(await publish({ ...draft, session: 'missing' }, caller)).toEqual({
      accepted: false,
      reason: 'unknown_session',
      detail: 'Unknown session: missing',
    });
    expect(ledger.list(conversationId)).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    expect(await publish({ ...draft, session: 'worker' }, caller)).toMatchObject({
      accepted: true,
      created: true,
      publication: { session: 'worker' },
    });
    expect(ledger.list(conversationId)[0]).toMatchObject({ session: 'worker' });
  });

  test('fills a certain source session and leaves an uncertain source empty', async () => {
    sourceSession = 'worker';
    expect(await publish(draft, caller)).toMatchObject({
      accepted: true,
      publication: { session: 'worker' },
    });
    sourceSession = undefined;
    const uncertain = await publish({ ...draft, requestId: 'uncertain' }, caller);
    expect(uncertain).toMatchObject({ accepted: true });
    expect(ledger.list(conversationId)[1].session).toBeUndefined();
    sourceSession = 'gone';
    expect(await publish({ ...draft, requestId: 'gone' }, caller)).toMatchObject({
      accepted: true,
    });
    expect(ledger.list(conversationId)[2].session).toBeUndefined();
  });

  test('pins an auto-filled session when the same request is retried after its turn ends', async () => {
    sourceSession = 'worker';
    expect(await publish(draft, caller)).toMatchObject({
      accepted: true,
      created: true,
      publication: { session: 'worker' },
    });
    sourceSession = undefined;
    expect(await publish(draft, caller)).toMatchObject({
      accepted: true,
      created: false,
      publication: { session: 'worker' },
    });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(await publish({ ...draft, text: 'Changed' }, caller)).toMatchObject({
      accepted: false,
      reason: 'publication_conflict',
    });
  });

  test('keeps an originally empty session empty when retrying in a worker turn', async () => {
    expect(await publish(draft, caller)).toMatchObject({ accepted: true, created: true });
    sourceSession = 'worker';
    expect(await publish(draft, caller)).toMatchObject({ accepted: true, created: false });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(ledger.list(conversationId)[0].session).toBeUndefined();
  });

  test('omits unknown reply ids without attributing a human answer', async () => {
    const receipt = await publish({ ...draft, replyTo: [conversationId] }, caller);
    expect(receipt).toMatchObject({ accepted: true, publication: { replyTo: [] } });
    expect(ledger.list(conversationId)![0].producerInput).toBeUndefined();
  });

  test('publishes a text-only reply from one text field and stores it verbatim', async () => {
    const content = '> quoted line\n\n```ts\nconst draft = \"as written\";\n```';
    const receipt = await publish({ requestId: 'send-verbatim', text: content }, caller);
    expect(receipt).toMatchObject({
      accepted: true,
      created: true,
      publication: { verbatim: true, fullText: content },
    });
    const stored = ledger.list(conversationId)![0];
    expect(stored).not.toHaveProperty('shortText');
    expect(stored).toMatchObject({ verbatim: true });
    expect(stored.fullText).toBe(content);
  });

  test('publishes longer details as summary and details and folds shorter details in', async () => {
    const split = await publish(
      { requestId: 'send-split', text: 'The result', details: 'More supporting detail.' },
      caller
    );
    expect(split).toMatchObject({
      accepted: true,
      created: true,
      publication: { shortText: 'The result', fullText: 'More supporting detail.' },
    });
    const stored = ledger.list(conversationId)![0];
    expect(stored).toMatchObject({ shortText: 'The result', fullText: 'More supporting detail.' });
    expect(stored.verbatim).toBeUndefined();

    const folded = await publish(
      {
        requestId: 'send-folded',
        text: 'The full answer with everything the human needs.',
        details: 'a short addendum',
      },
      caller
    );
    expect(folded).toMatchObject({
      accepted: true,
      created: true,
      publication: {
        verbatim: true,
        fullText: 'The full answer with everything the human needs.\n\na short addendum',
      },
    });
    const foldedRow = ledger.list(conversationId)![1];
    expect(foldedRow).not.toHaveProperty('shortText');
    expect(foldedRow.verbatim).toBe(true);
    expect(foldedRow.fullText).toBe(
      'The full answer with everything the human needs.\n\na short addendum'
    );
  });

  test('holds every body to about 60 words, 150 Chinese characters and 5 lines', async () => {
    const long = Array(61).fill('word').join(' ');
    const send = (requestId: string, text: string, details?: string) =>
      publish({ requestId, text, ...(details === undefined ? {} : { details }) }, caller);
    expect(await send('long-alone', long)).toMatchObject({
      accepted: false,
      reason: 'reply_needs_details',
    });
    expect(await send('long-split', 'Merged and green.', long)).toMatchObject({
      accepted: true,
      publication: { shortText: 'Merged and green.', fullText: long },
    });
    expect(await send('long-with-details', long, `${long} ${long}`)).toMatchObject({
      accepted: false,
      reason: 'reply_summary_too_long',
    });
    expect(await send('long-short-details', long, 'One more note.')).toMatchObject({
      accepted: false,
      reason: 'reply_summary_too_long',
    });
    expect(await send('chinese-long', '中'.repeat(151))).toMatchObject({
      accepted: false,
      reason: 'reply_needs_details',
    });
    expect(await send('six-lines', 'Title\n- a\n- b\n- c\n- d\n- e')).toMatchObject({
      accepted: false,
      reason: 'reply_needs_details',
    });
    const spaced = Array.from({ length: 20 }, (_, line) => `Line ${line}`).join('\n\n');
    expect(await send('blank-separated', spaced)).toMatchObject({
      accepted: false,
      reason: 'reply_needs_details',
    });
    expect(await send('base64', `Key: ${'QUJD'.repeat(125)}`)).toMatchObject({
      accepted: false,
      reason: 'reply_needs_details',
    });
    const email = `Dear Sam,\n\n${long}\n\nThanks,\nMarc\n\nP.S. ${'QUJD'.repeat(125)}`;
    expect(
      await publish({ requestId: 'deliverable', text: email, deliverable: true }, caller)
    ).toMatchObject({ accepted: true, publication: { verbatim: true, fullText: email } });
    for (const [requestId, text] of [
      ['short', '**Merged**\n- CI green\n- 已部署'],
      ['words-at-limit', Array(60).fill('word').join(' ')],
      ['chinese-at-limit', '中'.repeat(150)],
      ['five-lines', 'Title\n- a\n- b\n- c\n- d'],
    ] as const)
      expect(await send(requestId, text)).toMatchObject({
        accepted: true,
        publication: { verbatim: true, fullText: text },
      });
    const fiveLines = 'Merged.\n- CI green\n- Reviewed\n- Deployed\n- Docs updated';
    expect(await send('five-lines-short-details', fiveLines, 'Flag rolled back.')).toMatchObject({
      accepted: true,
      publication: { shortText: fiveLines, fullText: 'Flag rolled back.' },
    });
    const han = '中'.repeat(150);
    expect(await send('han-short-details', han, '文'.repeat(140))).toMatchObject({
      accepted: true,
      publication: { shortText: han, fullText: '文'.repeat(140) },
    });
    expect(await send('short-details-fold', 'Merged and green.', 'CI.')).toMatchObject({
      accepted: true,
      publication: { verbatim: true, fullText: 'Merged and green.\n\nCI.' },
    });
    expect(ledger.list(conversationId)).toHaveLength(9);
  });

  test('refuses folded details whose combined length passes the stored cap', async () => {
    const over = await publish(
      { requestId: 'send-folded-over', text: 'x'.repeat(16000), details: 'd'.repeat(15000) },
      caller
    );
    expect(over).toMatchObject({ accepted: false, reason: 'invalid_publication' });
    expect(ledger.list(conversationId) ?? []).toHaveLength(0);
  });

  test('refuses the old shortText, fullText and verbatim fields', async () => {
    for (const old of [
      { requestId: 'old', shortText: 'Preview', fullText: 'Whole.' },
      { requestId: 'old', verbatim: true, fullText: 'Whole.' },
      { requestId: 'old', shortText: 'Preview', verbatim: true, fullText: 'Whole.' },
    ])
      expect(await publish(old, caller)).toMatchObject({
        accepted: false,
        reason: 'invalid_publication',
      });
    expect(ledger.list(conversationId)).toHaveLength(0);
  });

  test.each(['askOrigin', 'producerInput', 'conversationId', 'publicationId'])(
    'does not accept model authored runtime field %s',
    async (field) => {
      expect(await publish({ ...draft, [field]: 'forged' }, caller)).toMatchObject({
        accepted: false,
        reason: 'invalid_publication',
      });
    }
  );
});
