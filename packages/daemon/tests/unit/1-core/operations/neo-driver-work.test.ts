import { withCodingWorkGoal as withWorkGoal } from '../../../../src/lib/neo/packs/coding/work-goal.ts';
import { describe, expect, mock, spyOn, test } from 'bun:test';
import { hostname } from 'node:os';
import { NEO_WORK_BLOCKER, NEO_WORK_GOAL, NEO_WORK_GOAL_REMAINING } from '@hyperneo/prompts';
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
  driverExchangeReport,
  driverWorkCall as buildDriverWorkCall,
  driverWorkCaller,
  NEO_CARD_CONFIRM_MS,
  type NeoDriverTarget,
  NeoDriverTargetSchema,
  neoCardSent,
  readDriverLanded,
  readDriverOutcome,
  readDriverSendBaseline,
  readDriverSent,
  readDriverSettlement,
} from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import type { NeoRef } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
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

const driverWorkCall = (
  target: Parameters<typeof buildDriverWorkCall>[0],
  work: Parameters<typeof buildDriverWorkCall>[1],
  goal: Parameters<typeof buildDriverWorkCall>[2] = null
) => buildDriverWorkCall(target, work, goal, withWorkGoal);

describe('driverWorkCall', () => {
  test('sends the goal with a started or continued driver session', () => {
    const goal = { workId: 'w1', goal: 'A full iOS app', doneWhen: null };
    for (const target of [startTarget, sendTarget])
      expect(driverWorkCall(target, work, goal).input.message).toContain(
        `${NEO_WORK_GOAL}\nWhat the human asked: A full iOS app`
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
      `Build the chat screen.\n\n${NEO_WORK_GOAL}\nWhat the human asked: A full iOS app\nDone when:\n- runs in the simulator\n${NEO_WORK_GOAL_REMAINING}\n${NEO_WORK_BLOCKER}`
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
      'Run `gh pr merge <number> --squash --match-head-commit <head_sha>` as a command of its own'
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
  test('an accepted inbox receipt is unconfirmed input, not a queued submission', () => {
    const ref = { adapter: 'claude-code', id: 'owned-cli' };
    const receipt = { executionId: ref.id, inputId: 'inbox-input' };
    const delivery = { delivered: false, unconfirmed: true as const, receipt };
    expect(
      readDriverOutcome(
        { verb: 'send', ref },
        { kind: 'completed', value: { ok: true, value: delivery } }
      )
    ).toEqual({ ref, delivery, receipt });
    const queued = { ...delivery, queuedSubmissionId: 'pending-inbox' };
    expect(
      readDriverOutcome(
        { verb: 'send', ref },
        { kind: 'completed', value: { ok: true, value: queued } }
      )
    ).toEqual({ ref, delivery: queued, receipt, queued: true });
  });

  test('Copilot pending receipt is accepted queued work with its original attribution', () => {
    const ref = { adapter: 'copilot-cli', id: 'owned-session' };
    const receipt = { executionId: ref.id, inputId: 'queued-input' };
    const delivery = { delivered: false, queuedSubmissionId: receipt.inputId, receipt };
    expect(
      readDriverOutcome(
        { verb: 'send', ref },
        { kind: 'completed', value: { ok: true, value: delivery } }
      )
    ).toEqual({ ref, delivery, queued: true, receipt });
  });

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
    ).toEqual({ ref: sendTarget.ref, queued: true, delivery: { delivered: false } });
    expect(
      readDriverOutcome(sendTarget, {
        kind: 'completed',
        value: { ok: true, value: { delivered: true } },
      })
    ).toEqual({ ref: sendTarget.ref, delivery: { delivered: true } });
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
  const archivedRef = { adapter: 'claude-desktop', id: 'archived' };
  const worker = (id: string, overrides: Partial<WorkSummary> = {}): WorkSummary => ({
    ref: { ...archivedRef, id },
    title: id,
    place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' },
    status: 'done',
    lastActivityAt: 100,
    ...overrides,
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
});

describe('readDriverSettlement', () => {
  const work = { updatedAt: 100 };
  const status = (value: Record<string, unknown>) => ({
    kind: 'completed' as const,
    value: { ok: true, value: { lastActivityAt: 200, ...value } },
  });

  test.each(['done', 'failed', 'stopped'])(
    'does not infer %s results from latest prose',
    (state) => {
      const outcome = status({ status: state, lastReply: 'Shipped.', lastReplyAt: 200 });
      for (const now of [150, 100 + 10 * 60_000, 100 + 4 * 60 * 60_000]) {
        expect(readDriverSettlement(work, outcome, now)).toBeNull();
        expect(readDriverSettlement(work, outcome, now, 100, true)).toBeNull();
        expect(readDriverSettlement(work, outcome, now, null, true)).toBeNull();
      }
    }
  );

  test('keeps waiting without a result and fails explicitly gone work', () => {
    const settle = (outcome: Parameters<typeof readDriverSettlement>[1], now = 150) =>
      readDriverSettlement(work, outcome, now);
    expect(settle(status({ status: 'running' }))).toBeNull();
    expect(settle(status({ status: 'needs_you' }))).toBeNull();
    expect(settle(status({ status: 'done', lastActivityAt: 100 }))).toBeNull();
    expect(settle(status({ status: 'done', lastActivityAt: 100 }), 100 + 10 * 60_000)).toBeNull();
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
