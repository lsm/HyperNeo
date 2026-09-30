import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { createNeoAskOriginResolver } from '../../../../src/lib/neo/ask-origin.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  admitPublicationDraft,
  createNeoPublicationOperation,
  createNeoPublisher,
  requirePublicationAsk,
  requirePublicationProducer,
  requirePublicationLinks,
  requirePublicationLifetime,
} from '../../../../src/lib/neo/publication-operation.ts';
import type { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoConsultationRepository } from '../../../../src/storage/repositories/neo-consultation-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration282 } from '../../../../src/storage/schema/m282-neo-consultation-origins.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration288 } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = { sessionId: `neo:${conversationId}`, kind: 'neo' as const, concernId: null };
const holder = { sessionId: 'holder:a', kind: 'concern' as const, concernId: 'a' };
const ask = { sessionId: root.sessionId, messageId: 'ask-original' };
const draft = {
  publicationId: '20000000-0000-4000-8000-000000000001',
  shortText: 'Ready. View comparison.',
  fullText: '**Two differences** need a closer look. Nothing was published.',
  links: [],
};
const caller = (sessionId = root.sessionId, messageId = ask.messageId) => ({
  source: 'mcp' as const,
  sessionId,
  role: 'neo' as const,
  neoTurn: { messageId, human: false, isLive: () => true },
});

describe('runtime-bound publication operation', () => {
  let mailbox: MailboxTestDb;
  let repo: NeoRepository;
  let consultations: NeoConsultationRepository;
  let ledger: NeoPublicationRepository;
  let runtime: Parameters<typeof createNeoPublisher>[0];
  let publish: ReturnType<typeof createNeoPublisher>;
  let notify: ReturnType<typeof vi.fn>;
  function prompt(sessionId: string, messageId: string, inputKind = 'human') {
    expect(
      mailbox.sdkMessageRepo.saveSDKMessage(sessionId, {
        type: 'user',
        uuid: messageId,
        session_id: sessionId,
        parent_tool_use_id: null,
        inputKind,
        message: { role: 'user', content: [{ type: 'text', text: 'Fictional immutable input' }] },
      } as SDKUserMessage)
    ).toBe(true);
  }
  function consultation(
    id = 'consult:1',
    messageId = ask.messageId,
    concernId = 'a',
    sessionId = holder.sessionId
  ) {
    return consultations.reserve({
      id,
      requestKey: id,
      concernId,
      originSessionId: root.sessionId,
      originMessageId: messageId,
      sessionId,
      question: 'Compare fictional sources',
    })!;
  }
  function work(id = 'work:1', messageId = ask.messageId, concernId = 'a') {
    return repo.proposeWork({
      id,
      requestKey: id,
      concernId,
      originSessionId: root.sessionId,
      originMessageId: messageId,
      title: 'Comparison',
      instruction: 'Keep it as a draft',
    });
  }
  function invoke(input: unknown = draft, who: OperationCaller = caller()) {
    return invokeOperation(
      createOperationRegistry([createNeoPublicationOperation(publish)]),
      'neo.publication.publish',
      input,
      who
    );
  }
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration279(mailbox.db);
    runMigration282(mailbox.db);
    runMigration283(mailbox.db);
    runMigration288(mailbox.db);
    repo = new NeoRepository(mailbox.db);
    consultations = new NeoConsultationRepository(mailbox.db, () => {});
    ledger = new NeoPublicationRepository(mailbox.db);
    for (const id of ['a', 'b']) repo.saveConcern({ id, title: id, summary: '', context: '' }, 0);
    for (const binding of [
      root,
      holder,
      { sessionId: 'holder:b', kind: 'concern' as const, concernId: 'b' },
      { sessionId: 'worker', kind: 'worker' as const, concernId: 'a' },
    ]) {
      mailbox.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(binding.sessionId);
      repo.reserveBinding(binding);
    }
    prompt(ask.sessionId, ask.messageId);
    const resolve = createNeoAskOriginResolver({
      getBinding: (id) => repo.getBindingBySession(id),
      getRootBinding: () => repo.getBindingForConcern(null),
      getPrompts: (sessionId, messageId) =>
        mailbox.sdkMessageRepo.getStoredPromptsByUuid(sessionId, messageId),
      getConsultation: (id) => consultations.get(id),
      getWork: (id) => repo.getWork(id),
    });
    notify = vi.fn();
    runtime = {
      getBinding: (id) => repo.getBindingBySession(id),
      getRootBinding: () => repo.getBindingForConcern(null),
      hasConcern: (id) => !!repo.getConcern(id),
      getWork: (id) => repo.getWork(id),
      getConsultation: (id) => consultations.get(id),
      resolveAskOrigin: resolve,
      append: (input) => ledger.append(input),
      notify,
    };
    publish = createNeoPublisher(runtime);
  });
  afterEach(() => mailbox.close());

  test('registers in the real family and persists authored content with runtime-derived identity', async () => {
    const service = {
      repo,
      publish,
      db: { getDatabase: () => mailbox.db },
    } as unknown as NeoService;
    const registry = createOperationRegistry(createNeoOperations(service));
    const before = mailbox.sdkRows();
    const result = await invokeOperation(registry, 'neo.publication.publish', draft, caller());
    expect(result).toMatchObject({
      kind: 'completed',
      value: {
        accepted: true,
        created: true,
        publication: { ...draft, conversationId, askOrigin: ask, producerInput: ask, sequence: 1 },
      },
    });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(mailbox.sdkRows()).toEqual(before);
    expect(mailbox.rowCount()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('holder publication resolves the original ask, never a newer unrelated ask', async () => {
    const item = consultation();
    const input = `neo-consult:${item.id}:request`;
    prompt(holder.sessionId, input, 'system');
    prompt(root.sessionId, 'newer-ask');
    expect(await invoke(draft, caller(holder.sessionId, input))).toMatchObject({
      value: {
        accepted: true,
        publication: {
          askOrigin: ask,
          producerInput: { sessionId: holder.sessionId, messageId: input },
        },
      },
    });
    expect(ledger.list(conversationId)![0].askOrigin).toEqual(ask);
  });

  test('work-return publication resolves the immutable original input without an avatar authority flag', async () => {
    const item = work();
    repo.transitionWork(item.id, item, { status: 'reported', report: 'Reported context only' });
    prompt(root.sessionId, item.id, 'system');
    expect(await invoke(draft, caller(root.sessionId, item.id))).toMatchObject({
      value: {
        accepted: true,
        publication: {
          askOrigin: ask,
          producerInput: { sessionId: root.sessionId, messageId: item.id },
        },
      },
    });
  });

  test.each([
    { source: 'rpc', principal: 'local' },
    { source: 'internal' },
    { source: 'mcp', role: 'neo', sessionId: 'worker' },
    { source: 'mcp', role: 'neo', sessionId: 'ordinary' },
    { source: 'mcp', role: 'neo', sessionId: root.sessionId },
  ] satisfies OperationCaller[])('refuses a nonlive/nonavatar publisher: %j', async (who) => {
    expect(await invoke(draft, who)).toMatchObject({
      value: { accepted: false, reason: 'live_avatar_required' },
    });
    expect(ledger.list(conversationId)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  test.each(['missing', 'system', 'dead', 'wrong-session'])(
    'refuses %s producer evidence before any append',
    async (kind) => {
      const who = caller(root.sessionId, 'unrecorded');
      if (kind === 'system') prompt(root.sessionId, 'unrecorded', 'system');
      if (kind === 'dead') who.neoTurn!.isLive = () => false;
      if (kind === 'wrong-session') prompt(holder.sessionId, 'unrecorded');
      expect(await invoke(draft, who)).toMatchObject({ value: { accepted: false } });
      expect(ledger.list(conversationId)).toEqual([]);
    }
  );

  test.each(['lifetime', 'input', 'binding', 'root'])(
    'rechecks %s at the synchronous append boundary',
    (change) => {
      const who = caller();
      const resolve = runtime.resolveAskOrigin;
      const read = runtime.getRootBinding;
      runtime.resolveAskOrigin = (input) => {
        const origin = resolve(input);
        if (change === 'lifetime') who.neoTurn!.isLive = () => false;
        if (change === 'input') who.neoTurn = { ...who.neoTurn!, messageId: 'new-input' };
        if (change === 'binding')
          mailbox.db
            .prepare('DELETE FROM neo_session_bindings WHERE session_id = ?')
            .run(root.sessionId);
        if (change === 'root')
          runtime.getRootBinding = () => ({ ...read()!, sessionId: 'neo:other' });
        return origin;
      };
      expect(publish(draft, who)).toEqual({ accepted: false, reason: 'publication_superseded' });
      expect(ledger.list(conversationId)).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
    }
  );

  test.each(['conversationId', 'askOrigin', 'producerInput', 'authority'])(
    'rejects injected %s rather than trusting payload provenance',
    async (field) => {
      expect(await invoke({ ...draft, [field]: ask })).toMatchObject({
        kind: 'failed',
        code: 'invalid_input',
      });
      expect(publish({ ...draft, [field]: ask }, caller())).toEqual({
        accepted: false,
        reason: 'invalid_publication',
      });
      expect(ledger.list(conversationId)).toEqual([]);
    }
  );

  test('identical retry returns the original durable receipt, conflict cannot rewrite it', () => {
    const first = publish(draft, caller());
    expect(first).not.toBeInstanceOf(Promise);
    expect(publish(draft, caller())).toEqual({ ...first, created: false });
    expect(publish({ ...draft, shortText: 'Other' }, caller())).toEqual({
      accepted: false,
      reason: 'publication_conflict',
    });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('one publication id cannot be replayed under a newer producer/ask tuple', () => {
    const first = publish(draft, caller());
    prompt(root.sessionId, 'other-ask');
    expect(publish(draft, caller(root.sessionId, 'other-ask'))).toEqual({
      accepted: false,
      reason: 'publication_conflict',
    });
    expect(first.accepted && ledger.list(conversationId)![0]).toEqual(
      first.accepted ? first.publication : false
    );
  });

  test('preserves arbitrary authored labels and validates actual work/consultation ownership', async () => {
    work();
    consultation();
    const links = [
      { label: '看看对比', kind: 'work', id: 'work:1' },
      { label: 'Context check', kind: 'consultation', id: 'consult:1' },
      { label: 'More about A', kind: 'concern', id: 'a' },
    ];
    expect(await invoke({ ...draft, links })).toMatchObject({
      value: { accepted: true, publication: { links } },
    });
    expect(ledger.list(conversationId)![0].links).toEqual(links);
  });

  test.each(['unknown', 'foreign-ask', 'foreign-concern', 'unsafe-kind'])(
    'rejects %s scene refs, without partial publication',
    async (kind) => {
      consultation();
      const input = 'neo-consult:consult:1:request';
      prompt(holder.sessionId, input, 'system');
      work(
        'work:1',
        kind === 'foreign-ask' ? 'other-ask' : ask.messageId,
        kind === 'foreign-concern' ? 'b' : 'a'
      );
      prompt(root.sessionId, 'other-ask');
      const link = {
        label: 'Open',
        kind: kind === 'unsafe-kind' ? 'url' : 'work',
        id: kind === 'unknown' ? 'missing' : 'work:1',
      };
      const result = await invoke({ ...draft, links: [link] }, caller(holder.sessionId, input));
      expect(result).toMatchObject(
        kind === 'unsafe-kind'
          ? { kind: 'failed', code: 'invalid_input' }
          : { value: { accepted: false, reason: 'invalid_scene_reference' } }
      );
      expect(ledger.list(conversationId)).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
    }
  );

  test('holder cannot link another concern even when the concern exists', () => {
    prompt(holder.sessionId, 'holder-human');
    expect(
      publish(
        { ...draft, links: [{ label: 'Other', kind: 'concern', id: 'b' }] },
        caller(holder.sessionId, 'holder-human')
      )
    ).toEqual({ accepted: false, reason: 'invalid_scene_reference' });
  });

  test.each(['pending', 'reported', 'failed', 'expired'] as const)(
    'pins %s runtime-bound holder consultation admission',
    (status) => {
      const item = consultation();
      const input = `neo-consult:${item.id}:request`;
      prompt(holder.sessionId, input, 'system');
      const who: OperationCaller = {
        ...caller(holder.sessionId, input),
        neoTurn: { messageId: input, consultationId: item.id, human: false, isLive: () => true },
      };
      const resolve = runtime.resolveAskOrigin;
      runtime.resolveAskOrigin = (origin) => {
        const answer = resolve(origin);
        mailbox.db
          .prepare('UPDATE neo_consultations SET status = ? WHERE id = ?')
          .run(status === 'expired' ? 'pending' : status, item.id);
        if (status === 'expired')
          mailbox.db
            .prepare('UPDATE neo_consultations SET created_at = 0 WHERE id = ?')
            .run(item.id);
        return answer;
      };
      const result = publish(draft, who);
      const accepted = status === 'pending' || status === 'reported';
      expect(result.accepted).toBe(accepted);
      expect(ledger.list(conversationId)).toHaveLength(accepted ? 1 : 0);
    }
  );

  test('pure link/lifetime gates refuse foreign evidence and superseded turns', () => {
    const who = caller();
    const producer = requirePublicationProducer(who, root, root);
    if (!('value' in producer)) throw new Error('Expected producer');
    const proof = { ...producer.value, ask };
    const link = { label: 'Open', kind: 'work' as const, id: 'work:1' };
    expect(
      requirePublicationLinks(proof, [{ link, exists: true, concernId: 'a', origin: ask }])
    ).toEqual({ value: proof });
    expect(
      requirePublicationLinks(proof, [
        { link, exists: true, concernId: 'a', origin: { ...ask, messageId: 'foreign' } },
      ])
    ).toHaveProperty('reason.reason', 'invalid_scene_reference');
    expect(requirePublicationLifetime(proof, who, root, root)).toEqual({ value: proof });
    expect(
      requirePublicationLifetime(proof, { ...who, neoTurn: undefined }, root, root)
    ).toHaveProperty('reason.reason', 'publication_superseded');
  });

  test('pure producer, draft and ask gates reject invalid evidence without consulting a database', () => {
    expect(requirePublicationProducer(caller(), root, root)).toHaveProperty('value.input', ask);
    expect(requirePublicationProducer(caller(), { ...root, kind: 'worker' }, root)).toHaveProperty(
      'reason.accepted',
      false
    );
    const admission = requirePublicationProducer(caller(), root, root);
    if (!('value' in admission)) throw new Error('Expected producer');
    expect(requirePublicationAsk(admission.value, null)).toHaveProperty(
      'reason.reason',
      'unknown_ask_origin'
    );
    expect(requirePublicationAsk(admission.value, ask)).toHaveProperty('value.ask', ask);
    expect(
      admitPublicationDraft({
        ...draft,
        links: Array.from({ length: 17 }, () => ({ label: 'Open', kind: 'concern', id: 'a' })),
      })
    ).toHaveProperty('reason.reason', 'invalid_publication');
  });
});
