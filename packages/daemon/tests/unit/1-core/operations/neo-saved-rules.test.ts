import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  type NeoSavedRulesNote,
  neoSavedRulesKey,
  planNeoSavedRules,
  planNeoSavedRulesAppend,
  planNeoSavedRulesNote,
  withNeoSavedRules,
} from '../../../../src/lib/neo/saved-rules.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const rule = 'HyperNeo code is done when merged to dev, as with #5555.';
const reply: NeoPublicationInput = {
  conversationId,
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: { sessionId: root, messageId: 'ask-1' },
  producerInput: { sessionId: root, messageId: 'ask-1' },
  shortText: 'Started #5559 in ~/focus/neokai.',
  fullText: 'Started #5559 in ~/focus/neokai on a worktree.',
  links: [],
};

describe('planNeoSavedRules', () => {
  test.each<[string, string[], string[], string[]]>([
    ['a new rule', ['Keep A.'], ['Keep A.', 'Keep B.'], ['Keep B.']],
    ['a reworded rule', ['Keep A.'], ['Keep A, always.'], ['Keep A, always.']],
    ['only removals', ['Keep A.', 'Keep B.'], ['Keep A.'], []],
  ])('%s', (_label, before, after, saved) => {
    expect(planNeoSavedRules(before, after)).toEqual(saved);
  });
});

describe('neoSavedRulesKey', () => {
  test.each<[string, string, string]>([
    ['a human turn', 'ask-1', `${root}:ask-1`],
    ['the publish nudge for that turn', 'neo-nudge:ask-1', `${root}:ask-1`],
    ['a done-check turn', 'w1:done-check:1', `${root}:w1:done-check:1`],
  ])('%s', (_label, messageId, key) => {
    expect(neoSavedRulesKey(root, messageId)).toBe(key);
  });
});

describe('planNeoSavedRulesNote', () => {
  const turn = { sessionId: root, messageId: 'ask-1' };
  const key = `${root}:ask-1`;
  const full = new Map(
    Array.from({ length: 50 }, (_, i) => [`${root}:old-${i}`, { pending: [], published: {} }])
  );
  test.each<
    [
      string,
      Parameters<typeof planNeoSavedRulesNote>[0],
      string[],
      Map<string, NeoSavedRulesNote>,
      ReturnType<typeof planNeoSavedRulesNote>,
    ]
  >([
    ['a call outside a Neo turn', { sessionId: root }, [rule], new Map(), null],
    ['a turn that saved nothing', turn, [], new Map(), null],
    [
      'a first save',
      turn,
      [rule],
      new Map(),
      { key, note: { pending: [rule], published: {} }, evict: [] },
    ],
    [
      'a second save after a reply went out',
      turn,
      [rule, 'Keep B.'],
      new Map([[key, { pending: [rule], published: { p1: ['Keep A.'] } }]]),
      { key, note: { pending: [rule, 'Keep B.'], published: { p1: ['Keep A.'] } }, evict: [] },
    ],
    [
      'a new turn past the cap',
      turn,
      [rule],
      full,
      { key, note: { pending: [rule], published: {} }, evict: [`${root}:old-0`] },
    ],
  ])('%s', (_label, at, saved, notes, plan) => {
    expect(planNeoSavedRulesNote(at, saved, notes)).toEqual(plan);
  });
});

describe('planNeoSavedRulesAppend', () => {
  const key = `${root}:ask-1`;
  const kept = { standingRules: [rule, 'Keep B.'], stored: false };
  const pending = new Map([[key, { pending: [rule], published: {} }]]);
  const sent = new Map([
    [key, { pending: ['Keep B.'], published: { [reply.publicationId]: [rule] } }],
  ]);
  test.each<
    [
      string,
      NeoPublicationInput,
      Map<string, NeoSavedRulesNote>,
      Parameters<typeof planNeoSavedRulesAppend>[2],
      string[],
      boolean,
    ]
  >([
    ['an interim update', { ...reply, interim: true }, pending, kept, [], false],
    ['the first final reply', reply, pending, kept, [rule], true],
    ['a rule the turn removed again', reply, pending, { ...kept, standingRules: [] }, [], false],
    ['a retry of that reply after another save', reply, sent, kept, [rule], false],
    [
      'a later reply in the same turn',
      { ...reply, publicationId: 'p2' },
      sent,
      kept,
      ['Keep B.'],
      true,
    ],
    [
      'a retry of a reply stored without lines',
      reply,
      pending,
      { ...kept, stored: true },
      [],
      false,
    ],
    ['a turn with no saves', reply, new Map(), kept, [], false],
  ])('%s', (_label, input, notes, current, rules, keeps) => {
    const plan = planNeoSavedRulesAppend(input, notes, current);
    expect(plan.rules).toEqual(rules);
    expect(plan.keep !== null).toBe(keeps);
    if (plan.keep) expect(plan.keep.note.published[input.publicationId]).toEqual(rules);
  });
});

describe('withNeoSavedRules', () => {
  test.each<[string, NeoPublicationInput, string[], string, string]>([
    ['nothing saved', reply, [], reply.shortText, reply.fullText],
    [
      'a saved rule',
      reply,
      [rule],
      `${reply.shortText}\n\nSaved: ${rule}`,
      `${reply.fullText}\n\nSaved: ${rule}`,
    ],
    [
      'a reply that already says it',
      { ...reply, shortText: `Started #5559.\nSaved: ${rule}` },
      [rule],
      `Started #5559.\nSaved: ${rule}`,
      `${reply.fullText}\n\nSaved: ${rule}`,
    ],
    ['an interim update', { ...reply, interim: true }, [rule], reply.shortText, reply.fullText],
  ])('%s', (_label, input, saved, shortText, fullText) => {
    expect(withNeoSavedRules(input, saved)).toMatchObject({ shortText, fullText });
  });

  test('makes room for the saved lines when the reply fills its limit', () => {
    const long = withNeoSavedRules({ ...reply, shortText: 'x'.repeat(2000) }, [rule]).shortText;
    expect(long).toHaveLength(2000);
    expect(long.endsWith(`…\n\nSaved: ${rule}`)).toBe(true);
  });

  test('keeps both the reply and the saved lines when many long rules were saved', () => {
    const rules = Array.from({ length: 20 }, (_, i) => `${i} ${'r'.repeat(495)}`);
    const short = withNeoSavedRules(reply, rules).shortText;
    expect(short.length).toBeLessThanOrEqual(2000);
    expect(short.startsWith(reply.shortText)).toBe(true);
    expect(short).toContain('Saved: 0 r');
  });
});

describe('Neo reply after a rule save', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  const caller: OperationCaller = {
    source: 'mcp',
    sessionId: root,
    role: 'neo',
    neoTurn: { messageId: 'ask-1', human: true, isLive: () => true },
  };

  beforeEach(async () => {
    db = await createTestDb();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession(root));
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', concernId: null });
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: 'ask-1',
      session_id: root,
      parent_tool_use_id: null,
      inputKind: 'human',
      message: { role: 'user', content: 'fix HyperNeo #5559' },
    } as unknown as SDKUserMessage);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  const invoke = (name: string, input: unknown, as = caller) =>
    invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, as);

  test('the published reply names the rule this turn saved, and a retry stays identical', async () => {
    db.updateGlobalSettings({ neo: { standingRules: ['Ask before deleting anything.'] } });
    await invoke('neo.rule.save', { rules: ['Ask before deleting anything.', rule] });
    const { conversationId: _c, askOrigin: _a, producerInput: _p, ...draft } = reply;

    expect(await invoke('neo.publication.publish', draft)).toMatchObject({
      value: { accepted: true, created: true },
    });
    expect(service.publications.get(conversationId, reply.publicationId)).toMatchObject({
      shortText: `${reply.shortText}\n\nSaved: ${rule}`,
    });
    expect(await invoke('neo.publication.publish', draft)).toMatchObject({
      value: { accepted: true, created: false },
    });
  });

  test('a later save never changes a sent reply, and the next reply names only the new rule', async () => {
    await invoke('neo.rule.save', { rules: [rule] });
    const { conversationId: _c, askOrigin: _a, producerInput: _p, ...draft } = reply;
    await invoke('neo.publication.publish', draft);
    await invoke('neo.rule.save', { rules: [rule, 'Keep B.'] });

    expect(await invoke('neo.publication.publish', draft)).toMatchObject({
      value: { accepted: true, created: false },
    });
    const next = { ...draft, publicationId: '20000000-0000-4000-8000-000000000002' };
    await invoke('neo.publication.publish', next);
    expect(service.publications.get(conversationId, next.publicationId)?.shortText).toBe(
      `${reply.shortText}\n\nSaved: Keep B.`
    );
  });

  test('a rule removed again in the same turn is not announced', async () => {
    await invoke('neo.rule.save', { rules: [rule, 'Keep B.'] });
    await invoke('neo.rule.save', { rules: [rule] });
    const { conversationId: _c, askOrigin: _a, producerInput: _p, ...draft } = reply;
    await invoke('neo.publication.publish', draft);
    expect(service.publications.get(conversationId, reply.publicationId)?.shortText).toBe(
      `${reply.shortText}\n\nSaved: ${rule}`
    );
  });

  test('a reply published after the publish nudge still names the rule', async () => {
    await invoke('neo.rule.save', { rules: [rule] });
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: 'neo-nudge:ask-1',
      session_id: root,
      parent_tool_use_id: null,
      inputKind: 'system',
      message: { role: 'user', content: 'Publish your answer.' },
    } as unknown as SDKUserMessage);
    const { conversationId: _c, askOrigin: _a, producerInput: _p, ...draft } = reply;
    expect(
      await invoke('neo.publication.publish', draft, {
        ...caller,
        neoTurn: { ...caller.neoTurn!, messageId: 'neo-nudge:ask-1', human: false },
      })
    ).toMatchObject({ value: { accepted: true } });
    expect(service.publications.get(conversationId, reply.publicationId)?.shortText).toBe(
      `${reply.shortText}\n\nSaved: ${rule}`
    );
  });

  test('a turn that saved nothing publishes its reply unchanged', async () => {
    await invoke(
      'neo.rule.save',
      { rules: [rule] },
      {
        ...caller,
        neoTurn: { ...caller.neoTurn!, messageId: 'earlier-ask' },
      }
    );
    const { conversationId: _c, askOrigin: _a, producerInput: _p, ...draft } = reply;
    await invoke('neo.publication.publish', draft);
    expect(service.publications.get(conversationId, reply.publicationId)?.shortText).toBe(
      reply.shortText
    );
  });
});
