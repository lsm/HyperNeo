import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MessageHub, MessageHubRouter } from '@hyperneo/shared';
import { NeoSpeech } from '../../../../src/lib/neo/speech.ts';
import {
  createNeoPublisher,
  createNeoPublicationOperation,
} from '../../../../src/lib/neo/publication-operation.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration288 } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { runMigration387 } from '../../../../src/storage/schema/m387-neo-ask-todo-tables.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';
import { runDbOpOn } from '../../helpers/run-db-op.ts';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishHandoff, publicHandoffReference } from '../../../../src/lib/handoffs/outbox.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const sessionId = `neo:${conversationId}`;
const caller = { source: 'mcp' as const, role: 'neo' as const, sessionId };
const draft = {
  requestId: 'result',
  text: 'Ready',
  details: 'The result is ready.',
  spoken: 'Here is the result.',
};

describe('publication speech follows the committed version', () => {
  let mailbox: MailboxTestDb;
  let hub: MessageHub;
  let speech: NeoSpeech;
  let ledger: NeoPublicationRepository;
  let send: (input?: unknown) => Promise<Record<string, unknown>>;
  let listen: (enabled: boolean, clientId?: string) => Promise<void>;
  let events: { type: string; client?: string; id?: string; text?: string }[];
  let hold: Promise<void> | undefined;
  let failWrite: boolean;
  let failSpeech: boolean;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration283(mailbox.db);
    runMigration288(mailbox.db);
    runMigration387(mailbox.db);
    mailbox.db.exec(
      'CREATE TABLE operation_refusals(operation TEXT,reason TEXT,session_id TEXT,at INTEGER,accepted INTEGER)'
    );
    mailbox.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sessionId);
    const repo = new NeoRepository(mailbox.db);
    repo.reserveBinding({ sessionId, kind: 'neo', projectId: null });
    ledger = new NeoPublicationRepository(mailbox.db);
    hub = new MessageHub();
    const router = new MessageHubRouter({ logger: { log() {}, warn() {}, error() {} } });
    hub.registerRouter(router);
    events = [];
    hold = undefined;
    failWrite = false;
    failSpeech = false;
    for (const client of ['phone', 'web'])
      router.registerConnection({
        id: client,
        isOpen: () => true,
        send: (raw) => {
          const data = JSON.parse(raw).data;
          if (data.type === 'say') {
            expect(ledger.list(conversationId)).toHaveLength(1);
            events.push({ ...data, client });
          }
        },
      });
    speech = new NeoSpeech(
      hub,
      async (op, args) => {
        if (failSpeech) throw Error('speech audit write failed');
        return runDbOpOn(mailbox.db)(op, args);
      },
      (id) => id === sessionId
    );
    const runtime = {
      receivedHumanInput: () => true,
      currentHumanInputs: () => [conversationId, '20000000-0000-4000-8000-000000000001'],
      getBinding: (id: string) => repo.getBindingBySession(id),
      getRootBinding: () => repo.defaultBinding(),
      hasProject: () => false,
      lookupSession: () => 'not_found' as const,
      publication: (conversation: string, id: string) => ledger.get(conversation, id),
      sourceSession: () => undefined,
      append: async (input: unknown) => {
        await hold;
        if (failWrite) throw Error('writer failed');
        const receipt = ledger.append(input);
        if (receipt.accepted) events.push({ type: 'persisted' });
        return receipt;
      },
      speech: (id: string, version: string, text?: string) => speech.publish(id, version, text),
      notify: () => {
        events.push({ type: 'publication' });
      },
      artifact: () => null,
    };
    const registry = createOperationRegistry([
      ...speech.operations,
      createNeoPublicationOperation(createNeoPublisher(runtime)),
    ]);
    const mcp = createOperationMcpHandler(registry, () => caller);
    send = async (input = draft) =>
      JSON.parse((await mcp({ name: 'neo.publication.publish', input })).content[0].text);
    listen = async (enabled, clientId = 'phone') => {
      expect(
        await invokeOperation(
          registry,
          'neo.speech.listen',
          { sessionId, enabled },
          {
            source: 'rpc',
            principal: 'local',
            clientId,
            device: { deviceId: `synthetic-${clientId}`, kind: 'human' },
          }
        )
      ).toMatchObject({ kind: 'completed', value: { ok: true } });
    };
  });
  afterEach(async () => {
    await speech.dispose();
    hub.cleanup();
    mailbox.close();
  });

  test('cases 2/3/8: a live result or quick answer speaks once for several inputs, before text notification', async () => {
    await listen(true);
    const input = speech.prepareInput(sessionId, {
      content: 'Quick question',
      inputKind: 'human',
      sendStatus: 'enqueued',
    });
    expect(input.content).toContain('For a quick answer, publish with spoken');
    expect(await send()).toMatchObject({ accepted: true, listening: 'yes', spokenDelivered: true });
    expect(events.map((e) => e.type)).toEqual(['persisted', 'say', 'publication']);
    expect(events[1]).toMatchObject({ client: 'phone', text: draft.spoken });
    expect(ledger.list(conversationId)[0].replyTo).toHaveLength(2);
    expect(JSON.stringify(ledger.list(conversationId))).not.toContain(draft.spoken);
  });

  test('cases 1/11: no listener silently drops speech; retries after enable never replay it', async () => {
    expect(await send()).toMatchObject({ accepted: true, listening: 'no', spokenDelivered: false });
    await listen(true);
    expect(await send()).toMatchObject({
      accepted: true,
      created: false,
      listening: 'yes',
      spokenDelivered: false,
    });
    expect(events.filter((e) => e.type === 'say')).toHaveLength(0);
  });

  test('case 11: successful retries and listener reconnects never replay speech', async () => {
    await listen(true);
    await send();
    await listen(false);
    await listen(true);
    expect(await send()).toMatchObject({ accepted: true, created: false, spokenDelivered: false });
    expect(events.filter((e) => e.type === 'say')).toHaveLength(1);
  });

  test('case 11: concurrent publication retries speak only the committed first version', async () => {
    await listen(true);
    const receipts = await Promise.all([send(), send()]);
    expect(receipts.map((r) => r.spokenDelivered).sort()).toEqual([false, true]);
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(events.filter((e) => e.type === 'say')).toHaveLength(1);
  });

  test('case 7: enable during append is reflected in the receipt, with one fallback and no republish on retry', async () => {
    let release = () => {};
    hold = new Promise<void>((done) => {
      release = done;
    });
    const pending = send({ ...draft, spoken: undefined });
    await listen(true);
    release();
    const receipt = await pending;
    expect(receipt).toMatchObject({ accepted: true, listening: 'yes', spokenDelivered: false });
    expect(receipt.guidance).toContain('neo.speech.say');
    expect(receipt.guidance).toContain('never re-publish');
    expect((await send({ ...draft, spoken: undefined })).guidance).not.toContain('neo.speech.say');
  });

  test('case 5: disabling during append drops a stale spoken draft', async () => {
    await listen(true);
    let release = () => {};
    hold = new Promise<void>((done) => {
      release = done;
    });
    const pending = send();
    await listen(false);
    release();
    expect(await pending).toMatchObject({
      accepted: true,
      listening: 'no',
      spokenDelivered: false,
    });
    expect(events.filter((e) => e.type === 'say')).toHaveLength(0);
  });

  test('case 9: only the last enabled client receives the publication speech', async () => {
    await listen(true);
    await listen(true, 'web');
    await listen(false);
    await send();
    expect(events.filter((e) => e.type === 'say').map((e) => e.client)).toEqual(['web']);
  });

  test('conflicts and writer errors cannot speak unpublished content', async () => {
    await listen(true);
    await send();
    events = [];
    expect(await send({ ...draft, details: 'Conflicting result.' })).toMatchObject({
      accepted: false,
      reason:
        'publication_conflict: This publication id already holds different content. Keep its stored fields, or use a different publicationId.',
    });
    expect(events).toEqual([]);
    failWrite = true;
    const failed = await send({ ...draft, requestId: 'failed' });
    expect(failed.accepted).not.toBe(true);
    expect(events).toEqual([]);
  });

  test('a card reply with text alone stores a summary instead of verbatim', async () => {
    mailbox.db
      .prepare(
        "INSERT INTO neo_questions(id,ask_id,text,kind,start_todos,created_at) VALUES ('question','ask','Review?','choice','[]',1)"
      )
      .run();
    const cardReply = {
      askId: 'ask',
      questionId: 'question',
      mutationId: '30000000-0000-4000-8000-000000000009',
      sourceMessageIds: [conversationId],
    };
    const { details: _details, spoken: _spoken, ...textOnly } = draft;
    expect(await send({ ...textOnly, requestId: 'card-text-only', cardReply })).toMatchObject({
      accepted: true,
    });
    expect(ledger.list(conversationId)![0]).toMatchObject({
      shortText: 'Ready',
      fullText: 'Ready',
      cardReply,
    });
    const long = Array(61).fill('word').join(' ');
    for (const [requestId, text, details] of [
      ['card-text-over', long, undefined],
      ['card-folded-over', long, 'd'.repeat(200)],
    ] as const) {
      const refused = await send({ ...textOnly, requestId, text, details, cardReply });
      expect(refused).toMatchObject({ accepted: false });
      expect(String(refused.reason)).toContain('reply_needs_details');
      expect(String(refused.reason)).toContain('the rest in details');
    }
    expect(ledger.list(conversationId)).toHaveLength(1);
  });

  test('new card versions speak once; retries of older versions never speak the latest content', async () => {
    mailbox.db
      .prepare(
        "INSERT INTO neo_questions(id,ask_id,text,kind,start_todos,created_at) VALUES ('question','ask','Review?','choice','[]',1)"
      )
      .run();
    const cardReply = {
      askId: 'ask',
      questionId: 'question',
      mutationId: '30000000-0000-4000-8000-000000000001',
      sourceMessageIds: [conversationId],
    };
    await listen(true);
    const first = await send({ ...draft, cardReply });
    const next = await send({
      ...draft,
      requestId: 'revision',
      cardReply,
      details: 'Updated result.',
      spoken: 'The updated result.',
    });
    expect(first).toMatchObject({ accepted: true, spokenDelivered: true });
    expect(next).toMatchObject({ accepted: true, created: false, spokenDelivered: true });
    expect(await send({ ...draft, cardReply })).toMatchObject({
      accepted: true,
      spokenDelivered: false,
    });
    const spoken = events.filter((e) => e.type === 'say');
    expect(spoken.map((e) => e.text)).toEqual([draft.spoken, 'The updated result.']);
    expect(spoken[0].id).not.toBe(spoken[1].id);
  });

  test('a later card reply version retains its handoff and retries preserve the original identity', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reply-handoff-')));
    const previous = process.env.HYPERNEO_DATA_DIR;
    process.env.HYPERNEO_DATA_DIR = dir;
    try {
      const drafts = join(dir, 'handoffs', 'worker', 'drafts');
      mkdirSync(drafts, { recursive: true });
      writeFileSync(join(drafts, 'report.md'), '# Synthetic report\n');
      const snapshot = await publishHandoff(dir, 'worker', 'report.md');
      if (snapshot.kind !== 'published') throw new Error('publish failed');
      const reference = publicHandoffReference(snapshot.reference);
      mailbox.db
        .prepare(
          "INSERT INTO neo_questions(id,ask_id,text,kind,start_todos,created_at) VALUES ('question','ask','Review?','choice','[]',1)"
        )
        .run();
      const cardReply = {
        askId: 'ask',
        questionId: 'question',
        mutationId: '30000000-0000-4000-8000-000000000001',
        sourceMessageIds: [conversationId],
      };
      expect(await send({ ...draft, cardReply })).toMatchObject({ accepted: true });
      const updated = await send({
        ...draft,
        requestId: 'revision-attachment',
        cardReply,
        details: 'Updated.',
        artifacts: [reference],
      });
      expect(updated).toMatchObject({ accepted: true, publication: { artifacts: [reference] } });
      expect(ledger.list(conversationId)[0].artifacts).toEqual([reference]);
      expect(await send({ ...draft, cardReply })).toMatchObject({ accepted: true, created: false });
      expect(
        await send({
          ...draft,
          requestId: 'remove-attachment',
          cardReply,
          details: 'Another update.',
          artifacts: [],
        })
      ).toMatchObject({
        accepted: false,
        reason:
          'publication_conflict: This publication id already holds different content. Keep its stored fields, or use a different publicationId.',
      });
      expect(ledger.list(conversationId)[0].artifacts).toEqual([reference]);
    } finally {
      if (previous === undefined) delete process.env.HYPERNEO_DATA_DIR;
      else process.env.HYPERNEO_DATA_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('speech infrastructure failure still notifies the saved text and cannot cause retry replay', async () => {
    await listen(true);
    failSpeech = true;
    expect(await send()).toMatchObject({ accepted: true, spokenDelivered: false });
    expect(events.map((e) => e.type)).toEqual(['persisted', 'publication']);
    failSpeech = false;
    expect(await send()).toMatchObject({ accepted: true, created: false, spokenDelivered: false });
    expect(events.filter((e) => e.type === 'say')).toHaveLength(0);
  });

  test('overlong speech is refused before saving', async () => {
    expect(await send({ ...draft, spoken: 'x'.repeat(501) })).toMatchObject({
      code: 'invalid_input',
    });
    expect(ledger.list(conversationId)).toHaveLength(0);
  });
});
