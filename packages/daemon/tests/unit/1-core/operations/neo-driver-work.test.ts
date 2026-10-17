import { describe, expect, mock, spyOn, test } from 'bun:test';
import { hostname } from 'node:os';
import { NEO_WORK_BLOCKER, NEO_WORK_GOAL_REMAINING } from '@hyperneo/prompts';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { NEO_WORK_CLOSED_DONE } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import type { WorkRef, WorkSummary } from '../../../../src/lib/drivers/types.ts';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { NEO_CARD_UNCHECKED_MS } from '../../../../src/lib/neo/card-check.ts';
import {
  NEO_DELIVERY_RETRY_BACKOFF_MS,
  NEO_WORK_DELIVERY_RETRY,
  runNeoDeliveryRetry,
} from '../../../../src/lib/neo/delivery-retry.ts';
import {
  type DriverSent,
  decideCardLiveStatus,
  decideStuckReminder,
  driverDoneCheckNote,
  driverExchangeReport,
  driverStartedReport,
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
  neoNoteCards,
  neoWorkProgress,
  planNeoStartReceiptAdoption,
  readDriverLanded,
  readDriverNeedsYou,
  readDriverOutcome,
  readDriverSendBaseline,
  readDriverSent,
  readDriverSettlement,
  readNeoStartFolder,
  requireNeoStartFolder,
  requireNeoWorkRetryable,
  withWorkGoal,
} from '../../../../src/lib/neo/driver-work.ts';
import { neoEvidenceSignature } from '../../../../src/lib/neo/evidence.ts';
import {
  createNeoOperations,
  requireNeoExecutionChoice,
  requireNeoProposalAsk,
  requireNeoWorkContinuation,
  requireNeoWorkRetryCaller,
} from '../../../../src/lib/neo/operations.ts';
import type { NeoRef } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { neoCardPrFacts } from '../../../../src/lib/neo/packs/coding/card-facts.ts';
import { lifeAdminReportEvidence } from '../../../../src/lib/neo/packs/life-admin/pack.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  NEO_WORK_AWAITING_WORKER,
  pickNeoReplacementWorkers,
} from '../../../../src/lib/neo/work-reroute.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import { withNeoProposalAsk } from '../../helpers/neo-proposal-ask.ts';
import { SessionEventSubscriptionRepository } from '../../../../src/storage/repositories/session-event-subscription-repository.ts';

const place = { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen', daemon: 'laptop' };
const retryVia = async (service: NeoService, id = 'work-1') => {
  const outcome = await invokeOperation(
    createOperationRegistry(createNeoOperations(service)),
    'neo.work.retry',
    { id },
    { source: 'rpc', principal: 'local' }
  );
  return 'value' in outcome ? outcome.value : outcome;
};
const approveReplacement = async (service: NeoService, id = 'work-1') => {
  const ask = service.askRecords.forWork(id)!;
  const question = ask.doneItems!.find((item) => item.state === 'needs_you' && !item.removed)!;
  expect(question).toMatchObject({
    question: `开始「${service.repo.getWork(id)!.title}」？`,
    options: ['先不做', '开始'],
  });
  expect(
    await invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.ask.answer',
      { askId: ask.id, itemId: question.id, choice: '开始', expectedRevision: ask.revision },
      { source: 'rpc', principal: 'local' }
    )
  ).toMatchObject({ value: { ok: true } });
};
const startTarget: NeoDriverTarget = { verb: 'start', adapter: 'codex-desktop', place };
const sendTarget: NeoDriverTarget = {
  verb: 'send',
  ref: { adapter: 'hyperneo', id: 's1' },
};
const work = { title: 'Bigger font', instruction: 'Raise the body font to 16px.' };

describe('requireNeoWorkRetryCaller', () => {
  test('refuses another Neo session in words about retrying, not continuing', () => {
    const work = { id: 'w1', originSessionId: 'neo:root' } as NeoWork;
    const other = { source: 'mcp' as const, sessionId: 'neo:other' };
    expect(requireNeoWorkRetryCaller(work, other)).toEqual({
      reason: {
        ok: false,
        reason:
          'Only the Neo session that proposed this work, Neo answering the human’s own chat message, or the user can retry it.',
      },
    });
    expect(requireNeoWorkContinuation(work, other)).toEqual({
      reason: {
        ok: false,
        reason:
          'Only the Neo session that proposed this work, Neo answering the human’s own chat message, or the user can continue it.',
      },
    });
    expect(requireNeoWorkRetryCaller(work, { source: 'mcp', sessionId: 'neo:root' })).toEqual({
      value: work,
    });
  });
});

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

describe('done-check note data', () => {
  const ask = {
    id: 'a1',
    originSessionId: 'neo:root',
    status: 'open',
    doneWhen: '- merged\n- deployed',
    doneItems: [
      { id: 'i1', text: 'merged', state: 'met', removed: false },
      { id: 'i2', text: 'deployed', state: 'pending', removed: false },
      { id: 'i3', text: 'gone', state: 'pending', removed: true },
    ],
    workIds: ['w1'],
  } as unknown as NeoAsk;
  test('items carry text only until met, and the done list is not repeated', () => {
    const note = driverDoneCheckNote(
      { id: 'w1', title: 'Ship', report: 'Merged.', originSessionId: 'neo:root' },
      { workId: 'w1', goal: 'Ship it', doneWhen: '- merged\n- deployed' },
      2,
      {
        ask,
        facts: neoCardPrFacts(
          [
            {
              url: 'u',
              state: 'MERGED',
              checks: 'passing',
              review: 'approved',
              title: 'x',
              createdAt: 1,
            },
          ],
          false
        ),
      }
    );
    const data = JSON.parse(note.slice(note.indexOf('\n{')));
    expect(data.items).toEqual([
      { id: 'i1', state: 'met' },
      { id: 'i2', state: 'pending', text: 'deployed' },
    ]);
    expect(data.card.doneWhen).toBeUndefined();
    expect(data.askDoneWhen).toBeUndefined();
    expect(data.card.prs).toEqual([
      { url: 'u', state: 'MERGED', checks: 'passing', review: 'approved' },
    ]);
    expect(note).not.toContain('wakes for this card bring no new commit');
  });
  test('a done list the items do not restate stays: a preamble, or a card list of its own', () => {
    const note = (goalDoneWhen: string, askDoneWhen: string) =>
      JSON.parse(
        ((text) => text.slice(text.indexOf('\n{')))(
          driverDoneCheckNote(
            { id: 'w1', title: 'Ship', report: null, originSessionId: 'neo:root' },
            { workId: 'w1', goal: 'Ship it', doneWhen: goalDoneWhen },
            0,
            { ask: { ...ask, doneWhen: askDoneWhen } }
          )
        )
      );
    const own = note('- docs updated', '- merged\n- deployed');
    expect(own.card.doneWhen).toBe('- docs updated');
    expect(own.askDoneWhen).toBeUndefined();
    const preamble = note(
      'Both, on the laptop:\n- merged\n- deployed',
      'Both, on the laptop:\n- merged\n- deployed'
    );
    expect(preamble.card.doneWhen).toContain('on the laptop');
    expect(preamble.askDoneWhen).toContain('on the laptop');
  });

  test('another card shows one PR verdict, the first one not done', () => {
    const pr = (state: NeoWorkPr['state'], checks: NeoWorkPr['checks']) =>
      ({ url: 'u', state, checks, review: 'none' }) as NeoWorkPr;
    expect(
      neoNoteCards([
        {
          id: 'w2',
          title: 'Docs',
          status: 'queued',
          prs: [pr('MERGED', 'passing'), pr('OPEN', 'failing')],
        },
        { id: 'w3', title: 'Quiet', status: 'proposed' },
      ])
    ).toEqual([
      { id: 'w2', title: 'Docs', status: 'queued', pr: 'failed' },
      { id: 'w3', title: 'Quiet', status: 'proposed' },
    ]);
  });
});

describe('requireNeoProposalAsk', () => {
  const neo = { source: 'mcp' as const, sessionId: 'neo:root', role: 'neo' as const };
  const human = { source: 'rpc' as const, principal: 'local' as const };

  test('refuses a Neo proposal without an ask, a done list no longer standing in for one', () => {
    for (const input of [{}, { doneWhen: '- merged' }])
      expect(requireNeoProposalAsk(input, neo)).toMatchObject({
        reason: { ok: false, reason: expect.stringContaining('ask_required') },
      });
    expect(requireNeoProposalAsk({ askId: 'a1' }, neo)).toEqual({ value: neo });
  });

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

describe('requireNeoStartFolder', () => {
  const start = (folder: string, extra: Record<string, unknown> = {}): NeoDriverTarget => ({
    verb: 'start',
    adapter: 'claude-desktop',
    place: { machine: 'laptop', folder, name: 'hn', ...extra },
  });

  test('refuses a local start in a folder that does not exist, and nothing else', () => {
    const missing = start('/Users/lsm/focus/hn-neo-test-5554');
    expect(
      requireNeoStartFolder(
        missing,
        readNeoStartFolder(missing, () => false),
        'v'
      )
    ).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining('Never invent a folder') },
    });
    expect(
      requireNeoStartFolder(
        missing,
        readNeoStartFolder(missing, () => true),
        'v'
      )
    ).toEqual({
      value: 'v',
    });
    const remote = start('/elsewhere', { daemon: 'tts' });
    expect(readNeoStartFolder(remote, () => false)).toEqual({ exists: null });
    const created = { ...start('/Users/lsm/new-app'), createFolder: true };
    expect(readNeoStartFolder(created, () => false)).toEqual({ exists: null });
    const send: NeoDriverTarget = { verb: 'send', ref: { adapter: 'claude-desktop', id: 'x' } };
    expect(
      requireNeoStartFolder(
        send,
        readNeoStartFolder(send, () => false),
        'v'
      )
    ).toEqual({
      value: 'v',
    });
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

describe('readDriverNeedsYou', () => {
  test('parses one status reply once, however many readers read it', () => {
    let statusReads = 0;
    const status = {
      get status() {
        statusReads += 1;
        return 'needs_you';
      },
      lastActivityAt: 7,
    };
    const outcome = { kind: 'completed' as const, value: { ok: true, value: status } };
    expect(readDriverNeedsYou(outcome)).toEqual({ needsYou: true, since: 7, lastReply: undefined });
    expect(readDriverNeedsYou(outcome)?.needsYou).toBe(true);
    expect(statusReads).toBe(1);
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
    expect(driverStartedReport(started.ref, undefined, 'gpt-6-luna')).toContain(
      'It runs on gpt-6-luna.'
    );
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

  test.each(['archived', 'ended'])(
    'reassigns a card rejected as %s to an idle worker in the same project',
    async (closed) => {
      const replacement = worker('idle');
      const { db, service, calls } = await setup(
        ({ ref }: { ref: WorkRef }) =>
          ref.id === 'archived'
            ? { ok: false, reason: 'not_open', detail: closed }
            : { ok: true, value: { delivered: true } },
        undefined,
        statusReply,
        { verb: 'send', ref: archivedRef },
        (input) =>
          found(
            input.id
              ? [worker('archived', { status: 'stopped' })]
              : [
                  worker('other-project', {
                    place: { machine: 'laptop', folder: '/focus/other', name: 'other' },
                  }),
                  worker('closed', { status: 'stopped' }),
                  worker('busy', { status: 'running' }),
                  worker('loaded', { liveCards: 1 }),
                  replacement,
                ]
          )
      );
      Object.assign(service, { returnReport: mock(async () => {}) });
      try {
        service.workGoals.record('work-1', 'Change the font', '- 16px');
        await service.start('work-1');
        expect(service.repo.getWork('work-1')?.status).toBe('proposed');
        expect(calls.filter((call) => call.name === 'work.send')).toHaveLength(1);
        await approveReplacement(service);
        expect(service.repo.getWork('work-1')).toMatchObject({
          status: 'queued',
          instruction: work.instruction,
        });
        expect(service.driverTargets.get('work-1')).toEqual({ verb: 'send', ref: replacement.ref });
        expect(service.driverTargets.readRef('work-1')).toEqual(replacement.ref);
        const sent = calls.filter((call) => call.name === 'work.send').map((call) => call.input);
        expect(sent).toEqual([
          { ref: archivedRef, message: expect.stringContaining('- 16px') },
          { ref: replacement.ref, message: expect.stringContaining('- 16px') },
        ]);
        expect((sent[0] as { message: string }).message).toBe(
          (sent[1] as { message: string }).message
        );
        await service.start('work-1');
        expect(calls.filter((call) => call.name === 'work.send')).toHaveLength(2);
      } finally {
        db.close();
      }
    }
  );

  test.each(['proposed', 'queued'] as const)(
    'respects a %s native Space-agent reservation when rerouting',
    async (status) => {
      const { db, service } = await setup({ ok: false, reason: 'not_open', detail: 'archived' });
      try {
        const held = service.agentTargets.propose(
          service.repo,
          {
            id: 'native-card',
            requestKey: 'native-card',
            projectId: null,
            originSessionId: 'neo:root',
            originMessageId: 'ask-1',
            targetSessionId: 'agent-session',
            ...work,
          },
          { spaceId: 'space', agentId: 'held', sessionId: 'agent-session' }
        );
        if (status === 'queued')
          service.repo.transitionWork(held.work.id, held.work, {
            status,
            sessionId: 'agent-session',
          });
        const free = { adapter: 'space', id: 'agent:free' };
        expect(
          service.driverTargets.reassign(service.repo, service.repo.getWork('work-1')!, [
            { adapter: 'space', id: 'agent:held' },
            free,
          ])?.target
        ).toEqual({ verb: 'send', ref: free });
        expect(service.repo.getWork(held.work.id)?.status).toBe(status);
      } finally {
        db.close();
      }
    }
  );

  test('returns an unassigned card to Neo without failing it, then retries the same card when a worker appears', async () => {
    let available = false;
    const { db, service, calls } = await setup(
      ({ ref }: { ref: WorkRef }) =>
        ref.id === 'archived'
          ? { ok: false, reason: 'not_open', detail: 'archived' }
          : { ok: true, value: { delivered: true } },
      undefined,
      statusReply,
      { verb: 'send', ref: archivedRef },
      (input) =>
        found(
          input.id ? [worker('archived', { status: 'stopped' })] : available ? [worker('idle')] : []
        )
    );
    const delivered = mock(async () => {});
    Object.assign(service, { deliver: delivered });
    try {
      await service.start('work-1');
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'proposed',
        report: NEO_WORK_AWAITING_WORKER,
      });
      expect(service.driverTargets.readRef('work-1')).toBeNull();
      expect(service.isRetryable('work-1')).toBe(true);
      expect(delivered).toHaveBeenCalledWith(
        'neo:root',
        expect.stringContaining('work-1'),
        expect.stringContaining('neo.work.retry'),
        'neo:root',
        expect.anything()
      );
      available = true;
      expect(await retryVia(service)).toMatchObject({
        ok: true,
        work: { id: 'work-1', status: 'proposed' },
      });
      await approveReplacement(service);
      expect(
        calls
          .filter((call) => call.name === 'work.send')
          .map((call) => (call.input as { ref: WorkRef }).ref.id)
      ).toEqual(['archived', 'idle']);
      expect(service.repo.listWork()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('waits for each replacement approval and preserves cancellation during discovery', async () => {
    let cancel: (() => Promise<void>) | undefined;
    const { db, service, calls } = await setup(
      { ok: false, reason: 'not_open', detail: 'archived' },
      undefined,
      statusReply,
      { verb: 'send', ref: archivedRef },
      async (input) => {
        await cancel?.();
        return found(input.id ? [worker(String(input.id))] : [worker('archived'), worker('stale')]);
      }
    );
    Object.assign(service, { deliver: mock(async () => {}) });
    try {
      await service.start('work-1');
      expect(service.repo.getWork('work-1')?.status).toBe('proposed');
      expect(calls.filter((call) => call.name === 'work.send')).toHaveLength(1);
      await approveReplacement(service);
      expect(calls.filter((call) => call.name === 'work.send')).toHaveLength(2);
      cancel = () => service.cancel('work-1');
      await approveReplacement(service);
      expect(service.repo.getWork('work-1')?.status).toBe('cancelled');
      expect(calls.filter((call) => call.name === 'work.send')).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test.each([
    [false, 'start'],
    [true, 'start'],
    [true, 'retry'],
  ] as const)(
    'an interrupted card resumes from stored state (reserved: %s, resume: %s)',
    async (reserved, resume) => {
      let available = reserved;
      const { db, service, calls } = await setup(
        ({ ref }: { ref: WorkRef }) =>
          ref.id === 'archived'
            ? { ok: false, reason: 'not_open', detail: 'archived' }
            : { ok: true, value: { delivered: true } },
        undefined,
        statusReply,
        { verb: 'send', ref: archivedRef },
        (input) =>
          found(
            input.id
              ? [worker(String(input.id), { status: input.id === 'archived' ? 'stopped' : 'done' })]
              : available
                ? [worker('idle')]
                : []
          )
      );
      const reassign = service.driverTargets.reassign.bind(service.driverTargets);
      spyOn(service.driverTargets, 'reassign').mockImplementation((...args) => {
        const saved = reassign(...args);
        if (saved?.target) throw new Error('interrupted');
        return saved;
      });
      Object.assign(service, {
        deliver: async () => {
          throw new Error('interrupted');
        },
      });
      try {
        await expect(service.start('work-1')).rejects.toThrow('interrupted');
        expect(service.repo.getWork('work-1')).toMatchObject({
          status: 'proposed',
          report: expect.stringContaining('worker'),
        });
        expect(service.driverTargets.get('work-1')).toEqual({
          verb: 'send',
          ref: reserved ? worker('idle').ref : archivedRef,
        });
        const restarted = new NeoService(
          db,
          service.sessions,
          { event: mock(() => {}) } as unknown as MessageHub,
          new InternalEventBus<DaemonInternalEventMap>()
        );
        Object.assign(restarted, { deliver: mock(async () => {}) });
        available = true;
        if (resume === 'retry') expect(await retryVia(restarted)).toMatchObject({ ok: true });
        else await restarted.start('work-1');
        expect(restarted.driverTargets.readRef('work-1')).toBeNull();
        expect(calls.filter((call) => call.name === 'work.send')).toHaveLength(1);
        await approveReplacement(restarted);
        expect(restarted.driverTargets.readRef('work-1')).toEqual(worker('idle').ref);
        expect(
          calls
            .filter((call) => call.name === 'work.send')
            .map((call) => (call.input as { ref: WorkRef }).ref.id)
        ).toEqual(['archived', 'idle']);
      } finally {
        db.close();
      }
    }
  );

  test.each(['unreachable', 'not_delivered', 'not_found'])(
    'keeps %s failures unchanged',
    async (reason) => {
      const { db, service, calls } = await setup(
        { ok: false, reason, detail: 'no send' },
        undefined,
        statusReply,
        { verb: 'send', ref: archivedRef }
      );
      Object.assign(service, { returnReport: mock(async () => {}) });
      try {
        await service.start('work-1');
        expect(service.repo.getWork('work-1')).toMatchObject({
          status: 'failed',
          report: `Could not start the execution: ${reason}: no send`,
        });
        expect(calls.some((call) => call.name === 'work.find')).toBe(false);
      } finally {
        db.close();
      }
    }
  );

  test('a card that stopped being checked still reads unchecked after a restart', async () => {
    const { db, service } = await setup({ ok: true, value: { ref: null } });
    const check = service as unknown as {
      recordCardCheck(workId: string, read: boolean, now: number): boolean;
    };
    try {
      check.recordCardCheck('work-1', true, 1_000);
      expect(check.recordCardCheck('work-1', false, 1_000 + NEO_CARD_UNCHECKED_MS + 1)).toBe(true);
      const restarted = new NeoService(
        db,
        { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
        { event: mock(() => {}) } as unknown as MessageHub,
        new InternalEventBus<DaemonInternalEventMap>()
      );
      expect(restarted.uncheckedSince('work-1')).toBe(1_000);
      expect(restarted.uncheckedSince('work-unknown')).toBeNull();
      expect(restarted.checkedAt('work-1')).toBe(1_000);
      expect(restarted.checkedAt('work-unknown')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('the minute pass forgets read throttles of cards it no longer follows', async () => {
    const { db, service } = await setup({ ok: true, value: { ref: null } });
    const throttles = service as unknown as {
      followReads: Map<string, number>;
      askEvidenceReads: Map<string, number>;
    };
    try {
      throttles.followReads.set('gone-card', 1);
      throttles.askEvidenceReads.set('gone-ask', 1);
      await service.refreshDriverWork();
      expect([...throttles.followReads.keys()]).toEqual([]);
      expect([...throttles.askEvidenceReads.keys()]).toEqual([]);
    } finally {
      db.close();
    }
  });

  test.each(['coding', 'legal', 'life-admin'])(
    'forwards preparation for independent %s cards only when their pack owns a stage',
    async (pack) => {
      const parameters = { target: 'release', prerequisiteCommits: ['a'.repeat(40)] };
      const target = NeoDriverTargetSchema.parse({
        ...startTarget,
        preparationParameters: parameters,
      });
      const { db, service, calls } = await setup(
        { ok: true, value: { ref: { adapter: 'codex-desktop', id: 'fresh' } } },
        undefined,
        undefined,
        target
      );
      service.filePacks = [
        {
          id: 'legal',
          describe: 'Legal',
          instructions: () => null,
          prepareExecution: async () => ({ ok: false, reason: 'not called here' }),
        },
      ];
      db.updateGlobalSettings({ neo: { packs: ['coding', 'legal', 'life-admin'] } });
      const ask = service.askRecords.open({
        id: 'a1',
        requestKey: 'pack-start',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 't',
        ask: 'a',
        doneWhen: '- done',
        doneSource: 'human',
        pack,
      })!;
      service.askRecords.link(ask.id, 'work-1');
      try {
        expect(service.driverTargets.get('work-1')).toEqual(target);
        await service.start('work-1');
        expect(calls).toHaveLength(1);
        const input = calls[0].input as Record<string, unknown>;
        expect(input.preparation).toEqual(pack === 'life-admin' ? undefined : { pack, parameters });
      } finally {
        service.dispose();
        db.close();
      }
    }
  );

  test.each([undefined, 'sol 6.1'])(
    'starts from a stored effort target with model %s',
    async (model) => {
      const target: NeoDriverTarget = {
        ...startTarget,
        ...(model ? { model } : {}),
        effort: 'medium',
      };
      const ref = { adapter: 'codex-desktop', id: 'configured' };
      const { db, service, calls } = await setup(
        { ok: true, value: { ref } },
        undefined,
        undefined,
        target
      );
      try {
        expect(service.driverTargets.get('work-1')).toEqual(target);
        expect(service.driverTargets.readCard('work-1')?.target).toEqual(target);
        await service.start('work-1');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ name: 'work.start', input: { effort: 'medium' } });
        expect((calls[0].input as Record<string, unknown>).model).toBe(model);
        expect(service.driverTargets.readRef('work-1')).toEqual(ref);
      } finally {
        service.dispose();
        db.close();
      }
    }
  );

  test('keeps the requested effort when a driver refuses it without a receipt', async () => {
    const { db, service } = await setup(
      { ok: false, reason: 'unsupported_effort', detail: 'Route cannot confirm effort.' },
      undefined,
      undefined,
      { ...startTarget, effort: 'medium' }
    );
    Object.assign(service, { returnReport: mock(async () => {}) });
    try {
      await service.start('work-1');
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'failed',
        report: 'Could not start the execution: unsupported_effort: Route cannot confirm effort.',
      });
      expect(service.driverTargets.get('work-1')).toEqual({ ...startTarget, effort: 'medium' });
      expect(service.driverTargets.readRef('work-1')).toBeNull();
      expect(service.driverTargets.receipts(['work-1'])[0]).not.toHaveProperty('model');
      expect(service.driverTargets.receipts(['work-1'])[0]).not.toHaveProperty('effort');
    } finally {
      service.dispose();
      db.close();
    }
  });

  test('starts the work through work.start as Neo and keeps the ref', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls, proposed } = await setup({ ok: true, value: { ref } });
    try {
      expect(proposed.target).toEqual(startTarget);
      await service.start('work-1');
      expect(calls).toEqual([
        {
          name: 'work.start',
          input: driverWorkCall(startTarget, work).input,
          caller: { source: 'internal', sessionId: 'neo:root', role: 'neo' },
        },
      ]);
      expect(service.repo.getWork('work-1')).toMatchObject({ status: 'queued', sessionId: null });
      expect(service.repo.getWork('work-1')?.report).toContain(
        `Follow up with work.status ${JSON.stringify({ ref })}`
      );
      expect(service.driverTargets.readRef('work-1')).toEqual(ref);
      await service.start('work-1');
      expect(calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test.each([
    { model: 'gpt-6.1-sol', effort: 'medium' },
    { model: 'gpt-6.1-sol' },
    { effort: 'low' },
    {},
  ])('records only observed start configuration %j and preserves it on retry', async (observed) => {
    const ref = { adapter: 'codex-desktop', id: 'configured-thread' };
    const target = { ...startTarget, model: 'sol 6.1', effort: 'high' };
    const { db, service, calls } = await setup(
      { ok: true, value: { ref, ...observed } },
      undefined,
      undefined,
      target
    );
    try {
      await service.start('work-1');
      const receipt = service.driverTargets.receipts(['work-1'])[0];
      for (const field of ['model', 'effort'] as const) {
        if (field in observed) expect(receipt[field]).toBe(observed[field]);
        else expect(receipt).not.toHaveProperty(field);
      }
      expect(service.driverTargets.get('work-1')).toEqual(target);
      expect(service.driverTargets.readRef('work-1')).toEqual(ref);
      await service.start('work-1');
      expect(calls).toHaveLength(1);
      expect(service.driverTargets.receipts(['work-1'])[0]).toEqual(receipt);
    } finally {
      service.dispose();
      db.close();
    }
  });

  test('stops work that was cancelled while it was starting', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls } = await setup({ ok: true, value: { ref } }, (neo) =>
      neo.cancel('work-1')
    );
    try {
      await service.start('work-1');
      expect(calls.map((call) => [call.name, call.input])).toEqual([
        ['work.start', driverWorkCall(startTarget, work).input],
        ['work.stop', { ref }],
      ]);
      expect(service.repo.getWork('work-1')?.status).toBe('cancelled');
    } finally {
      db.close();
    }
  });

  test('stops started work when it is cancelled later', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls } = await setup({ ok: true, value: { ref } });
    try {
      await service.start('work-1');
      await service.cancel('work-1');
      expect(calls.map((call) => call.name)).toEqual(['work.start', 'work.stop']);
      expect(service.repo.getWork('work-1')?.status).toBe('cancelled');
    } finally {
      db.close();
    }
  });

  test('the minute pass settles driver cards without loading every stored card', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'running', lastActivityAt: 0 },
    }));
    try {
      await service.start('work-1');
      Object.assign(service.repo, {
        listWork: () => {
          throw new Error('the minute pass must not list every card');
        },
      });
      await service.refreshDriverWork();
      expect(calls.map((call) => call.name)).toContain('work.status');
    } finally {
      db.close();
    }
  });

  test('records the input receipt a start returns on the card', async () => {
    const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 'local_1' };
    const receipt = { executionId: 'cli-1', inputId: 'u-1' };
    const { db, service } = await setup({ ok: true, value: { ref, receipt } });
    try {
      await service.start('work-1');
      expect(service.driverTargets.readSent('work-1')).toEqual({
        inputBefore: 0,
        opening: work.instruction,
        receipt,
      });
    } finally {
      db.close();
    }
  });

  test('settles started work from work.status once it finishes and reports back', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    let reply: unknown = { ok: true, value: { status: 'running', lastActivityAt: 0 } };
    const { db, service, calls } = await setup(
      { ok: true, value: { ref } },
      undefined,
      () => reply
    );
    const returned: string[] = [];
    Object.assign(service, {
      returnReport: async (settled: { id: string }) => {
        returned.push(settled.id);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
      expect(service.driverTargets.readSent('work-1')).toEqual({
        inputBefore: 0,
        opening: work.instruction,
      });
      reply = {
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: Date.now() + 1_000,
          lastReply: 'Font is 16px.',
          exchange: [
            { at: Date.now() + 500, role: 'user', text: work.instruction },
            { at: Date.now() + 900, role: 'agent', text: 'Font is 16px.' },
          ],
        },
      };
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'reported',
        report: 'Agent: Font is 16px.',
      });
      expect(returned).toEqual(['work-1']);
      const since = service.driverTargets.readSent('work-1')?.inputBefore;
      expect(calls.filter((call) => call.name === 'work.status').map((call) => call.input)).toEqual(
        [
          { ref, since },
          { ref, since },
        ]
      );
    } finally {
      db.close();
    }
  });

  test('drops Neo’s instruction from the report even when what it sent was never recorded', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: Date.now() + 1_000,
        lastReply: 'Font is 16px.',
        exchange: [
          { at: Date.now() + 500, role: 'user', text: `${work.instruction}\n\nNeo routed this` },
          { at: Date.now() + 900, role: 'agent', text: 'Font is 16px.' },
        ],
      },
    }));
    Object.assign(service, { returnReport: async () => {} });
    try {
      await service.start('work-1');
      service.driverTargets.recordSent('work-1', null);
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'reported',
        report: 'Agent: Font is 16px.',
      });
    } finally {
      db.close();
    }
  });

  test('refuses to retry a start into a folder that does not exist', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls } = await setup({ ok: true, value: { ref } });
    service.driverTargets.propose(
      service.repo,
      {
        id: 'work-2',
        requestKey: 'root:invented',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-2',
        title: 'Fix #5554',
        instruction: 'Fix it.',
      },
      {
        verb: 'start',
        adapter: 'claude-desktop',
        place: { machine: 'laptop', folder: '/nowhere/hn-neo-test-5554', name: 'hn' },
      }
    );
    try {
      const retried = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.work.retry',
        { id: 'work-2' },
        { source: 'rpc', principal: 'local' }
      );
      expect(retried).toMatchObject({
        value: { ok: false, reason: expect.stringContaining('does not exist') },
      });
      expect(calls.filter((call) => call.name === 'work.start')).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('a send card whose opening was never recorded finds its own message after the card began', async () => {
    let inputs: Array<{ at: number; text: string }> = [];
    const { db, service, calls } = await setup(
      { ok: true, value: { ref: sendTarget.ref } },
      undefined,
      () => ({
        ok: true,
        value: { status: 'running', lastActivityAt: 5_000, recentInputs: inputs },
      }),
      sendTarget
    );
    try {
      await service.start('work-1');
      const createdAt = service.repo.getWork('work-1')!.createdAt;
      inputs = [
        { at: createdAt - 10, text: `${work.instruction} (an older ask)` },
        { at: createdAt + 50, text: `${work.instruction}\n\nGoal: …` },
      ];
      service.driverTargets.recordStartedAt('work-1', null);
      service.driverTargets.recordSent('work-1', null);
      await service.refreshDriverWork();
      expect(calls.filter((call) => call.name === 'work.status').at(-1)?.input).toEqual({
        ref: sendTarget.ref,
        since: createdAt,
      });
      expect(service.driverTargets.readStartedAt('work-1')).toBe(createdAt + 50);
    } finally {
      db.close();
    }
  });

  test('looks for its sent message among the inputs after the baseline', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: {
        status: 'running',
        lastActivityAt: 5_000,
        recentInputs: [{ at: 2_000, text: 'Fix the bug please' }],
      },
    }));
    try {
      await service.start('work-1');
      service.driverTargets.recordStartedAt('work-1', null);
      service.driverTargets.recordSent('work-1', { inputBefore: 1_000, opening: 'Fix the bug' });
      await service.refreshDriverWork();
      expect(calls.filter((call) => call.name === 'work.status').at(-1)?.input).toEqual({
        ref,
        since: 1_000,
      });
      expect(service.driverTargets.readStartedAt('work-1')).toBe(2_000);
    } finally {
      db.close();
    }
  });

  test('asks the proposing session to check idle work against its done-when list', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: 'Skeleton builds.' },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'A full Neo iOS app', '- chat works\n- voice works');
    fileUnderAsk(service);
    const notes: Array<[string, string, string]> = [];
    Object.assign(service, {
      deliver: async (target: string, messageId: string, content: string) => {
        notes.push([target, messageId, content]);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('reported');
      expect(notes.map(([target, id]) => [target, id])).toEqual([
        ['neo:root', 'work-1:done-check:0'],
      ]);
      expect(notes[0][2]).not.toContain('Continuing it is refused');
      expect(
        JSON.parse(notes[0][2].slice(notes[0][2].indexOf('\n{'))).card.continuation
      ).toMatchObject({ prior_sends: 0, done_when_met: false });
      expect(notes[0][2]).toContain('- voice works');
      expect(notes[0][2]).toContain('Skeleton builds.');
      expect(service.workWakes.get('work-1')).toMatchObject({
        wakes: 1,
        note: 'work-1:done-check:0',
      });

      const still = neoWorkProgress(service.repo.getWork('work-1')!, null, null);
      for (let n = 0; n < 5; n++)
        service.workContinues.record('work-1', `Step ${n}`, Date.now(), still);
      for (let n = 0; n < 4; n++) service.workWakes.recordWake('work-1', `idle-${n}`, 'flat', n);
      await service.reconcile('work-1');
      expect(notes[1].slice(0, 2)).toEqual(['neo:root', 'work-1:done-check:5']);
      expect(notes[1][2]).not.toContain('continue_budget_spent');
      expect(notes[1][2]).not.toContain('It can no longer be continued.');
    } finally {
      db.close();
    }
  });

  test('checks work under an ask against the ask when the card has no checklist', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: 'Fixed and merged.' },
    }));
    db.createSession(createTestSession('neo:root'));
    const ask = service.askRecords.open({
      id: 'ask-1',
      requestKey: 'neo:root:fix',
      projectId: null,
      originSessionId: 'neo:root',
      originMessageId: null,
      title: 'Fix the bug',
      ask: 'Fix the login bug',
      doneWhen: '- merged to dev',
      doneSource: 'human',
    })!;
    service.askRecords.link(ask.id, 'work-1');
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, _id: string, content: string) => {
        notes.push(content);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('This work belongs to ask ask-1');
      expect(notes[0]).toContain('"doneWhen":"- merged to dev"');
      expect(notes[0]).toContain('"goal":"Fix the login bug"');
      expect(JSON.stringify(calls.find((call) => call.name === 'work.start')?.input)).toContain(
        'Done when:\\n- merged to dev'
      );
    } finally {
      db.close();
    }
  });

  test('shows the whole ask in the done check: the other cards and their pull requests', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: 'Code merged.' },
    }));
    db.createSession(createTestSession('neo:root'));
    const docsPr: NeoWorkPr = {
      url: 'https://github.com/lsm/HyperNeo/pull/7',
      state: 'OPEN',
      checks: 'pending',
      review: 'none',
    };
    const opened = service.askRecords.open({
      id: 'ask-ship',
      requestKey: 'neo:root:ship',
      projectId: null,
      originSessionId: 'neo:root',
      originMessageId: 'ask-1',
      title: 'Ship it',
      ask: 'Ship the fix and its docs',
      doneWhen: '- fix merged\n- docs merged',
      doneSource: 'human',
    })!;
    service.repo.proposeWork({
      id: 'work-2',
      requestKey: 'root:docs',
      projectId: null,
      originSessionId: 'neo:root',
      originMessageId: 'ask-1',
      title: 'Ship the docs',
      instruction: 'Write the docs.',
    });
    for (const id of ['work-1', 'work-2']) service.askRecords.link(opened.id, id);
    service.workPrs.record('work-2', [docsPr], Date.now());
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, _messageId: string, content: string) => {
        notes.push(content);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(notes).toHaveLength(1);
      expect(JSON.parse(notes[0].slice(notes[0].indexOf('\n{'))).cards).toEqual([
        { id: 'work-2', title: 'Ship the docs', status: 'proposed', pr: 'waiting' },
      ]);
      expect(notes[0]).toContain('which you opened');
    } finally {
      db.close();
    }
  });

  test('flags a card abandoned after the last stuck step, and a cancelled card has no live status', async () => {
    const { db, service } = await setup(
      { ok: true, value: { delivered: true } },
      undefined,
      () => ({
        ok: true,
        value: { status: 'running', lastActivityAt: Date.now(), recentInputs: [] },
      }),
      sendTarget
    );
    db.createSession(createTestSession('neo:root'));
    Object.assign(service, { deliver: async () => {} });
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.driverTargets.receipts(['work-1'])[0].abandoned).toBeUndefined();

      now += NEO_WORK_STUCK_STEPS_MS[NEO_WORK_STUCK_STEPS_MS.length - 1];
      expect(service.driverTargets.receipts(['work-1'], now)[0].abandoned).toBe(true);

      await service.cancel('work-1');
      const cancelled = service.driverTargets.receipts(['work-1'], now)[0];
      expect([cancelled.status, cancelled.abandoned]).toEqual([null, undefined]);
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test('marks a card unconfirmed when it shows its session without its message seen landing', async () => {
    const { db, service } = await setup(
      { ok: true, value: { delivered: true } },
      undefined,
      () => ({
        ok: true,
        value: { status: 'running', lastActivityAt: Date.now(), recentInputs: [] },
      }),
      sendTarget
    );
    db.createSession(createTestSession('neo:root'));
    Object.assign(service, { deliver: async () => {} });
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.driverTargets.receipts(['work-1'])[0]).toMatchObject({ status: 'queued' });
      expect(service.driverTargets.receipts(['work-1'])[0].unconfirmed).toBeUndefined();

      now += NEO_CARD_CONFIRM_MS;
      await service.refreshDriverWork();
      expect(service.driverTargets.receipts(['work-1'])[0]).toMatchObject({
        status: 'running',
        unconfirmed: true,
      });
      const snapshot = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.snapshot',
        {},
        { source: 'rpc', principal: 'local' }
      );
      expect(snapshot).toMatchObject({
        value: { cards: [expect.objectContaining({ workId: 'work-1', unconfirmed: true })] },
      });
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test("keeps reading a reported card's session after its ask settles, until the session finishes", async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    let reply: unknown = {
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: Date.now() + 1_000,
        lastReply: 'Icons regenerated.',
      },
    };
    const { db, service, calls } = await setup(
      { ok: true, value: { ref } },
      undefined,
      () => reply
    );
    db.createSession(createTestSession('neo:root'));
    const opened = fileUnderAsk(service);
    Object.assign(service, { deliver: async () => {} });
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const statusCalls = () => calls.filter((call) => call.name === 'work.status').length;
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      const reported = service.repo.getWork('work-1')!;
      expect(reported.status).toBe('reported');
      service.askRecords.settle(service.askRecords.get(opened.id)!, 'achieved', 'Done.', 'Done.');
      service.driverTargets.recordLive('work-1', 'running', undefined, undefined);
      reply = { ok: true, value: { status: 'done', lastActivityAt: now } };

      now += 3 * 60_000;
      await service.refreshDriverWork();
      expect(service.driverTargets.readLiveStatus('work-1')).toBe('done');
      expect(service.repo.getWork('work-1')?.report).toBe(reported.report);

      const before = statusCalls();
      now += 3 * 60_000;
      await service.refreshDriverWork();
      expect(statusCalls()).toBe(before);
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test('unrelated event turns neither replace the report nor reopen its card', async () => {
    const ref = { adapter: 'codex-desktop', id: 'worker' };
    const at = Date.now() + 10_000;
    const own = [
      { at, role: 'user', text: work.instruction },
      { at: at + 1, role: 'agent', text: 'Own result' },
    ];
    let reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: at + 1, exchange: own },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    const clock = spyOn(Date, 'now');
    Object.assign(service, { returnReport: async () => {}, checkDone: async () => {} });
    service.workGoals.record('work-1', 'Font', '- checked');
    fileUnderAsk(service);
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      const original = service.repo.getWork('work-1')!;
      expect(original.report).toBe('Agent: Own result');
      for (const [index, status] of ['needs_you', 'done'].entries()) {
        const later = at + (index + 1) * 180_000;
        clock.mockReturnValue(later);
        reply = {
          ok: true,
          value: {
            status,
            lastActivityAt: later,
            lastReply: 'Other PR result',
            exchange: [
              ...own,
              { at: later - 1, role: 'user', text: 'PR event for another card' },
              { at: later, role: 'agent', text: 'Other PR result' },
            ],
          },
        };
        await service.refreshDriverWork();
        expect(service.repo.getWork('work-1')).toMatchObject({
          status: 'reported',
          report: original.report,
        });
      }
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test('a reported card follows its session when it merges on its own later', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/neo-ios/pull/25';
    const reportedAt = Date.now() + 1_000;
    let reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: reportedAt, lastReply: 'Waiting for the build.' },
    };
    const { db, service, calls } = await setup(
      { ok: true, value: { ref } },
      undefined,
      () => reply
    );
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Fix the tap target', '- merged');
    const ask = service.askRecords.open({
      id: 'ask-tap',
      requestKey: 'neo:root:tap',
      projectId: null,
      originSessionId: 'neo:root',
      originMessageId: 'ask-1',
      title: 'Fix the tap target',
      ask: 'Fix the tap target',
      doneWhen: '- merged',
      doneSource: 'human',
    })!;
    service.askRecords.link(ask.id, 'work-1');
    service.readPrs = async () => [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }];
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string) => {
        notes.push(messageId);
      },
      hasDelivery: (_target: string, messageId: string) => notes.includes(messageId),
    });
    const statusCalls = () => calls.filter((call) => call.name === 'work.status').length;
    try {
      db.getDatabase().prepare('UPDATE neo_work SET follows = ? WHERE id = ?').run(url, 'work-1');
      await service.start('work-1');
      await service.refreshDriverWork();
      const reported = service.repo.getWork('work-1')!;
      expect(reported.report).toContain('Waiting for the build.');
      expect(notes).toEqual(['work-1:done-check:0:pr:1']);

      const later = reported.updatedAt + 60_000;
      reply = {
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: later,
          lastReplyAt: later,
          exchange: [
            { at: 1, role: 'user', text: service.driverTargets.readSent('work-1')!.opening },
            { at: later, role: 'agent', text: `CI passed; merged ${url}.` },
          ],
        },
      };
      const before = statusCalls();
      await service.refreshDriverWork();
      const followed = service.repo.getWork('work-1')!;
      expect(statusCalls()).toBe(before + 2);
      expect(calls.filter((call) => call.name === 'work.status').at(-1)?.input).toEqual({
        ref,
        since: service.driverTargets.readSent('work-1')?.inputBefore,
      });
      expect(followed.report).toContain(`merged ${url}`);
      expect(followed.report).toContain('Earlier report:');
      expect(service.workPrs.get('work-1')?.prs).toEqual([
        { url, state: 'MERGED', checks: 'passing', review: 'approved' },
      ]);
      expect(notes).toEqual([
        'work-1:done-check:0:pr:1',
        `work-1:done-check:0:pr:1:at:${followed.updatedAt}`,
      ]);

      await service.refreshDriverWork();
      expect(statusCalls()).toBe(before + 2);

      await service.reconcile('work-1');
      expect(notes).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('a card PR waiting on CI or review starts no Neo turn; its approval does', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/12';
    const reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Opened ${url}.` },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    fileUnderAsk(service);
    service.workGoals.record('work-1', 'Fix it', '- merged to dev');
    let pr: NeoWorkPr = { url, state: 'OPEN', checks: 'pending', review: 'none' };
    service.readPrs = async () => [pr];
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string) => {
        notes.push(messageId);
      },
      hasDelivery: (_target: string, messageId: string) => notes.includes(messageId),
    });
    const doneChecks = () => notes.filter((id) => id.includes('done-check'));
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      db.getDatabase().prepare('UPDATE neo_work SET follows = ? WHERE id = ?').run(url, 'work-1');
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(doneChecks()).toEqual([]);

      pr = { ...pr, checks: 'passing', blockers: ['needs 1 approving review, has 0'] };
      now += 3 * 60_000;
      await service.refreshDriverWork();
      now += 30 * 60_000;
      await service.refreshDriverWork();
      expect(doneChecks()).toEqual([]);

      pr = { url, state: 'OPEN', checks: 'passing', review: 'approved' };
      now += 3 * 60_000;
      await service.refreshDriverWork();
      expect(doneChecks()).toHaveLength(1);
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test('without the coding pack enabled, a card already told is not told again', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/10';
    const reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Opened ${url}.` },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    db.updateGlobalSettings({ neo: { packs: [] } });
    fileUnderAsk(service);
    service.workGoals.record('work-1', 'Fix it', '- merged to dev');
    service.readPrs = async () => [{ url, state: 'OPEN', checks: 'passing', review: 'approved' }];
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string) => {
        notes.push(messageId);
      },
    });
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      const told = notes.filter((id) => id.includes('done-check'));
      expect(told).toHaveLength(1);
      now += 3 * 60_000;
      await service.refreshDriverWork();
      now += 3 * 60_000;
      await service.refreshDriverWork();
      expect(notes.filter((id) => id.includes('done-check'))).toEqual(told);
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test('without the coding pack enabled, a card with a PR gets its done check at once', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/8';
    const reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Opened ${url}.` },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    db.updateGlobalSettings({ neo: { packs: [] } });
    fileUnderAsk(service);
    service.workGoals.record('work-1', 'Fix it', '- merged to dev');
    service.readPrs = async () => [{ url, state: 'OPEN', checks: 'pending', review: 'none' }];
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string) => {
        notes.push(messageId);
      },
    });
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(notes.filter((id) => id.includes('done-check'))).toEqual(['work-1:done-check:0']);
      now += 3 * 60_000;
      await service.refreshDriverWork();
      expect(notes.filter((id) => id.includes('done-check'))).toEqual(['work-1:done-check:0']);
      expect(service.workPrs.get('work-1')).toBeNull();
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test('with coding disabled, recovery does not reclaim a card PR', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/8';
    const reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Opened ${url}.` },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    db.updateGlobalSettings({ neo: { packs: [] } });
    fileUnderAsk(service);
    service.workGoals.record('work-1', 'Fix it', '- merged to dev');
    let reads = 0;
    service.readPrs = async () => {
      reads++;
      return [{ url, state: 'OPEN', checks: 'pending', review: 'none' }];
    };
    Object.assign(service, { deliver: async () => {} });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      await service.recover();
      expect(reads).toBe(0);
      expect(service.workPrs.get('work-1')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('with only a pack that cannot read PRs enabled, a card with a PR gets its done check at once', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/8';
    const reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Opened ${url}.` },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
    fileUnderAsk(service);
    service.workGoals.record('work-1', 'Fix it', '- merged to dev');
    service.readPrs = async () => [{ url, state: 'OPEN', checks: 'pending', review: 'none' }];
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string) => {
        notes.push(messageId);
      },
    });
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(notes.filter((id) => id.includes('done-check'))).toEqual(['work-1:done-check:0']);
      now += 3 * 60_000;
      await service.refreshDriverWork();
      expect(notes.filter((id) => id.includes('done-check'))).toEqual(['work-1:done-check:0']);
      expect(service.workPrs.get('work-1')).toBeNull();
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test('a life-admin confirmation in a worker report marks the item reported, not met', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const reply: unknown = {
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: Date.now() + 1_000,
        lastReply:
          'Reordered the water filters.\nConfirmation: id=<msg-1>; from=orders@amazon.com; subject=Your order is confirmed',
      },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    db.updateGlobalSettings({ neo: { packs: ['coding', 'life-admin'] } });
    service.askRecords.open(
      {
        id: 'ask-work-1',
        requestKey: 'neo:root:work-1',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Reorder the water filters',
        ask: 'Reorder the water filters',
        doneWhen: '- an order confirmation from Amazon',
        doneSource: 'human',
        pack: 'life-admin',
      },
      [{ text: 'Order confirmation from Amazon arrives', check: 'life-admin.confirmed' }]
    );
    service.askRecords.link('ask-work-1', 'work-1');
    service.workGoals.record('work-1', 'Reorder the water filters', '- an order confirmation');
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      const ask = service.askRecords.get('ask-work-1');
      expect(ask?.doneItems).toEqual([
        expect.objectContaining({
          text: 'Order confirmation from Amazon arrives',
          state: 'reported',
          metBy: null,
          evidence: expect.stringContaining('orders@amazon.com'),
        }),
      ]);
      expect(ask?.doneItems?.[0]?.verifiedDefinitionHash ?? null).toBeNull();
    } finally {
      db.close();
    }
  });

  test('a life-admin ask with a pull request row still reads the row', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/7';
    const reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Done. ${url}` },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    db.updateGlobalSettings({ neo: { packs: ['coding', 'life-admin'] } });
    fileUnderAsk(service);
    db.getDatabase()
      .prepare(`UPDATE neo_asks SET pack = 'life-admin' WHERE id = ?`)
      .run('ask-work-1');
    service.workGoals.record('work-1', 'Reorder', '- an order confirmation');
    const open: NeoWorkPr = { url, state: 'OPEN', checks: 'passing', review: 'none' };
    service.workPrs.record('work-1', [open], 0);
    let reads = 0;
    service.readPrs = async () => {
      reads++;
      return [open];
    };
    Object.assign(service, { deliver: async () => {} });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(reads).toBeGreaterThan(0);
      expect(service.workPrs.get('work-1')?.readAt).toBeGreaterThan(0);
      const toldAt = service.workChecks.get('work-1')?.toldAt;
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      expect(service.workChecks.get('work-1')?.toldAt).toBe(toldAt);
    } finally {
      db.close();
    }
  });

  test('a file-pack ask keeps the pull request done check', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/9';
    const reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Merged ${url}.` },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    service.filePacks = [
      { id: 'inbox-triage', describe: 'Inbox triage', instructions: () => 'File the inbox daily.' },
    ];
    db.updateGlobalSettings({ neo: { packs: ['coding', 'inbox-triage'] } });
    fileUnderAsk(service);
    db.getDatabase()
      .prepare(`UPDATE neo_asks SET pack = 'inbox-triage' WHERE id = ?`)
      .run('ask-work-1');
    service.workGoals.record('work-1', 'Triage the inbox', '- merged');
    const merged: NeoWorkPr = { url, state: 'MERGED', checks: 'passing', review: 'approved' };
    service.readPrs = async () => [merged];
    const notes: Array<[string, string]> = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string, content: string) => {
        notes.push([messageId, content]);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      expect(notes).toHaveLength(1);
      expect(notes[0][0]).toContain('work-1:done-check:');
      expect(notes[0][1]).toContain(url);
    } finally {
      db.close();
    }
  });

  test('delivers the done check for a life-admin card from its report confirmation', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const confirmation =
      'Confirmation: id=<msg-1>; from=orders@example.com; subject=Your order is confirmed';
    const reply: unknown = {
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: Date.now() + 1_000,
        lastReply: `Reordered the water filters.\n${confirmation}`,
      },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    db.updateGlobalSettings({ neo: { packs: ['coding', 'life-admin'] } });
    fileUnderAsk(service);
    db.getDatabase()
      .prepare(`UPDATE neo_asks SET pack = 'life-admin' WHERE id = ?`)
      .run('ask-work-1');
    service.workGoals.record(
      'work-1',
      'Reorder the water filters',
      '- an order confirmation from orders@example.com'
    );
    const notes: Array<[string, string]> = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string, content: string) => {
        notes.push([messageId, content]);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      expect(notes.map(([id]) => id)).toEqual(['work-1:done-check:0']);
      expect(notes[0][1]).toContain('orders@example.com');
      const reported = service.repo.getWork('work-1')!;
      expect(reported.report).toContain(confirmation);
      expect(service.workChecks.get('work-1')?.signature).toBe(
        neoEvidenceSignature(lifeAdminReportEvidence(reported))
      );
    } finally {
      db.close();
    }
  });

  test("tracks the pull request a card's session opened on its branch without naming it", async () => {
    const ref = { adapter: 'hyperneo', id: 'card-session' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6301';
    const at = Date.now() + 10_000;
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: at + 2,
        exchange: [
          { at, role: 'user', text: work.instruction },
          { at: at + 2, role: 'agent', text: 'Fixed it.' },
        ],
      },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Fix the font', '- merged to dev');
    fileUnderAsk(service);
    const worktree = {
      isWorktree: true as const,
      worktreePath: '/repo/.worktrees/font',
      mainRepoPath: '/repo',
      branch: 'neo/font',
    };
    const branches: string[] = [];
    service.readBranchPrs = async (branch) => {
      branches.push(branch.branch);
      return [url];
    };
    service.readPrs = async (urls) =>
      urls.map((item) => ({
        url: item,
        createdAt: at + 1,
        state: 'OPEN',
        checks: 'pending',
        review: 'none',
      }));
    Object.assign(service, { deliver: async () => {} });
    const clock = spyOn(Date, 'now');
    try {
      db.createSession({ ...createTestSession('card-session'), worktree });
      await service.start('work-1');
      clock.mockReturnValue(at + 3);
      await service.refreshDriverWork();
      expect(branches).toContain('neo/font');
      expect(service.workPrs.get('work-1')?.prs.map((pr) => pr.url)).toEqual([url]);
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test('a remote HyperNeo ref cannot borrow a colliding local session repository or branch', async () => {
    const ref = { adapter: 'hyperneo', daemon: 'other-host', id: 'collision' };
    const at = Date.now() + 10_000;
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: at + 2,
        exchange: [
          { at, role: 'user', text: work.instruction },
          { at: at + 2, role: 'agent', text: 'Fixed #6301' },
        ],
      },
    }));
    const localReads: string[] = [];
    service.readBranchPrs = async () => {
      localReads.push('branch');
      return ['https://github.com/local/repo/pull/6301'];
    };
    service.readWorkRepo = async () => {
      localReads.push('repo');
      return { owner: 'local', repo: 'repo' };
    };
    service.readPrs = async (urls) =>
      urls.map((url) => ({
        url,
        createdAt: at + 1,
        state: 'OPEN',
        checks: 'pending',
        review: 'none',
      }));
    service.readRefStates = async () => {
      localReads.push('relative ref');
      return [];
    };
    Object.assign(service, { deliver: async () => {} });
    db.createSession(createTestSession('neo:root'));
    db.createSession({
      ...createTestSession('collision'),
      worktree: {
        isWorktree: true,
        worktreePath: '/local/repo/worktree',
        mainRepoPath: '/local/repo',
        branch: 'local/branch',
      },
    });
    service.workGoals.record('work-1', 'Fix #6301', '- merged to dev');
    fileUnderAsk(service);
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.report).toContain('Fixed #6301');
      expect(localReads).toEqual([]);
      expect(service.workPrs.get('work-1')?.prs ?? []).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('does not claim a desktop PR without branch provenance', async () => {
    const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 'local_worker' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6651';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: {
        status: 'running',
        lastActivityAt: Date.now() + 1_000,
        lastReply: 'Opened the PR; waiting on CI.',
        openedPrs: [url],
      },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Fix the outage pause', '- merged to dev');
    fileUnderAsk(service);
    service.readBranchPrs = async () => [];
    service.readPrs = async (urls) =>
      urls.map((item) => ({ url: item, state: 'OPEN', checks: 'pending', review: 'none' }));
    Object.assign(service, { deliver: async () => {} });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
      expect(service.workPrs.get('work-1')?.prs.map((pr) => pr.url)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('records the PR its HyperNeo worker subscribes to once started, not one from before', async () => {
    const ref = { adapter: 'hyperneo', id: 'worker' };
    const at = Date.now() + 10_000;
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: {
        ref,
        status: 'done',
        lastActivityAt: at + 2,
        exchange: [
          { at, role: 'user', text: work.instruction },
          { at: at + 2, role: 'agent', text: 'Done.' },
        ],
      },
    }));
    const url = 'https://github.com/lsm/hyperneo-review-test/pull/18';
    service.readPrs = async (urls) =>
      urls.map((item) => ({
        url: item,
        state: 'OPEN' as const,
        checks: 'pending' as const,
        review: 'none' as const,
        createdAt: item === url ? at + 1 : 1,
      }));
    service.readBranchPrs = async () => [];
    service.readCheckoutPrs = async () => [];
    Object.assign(service, { deliver: async () => {} });
    db.createSession(createTestSession('neo:root'));
    db.createSession(createTestSession('worker'));
    const subscriptions = new SessionEventSubscriptionRepository(db.getDatabase());
    subscriptions.upsert({ sessionId: 'worker', topic: 'github/lsm/HyperNeo/pull_request/3.*' });
    const sql = db.getDatabase();
    sql
      .prepare('UPDATE session_event_subscriptions SET created_at = ? WHERE topic LIKE ?')
      .run(at - 5_000, '%/3.*');
    subscriptions.upsert({
      sessionId: 'worker',
      topic: 'github/lsm/hyperneo-review-test/pull_request/18.*',
    });
    service.workGoals.record('work-1', 'Open a PR', '- merged to dev');
    fileUnderAsk(service);
    try {
      await service.start('work-1');
      sql.prepare('UPDATE neo_work SET started_at = ? WHERE id = ?').run(at - 1_000, 'work-1');
      service.driverTargets.recordStartedAt('work-1', at + 1);
      sql
        .prepare('UPDATE session_event_subscriptions SET created_at = ? WHERE topic LIKE ?')
        .run(at, '%/18.*');
      await service.refreshDriverWork();
      expect(service.workPrs.get('work-1')?.prs.map((pr) => pr.url)).toEqual([url]);
    } finally {
      db.close();
    }
  });

  test.each([
    { adapter: 'codex-desktop', evidence: 'local' },
    { adapter: 'claude-desktop', evidence: 'local' },
    { adapter: 'codex-desktop', evidence: 'remote' },
    { adapter: 'codex-desktop', evidence: 'foreign-machine' },
    { adapter: 'codex-desktop', evidence: 'other-ref' },
    { adapter: 'codex-desktop', evidence: 'missing' },
  ])(
    'resolves card refs only from matching execution evidence: $adapter/$evidence',
    async ({ adapter, evidence }) => {
      const ref = { adapter, id: 'worker', ...(evidence === 'remote' ? { daemon: 'other' } : {}) };
      const at = Date.now() + 10_000;
      const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
        ok: true,
        value: {
          ref: { ...ref, id: evidence === 'other-ref' ? 'other-worker' : ref.id },
          execution:
            evidence === 'missing'
              ? undefined
              : {
                  directory: '/actual/checkout',
                  machine: evidence === 'foreign-machine' ? 'other-machine' : hostname(),
                },
          place: { folder: '/wrong/project' },
          status: 'done',
          lastActivityAt: at + 2,
          exchange: [
            { at, role: 'user', text: work.instruction },
            { at: at + 2, role: 'agent', text: 'Checked #6651 and mentioned #6652.' },
          ],
        },
      }));
      const cwds: string[] = [];
      service.readWorkRepo = async (cwd) => {
        cwds.push(cwd);
        return { owner: 'actual', repo: 'checkout' };
      };
      service.readRefStates = async (refs) =>
        refs.map((item) => ({
          url: `https://github.com/${item.owner}/${item.repo}/pull/${item.number}`,
          kind: 'pr' as const,
          state: 'OPEN' as const,
          at: null,
          done: false,
          closedBy: null,
        }));
      service.readPrs = async (urls) =>
        urls.map((url) => ({
          url,
          state: 'OPEN' as const,
          checks: 'pending' as const,
          review: 'none' as const,
          createdAt: at + 1,
        }));
      service.readBranchPrs = async () => [];
      service.readCheckoutPrs = async () => [];
      Object.assign(service, { deliver: async () => {} });
      db.createSession(createTestSession('neo:root'));
      service.workGoals.record('work-1', 'Review #6651', '- merged to dev');
      fileUnderAsk(service);
      try {
        await service.start('work-1');
        await service.refreshDriverWork();
        expect(service.repo.getWork('work-1')?.status).toBe('reported');
        expect(cwds.length > 0).toBe(evidence === 'local');
        expect(cwds.every((cwd) => cwd === '/actual/checkout')).toBe(true);
        expect(service.workPrs.get('work-1')?.prs.map((pr) => pr.url) ?? []).toEqual(
          evidence === 'local'
            ? [6651, 6652].map((number) => `https://github.com/actual/checkout/pull/${number}`)
            : []
        );
      } finally {
        db.close();
      }
    }
  );

  test.each([
    { adapter: 'codex-desktop', evidence: 'current' },
    { adapter: 'claude-desktop', evidence: 'current' },
    { adapter: 'codex-desktop', evidence: 'stale' },
    { adapter: 'codex-desktop', evidence: 'missing-exchange' },
    { adapter: 'codex-desktop', evidence: 'remote' },
    { adapter: 'codex-desktop', evidence: 'foreign-machine' },
    { adapter: 'codex-desktop', evidence: 'other-ref' },
    { adapter: 'codex-desktop', evidence: 'missing-directory' },
  ])(
    'discovers checkout PRs locally while retaining report-named PRs: $adapter/$evidence',
    async ({ adapter, evidence }) => {
      const ref = { adapter, id: 'worker', ...(evidence === 'remote' ? { daemon: 'other' } : {}) };
      const at = Date.now() + 10_000;
      let laterInput = evidence === 'stale';
      const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
        ok: true,
        value: {
          ref: { ...ref, id: evidence === 'other-ref' ? 'another-worker' : ref.id },
          execution:
            evidence === 'missing-directory'
              ? undefined
              : {
                  directory: '/actual/checkout',
                  machine: evidence === 'foreign-machine' ? 'another-machine' : hostname(),
                },
          status: 'done',
          lastActivityAt: at + 4,
          exchange:
            evidence === 'missing-exchange'
              ? undefined
              : [
                  { at, role: 'user', text: work.instruction },
                  {
                    at: at + 2,
                    role: 'agent',
                    text: 'Fixed it. https://github.com/actual/checkout/pull/3',
                  },
                  ...(laterInput
                    ? [
                        { at: at + 3, role: 'user', text: 'Unrelated PR event' },
                        { at: at + 4, role: 'agent', text: 'Acknowledged.' },
                      ]
                    : []),
                ],
        },
      }));
      const urls = [1, 2, 3].map((number) => `https://github.com/actual/checkout/pull/${number}`);
      const cwds: string[] = [];
      service.readCheckoutPrs = async (cwd) => {
        cwds.push(cwd);
        return urls;
      };
      service.readBranchPrs = async () => [];
      service.readWorkRepo = async () => null;
      service.readPrs = async (requested) =>
        requested.map((url) => ({
          url,
          state: 'OPEN' as const,
          checks: 'pending' as const,
          review: 'none' as const,
          createdAt: [at + 1, at - 1, at + 3][urls.indexOf(url)],
        }));
      Object.assign(service, { deliver: async () => {} });
      db.createSession(createTestSession('neo:root'));
      service.workGoals.record('work-1', 'Fix the font', '- merged to dev');
      fileUnderAsk(service);
      const clock = spyOn(Date, 'now');
      try {
        await service.start('work-1');
        db.getDatabase()
          .prepare('UPDATE neo_work SET started_at = ? WHERE id = ?')
          .run(at, 'work-1');
        clock.mockReturnValue(at + 5);
        await service.refreshDriverWork();
        const claimed = () => service.workPrs.get('work-1')?.prs.map((pr) => pr.url) ?? [];
        expect(cwds.length > 0).toBe(evidence === 'current');
        expect(cwds.every((cwd) => cwd === '/actual/checkout')).toBe(true);
        expect(claimed()).toEqual(
          evidence === 'current'
            ? [urls[2], urls[0]]
            : evidence === 'missing-exchange'
              ? []
              : [urls[2]]
        );
        if (evidence === 'current') {
          cwds.length = 0;
          laterInput = true;
          await service.refreshDriverWork();
          expect(cwds).toEqual([]);
          expect(claimed()).toEqual([urls[2], urls[0]]);
          expect(service.repo.getWork('work-1')?.report).toBe(`Agent: Fixed it. ${urls[2]}`);
        }
      } finally {
        clock.mockRestore();
        db.close();
      }
    }
  );

  test('claims report-named PRs while excluding issue references', async () => {
    const ref = { adapter: 'hyperneo', id: 'card-session' };
    const pull = (n: number) => `https://github.com/lsm/HyperNeo/pull/${n}`;
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: Date.now() + 1_000,
        lastReply: 'Waiting on CI results on #6403 and #6440; epic #6230 stays open.',
      },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Split the packs', '- merged to dev');
    fileUnderAsk(service);
    const cwds: string[] = [];
    service.readBranchPrs = async () => [];
    service.readWorkRepo = async (cwd) => {
      cwds.push(cwd);
      return { owner: 'lsm', repo: 'HyperNeo' };
    };
    service.readRefStates = async (refs) =>
      refs.map((item) => ({
        url:
          item.number === 6230 ? 'https://github.com/lsm/HyperNeo/issues/6230' : pull(item.number),
        kind: item.number === 6230 ? ('issue' as const) : ('pr' as const),
        state: 'OPEN' as const,
        at: null,
        done: false,
        closedBy: null,
      }));
    service.readPrs = async (urls) =>
      urls.map((url) => ({
        url,
        state: 'OPEN',
        checks: 'passing',
        review: 'approved',
        createdAt: Date.now() + 60_000,
      }));
    Object.assign(service, { deliver: async () => {} });
    try {
      db.createSession({ ...createTestSession('card-session'), workspacePath: '/repo' });
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(cwds).toContain('/repo');
      expect(service.workPrs.get('work-1')?.prs.map((pr) => pr.url)).toEqual([
        pull(6403),
        pull(6440),
      ]);
    } finally {
      db.close();
    }
  });

  test('tracks the pull requests of a card with no done list once it reports', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6403';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Opened ${url}.` },
    }));
    db.createSession(createTestSession('neo:root'));
    const notes: string[] = [];
    service.readPrs = async () => [{ url, state: 'OPEN', checks: 'passing', review: 'approved' }];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string) => {
        notes.push(messageId);
      },
    });
    try {
      db.getDatabase().prepare('UPDATE neo_work SET follows = ? WHERE id = ?').run(url, 'work-1');
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('reported');
      expect(service.workPrs.get('work-1')?.prs.map((pr) => pr.url)).toEqual([url]);
      expect(notes.some((id) => id.includes('done-check'))).toBe(false);
    } finally {
      db.close();
    }
  });

  test('ticks a merged-PR item itself when the card reports its PR merged', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6265';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Merged ${url}.` },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Regenerate icons', '- merged to dev');
    const opened = service.askRecords.open(
      {
        id: 'ask-icons-tick',
        requestKey: 'neo:root:icons',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [
        { text: 'Icons merged to dev', check: 'coding.pr_merged', watch: [url] },
        { text: 'App shows them', check: null },
      ]
    )!;
    service.askRecords.link(opened.id, 'work-1');
    service.readPrs = async () => [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }];
    independentlyMerged(service, [url]);
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, _id: string, content: string) => {
        notes.push(content);
      },
    });
    try {
      db.getDatabase().prepare('UPDATE neo_work SET follows = ? WHERE id = ?').run(url, 'work-1');
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.askRecords.get(opened.id)?.doneItems).toEqual([
        expect.objectContaining({
          id: 'i1',
          state: 'met',
          metBy: 'daemon',
          evidence: `Watched: ${url} merged`,
        }),
        expect.objectContaining({ id: 'i2', state: 'pending' }),
      ]);
      expect(notes.at(-1)).toContain('"state":"pending"');
    } finally {
      db.close();
    }
  });

  test('settles a card whose PRs merged without a Neo turn when the rest waits on GitHub', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6265';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Merged ${url}.` },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Regenerate icons', '- merged to dev');
    const opened = service.askRecords.open(
      {
        id: 'ask-icons-settle',
        requestKey: 'neo:root:icons-settle',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [
        { text: 'Icons merged to dev', check: 'coding.pr_merged', watch: [url] },
        {
          text: 'Android icons merged',
          check: null,
          watch: ['https://github.com/lsm/neo-ios/pull/9'],
        },
      ]
    )!;
    service.askRecords.link(opened.id, 'work-1');
    service.readPrs = async () => [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }];
    independentlyMerged(service, [url]);
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, _id: string, content: string) => {
        notes.push(content);
      },
    });
    try {
      db.getDatabase().prepare('UPDATE neo_work SET follows = ? WHERE id = ?').run(url, 'work-1');
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.askRecords.get(opened.id)?.doneItems?.map((item) => item.state)).toEqual([
        'met',
        'pending',
      ]);
      const work = service.repo.getWork('work-1')!;
      expect(work.status).toBe('reported');
      expect(work.report).toStartWith(`Closed as done by the daemon: ${url} merged`);
      expect(work.report).toContain(`Merged ${url}.`);
      expect(notes.filter((note) => note.includes('handed off went idle'))).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('leaves a merged-PR item alone while a sibling card under the ask has an open PR', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6265';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Merged ${url}.` },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Regenerate icons', '- merged to dev');
    const opened = service.askRecords.open(
      {
        id: 'ask-icons-open-sibling',
        requestKey: 'neo:root:icons',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons and their docs',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [
        {
          text: 'Icons and docs merged to dev',
          check: 'coding.pr_merged',
          watch: [url, 'https://github.com/lsm/HyperNeo/pull/6266'],
        },
      ]
    )!;
    service.repo.proposeWork({
      id: 'work-2',
      requestKey: 'root:docs',
      projectId: null,
      originSessionId: 'neo:root',
      originMessageId: 'ask-1',
      title: 'Document the icons',
      instruction: 'Write the docs.',
    });
    for (const id of ['work-1', 'work-2']) service.askRecords.link(opened.id, id);
    const docsPr: NeoWorkPr = {
      url: 'https://github.com/lsm/HyperNeo/pull/6266',
      state: 'OPEN',
      checks: 'passing',
      review: 'none',
    };
    service.workPrs.record('work-2', [docsPr], Date.now());
    service.readPrs = async () => [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }];
    independentlyMerged(service, [url]);
    Object.assign(service, { deliver: async () => {} });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.askRecords.get(opened.id)?.doneItems?.[0]).toMatchObject({
        state: 'pending',
        metBy: null,
      });
    } finally {
      db.close();
    }
  });

  test('leaves a merged-PR item alone while a sibling card under the ask has no PR yet', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6265';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Merged ${url}.` },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Regenerate icons', '- merged to dev');
    const opened = service.askRecords.open(
      {
        id: 'ask-icons-no-pr-sibling',
        requestKey: 'neo:root:icons',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons and their docs',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [
        {
          text: 'Icons and docs merged to dev',
          check: 'coding.pr_merged',
          watch: [url, 'https://github.com/lsm/HyperNeo/pull/6266'],
        },
      ]
    )!;
    service.repo.proposeWork({
      id: 'work-2',
      requestKey: 'root:docs',
      projectId: null,
      originSessionId: 'neo:root',
      originMessageId: 'ask-1',
      title: 'Document the icons',
      instruction: 'Write the docs.',
    });
    for (const id of ['work-1', 'work-2']) service.askRecords.link(opened.id, id);
    service.readPrs = async () => [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }];
    independentlyMerged(service, [url]);
    Object.assign(service, { deliver: async () => {} });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.askRecords.get(opened.id)?.doneItems?.[0]).toMatchObject({
        state: 'pending',
        metBy: null,
      });
    } finally {
      db.close();
    }
  });

  test('a waiting ask whose last item the daemon ticks met settles achieved', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6265';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Merged ${url}.` },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Regenerate icons', '- merged to dev');
    const opened = service.askRecords.open(
      {
        id: 'ask-icons-waiting',
        requestKey: 'neo:root:icons',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [{ text: 'Icons merged to dev', check: 'coding.pr_merged', watch: [url] }]
    )!;
    service.askRecords.link(opened.id, 'work-1');
    service.askRecords.tickItem(
      opened.id,
      { id: 'i1', state: 'pending', evidence: null, metBy: null },
      Date.now()
    );
    service.askRecords.settle(
      service.askRecords.get(opened.id)!,
      'waiting',
      'Icons merged to dev',
      'Icons merged to dev'
    );
    service.readPrs = async () => [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }];
    independentlyMerged(service, [url]);
    Object.assign(service, { deliver: async () => {} });
    try {
      db.getDatabase().prepare('UPDATE neo_work SET follows = ? WHERE id = ?').run(url, 'work-1');
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.askRecords.get(opened.id)).toMatchObject({
        status: 'achieved',
        doneItems: [expect.objectContaining({ state: 'met', metBy: 'daemon' })],
      });
    } finally {
      db.close();
    }
  });

  test('ticks merged-PR items on the next refresh for asks told about the merge before', async () => {
    const { db, service } = await setup({
      ok: true,
      value: { ref: { adapter: 'codex-desktop', id: 't1' } },
    });
    db.createSession(createTestSession('neo:root'));
    const url = 'https://github.com/lsm/HyperNeo/pull/6265';
    const opened = service.askRecords.open(
      {
        id: 'ask-icons-cached',
        requestKey: 'neo:root:icons',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [{ text: 'Icons merged to dev', check: 'coding.pr_merged', watch: [url] }]
    )!;
    service.askRecords.link(opened.id, 'work-1');
    const read = independentlyMerged(service, [url]);
    await service.start('work-1');
    service.workPrs.record(
      'work-1',
      [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }],
      Date.now()
    );
    try {
      await service.refreshDriverWork();
      expect(read).toHaveBeenCalled();
      expect(service.askRecords.get(opened.id)?.doneItems?.[0]).toMatchObject({
        state: 'met',
        metBy: 'daemon',
        evidence: `Watched: ${url} merged`,
      });
    } finally {
      db.close();
    }
  });

  test('stays quiet about pull requests of cards with no ask or a settled one', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6013';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Opened ${url}.` },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Ship it', '- merged to dev');
    const open: NeoWorkPr = { url, state: 'OPEN', checks: 'pending', review: 'none' };
    let prs = [open];
    service.readPrs = async () => prs;
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string) => {
        notes.push(messageId);
      },
    });
    const refreshLater = async () => {
      service.workPrs.recordFailedRead('work-1', 0);
      await service.refreshDriverWork();
    };
    try {
      db.getDatabase().prepare('UPDATE neo_work SET follows = ? WHERE id = ?').run(url, 'work-1');
      await service.start('work-1');
      await service.refreshDriverWork();
      service.workPrs.record('work-1', [open], 0);
      prs = [{ ...open, checks: 'passing', review: 'approved' }];
      await refreshLater();
      expect(notes.filter((id) => id.includes('done-check'))).toEqual([]);
      expect(service.workPrs.get('work-1')?.prs[0]?.review).toBe('approved');

      const ask = fileUnderAsk(service);
      service.askRecords.settle(ask, 'achieved', 'Merged.', 'Merged.');
      prs = [{ ...open, state: 'MERGED', checks: 'passing', review: 'approved' }];
      await refreshLater();
      expect(notes.filter((id) => id.includes('done-check'))).toEqual([]);
      expect(service.workPrs.get('work-1')?.prs[0]?.state).toBe('MERGED');
    } finally {
      db.close();
    }
  });

  test('waits while its pull request runs CI, then checks it with the live state', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/42';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: Date.now() + 1_000,
        lastReply: `Opened ${url}; I will squash-merge once it is approved.`,
      },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Fix the bug', '- merged to dev');
    fileUnderAsk(service);
    const running: NeoWorkPr = { url, state: 'OPEN', checks: 'pending', review: 'none' };
    let prs = [running];
    service.readPrs = async () => prs;
    const notes: Array<[string, string]> = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string, content: string) => {
        notes.push([messageId, content]);
      },
    });
    const refreshLater = async () => {
      service.workPrs.recordFailedRead('work-1', 0);
      await service.refreshDriverWork();
    };
    try {
      db.getDatabase().prepare('UPDATE neo_work SET follows = ? WHERE id = ?').run(url, 'work-1');
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('reported');
      expect(notes).toEqual([]);

      await refreshLater();
      expect(notes).toEqual([]);
      service.readPrs = async () => null;
      await service.reconcile('work-1');
      await refreshLater();
      expect(notes).toEqual([]);
      expect(service.workPrs.get('work-1')?.readAt).toBeGreaterThan(0);
      service.readPrs = async () => prs;
      const snapshot = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.snapshot',
        {},
        { source: 'rpc', principal: 'local' }
      );
      expect(snapshot).toMatchObject({
        value: {
          cards: [
            expect.objectContaining({
              workId: 'work-1',
              pr: expect.objectContaining({ count: 1, inProgress: true, setback: false }),
            }),
          ],
        },
      });

      prs = [{ ...running, checks: 'passing', review: 'approved' }];
      const changed = spyOn(service, 'notifyChanged');
      await refreshLater();
      expect(changed).toHaveBeenCalledTimes(1);
      await refreshLater();
      expect(notes.map(([id]) => id)).toEqual(['work-1:done-check:0:pr:2']);
      expect(notes[0][1]).toContain('it is newer than the report');
      expect(notes[0][1]).toContain('"checks":"passing","review":"approved"');

      let reads = 0;
      service.readPrs = async () => {
        reads++;
        return prs;
      };
      const getSession = db.getSession.bind(db);
      spyOn(db, 'getSession').mockImplementation((id: string) =>
        id === 'neo:root' ? null : getSession(id)
      );
      await refreshLater();
      expect(reads).toBe(0);
    } finally {
      db.close();
    }
  });

  test('skips cards checked before PR tracking and tells Neo once when PRs stay unreadable', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/42';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Opened ${url}.` },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Fix the bug', '- merged to dev');
    fileUnderAsk(service);
    const running: NeoWorkPr = { url, state: 'OPEN', checks: 'pending', review: 'none' };
    let reads = 0;
    let readable = true;
    service.readPrs = async () => {
      reads++;
      return readable ? [running] : null;
    };
    const notes: string[] = [];
    Object.assign(service, {
      hasDelivery: () => true,
      deliver: async (_target: string, _id: string, content: string) => {
        notes.push(content);
      },
    });
    try {
      db.getDatabase().prepare('UPDATE neo_work SET follows = ? WHERE id = ?').run(url, 'work-1');
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(reads).toBe(0);
      Reflect.deleteProperty(service, 'hasDelivery');

      await service.reconcile('work-1');
      expect([reads, notes.length]).toEqual([1, 0]);

      readable = false;
      service.workPrs.record('work-1', [running], 0);
      await service.refreshDriverWork();
      service.workPrs.recordFailedRead('work-1', 0);
      await service.refreshDriverWork();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('may be out of date');
    } finally {
      db.close();
    }
  });

  test('asks Neo for a short linked summary when work without a checklist returns', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'failed', lastActivityAt: Date.now() + 1_000, lastReply: 'Tests fail.' },
    }));
    db.createSession(createTestSession('neo:root'));
    const notes: Array<[string, string, string]> = [];
    Object.assign(service, {
      open: async () => 'neo:root',
      deliver: async (target: string, messageId: string, content: string) => {
        notes.push([target, messageId, content]);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(notes.map(([target, id]) => [target, id])).toEqual([['neo:root', 'work-1']]);
      expect(notes[0][2]).toContain('A delegated session returned.');
      expect(notes[0][2]).toContain('"workId":"work-1"');
    } finally {
      db.close();
    }
  });

  test('keeps refreshing when returning one report fails and returns it again on recovery', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'failed', lastActivityAt: Date.now() + 1_000, lastReply: 'Tests failed.' },
    }));
    Object.assign(service, {
      returnReport: async () => {
        throw new Error('mailbox rejected');
      },
    });
    try {
      await service.start('work-1');
      await expect(service.refreshDriverWork()).resolves.toBeUndefined();
      expect(service.repo.getWork('work-1')?.status).toBe('failed');
      const returned: string[] = [];
      Object.assign(service, {
        returnReport: async (work: { id: string }) => {
          returned.push(work.id);
        },
      });
      await service.reconcile('work-1');
      expect(returned).toEqual(['work-1']);
    } finally {
      db.close();
    }
  });

  test('restart recovery returns only reports Neo was not told yet', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: 'Shipped.' },
    }));
    db.createSession(createTestSession('neo:root'));
    const delivered = new Set<string>();
    const sent: string[] = [];
    Object.assign(service, {
      open: async () => 'neo:root',
      deliver: async (_target: string, messageId: string) => {
        delivered.add(messageId);
        sent.push(messageId);
      },
      hasDelivery: (_session: string, messageId: string) => delivered.has(messageId),
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(sent).toContain('work-1');
      sent.length = 0;
      await service.reconcile('work-1');
      expect(sent).toEqual([]);

      delivered.clear();
      delivered.add('work-1:done-check:0');
      await service.reconcile('work-1');
      expect(sent).toEqual([]);

      service.workContinues.record('work-1', 'Also the footer.', Date.now(), '0|x');
      await service.reconcile('work-1');
      expect(sent).toContain('work-1:continued:1');
    } finally {
      db.close();
    }
  });

  test('tells the proposing session once when running work shows no activity for 20 minutes', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    let activity = 5;
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'running', lastActivityAt: activity, lastReply: 'Building…' },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'A full Neo iOS app', '- voice works');
    const notes: Array<[string, string, string]> = [];
    Object.assign(service, {
      deliver: async (target: string, messageId: string, content: string) => {
        notes.push([target, messageId, content]);
      },
    });
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      now += 19 * 60_000;
      await service.refreshDriverWork();
      expect(notes).toEqual([]);
      now += 60_000;
      await service.refreshDriverWork();
      expect(notes.map(([target, id]) => [target, id])).toEqual([['neo:root', 'work-1:stall:5']]);
      expect(notes[0][2]).toContain('no activity for 20 minutes.\n');
      expect(notes[0][2]).not.toContain('continue_budget_spent');
      expect(notes[0][2]).toContain('- voice works');
      activity = 6;
      now += 30 * 60_000;
      await service.refreshDriverWork();
      expect(notes).toHaveLength(1);
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test('keeps reminding about a card stuck in progress and finally calls it abandoned', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'running', lastActivityAt: 5 },
    }));
    db.createSession(createTestSession('neo:root'));
    const notes: Array<[string, string]> = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string, content: string) => {
        if (content.includes('without a result')) notes.push([messageId, content]);
      },
    });
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await service.start('work-1');
      const since = service.repo.getWork('work-1')!.updatedAt;
      now = since + 2 * 60 * 60_000 - 1;
      await service.refreshDriverWork();
      expect(notes).toEqual([]);
      for (const hours of [2, 24, 48, 72]) {
        now = since + hours * 60 * 60_000;
        await service.refreshDriverWork();
      }
      expect(notes.map(([id]) => id)).toEqual(
        [2, 24, 48, 72].map((hours) => `work-1:stall:${since + hours * 60 * 60_000}`)
      );
      expect(notes[0][1]).toContain('in progress for 2 hours without a result.\n');
      expect(notes[1][1]).not.toContain('It can no longer be continued.');
      expect(notes[3][1]).toContain('It looks abandoned.');
      expect(notes.join('\n')).not.toMatch(/neo\.work\.|tell the human/);
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
    } finally {
      clock.mockRestore();
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

  test('a reported card whose session later waits on the user goes back to needing you', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const at = (status: string, lastActivityAt: number) => ({
      ok: true,
      value: { status, lastActivityAt, lastReply: 'Merge it for me?' },
    });
    const done = Date.now() + 1_000;
    const asked = done + 5_000;
    let reply: unknown = at('done', done);
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Ship it', '- merged to dev');
    fileUnderAsk(service);
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string) => {
        notes.push(messageId);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('reported');
      reply = at('needs_you', asked);
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
      expect(notes.filter((id) => id.includes('needs-you'))).toEqual([`work-1:needs-you:${asked}`]);
    } finally {
      db.close();
    }
  });

  test('a card answered and finished between refreshes is told again when it next needs the user', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const at = (status: string, lastActivityAt: number) => ({
      ok: true,
      value: { status, lastActivityAt, lastReply: 'Merge it for me?' },
    });
    const first = Date.now() + 1_000;
    let reply: unknown = at('needs_you', first);
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Ship it', '- merged to dev');
    fileUnderAsk(service);
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string) => {
        notes.push(messageId);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      reply = at('done', first + 5_000);
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('reported');
      reply = at('needs_you', first + 10_000);
      await service.refreshDriverWork();
      expect(notes.filter((id) => id.includes('needs-you'))).toEqual([
        `work-1:needs-you:${first}`,
        `work-1:needs-you:${first + 10_000}`,
      ]);
    } finally {
      db.close();
    }
  });

  test('tells Neo once when no card under an open ask is running any more', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } });
    db.createSession(createTestSession('neo:root'));
    fileUnderAsk(service);
    service.repo.transitionWork('work-1', service.repo.getWork('work-1')!, { status: 'cancelled' });
    const notes: string[] = [];
    const delivered = new Set<string>();
    Object.assign(service, {
      deliver: async (_target: string, messageId: string, content: string) => {
        delivered.add(messageId);
        if (content.includes('no work is running for it')) notes.push(messageId);
      },
      hasDelivery: (_session: string, messageId: string) => delivered.has(messageId),
    });
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await service.refreshDriverWork();
      expect(notes).toEqual([]);
      now += 2 * 60 * 60_000;
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      expect(notes).toHaveLength(1);
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test("stamps a delivered done-check note with its card's ask origin", async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: 'Shipped.' },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Ship it', '- shipped');
    fileUnderAsk(service);
    const asked: unknown[] = [];
    const human = { sessionId: 'neo:root', messageId: 'human-1' };
    Object.assign(service, {
      resolveAskOrigin: (parent: unknown) => {
        asked.push(parent);
        return human;
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      const work = service.repo.getWork('work-1')!;
      expect(asked).toContainEqual({
        sessionId: work.originSessionId,
        messageId: work.originMessageId,
      });
      const stamps = db
        .getDatabase()
        .prepare('SELECT message_id AS id, origin_message_id AS origin FROM neo_input_origins')
        .all() as { id: string; origin: string }[];
      expect(stamps).toContainEqual({ id: 'work-1:done-check:0', origin: 'human-1' });
    } finally {
      db.close();
    }
  });

  test('stamps a note before it is queued, so a failed enqueue never leaves it unstamped', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: 'Shipped.' },
    }));
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Ship it', '- shipped');
    fileUnderAsk(service);
    const human = { sessionId: 'neo:root', messageId: 'human-1' };
    const stamped = () =>
      db
        .getDatabase()
        .prepare('SELECT message_id AS id FROM neo_input_origins')
        .all()
        .map((row) => (row as { id: string }).id);
    const seen: string[][] = [];
    Object.assign(service, {
      resolveAskOrigin: () => human,
      enqueueDelivery: async () => {
        seen.push(stamped());
        throw new Error('daemon stopped');
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(seen.some((ids) => ids.includes('work-1:done-check:0'))).toBe(true);
    } finally {
      db.close();
    }
  });

  test('tells the proposing session once each time started work comes to need the user', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const at = (status: string, lastActivityAt: number) => ({
      ok: true,
      value: { status, lastActivityAt, lastReply: 'Approve the migration?' },
    });
    let reply: unknown = at('running', 0);
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    const notes: Array<[string, string]> = [];
    Object.assign(service, {
      deliver: async (target: string, messageId: string, content: string) => {
        notes.push([target, messageId]);
        expect(content).toContain('Approve the migration?');
      },
    });
    try {
      await service.start('work-1');
      reply = at('needs_you', 5);
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      reply = at('running', 6);
      await service.refreshDriverWork();
      reply = at('needs_you', 7);
      await service.refreshDriverWork();
      expect(notes).toEqual([
        ['neo:root', 'work-1:needs-you:5'],
        ['neo:root', 'work-1:needs-you:7'],
      ]);
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
    } finally {
      db.close();
    }
  });

  test('reopens the ask when the human answers the work session it was waiting on', async () => {
    const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 't1' };
    let reply: unknown = { ok: true, value: { status: 'running', lastActivityAt: 0 } };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    Object.assign(service, { deliver: async () => {} });
    const opened = service.askRecords.open(
      {
        id: 'ask-1',
        requestKey: 'neo:root:startup',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Desktop app stuck on startup',
        ask: 'Fix the stuck startup',
        doneWhen: '- app gets past startup',
        doneSource: 'human',
      },
      [{ text: 'App gets past startup', check: null }]
    )!;
    service.askRecords.link(opened.id, 'work-1');
    try {
      await service.start('work-1');
      reply = { ok: true, value: { status: 'needs_you', lastActivityAt: 5, lastReply: 'A or B?' } };
      await service.refreshDriverWork();
      service.askRecords.tickItem(
        opened.id,
        { id: 'i1', state: 'needs_you', evidence: 'A or B?', metBy: null },
        Date.now()
      );
      service.askRecords.settle(
        service.askRecords.get(opened.id)!,
        'waiting',
        'A or B?',
        'A or B?'
      );

      reply = { ok: true, value: { status: 'running', lastActivityAt: 6 } };
      await service.refreshDriverWork();

      expect(service.askRecords.get(opened.id)).toMatchObject({
        status: 'open',
        doneItems: [expect.objectContaining({ id: 'i1', state: 'pending', evidence: null })],
      });
    } finally {
      db.close();
    }
  });

  test.each([
    ['still runs', 'queued', 'waiting'],
    ['already reported', 'reported', 'open'],
  ] as const)(
    'reopens the ask on an answer only when no sibling card that %s needs the human',
    async (_label, siblingStatus, askStatus) => {
      const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 't1' };
      let reply: unknown = { ok: true, value: { status: 'running', lastActivityAt: 0 } };
      const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
      db.createSession(createTestSession('neo:root'));
      Object.assign(service, { deliver: async () => {} });
      const opened = fileUnderAsk(service);
      service.driverTargets.propose(
        service.repo,
        {
          id: 'work-2',
          requestKey: 'root:font-2',
          projectId: null,
          originSessionId: 'neo:root',
          originMessageId: 'ask-1',
          title: work.title,
          instruction: work.instruction,
        },
        startTarget
      );
      service.askRecords.link(opened.id, 'work-2');
      const sibling = service.repo.getWork('work-2')!;
      const queued = service.repo.transitionWork('work-2', sibling, { status: 'queued' })!;
      if (siblingStatus === 'reported')
        service.repo.transitionWork('work-2', queued, { status: 'reported', report: 'Done.' });
      service.driverTargets.recordNeedsYouSince('work-2', 4);
      try {
        await service.start('work-1');
        reply = {
          ok: true,
          value: { status: 'needs_you', lastActivityAt: 5, lastReply: 'A or B?' },
        };
        await service.refreshDriverWork();
        service.askRecords.settle(service.askRecords.get(opened.id)!, 'waiting', 'A or B?', 'x');
        reply = { ok: true, value: { status: 'running', lastActivityAt: 6 } };
        await service.refreshDriverWork();
        expect(service.askRecords.get(opened.id)?.status).toBe(askStatus);
      } finally {
        db.close();
      }
    }
  );

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

  test.each([true, false])('captures initial send receipt with delivered=%s', async (delivered) => {
    const receipt = { executionId: 'node-session', inputId: 'input-1' };
    const { db, service } = await setup(
      { ok: true, value: { delivered, receipt } },
      undefined,
      () => ({ ok: true, value: { status: 'done', lastActivityAt: 1, recentInputs: [] } }),
      sendTarget
    );
    try {
      await service.start('work-1');
      expect(service.driverTargets.readSent('work-1')).toEqual({
        inputBefore: 0,
        opening: work.instruction,
        receipt,
      });
      expect(service.driverTargets.readStartedAt('work-1')).toBe(delivered ? 1 : null);
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
    } finally {
      service.dispose();
      db.close();
    }
  });

  test('records the live status and link of sent work without settling it', async () => {
    const reply = {
      ok: true,
      value: { status: 'running', lastActivityAt: 1, link: 'codex://threads/s1' },
    };
    const { db, service } = await setup(
      { ok: true, value: { delivered: true } },
      undefined,
      () => reply,
      sendTarget
    );
    try {
      expect(service.driverTargets.receipts(['work-1'])).toEqual([
        { workId: 'work-1', adapter: 'hyperneo', daemon: null, status: null, link: null },
      ]);
      await service.start('work-1');
      let changes = 0;
      Object.assign(service, { notifyChanged: () => changes++ });
      await service.refreshDriverWork();
      await service.refreshDriverWork();
      expect(changes).toBe(1);
      expect(service.driverTargets.receipts(['work-1', 'missing'])).toEqual([
        {
          workId: 'work-1',
          adapter: 'hyperneo',
          daemon: null,
          status: 'queued',
          link: 'codex://threads/s1',
        },
      ]);
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
    } finally {
      db.close();
    }
  });

  test('records the remote link of sent work and clears it when Remote Control goes off', async () => {
    let remoteLink: string | undefined = 'https://claude.ai/code/session_01A';
    const { db, service } = await setup(
      { ok: true, value: { delivered: true } },
      undefined,
      () => ({
        ok: true,
        value: {
          status: 'running',
          lastActivityAt: 1,
          link: 'claude://claude.ai/epitaxy/local_a1',
          ...(remoteLink ? { remoteLink } : {}),
        },
      }),
      sendTarget
    );
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.driverTargets.receipts(['work-1'])[0]).toMatchObject({
        link: 'claude://claude.ai/epitaxy/local_a1',
        remoteLink: 'https://claude.ai/code/session_01A',
      });
      remoteLink = undefined;
      let changes = 0;
      Object.assign(service, { notifyChanged: () => changes++ });
      await service.refreshDriverWork();
      expect(changes).toBe(1);
      expect(service.driverTargets.receipts(['work-1'])[0]).toEqual({
        workId: 'work-1',
        adapter: 'hyperneo',
        daemon: null,
        status: 'queued',
        link: 'claude://claude.ai/epitaxy/local_a1',
      });
    } finally {
      db.close();
    }
  });

  test.each(['hyperneo', 'space', 'codex-desktop'])(
    'adopts %s input without sending its brief, settles and reopens',
    async (adapter) => {
      const ref = { adapter, id: 'adopted' };
      const at = Date.now() - 1_000;
      const input = { at, text: 'Human started this task' };
      const history = adapter === 'codex-desktop';
      let reply: unknown = {
        ok: true,
        value: { status: 'running', lastActivityAt: at, recentInputs: [input] },
      };
      const { db, service, calls } = await setup(null, undefined, () => reply, {
        verb: 'adopt',
        ref,
      });
      let now = Date.now();
      const clock = spyOn(Date, 'now').mockImplementation(() => now);
      Object.assign(service, {
        returnReport: async () => {},
        checkDone: async () => {},
        deliver: async () => {},
      });
      service.workGoals.record('work-1', 'Finish', '- checked');
      fileUnderAsk(service);
      const update = (status: string, other = false) => {
        now += 180_000;
        const inputs = other ? [input, { at: now - 1, text: 'Another card PR event' }] : [input];
        reply = {
          ok: true,
          value: {
            status,
            lastActivityAt: now,
            lastReplyAt: now,
            lastReply: 'Task result',
            recentInputs: inputs,
            ...(history
              ? {
                  exchange: [
                    ...inputs.map((item) => ({ ...item, role: 'user' })),
                    { at: now, role: 'agent', text: 'Task result' },
                  ],
                }
              : {}),
          },
        };
      };
      try {
        await service.start('work-1');
        expect(calls.map((call) => call.name)).toEqual(['work.status']);
        expect(service.driverTargets.readSent('work-1')).toEqual({
          inputBefore: at - 1,
          opening: input.text,
        });
        await service.refreshDriverWork();
        expect(service.repo.getWork('work-1')?.status).toBe('queued');
        update('done');
        await service.refreshDriverWork();
        expect(service.repo.getWork('work-1')).toMatchObject({
          status: 'reported',
          report: history
            ? 'Agent: Task result'
            : `${NEO_WORK_UNVERIFIED_REPLY_NOTE}\n\nTask result`,
        });
        update('needs_you');
        await service.refreshDriverWork();
        expect(service.repo.getWork('work-1')?.status).toBe('queued');
        update('done');
        await service.refreshDriverWork();
        const report = service.repo.getWork('work-1')?.report;
        update('needs_you', true);
        await service.refreshDriverWork();
        expect(service.repo.getWork('work-1')).toMatchObject({ status: 'reported', report });
        update('done', true);
        await service.refreshDriverWork();
        expect(service.repo.getWork('work-1')?.report).toBe(report);
      } finally {
        clock.mockRestore();
        db.close();
      }
    }
  );

  test('settles sent work once the session acts after the send, on its own clock', async () => {
    let reply: unknown = { ok: true, value: { status: 'done', lastActivityAt: 1 } };
    const { db, service, calls } = await setup(
      { ok: true, value: { delivered: true } },
      undefined,
      () => reply,
      sendTarget
    );
    const returned: string[] = [];
    Object.assign(service, {
      returnReport: async (settled: { id: string }) => {
        returned.push(settled.id);
      },
    });
    try {
      await service.start('work-1');
      expect(service.driverTargets.readStartedAt('work-1')).toBe(1);
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('queued');

      reply = {
        ok: true,
        value: { status: 'done', lastActivityAt: 2, lastReply: 'Voice is durable.' },
      };
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'reported',
        report: `${NEO_WORK_UNVERIFIED_REPLY_NOTE}\n\nVoice is durable.`,
      });
      expect(returned).toEqual(['work-1']);
      expect(calls.map((call) => call.name)).toEqual([
        'work.status',
        'work.send',
        'work.status',
        'work.status',
      ]);
    } finally {
      db.close();
    }
  });

  test('leaves work sent behind a running turn for Neo to follow up', async () => {
    let reply: unknown = { ok: true, value: { status: 'running', lastActivityAt: 1 } };
    const { db, service } = await setup(
      { ok: true, value: { delivered: false } },
      undefined,
      () => reply,
      sendTarget
    );
    try {
      await service.start('work-1');
      expect(service.driverTargets.readStartedAt('work-1')).toBeNull();
      reply = {
        ok: true,
        value: { status: 'done', lastActivityAt: 2, lastReply: 'The earlier turn finished.' },
      };
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
    } finally {
      db.close();
    }
  });

  test('never takes the unanchored fallback in the refresh that finds the message', async () => {
    const landed = [{ at: 3, text: `${work.instruction} Neo routed this` }];
    let reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: 1, recentInputs: [] },
    };
    const { db, service } = await setup(
      { ok: true, value: { delivered: false } },
      undefined,
      () => reply,
      sendTarget
    );
    const clock = spyOn(Date, 'now');
    try {
      await service.start('work-1');
      const sentAt = service.repo.getWork('work-1')!.updatedAt;
      reply = {
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: sentAt + 10,
          recentInputs: landed,
          lastReply: 'Done.',
          lastReplyAt: sentAt + 10,
        },
      };
      clock.mockImplementation(() => sentAt + 10 + NEO_WORK_UNANCHORED_SETTLE_MS);
      await service.refreshDriverWork();
      expect(service.driverTargets.readStartedAt('work-1')).toBe(3);
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  test('settles a queued send on the reply after its message lands, a refresh after it lands', async () => {
    const input = (inputAt: number, text: string) => ({ at: inputAt, text });
    const older = [input(1, 'hello')];
    const landed = [...older, input(3, `${work.instruction} Neo routed this`)];
    let reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: 1, recentInputs: older },
    };
    const { db, service } = await setup(
      { ok: true, value: { delivered: false } },
      undefined,
      () => reply,
      sendTarget
    );
    const returned: string[] = [];
    Object.assign(service, {
      returnReport: async (settled: { id: string }) => {
        returned.push(settled.id);
      },
    });
    try {
      await service.start('work-1');
      expect(service.driverTargets.readStartedAt('work-1')).toBeNull();
      expect(service.driverTargets.readSent('work-1')).toEqual({
        inputBefore: 1,
        opening: work.instruction,
      });

      reply = {
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: 2,
          recentInputs: [...older, input(2, 'the human typed this')],
          lastReply: 'Answer to the human.',
          lastReplyAt: 2,
        },
      };
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('queued');

      reply = {
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: 4,
          recentInputs: landed,
          lastReply: 'Half an answer',
          lastReplyAt: 4,
        },
      };
      await service.refreshDriverWork();
      expect(service.driverTargets.readStartedAt('work-1')).toBe(3);
      expect(service.repo.getWork('work-1')?.status).toBe('queued');

      reply = {
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: 6,
          recentInputs: landed,
          lastReply: 'Answer to the human.',
          lastReplyAt: 2,
        },
      };
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')?.status).toBe('queued');

      reply = {
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: 7,
          recentInputs: landed,
          lastReply: 'Blocked on X.',
          lastReplyAt: 7,
          exchange: [
            { at: 3, role: 'user', text: work.instruction },
            { at: 5, role: 'agent', text: 'Checked the tree.' },
            { at: 7, role: 'agent', text: 'Blocked on X.' },
          ],
        },
      };
      await service.refreshDriverWork();
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'reported',
        report: 'Agent: Checked the tree.\n\nAgent: Blocked on X.',
      });
      expect(returned).toEqual(['work-1']);
    } finally {
      db.close();
    }
  });

  test('leaves work queued behind a turn that started during the send for Neo', async () => {
    const { db, service } = await setup(
      { ok: true, value: { delivered: false } },
      undefined,
      () => ({ ok: true, value: { status: 'done', lastActivityAt: 1 } }),
      sendTarget
    );
    try {
      await service.start('work-1');
      expect(service.driverTargets.readStartedAt('work-1')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('falls back to the time before the send when the target status is unreadable', async () => {
    const { db, service } = await setup(
      { ok: true, value: { delivered: true } },
      undefined,
      () => ({ ok: false, reason: 'unreachable', detail: 'asleep' }),
      sendTarget
    );
    try {
      const before = Date.now();
      await service.start('work-1');
      expect(service.driverTargets.readStartedAt('work-1')).toBeGreaterThanOrEqual(before);
    } finally {
      db.close();
    }
  });

  test('fails queued work without a ref instead of starting it twice', async () => {
    const { db, service, calls } = await setup({ ok: true, value: { ref: null } });
    Object.assign(service, { returnReport: async () => {} });
    try {
      const proposed = service.repo.getWork('work-1');
      if (proposed) service.repo.transitionWork('work-1', proposed, { status: 'queued' });
      await service.start('work-1');
      expect(calls).toEqual([]);
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'failed',
        report: expect.stringContaining('check work.find'),
      });
    } finally {
      db.close();
    }
  });

  test('a start that throws fails the card and returns its report', async () => {
    const { db, service } = await setup({ ok: true, value: { ref: null } });
    const returned: Array<{ status: string; report: string | null }> = [];
    Object.assign(service, {
      returnReport: async (work: { status: string; report: string | null }) => {
        returned.push({ status: work.status, report: work.report });
      },
      startReservedWork: async (id: string) => {
        const proposed = service.repo.getWork(id);
        if (proposed) service.repo.transitionWork(id, proposed, { status: 'queued' });
        throw new Error('adapter crashed');
      },
    });
    try {
      await expect(service.start('work-1')).rejects.toThrow('adapter crashed');
      expect(returned).toEqual([
        { status: 'failed', report: 'Could not start the execution: adapter crashed' },
      ]);
    } finally {
      db.close();
    }
  });

  test('fails the work with the adapter reason when it cannot start', async () => {
    const { db, service } = await setup({
      ok: false,
      reason: 'invalid_place',
      detail: '/focus/dolmen does not exist.',
    });
    const delivered: Array<[string, string, string]> = [];
    db.createSession(createTestSession('neo:root'));
    Object.assign(service, {
      open: async () => 'neo:root',
      deliver: async (target: string, messageId: string, _content: string, origin: string) => {
        delivered.push([target, messageId, origin]);
      },
    });
    try {
      await service.start('work-1');
      expect(delivered).toEqual([['neo:root', 'work-1', 'neo:root']]);
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'failed',
        report: 'Could not start the execution: invalid_place: /focus/dolmen does not exist.',
      });
      expect(service.driverTargets.readRef('work-1')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('Neo closes a card it started only with a reason, which the card shows', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } });
    try {
      await service.start('work-1');
      db.createSession(createTestSession('neo:root'));
      service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
      const registry = createOperationRegistry(createNeoOperations(service));
      const neo: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };
      expect(
        await invokeOperation(registry, 'neo.work.close', { id: 'work-1', outcome: 'done' }, neo)
      ).toMatchObject({
        kind: 'completed',
        value: { ok: false, reason: 'Give a reason; the card shows it.' },
      });
      expect(service.repo.getWork('work-1')?.status).toBe('queued');

      expect(
        await invokeOperation(
          registry,
          'neo.work.close',
          { id: 'work-1', outcome: 'done', reason: 'both PRs merged' },
          neo
        )
      ).toMatchObject({ kind: 'completed', value: { ok: true } });
      expect(service.repo.getWork('work-1')).toMatchObject({
        status: 'reported',
        report: 'Closed as done by Neo: both PRs merged',
      });
    } finally {
      db.close();
    }
  });

  test('a person closes started work as done or cancelled and the driver work stops', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service, calls } = await setup({ ok: true, value: { ref } });
    const delivered: string[] = [];
    Object.assign(service, {
      open: async () => 'neo:root',
      deliver: async (_target: string, messageId: string) => {
        delivered.push(messageId);
      },
    });
    try {
      await service.start('work-1');
      expect(await service.close('work-1', 'done')).toMatchObject({
        ok: true,
        work: { status: 'reported', report: NEO_WORK_CLOSED_DONE },
      });
      expect(calls.map((call) => call.name)).toEqual(['work.start', 'work.stop']);
      await service.reconcile('work-1');
      expect(delivered).toEqual([]);
      expect(await service.close('work-1', 'cancelled')).toMatchObject({
        ok: true,
        work: { status: 'cancelled' },
      });
      expect(calls.map((call) => call.name)).toEqual(['work.start', 'work.stop']);
      expect(await service.close('work-1', 'done')).toEqual({
        ok: false,
        reason: 'work_closed: cancelled work stays cancelled',
      });
    } finally {
      db.close();
    }
  });

  test('an interrupted start is not offered or allowed a retry, since it may have started', async () => {
    const { db, service, calls } = await setup({ ok: true, value: { ref: null } });
    const delivered: string[] = [];
    db.createSession(createTestSession('neo:root'));
    Object.assign(service, {
      open: async () => 'neo:root',
      deliver: async (_target: string, _id: string, content: string) => {
        delivered.push(content);
      },
    });
    try {
      const proposed = service.repo.getWork('work-1');
      if (proposed) service.repo.transitionWork('work-1', proposed, { status: 'queued' });
      await service.start('work-1');
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).not.toContain('neo.work.retry');
      expect(await retryVia(service)).toEqual({
        ok: false,
        reason:
          'Starting was interrupted and it may have started anyway; check work.find before proposing it again.',
      });
      expect(calls).toEqual([]);
      expect(service.repo.getWork('work-1')?.status).toBe('failed');
      expect(service.isRetryable('work-1')).toBe(false);
    } finally {
      db.close();
    }
  });

  test('a retry waits out a start still finishing instead of reusing it', async () => {
    const reply: Record<string, unknown> = { ok: false, reason: 'not_delivered', detail: 'down' };
    const { db, service, calls } = await setup(reply);
    Object.assign(service, { returnReport: async () => {} });
    try {
      await service.start('work-1');
      let finish: () => void = () => {};
      const pending = (service as unknown as { workPending: Map<string, Promise<void>> })
        .workPending;
      pending.set(
        'work-1',
        new Promise<void>((resolve) => {
          finish = () => {
            pending.delete('work-1');
            resolve();
          };
        })
      );
      Object.assign(reply, { ok: true, value: { ref: { adapter: 'codex-desktop', id: 't1' } } });
      delete reply.reason;
      delete reply.detail;
      const retried = retryVia(service);
      finish();
      expect(await retried).toMatchObject({ ok: true, work: { status: 'queued' } });
      expect(calls.filter((call) => call.name === 'work.start')).toHaveLength(2);
    } finally {
      db.close();
    }
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
    const queue = ready.db.getJobQueueRepo();
    const due = () =>
      queue.listActiveByPayload(NEO_WORK_DELIVERY_RETRY, { workId: 'work-1' }, ['pending']);
    return { ...ready, delivered, queue, due };
  }

  test('an approved ask’s undelivered card is retried by the daemon, then offers Retry after three failures', async () => {
    const { db, service, calls, delivered, queue, due } = await undelivered(true);
    try {
      await service.start('work-1');
      for (const backoff of NEO_DELIVERY_RETRY_BACKOFF_MS) {
        const [job] = due();
        expect(job.runAt - Date.now()).toBeGreaterThan(backoff - 5_000);
        expect(service.isRetryable('work-1')).toBe(false);
        expect(delivered).toEqual([]);
        queue.reschedulePending(job.id, Date.now());
        const [claimed] = queue.dequeue(NEO_WORK_DELIVERY_RETRY);
        expect(await runNeoDeliveryRetry(claimed, service)).toEqual({ retried: true });
      }
      expect(due()).toEqual([]);
      expect(calls.filter((call) => call.name === 'work.start')).toHaveLength(4);
      expect(service.repo.getWork('work-1')?.status).toBe('failed');
      expect(service.isRetryable('work-1')).toBe(true);
      expect(delivered).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('an unapproved ask’s undelivered card waits for the human’s Retry', async () => {
    const { db, service, calls, delivered, due } = await undelivered(false);
    try {
      await service.start('work-1');
      expect(due()).toEqual([]);
      expect(calls.filter((call) => call.name === 'work.start')).toHaveLength(1);
      expect(service.isRetryable('work-1')).toBe(true);
      expect(delivered).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('a hand-off that failed before it started retries on the same card', async () => {
    const reply: Record<string, unknown> = {
      ok: false,
      reason: 'claude_cli_login_expired',
      detail: 'Run `claude auth login`, then try again.',
    };
    const { db, service, calls } = await setup(reply);
    const delivered: Array<[string, string, string]> = [];
    db.createSession(createTestSession('neo:root'));
    Object.assign(service, {
      open: async () => 'neo:root',
      deliver: async (target: string, messageId: string, content: string) => {
        delivered.push([target, messageId, content]);
      },
    });
    try {
      await service.start('work-1');
      expect(delivered.map(([, id]) => id)).toEqual(['work-1']);
      expect(delivered[0][2]).toContain('This hand-off never started.');
      expect(service.isRetryable('work-1')).toBe(true);
      expect(service.driverTargets.receipts(['work-1'])).toHaveLength(1);

      expect(await retryVia(service)).toMatchObject({
        ok: true,
        work: { id: 'work-1', status: 'failed' },
      });
      expect(delivered.map(([, id]) => id)).toEqual(['work-1', 'work-1:retry:1']);
      expect(delivered[1][2]).toContain('it has been retried 1 time');

      delete reply.reason;
      delete reply.detail;
      Object.assign(reply, { ok: true, value: { ref: { adapter: 'codex-desktop', id: 't1' } } });
      expect(await retryVia(service)).toMatchObject({
        ok: true,
        work: { id: 'work-1', status: 'queued' },
      });
      expect(calls.filter((call) => call.name === 'work.start')).toHaveLength(3);
      expect(service.repo.listWork()).toHaveLength(1);
      expect(await retryVia(service)).toMatchObject({ ok: false });
      expect(service.isRetryable('work-1')).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('readDriverNeedsYou', () => {
  test('reads whether the work waits on the user, and ignores failures', () => {
    expect(
      readDriverNeedsYou({
        kind: 'completed',
        value: { ok: true, value: { status: 'needs_you', lastActivityAt: 9, lastReply: 'Allow?' } },
      })
    ).toEqual({ needsYou: true, since: 9, lastReply: 'Allow?' });
    expect(
      readDriverNeedsYou({
        kind: 'completed',
        value: { ok: true, value: { status: 'running', lastActivityAt: 9 } },
      })
    ).toMatchObject({ needsYou: false });
    expect(
      readDriverNeedsYou({
        kind: 'completed',
        value: { ok: false, reason: 'unreachable', detail: 'asleep' },
      })
    ).toBeNull();
    expect(
      readDriverNeedsYou({ kind: 'failed', code: 'execution_failed', message: 'boom' })
    ).toBeNull();
  });
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

describe('neo.work.propose with a drivers target', () => {
  test('a retried drivers proposal returns its card, and another target is a separate card', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession('root'));
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', projectId: null });
    const neo: OperationCaller = {
      source: 'mcp',
      sessionId: 'root',
      role: 'neo',
      neoTurn: { messageId: 'ask-1', human: true, isLive: () => true },
    };
    const propose = (target: Record<string, unknown>) =>
      invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.work.propose',
        withNeoProposalAsk(
          service,
          'neo.work.propose',
          {
            title: work.title,
            instruction: work.instruction,
            doneWhen: '- font raised',
            ...target,
          },
          neo
        ),
        neo
      );
    try {
      const first = (await propose({ work: sendTarget })) as {
        kind: string;
        value: { ok: boolean; work: { id: string } };
      };
      expect(first).toMatchObject({ kind: 'completed', value: { ok: true } });
      expect(await propose({ work: sendTarget })).toMatchObject({
        value: { ok: true, work: { id: first.value.work.id } },
      });
      const other = (await propose({ work: startTarget })) as {
        value: { ok: boolean; work: { id: string } };
      };
      expect(other).toMatchObject({ value: { ok: true } });
      expect(other.value.work.id).not.toBe(first.value.work.id);
      expect(service.repo.listWork()).toHaveLength(2);
    } finally {
      service.dispose();
      db.close();
    }
  });

  test('refuses a target whose adapter cannot do the verb and names ones that can', async () => {
    const db = await createTestDb();
    const asked: unknown[] = [];
    const drivers = createOperationRegistry([
      defineOperation({
        name: 'work.adapters',
        description: 'test adapters',
        inputSchema: z.object({ daemon: z.string().optional() }),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async (input: { daemon?: string }) => {
          asked.push(input);
          return {
            ok: true,
            value: [
              { id: 'claude-code', capabilities: ['find'] },
              { id: 'claude-desktop', capabilities: ['find', 'start', 'send', 'status'] },
            ],
          };
        },
      }),
    ]);
    const service = new NeoService(
      db,
      { getOperationRegistry: () => drivers } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession('root'));
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', projectId: null });
    const neo: OperationCaller = {
      source: 'mcp',
      sessionId: 'root',
      role: 'neo',
      neoTurn: { messageId: 'ask-1', human: true, isLive: () => true },
    };
    const place = { machine: 'laptop', daemon: 'laptop', folder: '/Users/me/app', name: 'app' };
    const propose = (requestKey: string, adapter: string) =>
      invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.work.propose',
        withNeoProposalAsk(
          service,
          'neo.work.propose',
          {
            requestKey,
            title: 'Fix it',
            instruction: 'Fix the bug.',
            doneWhen: '- bug fixed',
            work: { verb: 'start', adapter, place },
          },
          neo
        ),
        neo
      );
    try {
      expect(await propose('cli', 'claude-code')).toMatchObject({
        value: {
          ok: false,
          reason: 'The claude-code adapter cannot start work. Adapters that can: claude-desktop.',
        },
      });
      expect(await propose('desktop', 'claude-desktop')).toMatchObject({ value: { ok: true } });
      expect(asked).toEqual([{ daemon: 'laptop' }, { daemon: 'laptop' }]);
    } finally {
      service.dispose();
      db.close();
    }
  });
});

describe('planNeoStartReceiptAdoption', () => {
  const startReceipt = { executionId: 's-code', inputId: 'kickoff' };
  const status = (extra: Record<string, unknown> = { startReceipt }) =>
    ({
      kind: 'completed',
      value: { ok: true, value: { status: 'running', lastActivityAt: 1, ...extra } },
    }) as never;
  const sent = { inputBefore: 0, opening: 'raise it to 16px' };

  test('a started card without a receipt adopts the start receipt status reports', () => {
    expect(planNeoStartReceiptAdoption(status(), sent, 'start')).toEqual({
      ...sent,
      receipt: startReceipt,
    });
  });

  test('a card that has a receipt, was sent or adopted, or got a malformed one keeps what it has', () => {
    const own = { executionId: 's-code', inputId: 'brief' };
    expect(planNeoStartReceiptAdoption(status(), { ...sent, receipt: own }, 'start')).toBeNull();
    expect(planNeoStartReceiptAdoption(status(), sent, 'send')).toBeNull();
    expect(planNeoStartReceiptAdoption(status(), sent, 'adopt')).toBeNull();
    expect(planNeoStartReceiptAdoption(status(), null, 'start')).toBeNull();
    expect(
      planNeoStartReceiptAdoption(status({ startReceipt: { executionId: '' } }), sent, 'start')
    ).toBeNull();
    expect(planNeoStartReceiptAdoption(status({}), sent, 'start')).toBeNull();
  });
});
