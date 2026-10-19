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
import {
  type NeoDeliveryTrigger,
  neoDeliveryTrigger,
  neoHumanTrigger,
  requirePublicationTrigger,
} from '../../../../src/lib/neo/notification-triggers.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration288 } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = { sessionId: `neo:${conversationId}`, kind: 'neo' as const, projectId: null };
const holder = { sessionId: 'holder:a', kind: 'worker' as const, projectId: 'a' };
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
describe('runtime-bound publication operation', () => {
  let mailbox: MailboxTestDb;
  let repo: NeoRepository;
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
  const triggers = new Map<string, string | null>();
  const key = (input: NeoAskOrigin) => `${input.sessionId}\0${input.messageId}`;
  const isHuman = (input: NeoAskOrigin) =>
    mailbox.sdkMessageRepo
      .getStoredPromptsByUuid(input.sessionId, input.messageId)
      .some((message) => 'inputKind' in message && message.inputKind === 'human');
  const inputTrigger = (input: NeoAskOrigin): string | null =>
    triggers.get(key(input)) ?? (isHuman(input) ? neoHumanTrigger(input.messageId) : null);
  function stamp(input: NeoAskOrigin, parent: NeoAskOrigin, trigger: NeoDeliveryTrigger) {
    stamps.set(key(input), parent);
    triggers.set(
      key(input),
      neoDeliveryTrigger(trigger, () => inputTrigger(parent))
    );
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
    const { publicationId, ...authored } = input as { publicationId?: string };
    return invokeOperation(
      createOperationRegistry([createNeoPublicationOperation(publish)]),
      'neo.publication.publish',
      { ...authored, requestId: publicationId ?? 'send' },
      who
    );
  }
  beforeEach(() => {
    stamps.clear();
    triggers.clear();
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration283(mailbox.db);
    runMigration288(mailbox.db);
    repo = new NeoRepository(mailbox.db);
    ledger = new NeoPublicationRepository(mailbox.db);
    for (const id of ['a', 'b']) repo.saveProject({ id, title: id, summary: '', context: '' }, 0);
    for (const binding of [
      root,
      holder,
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
      getRootBinding: () => repo.defaultBinding(),
      hasProject: (id) => !!repo.getProject(id),
      getWork: (id) => repo.getWork(id),
      resolveAskOrigin: resolve,
      resolveHumanAskOrigin: (input) => {
        const origin = resolve(input);
        return origin && isHuman(origin) ? origin : null;
      },
      append: (input) => ledger.append(input),
      inputTrigger,
      isDeliveredHumanInput: (input) =>
        isHuman(input) &&
        mailbox.sdkMessageRepo.getUserSendStatus(input.sessionId, input.messageId) === 'consumed',
      notify,
    };
    const publishRaw = createNeoPublisher(runtime);
    publish = ((input: unknown, who: OperationCaller) => {
      const { publicationId, ...authored } = input as { publicationId?: string };
      return publishRaw({ ...authored, requestId: publicationId ?? 'send' }, who);
    }) as typeof publishRaw;
  });
  afterEach(() => mailbox.close());

  test('returns the answered human message and the delivered publication, without yielding', async () => {
    const yieldTurn = vi.fn();
    const who = caller();
    const result = await invoke(draft, { ...who, neoTurn: { ...who.neoTurn, yield: yieldTurn } });
    expect(result).toMatchObject({
      kind: 'completed',
      value: {
        accepted: true,
        answered: {
          message: ask,
          publicationId: expect.any(String),
          revisionId: expect.any(String),
        },
      },
    });
    const publication = ledger.list(conversationId)![0];
    expect(result).toHaveProperty('value.answered.publicationId', publication.publicationId);
    expect(result).toHaveProperty('value.answered.revisionId', publication.publicationId);
    expect(yieldTurn).not.toHaveBeenCalled();
    expect(who.neoTurn.isLive()).toBe(true);
  });

  test('a root turn may thread a publish to another delivered human message, more than once', async () => {
    prompt(root.sessionId, 'event', 'system');
    prompt(root.sessionId, 'steered');
    const turn = caller(root.sessionId, 'event', false);
    const answer = async (requestId: string) => ({
      value: await publish(
        { ...draft, publicationId: requestId, triggerId: 'human:steered' },
        turn
      ),
    });
    expect(await answer('first')).toMatchObject({
      value: {
        accepted: true,
        publication: { triggerId: 'human:steered' },
        answered: { message: { sessionId: root.sessionId, messageId: 'steered' } },
      },
    });
    expect(await answer('first')).toMatchObject({ value: { accepted: true, created: false } });
    expect(await answer('second')).toMatchObject({
      value: { accepted: true, created: true, publication: { triggerId: 'human:steered' } },
    });
  });

  test('a human message not yet delivered to the root cannot be answered by reference', async () => {
    prompt(root.sessionId, 'event', 'system');
    prompt(root.sessionId, 'waiting');
    mailbox.sdkMessageRepo.updateMessageStatus(
      [mailbox.sdkMessageRepo.findMessageIdByUuid(root.sessionId, 'waiting')!],
      'enqueued'
    );
    expect(
      await invoke({ ...draft, triggerId: 'human:waiting' }, caller(root.sessionId, 'event', false))
    ).toMatchObject({ value: { accepted: false, reason: 'wrong_trigger' } });
  });

  test('an unbound event delivery does not invent an answered human question', async () => {
    prompt(root.sessionId, 'event', 'system');
    stamp(
      { sessionId: root.sessionId, messageId: 'event' },
      { sessionId: root.sessionId, messageId: 'event' },
      null
    );
    expect(await invoke(draft, caller(root.sessionId, 'event', false))).toMatchObject({
      kind: 'completed',
      value: { accepted: true, answered: null },
    });
  });

  test('takes no publication id from the model: the daemon mints it', async () => {
    const registry = createOperationRegistry([createNeoPublicationOperation(publish)]);
    expect(
      await invokeOperation(registry, 'neo.publication.publish', draft, caller())
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    const { publicationId: _chosen, ...authored } = draft;
    const result = await invokeOperation(
      registry,
      'neo.publication.publish',
      { ...authored, requestId: 'send' },
      caller()
    );
    expect(result).toMatchObject({ kind: 'completed', value: { accepted: true, created: true } });
    const minted =
      result.kind === 'completed'
        ? (result.value as { publication: { publicationId: string } }).publication.publicationId
        : '';
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    expect(ledger.list(conversationId)!.map((item) => item.publicationId)).toEqual([minted]);
  });

  test('registers in the real family and persists authored content with runtime-derived identity', async () => {
    const service = {
      repo,
      publish,
      db: { getDatabase: () => mailbox.db },
    } as unknown as NeoService;
    const registry = createOperationRegistry(createNeoOperations(service));
    const before = mailbox.sdkRows();
    const { publicationId, ...authored } = draft;
    const result = await invokeOperation(
      registry,
      'neo.publication.publish',
      { ...authored, requestId: 'send' },
      caller()
    );
    expect(result).toMatchObject({
      kind: 'completed',
      value: {
        accepted: true,
        created: true,
        publication: {
          shortText: draft.shortText,
          fullText: draft.fullText,
          links: [],
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

  test('a live turn can deliver an acknowledgement without a trigger', async () => {
    prompt(root.sessionId, 'note-1', 'system');
    expect(
      await invoke(
        { ...draft, shortText: '收到。', fullText: '收到。' },
        caller(root.sessionId, 'note-1', false)
      )
    ).toMatchObject({ value: { accepted: true, publication: { shortText: '收到。' } } });
  });

  test('separate operations with identical text both publish under the same trigger', () => {
    const first = publish(draft, caller());
    expect(first).toMatchObject({ accepted: true, created: true });
    const second = publish(
      { ...draft, publicationId: '20000000-0000-4000-8000-000000000002' },
      caller()
    );
    expect(second).toMatchObject({ accepted: true, created: true });
    expect(ledger.list(conversationId)).toHaveLength(2);
    expect(publish(draft, caller())).toEqual({ ...first, created: false });
  });

  test('a stamped return answers the human message that asked it; a note’s new fact posts without one', () => {
    const reply = 'neo-return:1';
    prompt(root.sessionId, reply, 'system');
    stamp({ sessionId: root.sessionId, messageId: reply }, ask, 'continues');
    expect(publish(draft, caller(root.sessionId, reply, false))).toMatchObject({
      accepted: true,
      publication: { triggerId: `human:${ask.messageId}` },
    });
    const noted = 'neo-return:2';
    prompt(root.sessionId, 'note-1', 'system');
    prompt(root.sessionId, noted, 'system');
    stamp(
      { sessionId: root.sessionId, messageId: noted },
      { sessionId: root.sessionId, messageId: 'note-1' },
      'continues'
    );
    const fact = publish(
      {
        ...draft,
        publicationId: '20000000-0000-4000-8000-000000000004',
        shortText: 'A note fact.',
        fullText: 'A note fact.',
      },
      caller(root.sessionId, noted, false)
    );
    expect(fact).toMatchObject({ accepted: true, created: true });
    expect(fact.accepted && fact.publication.triggerId).toBeUndefined();
  });

  test('refuses a triggerId that is not this turn’s trigger', () => {
    expect(publish({ ...draft, triggerId: 'outcome:other:1' }, caller())).toMatchObject({
      accepted: false,
      reason: 'wrong_trigger',
    });
    expect(ledger.list(conversationId)).toEqual([]);
  });

  test('the removed interim field is not part of the message contract', () => {
    expect(publish({ ...draft, interim: true }, caller())).toMatchObject({
      accepted: false,
      reason: 'invalid_publication',
    });
    expect(publish(draft, caller())).toMatchObject({ accepted: true });
  });

  test('a publish nudge answers the human message it nudges, under that message’s trigger', () => {
    const nudge = `neo-nudge:${ask.messageId}`;
    prompt(root.sessionId, nudge, 'system');
    stamp({ sessionId: root.sessionId, messageId: nudge }, ask, 'continues');
    expect(publish(draft, caller(root.sessionId, nudge, false))).toMatchObject({
      accepted: true,
      publication: { triggerId: `human:${ask.messageId}` },
    });
    expect(ledger.list(conversationId)).toHaveLength(1);
  });

  test('a later input on an answered human trigger posts its new fact, never replacing the first', () => {
    expect(publish(draft, caller())).toMatchObject({ accepted: true, created: true });
    const reply = 'neo-return:9';
    prompt(root.sessionId, reply, 'system');
    stamp({ sessionId: root.sessionId, messageId: reply }, ask, 'continues');
    expect(
      publish(
        {
          ...draft,
          publicationId: '20000000-0000-4000-8000-000000000002',
          shortText: 'Overwrite.',
        },
        caller(root.sessionId, reply, false)
      )
    ).toMatchObject({ accepted: true, created: true });
    expect(ledger.list(conversationId)!.map((item) => item.shortText)).toEqual([
      draft.shortText,
      'Overwrite.',
    ]);
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

  test('refuses a dead turn before any append', async () => {
    const who = caller(root.sessionId, 'unrecorded');
    who.neoTurn!.isLive = () => false;
    expect(await invoke(draft, who)).toMatchObject({ kind: 'failed', code: 'forbidden' });
    expect(ledger.list(conversationId)).toEqual([]);
  });

  test.each(['missing', 'system', 'wrong-session'])(
    'a live turn with %s input evidence may still tell a new fact, once',
    async (kind) => {
      const who = caller(root.sessionId, 'unrecorded');
      if (kind === 'system') prompt(root.sessionId, 'unrecorded', 'system');
      if (kind === 'wrong-session') prompt(holder.sessionId, 'unrecorded');
      expect(await invoke(draft, who)).toMatchObject({ value: { accepted: true, created: true } });
      expect(await invoke(draft, who)).toMatchObject({ value: { accepted: true, created: false } });
      expect(ledger.list(conversationId)).toHaveLength(1);
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

  test('acknowledgements and progress text are delivery decisions, not refusals', () => {
    for (const [index, text] of ['收到。', 'Still waiting.', 'Still waiting.'].entries()) {
      expect(
        publish(
          { ...draft, publicationId: `send-${index}`, shortText: text, fullText: text },
          caller()
        )
      ).toMatchObject({ accepted: true, created: true });
    }
    expect(ledger.list(conversationId)).toHaveLength(3);
  });

  test('operation identities are scoped to the input that authored them', () => {
    expect(publish(draft, caller())).toMatchObject({ accepted: true, created: true });
    expect(publish(draft, caller(root.sessionId, 'other-ask'))).toMatchObject({
      accepted: true,
      created: true,
    });
    expect(ledger.list(conversationId)).toHaveLength(2);
  });

  test('a trigger note turn records its trigger, and a new fact for it also posts', () => {
    const triggerId = 'outcome:ask-1:abc';
    const note = `neo-trigger:${triggerId}`;
    prompt(root.sessionId, note, 'system');
    stamp({ sessionId: root.sessionId, messageId: note }, ask, { id: triggerId });
    const who = {
      ...caller(root.sessionId, note),
      neoTurn: { ...caller().neoTurn, messageId: note },
    };
    expect(publish({ ...draft, triggerId }, who)).toMatchObject({
      accepted: true,
      publication: { triggerId },
    });
    expect(
      publish(
        { ...draft, publicationId: '20000000-0000-4000-8000-000000000002', shortText: 'Again.' },
        who
      )
    ).toMatchObject({ accepted: true, created: true, publication: { triggerId } });
    expect(ledger.list(conversationId)).toHaveLength(2);
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

  test('preserves arbitrary authored labels and validates actual work ownership', async () => {
    work();
    const links = [
      { label: '看看对比', kind: 'work', id: 'work:1' },
      { label: 'More about A', kind: 'project', id: 'a' },
    ];
    expect(await invoke({ ...draft, links })).toMatchObject({
      value: { accepted: true, publication: { links } },
    });
    expect(ledger.list(conversationId)![0].links).toEqual(links);
  });

  test.each(['unknown', 'foreign-ask', 'unsafe-kind'])(
    'rejects %s scene refs, without partial publication',
    async (kind) => {
      const input = 'neo-note:1';
      prompt(root.sessionId, input, 'system');
      stamp({ sessionId: root.sessionId, messageId: input }, ask, 'continues');
      work('work:1', kind === 'foreign-ask' ? 'other-ask' : ask.messageId);
      prompt(root.sessionId, 'other-ask');
      const link = {
        label: 'Open',
        kind: kind === 'unsafe-kind' ? 'url' : 'work',
        id: kind === 'unknown' ? 'missing' : 'work:1',
      };
      const result = await invoke(
        { ...draft, links: [link] },
        caller(root.sessionId, input, false)
      );
      const detail = {
        unknown:
          'work link "missing" does not exist; link only Neo project or work ids, never work.find refs or session ids',
        'foreign-ask':
          'work link "work:1" was not started for this ask; link only work this ask created',
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

  test('pure link/lifetime gates refuse foreign evidence and superseded turns', () => {
    const who = caller();
    const producer = requirePublicationProducer(who, root, root);
    if (!('value' in producer)) throw new Error('Expected producer');
    const proof = { ...producer.value, ask };
    const link = { label: 'Open', kind: 'work' as const, id: 'work:1' };
    expect(requirePublicationLinks(proof, [{ link, exists: true, origin: ask }])).toEqual({
      value: proof,
    });
    expect(
      requirePublicationLinks(proof, [
        { link, exists: true, origin: { ...ask, messageId: 'foreign' } },
      ])
    ).toHaveProperty('reason.reason', 'invalid_scene_reference');
    expect(requirePublicationLifetime(proof, who, root, root)).toEqual({ value: proof });
    expect(
      requirePublicationLifetime(proof, { ...who, neoTurn: undefined }, root, root)
    ).toHaveProperty('reason.reason', 'publication_superseded');
  });

  test('pure producer and draft gates reject invalid evidence without consulting a database', () => {
    expect(requirePublicationProducer(caller(), root, root)).toHaveProperty('value.input', ask);
    expect(requirePublicationProducer(caller(), { ...root, kind: 'worker' }, root)).toHaveProperty(
      'reason.accepted',
      false
    );
    const { publicationId: _publicationId, ...authored } = draft;
    expect(admitPublicationDraft({ ...authored, requestId: 'send' })).toHaveProperty('value');
    expect(
      admitPublicationDraft({
        ...authored,
        links: Array.from({ length: 17 }, () => ({ label: 'Open', kind: 'project', id: 'a' })),
      })
    ).toHaveProperty('reason.reason', 'invalid_publication');
  });
});

describe('neoDeliveryTrigger', () => {
  test.each([
    ['continues', 'human:m1', 'human:m1'],
    ['continues', 'outcome:a:1', 'outcome:a:1'],
    ['continues', null, null],
    [{ id: 'action:a:1' }, 'human:m1', 'action:a:1'],
    [null, 'human:m1', null],
  ] as const)('a %j delivery under parent trigger %s carries %s', (trigger, parent, expected) => {
    expect(neoDeliveryTrigger(trigger, () => parent)).toBe(expected);
  });
});

describe('requirePublicationTrigger', () => {
  test('stamps the turn trigger when there is one, and refuses only a wrong trigger', () => {
    expect(requirePublicationTrigger({ a: 1 }, {}, 'human:m1')).toEqual({
      value: { a: 1, triggerId: 'human:m1' },
    });
    expect(requirePublicationTrigger({ a: 1 }, {}, null)).toEqual({
      value: { a: 1, triggerId: undefined },
    });
    expect(requirePublicationTrigger({ a: 1 }, { triggerId: 'x' }, 'human:m1')).toHaveProperty(
      'reason.reason',
      'wrong_trigger'
    );
  });
});
