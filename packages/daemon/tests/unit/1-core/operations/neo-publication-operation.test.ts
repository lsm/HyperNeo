import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  createNeoAskOriginResolver,
  type NeoAskOrigin,
} from '../../../../src/lib/neo/ask-origin.ts';
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
import { requirePublicationNews } from '../../../../src/lib/neo/publication-news.ts';
import {
  neoInputTrigger,
  neoTriggerMessageId,
  requirePublicationTrigger,
} from '../../../../src/lib/neo/notification-triggers.ts';
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
const root = { sessionId: `neo:${conversationId}`, kind: 'neo' as const, projectId: null };
const holder = { sessionId: 'holder:a', kind: 'project' as const, projectId: 'a' };
const ask = { sessionId: root.sessionId, messageId: 'ask-original' };
const draft = {
  publicationId: '20000000-0000-4000-8000-000000000001',
  shortText: 'Ready. View comparison.',
  fullText: '**Two differences** need a closer look. Nothing was published.',
  links: [],
};
const caller = (sessionId = root.sessionId, messageId = ask.messageId, human = true) => ({
  source: 'mcp' as const,
  sessionId,
  role: 'neo' as const,
  neoTurn: { messageId, human, isLive: () => true },
});
const consultCaller = (id: string): OperationCaller => ({
  ...caller(holder.sessionId, `neo-consult:${id}:request`, false),
  neoTurn: {
    messageId: `neo-consult:${id}:request`,
    consultationId: id,
    human: false,
    isLive: () => true,
  },
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
  const stamps = new Map<string, NeoAskOrigin>();
  function consultation(
    id = 'consult:1',
    messageId = ask.messageId,
    projectId = 'a',
    sessionId = holder.sessionId
  ) {
    const item = consultations.reserve({
      id,
      requestKey: id,
      projectId,
      originSessionId: root.sessionId,
      originMessageId: messageId,
      sessionId,
      question: 'Compare fictional sources',
    })!;
    stamps.set(`${sessionId}\0neo-consult:${id}:request`, {
      sessionId: root.sessionId,
      messageId,
    });
    return item;
  }
  function work(id = 'work:1', messageId = ask.messageId, projectId = 'a') {
    return repo.proposeWork({
      id,
      requestKey: id,
      projectId,
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
    stamps.clear();
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration279(mailbox.db);
    runMigration282(mailbox.db);
    runMigration283(mailbox.db);
    runMigration288(mailbox.db);
    repo = new NeoRepository(mailbox.db);
    consultations = new NeoConsultationRepository(mailbox.db, () => {});
    ledger = new NeoPublicationRepository(mailbox.db);
    for (const id of ['a', 'b']) repo.saveProject({ id, title: id, summary: '', context: '' }, 0);
    for (const binding of [
      root,
      holder,
      { sessionId: 'holder:b', kind: 'project' as const, projectId: 'b' },
      { sessionId: 'worker', kind: 'worker' as const, projectId: 'a' },
    ]) {
      mailbox.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(binding.sessionId);
      repo.reserveBinding(binding);
    }
    prompt(ask.sessionId, ask.messageId);
    const resolve = createNeoAskOriginResolver({
      getBinding: (id) => repo.getBindingBySession(id),
      getPrompts: (sessionId, messageId) =>
        mailbox.sdkMessageRepo.getStoredPromptsByUuid(sessionId, messageId),
      getStamp: (sessionId, messageId) => stamps.get(`${sessionId}\0${messageId}`) ?? null,
    });
    notify = vi.fn();
    runtime = {
      getBinding: (id) => repo.getBindingBySession(id),
      getRootBinding: () => repo.getBindingForProject(null),
      hasProject: (id) => !!repo.getProject(id),
      getWork: (id) => repo.getWork(id),
      getConsultation: (id) => consultations.get(id),
      resolveAskOrigin: resolve,
      append: (input) => ledger.append(input),
      isHumanInput: (input) =>
        mailbox.sdkMessageRepo
          .getStoredPromptsByUuid(input.sessionId, input.messageId)
          .some((message) => 'inputKind' in message && message.inputKind === 'human'),
      isTriggerPublished: (conversationId, triggerId, publicationId) =>
        ledger.hasTrigger(conversationId, triggerId, publicationId),
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
        publication: {
          ...draft,
          conversationId,
          askOrigin: ask,
          producerInput: ask,
          triggerId: `human:${ask.messageId}`,
          sequence: 1,
        },
      },
    });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(mailbox.sdkRows()).toEqual(before);
    expect(mailbox.rowCount()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('a publication with no links array publishes with none', async () => {
    const { links: _links, ...unlinked } = draft;
    expect(await invoke(unlinked)).toMatchObject({
      value: { accepted: true, publication: { links: [] } },
    });
  });

  test('holder publication resolves the original ask, never a newer unrelated ask', async () => {
    const item = consultation();
    const input = `neo-consult:${item.id}:request`;
    prompt(holder.sessionId, input, 'system');
    prompt(root.sessionId, 'newer-ask');
    expect(await invoke(draft, consultCaller(item.id))).toMatchObject({
      value: {
        accepted: true,
        publication: {
          askOrigin: ask,
          producerInput: { sessionId: holder.sessionId, messageId: input },
          triggerId: `human:${ask.messageId}`,
        },
      },
    });
    expect(ledger.list(conversationId)![0].askOrigin).toEqual(ask);
  });

  test('a returned-work note is not a trigger, so its publication is refused with a reason', async () => {
    const item = work();
    repo.transitionWork(item.id, item, { status: 'reported', report: 'Reported context only' });
    prompt(root.sessionId, item.id, 'system');
    stamps.set(`${root.sessionId}\0${item.id}`, ask);
    expect(await invoke(draft, caller(root.sessionId, item.id, false))).toMatchObject({
      value: {
        accepted: false,
        reason: 'no_trigger',
        detail: expect.stringContaining('End the turn'),
      },
    });
    expect(ledger.list(conversationId)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  test('a trigger note turn publishes once under its trigger id, and the same transition never posts twice', () => {
    const triggerId = 'outcome:ask-1:abc';
    const note = neoTriggerMessageId(triggerId);
    prompt(root.sessionId, note, 'system');
    stamps.set(`${root.sessionId}\0${note}`, ask);
    expect(publish({ ...draft, triggerId }, caller(root.sessionId, note, false))).toMatchObject({
      accepted: true,
      publication: { triggerId, producerInput: { sessionId: root.sessionId, messageId: note } },
    });
    expect(
      publish(
        { ...draft, publicationId: '20000000-0000-4000-8000-000000000002' },
        caller(root.sessionId, note, false)
      )
    ).toMatchObject({ accepted: false, reason: 'trigger_already_published' });
    expect(
      ledger.append({
        ...draft,
        publicationId: '20000000-0000-4000-8000-000000000099',
        conversationId,
        askOrigin: ask,
        producerInput: { sessionId: root.sessionId, messageId: `${note}:again` },
        triggerId,
      })
    ).toEqual({ accepted: false, reason: 'trigger_already_published' });
    expect(ledger.list(conversationId)).toHaveLength(1);
  });

  test('a cross-project return answers the human message that started it, once', () => {
    const reply = 'neo-cross-project:group-1:reply';
    prompt(root.sessionId, reply, 'system');
    stamps.set(`${root.sessionId}\0${reply}`, ask);
    expect(publish(draft, caller(root.sessionId, reply, false))).toMatchObject({
      accepted: true,
      publication: { triggerId: `human:${ask.messageId}` },
    });
    expect(
      publish({ ...draft, publicationId: '20000000-0000-4000-8000-000000000002' }, caller())
    ).toMatchObject({ accepted: false, reason: 'trigger_already_published' });
  });

  test('a returned consultation answers the human message that asked it, but not a note', () => {
    const reply = 'neo-consult:consult:1:reply';
    prompt(root.sessionId, reply, 'system');
    stamps.set(`${root.sessionId}\0${reply}`, ask);
    expect(publish(draft, caller(root.sessionId, reply, false))).toMatchObject({
      accepted: true,
      publication: { triggerId: `human:${ask.messageId}` },
    });
    const noted = 'neo-consult:consult:2:reply';
    prompt(root.sessionId, 'note-1', 'system');
    prompt(root.sessionId, noted, 'system');
    stamps.set(`${root.sessionId}\0${noted}`, { sessionId: root.sessionId, messageId: 'note-1' });
    expect(
      publish(
        { ...draft, publicationId: '20000000-0000-4000-8000-000000000004' },
        caller(root.sessionId, noted, false)
      )
    ).toMatchObject({ accepted: false, reason: 'no_trigger' });
  });

  test('refuses a triggerId that is not this turn’s trigger', () => {
    expect(publish({ ...draft, triggerId: 'outcome:other:1' }, caller())).toMatchObject({
      accepted: false,
      reason: 'wrong_trigger',
    });
    expect(ledger.list(conversationId)).toEqual([]);
  });

  test('refuses an interim status post even on a human turn', () => {
    expect(publish({ ...draft, interim: true }, caller())).toMatchObject({
      accepted: false,
      reason: 'interim_refused',
    });
    expect(publish(draft, caller())).toMatchObject({ accepted: true });
  });

  test('a publish nudge answers the human message it nudges, under that message’s trigger', () => {
    const nudge = `neo-nudge:${ask.messageId}`;
    prompt(root.sessionId, nudge, 'system');
    stamps.set(`${root.sessionId}\0${nudge}`, ask);
    expect(publish(draft, caller(root.sessionId, nudge, false))).toMatchObject({
      accepted: true,
      publication: { triggerId: `human:${ask.messageId}` },
    });
    expect(
      publish({ ...draft, publicationId: '20000000-0000-4000-8000-000000000002' }, caller())
    ).toMatchObject({ accepted: false, reason: 'trigger_already_published' });
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

  test('one reply per human message: a bare acknowledgement and a second reply are refused', () => {
    const id = (n: number) => `20000000-0000-4000-8000-00000000010${n}`;
    expect(
      publish({ ...draft, publicationId: id(1), shortText: '收到。', fullText: '收到。' }, caller())
    ).toMatchObject({ accepted: false, reason: 'empty_acknowledgement' });
    expect(publish({ ...draft, publicationId: id(2) }, caller())).toMatchObject({ accepted: true });
    expect(
      publish({ ...draft, publicationId: id(3), shortText: 'One more thing.' }, caller())
    ).toMatchObject({
      accepted: false,
      reason: 'trigger_already_published',
      detail: expect.stringContaining('told once'),
    });
    expect(publish({ ...draft, publicationId: id(2) }, caller())).toMatchObject({
      accepted: true,
      created: false,
    });
    expect(ledger.list(conversationId)).toHaveLength(1);
    prompt(root.sessionId, 'next-ask');
    expect(
      publish({ ...draft, publicationId: id(4) }, caller(root.sessionId, 'next-ask'))
    ).toMatchObject({ accepted: true });
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

  test('a trigger note turn records its trigger, and the same transition never posts twice', () => {
    const triggerId = 'outcome:ask-1:abc';
    const note = `neo-trigger:${triggerId}`;
    prompt(root.sessionId, note, 'system');
    stamps.set(`${root.sessionId}\0${note}`, ask);
    const who = {
      ...caller(root.sessionId, note),
      neoTurn: { ...caller().neoTurn, messageId: note },
    };
    expect(publish({ ...draft, triggerId }, who)).toMatchObject({
      accepted: true,
      publication: { triggerId },
    });
    expect(
      publish({ ...draft, publicationId: '20000000-0000-4000-8000-000000000002' }, who)
    ).toMatchObject({ accepted: false, reason: 'trigger_already_published' });
    expect(ledger.list(conversationId)).toHaveLength(1);
  });

  test('a human reply records its human trigger, and a triggerId it names is refused', () => {
    expect(publish(draft, caller())).toMatchObject({ accepted: true });
    expect(ledger.list(conversationId)![0].triggerId).toBe('human:ask-original');
    expect(
      publish(
        {
          ...draft,
          publicationId: '20000000-0000-4000-8000-000000000003',
          triggerId: 'outcome:x:1',
        },
        caller()
      )
    ).toMatchObject({ accepted: false, reason: 'wrong_trigger' });
  });

  test('preserves arbitrary authored labels and validates actual work/consultation ownership', async () => {
    work();
    consultation();
    const links = [
      { label: '看看对比', kind: 'work', id: 'work:1' },
      { label: 'Context check', kind: 'consultation', id: 'consult:1' },
      { label: 'More about A', kind: 'project', id: 'a' },
    ];
    expect(await invoke({ ...draft, links })).toMatchObject({
      value: { accepted: true, publication: { links } },
    });
    expect(ledger.list(conversationId)![0].links).toEqual(links);
  });

  test.each(['unknown', 'foreign-ask', 'foreign-project', 'unsafe-kind'])(
    'rejects %s scene refs, without partial publication',
    async (kind) => {
      consultation();
      const input = 'neo-consult:consult:1:request';
      prompt(holder.sessionId, input, 'system');
      work(
        'work:1',
        kind === 'foreign-ask' ? 'other-ask' : ask.messageId,
        kind === 'foreign-project' ? 'b' : 'a'
      );
      prompt(root.sessionId, 'other-ask');
      const link = {
        label: 'Open',
        kind: kind === 'unsafe-kind' ? 'url' : 'work',
        id: kind === 'unknown' ? 'missing' : 'work:1',
      };
      const result = await invoke({ ...draft, links: [link] }, caller(holder.sessionId, input));
      const detail = {
        unknown:
          'work link "missing" does not exist; link only Neo project, work or consultation ids, never work.find refs or session ids',
        'foreign-ask':
          'work link "work:1" was not started for this ask; link only work or consultations this ask created',
        'foreign-project': 'work link "work:1" belongs to another project',
      }[kind];
      expect(result).toMatchObject(
        kind === 'unsafe-kind'
          ? { kind: 'failed', code: 'invalid_input' }
          : { value: { accepted: false, reason: 'invalid_scene_reference', detail } }
      );
      expect(ledger.list(conversationId)).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
    }
  );

  test('holder cannot link another project even when the project exists', () => {
    prompt(holder.sessionId, 'holder-human');
    expect(
      publish(
        { ...draft, links: [{ label: 'Other', kind: 'project', id: 'b' }] },
        caller(holder.sessionId, 'holder-human')
      )
    ).toEqual({
      accepted: false,
      reason: 'invalid_scene_reference',
      detail: 'project link "b" belongs to another project',
    });
  });

  test.each(['pending', 'reported', 'failed', 'expired'] as const)(
    'pins %s runtime-bound holder consultation admission',
    (status) => {
      const item = consultation();
      const input = `neo-consult:${item.id}:request`;
      prompt(holder.sessionId, input, 'system');
      const who = consultCaller(item.id);
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
      requirePublicationLinks(proof, [{ link, exists: true, projectId: 'a', origin: ask }])
    ).toEqual({ value: proof });
    expect(
      requirePublicationLinks(proof, [
        { link, exists: true, projectId: 'a', origin: { ...ask, messageId: 'foreign' } },
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
        links: Array.from({ length: 17 }, () => ({ label: 'Open', kind: 'project', id: 'a' })),
      })
    ).toHaveProperty('reason.reason', 'invalid_publication');
  });
});

describe('requirePublicationNews', () => {
  const reply = { publicationId: 'p1', shortText: 'Merged #12.', fullText: 'Merged #12 to dev.' };

  test.each(['收到。', '我听到了。', 'Got it!', 'ok'])(
    'refuses the bare acknowledgement %s',
    (text) => {
      expect(
        requirePublicationNews('v', { ...reply, shortText: text, fullText: text })
      ).toMatchObject({ reason: { reason: 'empty_acknowledgement' } });
    }
  );

  test.each([
    ['收到。', 'Got it.'],
    ['👍', '👍'],
  ])('refuses %s with full text %s', (shortText, fullText) => {
    expect(requirePublicationNews('v', { ...reply, shortText, fullText })).toMatchObject({
      reason: { reason: 'empty_acknowledgement' },
    });
  });

  test.each([
    '我先核对一下 HyperNeo 目前开放的事项，再给你整理。',
    '稍等，我查一下。',
    '正在确认 Slice 6 的状态。',
    'Let me check what is open on HyperNeo.',
    "I'll look into it and get back to you.",
    'Checking now…',
    '我再向 HyperNeo 当前负责会话核对开放事项，拿到清单后直接发给你。',
    'I will ask the HyperNeo holder to verify the list and get back to you.',
  ])('refuses the checking-only post %s', (text) => {
    expect(
      requirePublicationNews('v', { ...reply, shortText: text, fullText: text })
    ).toMatchObject({ reason: { reason: 'interim_refused' } });
  });

  test.each([
    '查到了：HyperNeo 有两张卡在等你。',
    '我查到了：Slice 6 还在等你审批。',
    '我检查了一下，CI 失败了。',
    '我确认了，#12 已合并。',
    '我先确认好了：两张卡在等你。',
    'PR #12 已开，合并后告诉你。',
    "Let me check what's open: Slice 1 and Slice 6.",
    '我先核对一下：两张卡在等你。',
    '我再给你确认一下范围：Slice 1 到 Slice 6',
    '看起来 Slice 6 还在等你决定。',
    'Checked: two cards are waiting on you.',
  ])('keeps the answer %s', (text) => {
    expect(requirePublicationNews('v', { ...reply, shortText: text, fullText: text })).toEqual({
      value: 'v',
    });
  });

  test('keeps a reply whose full text carries the answer after a checking lead', () => {
    expect(
      requirePublicationNews('v', {
        ...reply,
        shortText: 'Let me check.',
        fullText: 'Two cards are open on HyperNeo: Slice 1 needs approval and Slice 6 needs you.',
      })
    ).toEqual({ value: 'v' });
  });

  test('keeps an acknowledgement that carries details', () => {
    expect(requirePublicationNews('v', { ...reply, shortText: '收到。' })).toEqual({
      value: 'v',
    });
  });
});

describe('neoInputTrigger', () => {
  test.each([
    ['m1', true, 'human:m1'],
    ['m1', false, null],
    ['neo-trigger:action:a:1', false, 'action:a:1'],
    ['neo-nudge:m1', false, 'human:m1'],
    ['neo-forward:m1:0', false, 'human:m1'],
    ['neo-nudge:neo-forward:m1:0', false, 'human:m1'],
    ['work-1:done-check:0', false, null],
  ] as const)('maps input %s (human %s) to trigger %s', (messageId, human, trigger) => {
    expect(neoInputTrigger(messageId, human)).toBe(trigger);
  });
});

describe('requirePublicationTrigger', () => {
  test('stamps the turn trigger and refuses a turn without one', () => {
    expect(requirePublicationTrigger({ a: 1 }, {}, 'human:m1')).toEqual({
      value: { a: 1, triggerId: 'human:m1' },
    });
    expect(requirePublicationTrigger({ a: 1 }, {}, null)).toHaveProperty(
      'reason.reason',
      'no_trigger'
    );
  });
});
