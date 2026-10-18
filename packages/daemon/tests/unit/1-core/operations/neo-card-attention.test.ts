import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { NEO_WORK_CLOSED_DONE, type NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { vi } from 'vitest';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  neoCardAttentionNeoNote,
  requireNeoCardAttentionRelay,
} from '../../../../src/lib/neo/card-attention.ts';
import {
  neoCardPrAttention,
  neoCardPrFacts,
} from '../../../../src/lib/neo/packs/coding/card-facts.ts';
import { neoPackCardAttention } from '../../../../src/lib/neo/packs/index.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const url = 'https://github.com/lsm/HyperNeo/pull/1';
const pr = (fields: Partial<NeoWorkPr> = {}): NeoWorkPr => ({
  url,
  state: 'OPEN',
  checks: 'passing',
  review: 'none',
  ...fields,
});

describe('neoCardPrAttention', () => {
  test('lists failing checks, requested changes, unresolved threads and conflicts per open PR', () => {
    expect(
      neoCardPrAttention([
        pr({
          checks: 'failing',
          review: 'changes_requested',
          blockers: ['2 unresolved review threads', 'merge conflicts with dev', 'behind dev'],
        }),
      ])
    ).toEqual({
      attention: {
        signature: `- ${url}: CI checks are failing; a reviewer requested changes; 2 unresolved review threads; merge conflicts with dev`,
        facts: `Your pull requests have news:\n- ${url}: CI checks are failing; a reviewer requested changes; 2 unresolved review threads; merge conflicts with dev`,
      },
      pending: false,
    });
  });

  test('a new review thread changes the signature even when the kinds stay the same', () => {
    const one = neoCardPrAttention([pr({ blockers: ['1 unresolved review thread'] })]);
    const two = neoCardPrAttention([pr({ blockers: ['2 unresolved review threads'] })]);
    expect(one.attention?.signature).not.toBe(two.attention?.signature);
  });

  test('asks for a CI run on an approved head with no checks, then for the merge once it is green', () => {
    const unrun = neoCardPrAttention([pr({ review: 'approved', checks: 'none' })]);
    const green = neoCardPrAttention([pr({ review: 'approved', checks: 'passing' })]);
    expect(unrun.attention?.signature).toBe(
      `- ${url}: approved, but no CI checks ran on its head; push or update the branch from its base so CI runs`
    );
    expect(green.attention?.signature).toBe(
      `- ${url}: approved and green; merge it now with a manual squash merge`
    );
    expect(
      neoCardPrAttention([
        pr({ review: 'approved', checks: 'passing', blockers: ['behind dev'] }),
        pr({ review: 'approved', checks: 'pending' }),
        pr({ state: 'MERGED', review: 'approved', checks: 'none' }),
      ]).attention
    ).toBeNull();
    expect(
      neoCardPrAttention([pr({ review: 'approved', checks: 'none' })], false).attention
    ).toBeNull();
    expect(
      neoCardPrAttention(
        [pr({ review: 'approved', checks: 'passing', blockers: ['1 unresolved review thread'] })],
        false
      ).attention?.signature
    ).toBe(`- ${url}: 1 unresolved review thread`);
  });

  test('stays quiet for a clean, pending, merged or closed PR', () => {
    expect(
      neoCardPrAttention([
        pr(),
        pr({ checks: 'pending', blockers: ['behind dev'] }),
        pr({ state: 'MERGED', checks: 'failing' }),
        pr({ state: 'CLOSED', review: 'changes_requested' }),
      ])
    ).toEqual({ attention: null, pending: true });
  });
});

describe('neoCardPrFacts', () => {
  test('states the live or stale PR read, with no command in it', () => {
    const live = neoCardPrFacts([pr({ blockers: ['behind dev'] })], false);
    expect(live?.data).toEqual({
      waiting_on_pr: [],
      prs: [{ url, state: 'OPEN', checks: 'passing', review: 'none', blockers: ['behind dev'] }],
    });
    expect(live?.text).toContain('live state');
    expect(neoCardPrFacts([pr()], true)?.text).toContain('may be out of date');
    expect(neoCardPrFacts(undefined, false)).toBeNull();
    expect(neoCardPrFacts([pr({ checks: 'pending' })], false)?.data?.waiting_on_pr).toEqual([url]);
  });

  test('names a pull request that can be merged now, and only that one', () => {
    const ready = pr({ review: 'approved' });
    const facts = neoCardPrFacts(
      [
        ready,
        pr({ url: `${url}0`, review: 'approved', blockers: ['behind dev'] }),
        pr({ url: `${url}1` }),
      ],
      false
    );
    expect(facts?.text).toContain(`so it can be merged now: ${url}.`);
    expect(facts?.text).not.toContain(`${url}0`);
    expect(facts?.text).not.toContain(`${url}1`);
    expect(
      neoCardPrFacts([pr({ checks: 'pending', review: 'approved' })], false)?.text
    ).not.toContain('merged now');
    expect(neoCardPrFacts([ready], true)?.text).not.toContain('merged now');
  });
});

describe('neoPackCardAttention', () => {
  test('joins what each pack reports and stays pending while any pack waits', () => {
    const a = { signature: 'a', facts: 'A' };
    const b = { signature: 'b', facts: 'B' };
    const packs = [
      { cardAttention: () => ({ attention: a, pending: false }) },
      { cardAttention: () => ({ attention: b, pending: true }) },
      {},
    ] as unknown as Parameters<typeof neoPackCardAttention>[0];
    expect(neoPackCardAttention(packs, 'w1')).toEqual({
      attention: { signature: 'a\nb', facts: 'A\nB' },
      pending: true,
    });
    expect(neoPackCardAttention([], 'w1')).toEqual({ attention: null, pending: false });
  });
});

describe('requireNeoCardAttentionRelay', () => {
  const attention = { signature: 's1', facts: `- ${url}: CI checks are failing` };

  test('relays new PR news to a queued or reported card', () => {
    for (const status of ['queued', 'reported'] as const) {
      const relay = requireNeoCardAttentionRelay({ status, report: null }, attention, null);
      expect(relay).toMatchObject({ value: { signature: 's1' } });
      expect('value' in relay && relay.value.message).toBe(attention.facts);
    }
    expect(
      requireNeoCardAttentionRelay({ status: 'queued', report: null }, attention, 's0')
    ).toMatchObject({ value: { signature: 's1' } });
  });

  test.each([
    ['not_in_flight', { status: 'cancelled' as const, report: null }, attention, null],
    ['not_in_flight', null, attention, null],
    [
      'not_in_flight',
      { status: 'reported' as const, report: NEO_WORK_CLOSED_DONE },
      attention,
      null,
    ],
    [
      'not_in_flight',
      { status: 'reported' as const, report: 'Closed as done by Neo: both PRs merged' },
      attention,
      null,
    ],
    ['clear', { status: 'queued' as const, report: null }, null, null],
    ['told', { status: 'queued' as const, report: null }, attention, 's1'],
  ] as const)('skips with %s', (reason, work, news, told) => {
    expect(requireNeoCardAttentionRelay(work, news, told)).toEqual({ reason });
  });
});

describe('neoCardAttentionNeoNote', () => {
  test('tells Neo when the card can never take the news, but not when it is only busy', () => {
    const work = { id: 'w1', title: 'Fix login' };
    expect(
      neoCardAttentionNeoNote(
        work,
        `- ${url}: CI checks are failing`,
        'Only started driver work can be continued.'
      )
    ).toContain(`- ${url}: CI checks are failing`);
    expect(
      neoCardAttentionNeoNote(
        work,
        'items',
        'This work is already being continued; wait for that first.'
      )
    ).toBeNull();
  });
});

describe('NeoService relayCardPr', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  const sent: { id: string; message: string }[] = [];
  let refuse: string | null;
  const told: { messageId: string; content: string }[] = [];

  beforeEach(async () => {
    sent.length = 0;
    told.length = 0;
    refuse = null;
    db = await createTestDb();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession('neo:root'));
    Object.assign(service.todoRunner, {
      proceed: async (id: string, message: string) => {
        sent.push({ id, message });
        return refuse
          ? { ok: false, reason: refuse }
          : { ok: true, todo: service.todos.getTodo(id) };
      },
    });
    Object.assign(service, {
      deliverForward: async (_sessionId: string, messageId: string, content: string) => {
        told.push({ messageId, content });
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    db.close();
  });

  const relay = (workId: string) =>
    (service as unknown as { relayCardPr(id: string): Promise<unknown> }).relayCardPr(workId);

  function queuedCard(): string {
    service.todos.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo:root',
      originMessageId: null,
      title: 'Fix login',
      request: 'Fix login',
      createdAt: 1,
    });
    const todo = service.todos.addTodo(
      'w-pr',
      'ask',
      {
        title: 'Fix login',
        instruction: 'Fix login.',
        doneWhen: 'Merged',
        named: null,
        check: { pack: 'coding', kind: 'pr_merged', params: {} },
      },
      1
    );
    service.todos.claimStart(todo, 2);
    return todo.id;
  }

  test('sends each new PR problem to the card once, and again after it clears and returns', async () => {
    const workId = queuedCard();
    service.todoPrs.record(workId, [pr({ checks: 'failing' })], 1);
    await relay(workId);
    await relay(workId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: workId });
    expect(sent[0].message).toContain(`${url}: CI checks are failing`);

    service.todoPrs.record(workId, [pr({ checks: 'failing', review: 'changes_requested' })], 2);
    await relay(workId);
    expect(sent).toHaveLength(2);

    service.todoPrs.record(workId, [pr()], 3);
    await relay(workId);
    service.todoPrs.record(workId, [pr({ checks: 'failing', review: 'changes_requested' })], 4);
    await relay(workId);
    expect(sent).toHaveLength(3);
  });

  test('tries again on the next sweep when the continue is refused', async () => {
    const workId = queuedCard();
    service.todoPrs.record(workId, [pr({ checks: 'failing' })], 1);
    refuse = 'This work is already being continued; wait for that first.';
    await relay(workId);
    refuse = null;
    await relay(workId);
    await relay(workId);
    expect(sent).toHaveLength(2);
  });

  test('keeps what it told while CI is pending, so unchanged threads are not sent again', async () => {
    const workId = queuedCard();
    const threads = { blockers: ['1 unresolved review thread'] };
    service.todoPrs.record(workId, [pr(threads)], 1);
    await relay(workId);
    service.todoPrs.record(workId, [pr({ checks: 'pending' })], 2);
    await relay(workId);
    service.todoPrs.record(workId, [pr(threads)], 3);
    await relay(workId);
    expect(sent).toHaveLength(1);
  });

  test('tells Neo once when the card can never be continued', async () => {
    const workId = queuedCard();
    service.todoPrs.record(workId, [pr({ checks: 'failing' })], 1);
    refuse = 'Only started driver work can be continued.';
    await relay(workId);
    await relay(workId);
    expect(sent).toHaveLength(1);
    expect(told).toHaveLength(1);
    expect(told[0].content).toContain(`- ${url}: CI checks are failing`);
    expect(told[0].content).toContain('Fix login');
  });

  test('after a restart, does not resend a problem set it already told', async () => {
    const workId = queuedCard();
    service.todoPrs.record(workId, [pr({ checks: 'failing' })], 1);
    await relay(workId);
    service.dispose();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    Object.assign(service.todoRunner, {
      proceed: async (id: string, message: string) => {
        sent.push({ id, message });
        return { ok: true, todo: service.todos.getTodo(id) };
      },
    });
    await relay(workId);
    expect(sent).toHaveLength(1);
  });

  test('leaves a cancelled card alone', async () => {
    const workId = queuedCard();
    service.todos.updateTodo(service.todos.getTodo(workId)!, { state: 'removed' }, 3);
    service.todoPrs.record(workId, [pr({ checks: 'failing' })], 1);
    await relay(workId);
    expect(sent).toEqual([]);
  });
});
