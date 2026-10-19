import { describe, expect, mock, spyOn, test } from 'bun:test';
import { hostname } from 'node:os';
import { NEO_WORK_BLOCKER, NEO_WORK_GOAL_REMAINING } from '@hyperneo/prompts';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { NEO_WORK_CLOSED_DONE } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import type { WorkSummary } from '../../../../src/lib/drivers/types.ts';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  type DriverSent,
  decideCardLiveStatus,
  decideStuckReminder,
  driverExchangeReport,
  driverWorkCall,
  driverWorkCaller,
  isNeoReceiptUnconfirmed,
  NEO_CARD_CONFIRM_MS,
  NEO_WORK_STUCK_STEPS_MS,
  NEO_WORK_UNANCHORED_NOTE,
  NEO_WORK_UNANCHORED_SETTLE_MS,
  NEO_WORK_UNVERIFIED_REPLY_NOTE,
  type NeoDriverTarget,
  NeoDriverTargetSchema,
  neoCardSent,
  readDriverLanded,
  readDriverOutcome,
  readDriverSendBaseline,
  readDriverSent,
  readDriverSettlement,
  requireNeoWorkRetryable,
  withWorkGoal,
} from '../../../../src/lib/neo/driver-work.ts';
import { neoEvidenceSignature } from '../../../../src/lib/neo/evidence.ts';
import {
  createNeoOperations,
  requireNeoExecutionChoice,
  requireNeoProposalAsk,
} from '../../../../src/lib/neo/operations.ts';
import type { NeoRef } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { lifeAdminReportEvidence } from '../../../../src/lib/neo/packs/life-admin/pack.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { pickNeoReplacementWorkers } from '../../../../src/lib/neo/work-reroute.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import { SessionEventSubscriptionRepository } from '../../../../src/storage/repositories/session-event-subscription-repository.ts';

const place = { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen', daemon: 'laptop' };
const startTarget: NeoDriverTarget = { verb: 'start', adapter: 'codex-desktop', place };
const sendTarget: NeoDriverTarget = {
  verb: 'send',
  ref: { adapter: 'hyperneo', id: 's1' },
};
const work = { title: 'Bigger font', instruction: 'Raise the body font to 16px.' };

describe('requireNeoWorkRetryable', () => {
  test.each<
    [
      string,
      { status: NeoWork['status']; report: string | null },
      { target: boolean; ref: boolean; interrupted: boolean },
      boolean,
    ]
  >([
    [
      'a hand-off that failed before it started',
      { status: 'failed', report: 'down' },
      { target: true, ref: false, interrupted: false },
      true,
    ],
    [
      'started work',
      { status: 'failed', report: 'down' },
      { target: true, ref: true, interrupted: false },
      false,
    ],
    [
      'work with no driver target',
      { status: 'failed', report: null },
      { target: false, ref: false, interrupted: false },
      false,
    ],
    [
      'work still queued',
      { status: 'queued', report: null },
      { target: true, ref: false, interrupted: false },
      false,
    ],
    [
      'a start that was interrupted',
      { status: 'failed', report: 'down' },
      { target: true, ref: false, interrupted: true },
      false,
    ],
  ])('%s', (_label, work, card, retryable) => {
    expect('value' in requireNeoWorkRetryable(work, card, true)).toBe(retryable);
  });
});

describe('isNeoReceiptUnconfirmed', () => {
  const card: Parameters<typeof isNeoReceiptUnconfirmed>[0] = {
    ref: true,
    workStatus: 'queued',
    workCreatedAt: 100,
    startedAt: null,
    inputBefore: null,
    status: 'running',
  };
  test.each<[string, Partial<typeof card>, number, boolean]>([
    ['a card showing its session a day after it was sent', {}, 100 + NEO_CARD_CONFIRM_MS, true],
    ['the same card earlier', {}, 100 + NEO_CARD_CONFIRM_MS - 1, false],
    ['a session that failed before the card was confirmed', { status: 'failed' }, 200, false],
    ['a card still queued', { status: 'queued' }, 100 + NEO_CARD_CONFIRM_MS, false],
    ['a card that started', { startedAt: 150 }, 100 + NEO_CARD_CONFIRM_MS, false],
    ['a card that reported', { workStatus: 'reported' }, 100 + NEO_CARD_CONFIRM_MS, false],
    ['a later send', { inputBefore: 5_000 }, 100 + NEO_CARD_CONFIRM_MS, false],
  ])('%s', (_label, overrides, now, unconfirmed) => {
    expect(isNeoReceiptUnconfirmed({ ...card, ...overrides }, now)).toBe(unconfirmed);
  });
});

describe('requireNeoProposalAsk', () => {
  const neo = { source: 'mcp' as const, sessionId: 'neo:root', role: 'neo' as const };
  const human = { source: 'rpc' as const, principal: 'local' as const };

  test('leaves the human proposing from the app alone', () => {
    expect(requireNeoProposalAsk({}, human)).toEqual({ value: human });
  });
});

describe('requireNeoExecutionChoice', () => {
  const neo = { source: 'mcp' as const, sessionId: 'neo:root', role: 'neo' as const };

  test('accepts a drivers target as the explicit choice and refuses it next to a chat', () => {
    expect(requireNeoExecutionChoice({ work: sendTarget }, neo)).toEqual({ value: neo });
    expect(
      requireNeoExecutionChoice({ work: sendTarget, targetSessionId: 's1' }, neo)
    ).toMatchObject({ reason: { ok: false } });
  });

  test('refuses a start in a place with no folder or Space before a card exists', () => {
    const chats = { machine: 'laptop', name: 'Chats' };
    expect(
      requireNeoExecutionChoice({ work: { verb: 'start', adapter: 'hyperneo', place: chats } }, neo)
    ).toMatchObject({
      reason: {
        ok: false,
        reason: expect.stringContaining('ask the human where the work belongs'),
      },
    });
    expect(
      requireNeoExecutionChoice(
        { work: { verb: 'start', adapter: 'space', place: { ...chats, spaceId: 'sp1' } } },
        neo
      )
    ).toEqual({ value: neo });
    expect(requireNeoExecutionChoice({ work: startTarget }, neo)).toEqual({ value: neo });
  });
});

describe('NeoDriverTargetSchema', () => {
  test('normalizes requested configuration and preserves omitted settings', () => {
    expect(
      NeoDriverTargetSchema.parse({ ...startTarget, model: ' sol 6.1 ', effort: ' medium ' })
    ).toEqual({ ...startTarget, model: 'sol 6.1', effort: 'medium' });
    expect(NeoDriverTargetSchema.parse(startTarget)).toEqual(startTarget);
    expect(NeoDriverTargetSchema.parse({ ...startTarget, effort: 'high' })).toEqual({
      ...startTarget,
      effort: 'high',
    });
  });

  test.each(['', '   ', 'x'.repeat(101), 1, null])('rejects invalid effort %j', (effort) => {
    expect(NeoDriverTargetSchema.safeParse({ ...startTarget, effort }).success).toBe(false);
  });
});

describe('driverWorkCall', () => {
  test('sends the goal with a started or continued driver session', () => {
    const goal = { workId: 'w1', goal: 'A full iOS app', doneWhen: null };
    for (const target of [startTarget, sendTarget])
      expect(driverWorkCall(target, work, goal).input.message).toContain(
        'Neo routed this to you: do it here, not by handing it to another session or chat.\nWhat the human asked: A full iOS app'
      );
  });

  test('starts new work with the title and instruction, or sends the instruction', () => {
    expect(driverWorkCall(startTarget, work)).toEqual({
      name: 'work.start',
      input: {
        adapter: 'codex-desktop',
        place,
        title: 'Bigger font',
        message: `Raise the body font to 16px.\n\n${NEO_WORK_BLOCKER}`,
      },
    });
    expect(driverWorkCall({ ...startTarget, createFolder: true }, work)).toEqual({
      name: 'work.start',
      input: {
        adapter: 'codex-desktop',
        place,
        title: 'Bigger font',
        message: `Raise the body font to 16px.\n\n${NEO_WORK_BLOCKER}`,
        createFolder: true,
      },
    });
    expect(driverWorkCall(sendTarget, work)).toEqual({
      name: 'work.send',
      input: {
        ref: { adapter: 'hyperneo', id: 's1' },
        message: `Raise the body font to 16px.\n\n${NEO_WORK_BLOCKER}`,
      },
    });
    expect(
      driverWorkCall({ ...startTarget, adapter: 'hyperneo', model: 'glm-5.3' }, work).input
    ).toMatchObject({ adapter: 'hyperneo', model: 'glm-5.3' });
  });
});

describe('withWorkGoal', () => {
  test('appends the goal and checklist, and gives every brief the blocker line', () => {
    const goal = { workId: 'w1', goal: 'A full iOS app', doneWhen: '- runs in the simulator' };
    expect(withWorkGoal('Build the chat screen.', goal)).toBe(
      `Build the chat screen.\n\nNeo routed this to you: do it here, not by handing it to another session or chat.\nWhat the human asked: A full iOS app\nDone when:\n- runs in the simulator\n${NEO_WORK_GOAL_REMAINING}\n${NEO_WORK_BLOCKER}`
    );
    expect(withWorkGoal('Build the chat screen.', null)).toBe(
      `Build the chat screen.\n\n${NEO_WORK_BLOCKER}`
    );
    const longest = withWorkGoal('i'.repeat(16000), {
      workId: 'w1',
      goal: 'g'.repeat(1000),
      doneWhen: 'd'.repeat(2000),
    });
    expect(longest.length).toBeLessThanOrEqual(20000);
    const merging = withWorkGoal('i'.repeat(16000), {
      workId: 'w1',
      goal: 'g'.repeat(1000),
      doneWhen: `merged ${'d'.repeat(1993)}`,
    });
    expect(merging.length).toBeLessThanOrEqual(20000);
    expect(merging).toContain('mergeStateStatus,mergeable');
    expect(merging.endsWith(`${NEO_WORK_GOAL_REMAINING}\n${NEO_WORK_BLOCKER}`)).toBe(true);
    expect(withWorkGoal('Build it.', { workId: 'w1', goal: null, doneWhen: null })).toBe(
      `Build it.\n\n${NEO_WORK_BLOCKER}`
    );
  });

  test('tells a session whose done means merging to run the merge on its own', () => {
    const merged = { workId: 'w1', goal: 'Fix it', doneWhen: '- squash-merged to dev' };
    expect(withWorkGoal('Fix it.', merged)).toContain(
      'run `gh pr merge <number> --squash` as a command of its own'
    );
    expect(
      withWorkGoal('Fix it.', { ...merged, doneWhen: '- runs in the simulator' })
    ).not.toContain('gh pr merge');
  });

  test.each([true, false])(
    'keeps the review gate in the card brief when eventsDelivered is %s',
    (eventsDelivered) => {
      const goal = { workId: 'w1', goal: 'Fix it', doneWhen: '- squash-merged to dev' };
      const brief = withWorkGoal('Fix it.', goal, eventsDelivered);
      expect(brief).toContain("Follow the repository's review requirements");
      expect(brief).toContain('Never enable GitHub auto-merge');
      expect(brief).toContain('review approval of the latest head commit');
      expect(brief).toContain("using the repository's own ready signal");
      expect(brief).toContain('all required checks to pass before manually merging');
      expect(brief).toContain('When review is required, a new commit needs fresh review approval');
      expect(brief).toContain('If another actor owns the merge, leave it to them');
      expect(brief).toContain('review and check requirements above to be met on the latest head');
      expect(brief).toContain('then try the merge again if you own it');
      expect(
        withWorkGoal('Fix it.', { ...goal, doneWhen: '- runs in the simulator' }, eventsDelivered)
      ).not.toContain('auto-merge');
    }
  );

  test('tells a session whose done means merging to resolve the threads it addresses', () => {
    const merged = { workId: 'w1', goal: 'Fix it', doneWhen: '- squash-merged to dev' };
    expect(withWorkGoal('Fix it.', merged)).toContain('resolveReviewThread');
    expect(
      withWorkGoal('Fix it.', { ...merged, doneWhen: '- runs in the simulator' })
    ).not.toContain('resolveReviewThread');
  });

  test('tells a session whose done means merging to find and fix why a merge was refused', () => {
    const merged = { workId: 'w1', goal: 'Fix it', doneWhen: '- squash-merged to dev' };
    expect(withWorkGoal('Fix it.', merged)).toContain('mergeStateStatus,mergeable');
    expect(
      withWorkGoal('Fix it.', { ...merged, doneWhen: '- runs in the simulator' })
    ).not.toContain('mergeStateStatus');
  });

  test("tells a session whose done means merging that its pull request's events reach it", () => {
    const merged = { workId: 'w1', goal: 'Fix it', doneWhen: '- squash-merged to dev' };
    expect(withWorkGoal('Fix it.', merged)).toContain('with no subscription needed');
    expect(withWorkGoal('Fix it.', merged)).not.toContain('event.external.subscribe');
    expect(
      withWorkGoal('Fix it.', { ...merged, doneWhen: '- runs in the simulator' })
    ).not.toContain('with no subscription needed');
    expect(withWorkGoal('Fix it.', merged, false)).toContain('event.external.subscribe');
    expect(withWorkGoal('Fix it.', merged, false)).not.toContain('with no subscription needed');
  });
});

describe('driverWorkCaller', () => {
  test('runs as Neo from the session that proposed the work', () => {
    expect(driverWorkCaller({ originSessionId: 'neo:root' })).toEqual({
      source: 'internal',
      sessionId: 'neo:root',
      role: 'neo',
    });
  });
});

describe('readDriverOutcome', () => {
  test('retains reported effort and ignores malformed effort without inventing a value', () => {
    const ref = { adapter: 'codex-desktop', id: 't1' };
    for (const effort of ['medium', undefined, null, 3, { value: 'high' }]) {
      expect(
        readDriverOutcome(startTarget, {
          kind: 'completed',
          value: { ok: true, value: { ref, model: 'gpt-6.1-sol', effort } },
        })
      ).toEqual({
        ref,
        model: 'gpt-6.1-sol',
        ...(typeof effort === 'string' ? { effort } : {}),
      });
    }
  });

  test('keeps the started ref, or the sent-to ref, and explains every failure', () => {
    const started = { ref: { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' }, title: 'x' };
    expect(
      readDriverOutcome(startTarget, { kind: 'completed', value: { ok: true, value: started } })
    ).toEqual({ ref: started.ref });
    expect(
      readDriverOutcome(startTarget, {
        kind: 'completed',
        value: { ok: true, value: { ...started, model: 'gpt-6-luna' } },
      })
    ).toEqual({ ref: started.ref, model: 'gpt-6-luna' });
    expect(
      readDriverOutcome(sendTarget, {
        kind: 'completed',
        value: { ok: true, value: { delivered: false } },
      })
    ).toEqual({ ref: sendTarget.ref, queued: true });
    expect(
      readDriverOutcome(sendTarget, {
        kind: 'completed',
        value: { ok: true, value: { delivered: true } },
      })
    ).toEqual({ ref: sendTarget.ref });
    expect(
      readDriverOutcome(sendTarget, {
        kind: 'completed',
        value: { ok: false, reason: 'not_open', detail: 'archived' },
      })
    ).toEqual({ failure: 'not_open: archived', reason: 'not_open' });
    expect(
      readDriverOutcome(startTarget, { kind: 'failed', code: 'execution_failed', message: 'boom' })
    ).toEqual({ failure: 'boom' });
    const receipt = { executionId: 'cli-1', inputId: 'u-1' };
    expect(
      readDriverOutcome(startTarget, {
        kind: 'completed',
        value: { ok: true, value: { ...started, receipt } },
      })
    ).toEqual({ ref: started.ref, receipt });
    expect(
      readDriverOutcome(startTarget, {
        kind: 'completed',
        value: { ok: true, value: { ...started, receipt: { inputId: 'u-1' } } },
      })
    ).toEqual({ ref: started.ref });
    expect(readDriverOutcome(startTarget, { kind: 'completed', value: 'nope' })).toEqual({
      failure: 'The work operation returned an unusable reply.',
    });
  });
});

describe('readDriverSendBaseline', () => {
  test('takes the send baseline from an idle target, and none from a busy or unreadable remote one', () => {
    const at = (value: unknown) => ({ kind: 'completed' as const, value });
    expect(
      readDriverSendBaseline(
        at({ ok: true, value: { status: 'done', lastActivityAt: 7 } }),
        50,
        true
      )
    ).toBe(7);
    expect(
      readDriverSendBaseline(
        at({ ok: true, value: { status: 'running', lastActivityAt: 7 } }),
        50,
        false
      )
    ).toBeNull();
    const unreadable = at({ ok: false, reason: 'unreachable', detail: 'asleep' });
    expect(readDriverSendBaseline(unreadable, 50, false)).toBe(50);
    expect(readDriverSendBaseline(unreadable, 50, true)).toBeNull();
  });
});

describe('readDriverSent and readDriverLanded', () => {
  const at = (value: unknown) => ({ kind: 'completed' as const, value });
  const status = (recentInputs?: Array<{ at: number; text: string }>) =>
    at({ ok: true, value: { status: 'done', lastActivityAt: 9, recentInputs } });

  test('notes the latest input before the send and the opening of what Neo sends', () => {
    expect(
      readDriverSent(status([{ at: 4, text: 'earlier' }]), '  Raise the  font.\nThen stop.')
    ).toEqual({ inputBefore: 4, opening: 'Raise the font.' });
    expect(readDriverSent(status([]), 'Go on.')).toEqual({ inputBefore: 0, opening: 'Go on.' });
    expect(readDriverSent(status(), 'Go on.', 700)).toEqual({
      inputBefore: 700,
      opening: 'Go on.',
    });
    expect(readDriverSent(status([]), '   ')).toBeNull();
  });

  test.each<[string, DriverSent | null, string, DriverSent | null]>([
    [
      'a recorded send',
      { inputBefore: 4, opening: 'Go on.' },
      'Raise it.',
      { inputBefore: 4, opening: 'Go on.' },
    ],
    [
      'a send recorded without its opening',
      null,
      'Raise it.\nThen stop.',
      { inputBefore: 900, opening: 'Raise it.' },
    ],
    ['a card with no instruction', null, '', null],
  ])('neoCardSent keeps %s findable from the card on', (_label, stored, instruction, sent) => {
    expect(neoCardSent(stored, { instruction, createdAt: 900 })).toEqual(sent);
  });

  test('neoCardSent has nothing to find for a missing card', () => {
    expect(neoCardSent(null, null)).toBeNull();
  });

  test('anchors only on Neo’s own message landing after the send, not on one the human typed', () => {
    const sent = { inputBefore: 4, opening: 'Raise the font.' };
    expect(
      readDriverLanded(
        status([
          { at: 3, text: 'Raise the font. (an older ask)' },
          { at: 6, text: 'actually, also fix the footer' },
          { at: 8, text: 'Raise the font. Neo routed this to you' },
        ]),
        sent
      )
    ).toBe(8);
    expect(
      readDriverLanded(status([{ at: 6, text: 'actually, also fix the footer' }]), sent)
    ).toBeNull();
    expect(readDriverLanded(status([{ at: 8, text: 'Raise the font.' }]), null)).toBeNull();
    expect(readDriverLanded(status(), sent)).toBeNull();
  });
});

describe('driverExchangeReport', () => {
  const agent = (at: number, text: string) => ({ at, role: 'agent' as const, text });
  const user = (at: number, text: string) => ({ at, role: 'user' as const, text });

  test('includes only replies before the next input', () => {
    expect(
      driverExchangeReport(
        [
          user(1, 'Raise the font. Neo routed this to you'),
          agent(2, 'Looking.'),
          user(3, 'also the footer'),
          agent(4, 'Both done.'),
        ],
        false,
        'Raise the font.'
      )
    ).toBe('Agent: Looking.');
    expect(
      driverExchangeReport(
        [
          user(1, 'Raise the font. Neo routed this to you'),
          user(2, 'Raise the font. I mean the footer too'),
          agent(3, 'Done.'),
        ],
        false,
        'Raise the font.'
      )
    ).toBeNull();
    expect(driverExchangeReport([user(1, 'hi')], false, null)).toBeNull();
    expect(driverExchangeReport(undefined, false, null)).toBeNull();
  });

  test('says when earlier messages were not read and trims the middle to fit', () => {
    expect(driverExchangeReport([agent(1, 'Done.')], true, null)).toBe(
      '(Earlier messages were not read; this is not the whole exchange.)\n\nAgent: Done.'
    );
    const long = Array.from({ length: 10 }, (_, index) => agent(index, `${index}`.repeat(3_000)));
    const report = driverExchangeReport(long, false, null) ?? '';
    expect(report.length).toBeLessThanOrEqual(12_000);
    expect(report.startsWith(`Agent: ${'0'.repeat(3_000)}`)).toBe(true);
    expect(report.endsWith(`Agent: ${'9'.repeat(3_000)}`)).toBe(true);
    expect(report).toContain('messages in between trimmed.');
  });
});

describe('Neo work with a drivers target', () => {
  function fileUnderAsk(service: NeoService, workId = 'work-1') {
    const ask = service.askRecords.open({
      id: `ask-${workId}`,
      requestKey: `neo:root:${workId}`,
      projectId: null,
      originSessionId: 'neo:root',
      originMessageId: 'ask-1',
      title: 'Fix it',
      ask: 'Fix it',
      doneWhen: '- merged',
      doneSource: 'human',
    })!;
    service.askRecords.link(ask.id, workId);
    return ask;
  }

  async function setup(
    reply: unknown,
    during?: (service: NeoService) => Promise<void>,
    status: (input: Record<string, unknown>) => unknown = () => ({
      ok: false,
      reason: 'unreachable',
      detail: 'down',
    }),
    target: NeoDriverTarget = startTarget,
    find: (input: Record<string, unknown>) => unknown = () => ({ places: [], unreachable: [] })
  ) {
    const db = await createTestDb();
    const calls: Array<{ name: string; input: unknown; caller: OperationCaller }> = [];
    let service: NeoService;
    const operation = (name: string) =>
      defineOperation({
        name,
        description: name,
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        execute: async (input, caller) => {
          calls.push({ name, input, caller });
          if (name === 'work.start') await during?.(service);
          if (name === 'work.status') return status(input);
          if (name === 'work.find') return find(input);
          return name === 'work.stop'
            ? { ok: true, value: { stopped: true } }
            : typeof reply === 'function'
              ? reply(input)
              : reply;
        },
      });
    const registry = createOperationRegistry([
      operation('work.start'),
      operation('work.send'),
      operation('work.stop'),
      operation('work.status'),
      operation('work.find'),
    ]);
    service = new NeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    const proposed = service.driverTargets.propose(
      service.repo,
      {
        id: 'work-1',
        requestKey: 'root:font',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: work.title,
        instruction: work.instruction,
      },
      target
    );
    return { db, service, calls, proposed };
  }

  function independentlyMerged(service: NeoService, urls: string[]) {
    const at = Date.now() + 60_000;
    const reader = mock(async (refs: NeoRef[]) =>
      refs.flatMap((ref) => {
        const url = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
        return urls.includes(url)
          ? [
              {
                url,
                kind: 'pr' as const,
                state: 'MERGED' as const,
                at,
                done: true,
                closedBy: null,
              },
            ]
          : [];
      })
    );
    service.readRefStates = reader;
    return reader;
  }

  const archivedRef = { adapter: 'claude-desktop', id: 'archived' };
  const worker = (id: string, overrides: Partial<WorkSummary> = {}): WorkSummary => ({
    ref: { ...archivedRef, id },
    title: id,
    place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' },
    status: 'done',
    lastActivityAt: 100,
    ...overrides,
  });
  const found = (workers: WorkSummary[]) => ({
    places: workers.map((item) => ({
      place: item.place,
      lastActivityAt: item.lastActivityAt,
      openCount: 1,
      archivedCount: 0,
      adapters: [item.ref.adapter],
      work: [item],
    })),
    unreachable: [],
  });
  const statusReply = () => ({ ok: true, value: { status: 'done', lastActivityAt: 10 } });

  test('replacement selection preserves the project, daemon and adapter and skips every non-idle candidate', () => {
    const original = worker('archived');
    const candidates = [
      worker('older', { lastActivityAt: 50 }),
      worker('newer'),
      worker('remote', { ref: { ...archivedRef, id: 'remote', daemon: 'remote' } }),
      worker('adapter', { ref: { adapter: 'codex-desktop', id: 'adapter' } }),
      worker('machine', { place: { ...original.place, machine: 'remote' } }),
      worker('project', { place: { ...original.place, folder: '/other' } }),
      worker('space', { place: { ...original.place, spaceId: 'other' } }),
      worker('busy', { busy: true }),
      worker('loaded', { liveCards: 1 }),
      ...(['queued', 'running', 'needs_you', 'stopped', 'failed'] as const).map((status) =>
        worker(status, { status })
      ),
    ];
    expect(pickNeoReplacementWorkers(candidates, original, new Set())).toEqual([
      worker('newer').ref,
      worker('older').ref,
    ]);
    expect(pickNeoReplacementWorkers(candidates, undefined, new Set())).toEqual([]);
    expect(
      pickNeoReplacementWorkers(
        candidates,
        { ...original, place: { machine: 'laptop', name: 'Chats' } },
        new Set()
      )
    ).toEqual([]);
  });

  test('reserving a replacement skips a worker already reserved by another card', async () => {
    const { db, service } = await setup({ ok: false, reason: 'not_open', detail: 'archived' });
    try {
      service.driverTargets.propose(
        service.repo,
        {
          id: 'other-card',
          requestKey: 'other-card',
          projectId: null,
          originSessionId: 'neo:root',
          originMessageId: 'ask-1',
          ...work,
        },
        { verb: 'send', ref: worker('claimed').ref }
      );
      const original = service.repo.getWork('work-1')!;
      expect(
        service.driverTargets.reassign(service.repo, original, [
          worker('claimed').ref,
          worker('free').ref,
        ])?.target
      ).toEqual({ verb: 'send', ref: worker('free').ref });
    } finally {
      db.close();
    }
  });

  test('stuck reminders step through the schedule and end on abandoned', () => {
    expect(decideStuckReminder(0, NEO_WORK_STUCK_STEPS_MS[0] - 1)).toBeNull();
    expect(decideStuckReminder(0, NEO_WORK_STUCK_STEPS_MS[0])).toEqual({
      due: NEO_WORK_STUCK_STEPS_MS[0],
      abandoned: false,
    });
    expect(decideStuckReminder(10, 10 + NEO_WORK_STUCK_STEPS_MS[3] + 5)).toEqual({
      due: 10 + NEO_WORK_STUCK_STEPS_MS[3],
      abandoned: true,
    });
  });

  test("card status follows the session only after Neo's message landed and stays done after a reply", () => {
    const running = { status: 'running' as const, lastActivityAt: 30 };
    expect(decideCardLiveStatus(running, null, null)).toBe('queued');
    expect(decideCardLiveStatus({ status: 'stopped', lastActivityAt: 30 }, null, null)).toBe(
      'stopped'
    );
    expect(decideCardLiveStatus(running, 10, null)).toBe('running');
    expect(decideCardLiveStatus({ status: 'done', lastActivityAt: 30 }, 10, null)).toBe('running');
    expect(
      decideCardLiveStatus({ status: 'done', lastActivityAt: 30, lastReplyAt: 20 }, 10, null)
    ).toBe('done');
    expect(decideCardLiveStatus({ ...running, lastReplyAt: 20 }, 10, 'done')).toBe('done');
    expect(decideCardLiveStatus({ ...running, lastReplyAt: 20 }, 10, 'running')).toBe('running');
    expect(decideCardLiveStatus({ ...running, lastReplyAt: 5 }, 10, 'done')).toBe('running');
    expect(
      decideCardLiveStatus({ status: 'needs_you', lastActivityAt: 30, lastReplyAt: 20 }, 10, null)
    ).toBe('needs_you');
  });

  async function undelivered(approved: boolean) {
    const ready = await setup({ ok: false, reason: 'not_delivered', detail: 'down' });
    const delivered: string[] = [];
    ready.db.createSession(createTestSession('neo:root'));
    Object.assign(ready.service, {
      open: async () => 'neo:root',
      deliver: async (_target: string, messageId: string) => {
        delivered.push(messageId);
      },
    });
    const ask = fileUnderAsk(ready.service);
    if (approved) ready.service.askRecords.approve(ask.id, Date.now());
    return { ...ready, delivered };
  }
});

describe('readDriverSettlement', () => {
  const work = { updatedAt: 100 };
  const status = (value: Record<string, unknown>) => ({
    kind: 'completed' as const,
    value: { ok: true, value: { lastActivityAt: 200, ...value } },
  });

  test('settles finished, failed and stopped work that moved after it was handed over', () => {
    const settle = (outcome: Parameters<typeof readDriverSettlement>[1], now = 150) =>
      readDriverSettlement(work, outcome, now);
    expect(settle(status({ status: 'done', lastReply: 'Shipped.' }))).toEqual({
      status: 'reported',
      report: `${NEO_WORK_UNVERIFIED_REPLY_NOTE}\n\nShipped.`,
    });
    expect(settle(status({ status: 'done' }))).toEqual({
      status: 'reported',
      report: 'It finished without a written reply.',
    });
    expect(settle(status({ status: 'failed', lastReply: 'Tests broke.' }))).toEqual({
      status: 'failed',
      report: `It failed. ${NEO_WORK_UNVERIFIED_REPLY_NOTE}\n\nTests broke.`,
    });
    expect(settle(status({ status: 'stopped' }))).toEqual({
      status: 'failed',
      report: 'It stopped.',
    });
  });

  test('compares status with the start time the backend reported, on its own clock', () => {
    const work = { updatedAt: 100 };
    const done = {
      kind: 'completed' as const,
      value: { ok: true, value: { status: 'done', lastActivityAt: 250 } },
    };
    expect(readDriverSettlement(work, done, 150, 300)).toBeNull();
    expect(readDriverSettlement(work, done, 150, 200)).toMatchObject({ status: 'reported' });
  });

  test('never settles on activity older than a send or continue, even after the grace', () => {
    const work = { updatedAt: 100 };
    const stale = {
      kind: 'completed' as const,
      value: { ok: true, value: { status: 'done', lastActivityAt: 50, lastReply: 'Old reply.' } },
    };
    const later = 100 + 10 * 60_000;
    expect(readDriverSettlement(work, stale, later, 100)).toMatchObject({ status: 'reported' });
    expect(readDriverSettlement(work, stale, later, 100, true)).toBeNull();
  });

  test('settles an unanchored send on the latest reply once the session has been quiet for hours', () => {
    const work = { updatedAt: 100 };
    const reply = (lastReplyAt: number, status = 'done') => ({
      kind: 'completed' as const,
      value: {
        ok: true,
        value: { status, lastActivityAt: 1_000, lastReplyAt, lastReply: 'Shipped it.' },
      },
    });
    const quiet = 1_000 + NEO_WORK_UNANCHORED_SETTLE_MS;
    expect(readDriverSettlement(work, reply(900), quiet - 1, null, true)).toBeNull();
    expect(readDriverSettlement(work, reply(50), quiet, null, true)).toBeNull();
    expect(readDriverSettlement(work, reply(900, 'running'), quiet, null, true)).toBeNull();
    expect(readDriverSettlement(work, reply(900), quiet, null, true)).toEqual({
      status: 'reported',
      report: `${NEO_WORK_UNANCHORED_NOTE}\n\nShipped it.`,
    });
  });

  test('keeps waiting on running, unreachable or unreadable status and briefly on stale status, and fails gone work', () => {
    const settle = (outcome: Parameters<typeof readDriverSettlement>[1], now = 150) =>
      readDriverSettlement(work, outcome, now);
    expect(settle(status({ status: 'running' }))).toBeNull();
    expect(settle(status({ status: 'needs_you' }))).toBeNull();
    expect(settle(status({ status: 'done', lastActivityAt: 100 }))).toBeNull();
    expect(settle(status({ status: 'done', lastActivityAt: 100 }), 100 + 10 * 60_000)).toEqual({
      status: 'reported',
      report: 'It finished without a written reply.',
    });
    expect(
      settle({
        kind: 'completed',
        value: { ok: false, reason: 'unreachable', detail: 'laptop asleep' },
      })
    ).toBeNull();
    expect(settle({ kind: 'completed', value: 'nope' })).toBeNull();
    expect(settle({ kind: 'failed', code: 'execution_failed', message: 'boom' })).toBeNull();
    expect(
      settle({
        kind: 'completed',
        value: { ok: false, reason: 'not_found', detail: 'thread deleted' },
      })
    ).toEqual({ status: 'failed', report: 'The work is gone: thread deleted' });
  });
});
