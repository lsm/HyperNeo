import { describe, expect, test } from 'bun:test';
import type { NeoBinding, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import {
  createNeoInboxPromoteOperation,
  isNeoRecurringTopic,
  type NeoInboxPromoteRuntime,
  requireNeoInboxAsks,
  requireNeoInboxHolder,
} from '../../../../src/lib/neo/inbox-promote-operation.ts';
import { NEO_INBOX_ID } from '../../../../src/lib/neo/router.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';

const DAY = 24 * 60 * 60 * 1000;
const inbox: NeoBinding = { sessionId: 'neo:inbox', projectId: NEO_INBOX_ID, kind: 'project' };
const caller = (sessionId = inbox.sessionId, live = true): OperationCaller => ({
  source: 'mcp',
  sessionId,
  role: 'neo',
  neoTurn: { messageId: 'm', human: true, isLive: () => live },
});
const ask = (id: string, createdAt: number, extra: Partial<NeoAsk> = {}) =>
  ({
    id,
    projectId: NEO_INBOX_ID,
    status: 'open',
    title: `Ask ${id}`,
    ask: id,
    createdAt,
    originSessionId: inbox.sessionId,
    originMessageId: `m-${id}`,
    workIds: [],
    ...extra,
  }) as unknown as NeoAsk;

describe('isNeoRecurringTopic', () => {
  test.each([
    ['one ask', [0], false],
    ['two asks on one day', [0, 1000], false],
    ['two asks on two days', [0, DAY + 1], true],
    ['three asks on one day', [0, 1, 2], true],
  ] as const)('%s', (_label, times, recurring) => {
    expect(isNeoRecurringTopic(times.map((createdAt) => ({ createdAt })))).toBe(recurring);
  });
});

describe('requireNeoInboxHolder', () => {
  test('admits only the Inbox holder in a live turn', () => {
    expect(requireNeoInboxHolder(caller(), inbox)).toEqual({ value: inbox.sessionId });
    for (const [who, binding] of [
      [caller('neo:garden'), { sessionId: 'neo:garden', projectId: 'garden', kind: 'project' }],
      [caller(inbox.sessionId, false), inbox],
      [{ source: 'rpc', principal: 'local' } as OperationCaller, inbox],
    ] as const)
      expect(requireNeoInboxHolder(who, binding as NeoBinding)).toHaveProperty(
        'reason.reason',
        'inbox_only'
      );
  });
});

describe('requireNeoInboxAsks', () => {
  test('takes live Inbox asks only, each once', () => {
    const a = ask('a', 0);
    const b = ask('b', 1);
    expect(requireNeoInboxAsks(['a', 'b'], [a, b])).toEqual({ value: [a, b] });
    for (const [ids, asks] of [
      [
        ['a', 'a'],
        [a, a],
      ],
      [
        ['a', 'x'],
        [a, null],
      ],
      [
        ['a', 'g'],
        [a, ask('g', 1, { projectId: 'garden' })],
      ],
      [
        ['a', 's'],
        [a, ask('s', 1, { status: 'achieved' })],
      ],
    ] as const)
      expect(requireNeoInboxAsks(ids, asks)).toHaveProperty(
        'reason.reason',
        expect.stringContaining('not_an_inbox_ask')
      );
  });
});

describe('neo.inbox.promote', () => {
  function setup(asks: NeoAsk[], project = true) {
    const created: string[] = [];
    const delivered: string[] = [];
    const moved: { askId: string; projectId: string; cards: number }[] = [];
    const card = { id: 'w1', title: 'Card', status: 'proposed' } as NeoWork;
    const runtime: NeoInboxPromoteRuntime = {
      getBinding: (id) => (id === inbox.sessionId ? inbox : null),
      ask: (id) => asks.find((item) => item.id === id) ?? null,
      cards: (item) => (item.id === 'a' ? [card] : []),
      deliver: async (sessionId, messageId) => {
        delivered.push(`${sessionId}:${messageId}`);
      },
      move: (item, cards, owner) => {
        moved.push({ askId: item.id, projectId: owner.projectId, cards: cards.length });
      },
      log: () => {},
      createProject: async (title) => {
        created.push(title);
        return project ? { projectId: 'tax', sessionId: 'neo:tax', title, summary: '' } : null;
      },
    };
    const invoke = (input: unknown, who = caller()) =>
      invokeOperation(
        createOperationRegistry([createNeoInboxPromoteOperation(runtime)]),
        'neo.inbox.promote',
        input,
        who
      );
    return { invoke, created, delivered, moved };
  }

  test('gives a topic that came up on two days its own project and moves its asks and cards', async () => {
    const { invoke, created, delivered, moved } = setup([ask('a', 0), ask('b', DAY + 1)]);
    expect(await invoke({ title: 'Taxes', askIds: ['a', 'b'] })).toMatchObject({
      value: { ok: true, projectId: 'tax', moved: ['a', 'b'] },
    });
    expect(created).toEqual(['Taxes']);
    expect(moved).toEqual([
      { askId: 'a', projectId: 'tax', cards: 1 },
      { askId: 'b', projectId: 'tax', cards: 0 },
    ]);
    expect(delivered).toHaveLength(2);
    expect(delivered.every((line) => line.startsWith('neo:tax:neo-moved:'))).toBe(true);
  });

  test('refuses a one-off topic and creates nothing', async () => {
    const { invoke, created, moved } = setup([ask('a', 0)]);
    expect(await invoke({ title: 'Taxes', askIds: ['a'] })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('not_recurring') },
    });
    expect(created).toEqual([]);
    expect(moved).toEqual([]);
  });

  test('only the Inbox holder may promote', async () => {
    const { invoke, created } = setup([ask('a', 0), ask('b', DAY + 1)]);
    expect(
      await invoke({ title: 'Taxes', askIds: ['a', 'b'] }, caller('neo:garden'))
    ).toMatchObject({ value: { ok: false, reason: 'inbox_only' } });
    expect(created).toEqual([]);
  });

  test('moves nothing when the project cannot be opened', async () => {
    const { invoke, moved } = setup([ask('a', 0), ask('b', DAY + 1)], false);
    expect(await invoke({ title: 'Taxes', askIds: ['a', 'b'] })).toMatchObject({
      value: { ok: false, reason: 'project_unavailable' },
    });
    expect(moved).toEqual([]);
  });
});
