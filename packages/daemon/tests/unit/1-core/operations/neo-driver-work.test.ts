import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  driverStartedReport,
  driverWorkCall,
  NEO_WORK_SUMMARY_NOTE,
  withWorkGoal,
  driverWorkCaller,
  type NeoDriverTarget,
  driverExchangeReport,
  readDriverLanded,
  readDriverSent,
  neoCardSent,
  type DriverSent,
  readDriverNeedsYou,
  readDriverOutcome,
  readDriverSendBaseline,
  NEO_WORK_STUCK_STEPS_MS,
  decideStuckReminder,
  NEO_WORK_UNANCHORED_NOTE,
  NEO_WORK_UNANCHORED_SETTLE_MS,
  decideCardLiveStatus,
  isNeoReceiptUnconfirmed,
  NEO_CARD_CONFIRM_MS,
  readDriverSettlement,
  readNeoStartFolder,
  requireNeoStartFolder,
} from '../../../../src/lib/neo/driver-work.ts';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  createNeoOperations,
  requireNeoExecutionChoice,
} from '../../../../src/lib/neo/operations.ts';
import { NEO_WORK_CLOSED_DONE } from '@hyperneo/shared/types/neo-snapshot';
import { neoEvidenceSignature } from '../../../../src/lib/neo/evidence.ts';
import {
  neoWorkPrEvidence,
  neoWorkPrSignature,
} from '../../../../src/lib/neo/packs/coding/work-prs.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const place = { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen', daemon: 'laptop' };
const startTarget: NeoDriverTarget = { verb: 'start', adapter: 'codex-desktop', place };
const sendTarget: NeoDriverTarget = {
  verb: 'send',
  ref: { adapter: 'hyperneo', id: 's1' },
};
const work = { title: 'Bigger font', instruction: 'Raise the body font to 16px.' };

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
        message: 'Raise the body font to 16px.',
      },
    });
    expect(driverWorkCall({ ...startTarget, createFolder: true }, work)).toEqual({
      name: 'work.start',
      input: {
        adapter: 'codex-desktop',
        place,
        title: 'Bigger font',
        message: 'Raise the body font to 16px.',
        createFolder: true,
      },
    });
    expect(driverWorkCall(sendTarget, work)).toEqual({
      name: 'work.send',
      input: { ref: { adapter: 'hyperneo', id: 's1' }, message: 'Raise the body font to 16px.' },
    });
    expect(
      driverWorkCall({ ...startTarget, adapter: 'hyperneo', model: 'glm-5.3' }, work).input
    ).toMatchObject({ adapter: 'hyperneo', model: 'glm-5.3' });
  });
});

describe('NEO_WORK_SUMMARY_NOTE', () => {
  test('asks for the outcome and any action in one or two sentences, evidence in fullText', () => {
    expect(NEO_WORK_SUMMARY_NOTE).toContain('shortText is one or two short sentences');
    expect(NEO_WORK_SUMMARY_NOTE).toContain('Keep evidence, commit ids, CI runs');
    expect(NEO_WORK_SUMMARY_NOTE).not.toContain('2 to 4 plain lines');
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
  test('appends the goal and checklist, and leaves a bare instruction alone', () => {
    const goal = { workId: 'w1', goal: 'A full iOS app', doneWhen: '- runs in the simulator' };
    expect(withWorkGoal('Build the chat screen.', goal)).toBe(
      'Build the chat screen.\n\nNeo routed this to you: do it here, not by handing it to another session or chat.\nWhat the human asked: A full iOS app\nDone when:\n- runs in the simulator\nIf you stop before this is done, say what remains and why.'
    );
    expect(withWorkGoal('Build the chat screen.', null)).toBe('Build the chat screen.');
    const longest = withWorkGoal('i'.repeat(16000), {
      workId: 'w1',
      goal: 'g'.repeat(1000),
      doneWhen: 'd'.repeat(2000),
    });
    expect(longest.length).toBeLessThanOrEqual(20000);
    expect(withWorkGoal('Build it.', { workId: 'w1', goal: null, doneWhen: null })).toBe(
      'Build it.'
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
    ).toEqual({ failure: 'not_open: archived' });
    expect(
      readDriverOutcome(startTarget, { kind: 'failed', code: 'execution_failed', message: 'boom' })
    ).toEqual({ failure: 'boom' });
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

  test('gives every message after Neo’s, oldest first, without Neo’s own message', () => {
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
    ).toBe('Agent: Looking.\n\nInput: also the footer\n\nAgent: Both done.');
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
    ).toBe('Input: Raise the font. I mean the footer too\n\nAgent: Done.');
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
      concernId: null,
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
    status: () => unknown = () => ({ ok: false, reason: 'unreachable', detail: 'down' }),
    target: NeoDriverTarget = startTarget
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
          if (name === 'work.status') return status();
          return name === 'work.stop' ? { ok: true, value: { stopped: true } } : reply;
        },
      });
    const registry = createOperationRegistry([
      operation('work.start'),
      operation('work.send'),
      operation('work.stop'),
      operation('work.status'),
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
        concernId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: work.title,
        instruction: work.instruction,
      },
      target
    );
    return { db, service, calls, proposed };
  }

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
      const since = service.driverTargets.readStartedAt('work-1');
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
        concernId: null,
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
      expect(notes[0][2]).toContain('neo.work.continue');
      expect(notes[0][2]).toContain('- voice works');
      expect(notes[0][2]).toContain('Skeleton builds.');
      expect(notes[0][2]).toContain('do not tell the human yet');
      expect(notes[0][2]).toContain(NEO_WORK_SUMMARY_NOTE);

      for (let n = 0; n < 5; n++) service.workContinues.record('work-1', `Step ${n}`, Date.now());
      await service.reconcile('work-1');
      expect(notes[1].slice(0, 2)).toEqual(['neo:root', 'work-1:done-check:5']);
      expect(notes[1][2]).toContain('continue_budget_spent');
      expect(notes[1][2]).toContain('Do not continue it.');
      expect(notes[1][2]).toContain(NEO_WORK_SUMMARY_NOTE);
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
      concernId: null,
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
      concernId: null,
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
      concernId: null,
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
      expect(JSON.parse(notes[0].slice(notes[0].indexOf('\n{'))).ask.cards).toEqual([
        { id: 'work-2', title: 'Ship the docs', status: 'proposed', prs: [docsPr] },
      ]);
      expect(notes[0]).toContain('end the turn without telling the human');
    } finally {
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
        value: { workDrivers: [expect.objectContaining({ workId: 'work-1', unconfirmed: true })] },
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
      concernId: null,
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
      await service.start('work-1');
      await service.refreshDriverWork();
      const reported = service.repo.getWork('work-1')!;
      expect(reported.report).toContain('Waiting for the build.');
      expect(notes).toEqual(['work-1:done-check:0']);

      const later = reported.updatedAt + 60_000;
      reply = {
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: later,
          lastReplyAt: later,
          exchange: [{ at: later, role: 'agent', text: `CI passed; merged ${url}.` }],
        },
      };
      const before = statusCalls();
      await service.refreshDriverWork();
      const followed = service.repo.getWork('work-1')!;
      expect(statusCalls()).toBe(before + 1);
      expect(calls.filter((call) => call.name === 'work.status').at(-1)?.input).toEqual({
        ref,
        since: reportedAt,
      });
      expect(followed.report).toContain(`merged ${url}`);
      expect(followed.report).toContain('Earlier report:');
      expect(service.workPrs.get('work-1')?.prs).toEqual([
        { url, state: 'MERGED', checks: 'passing', review: 'approved' },
      ]);
      expect(notes).toEqual([
        'work-1:done-check:0',
        `work-1:done-check:0:pr:1:at:${followed.updatedAt}`,
      ]);

      await service.refreshDriverWork();
      expect(statusCalls()).toBe(before + 1);

      await service.reconcile('work-1');
      expect(notes).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('reminds Neo once when an approved green pull request sits unmerged and quiet', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6013';
    let reply: unknown = {
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: `Opened ${url}.` },
    };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => reply);
    db.createSession(createTestSession('neo:root'));
    service.workGoals.record('work-1', 'Lower reasoning effort', '- merged to dev');
    fileUnderAsk(service);
    const ready: NeoWorkPr = { url, state: 'OPEN', checks: 'passing', review: 'approved' };
    service.readPrs = async () => [ready];
    const notes: Array<[string, string]> = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string, content: string) => {
        notes.push([messageId, content]);
      },
    });
    const quietFor = (ms: number) => {
      const at = Date.now() - ms;
      const sqlite = db.getDatabase();
      sqlite.prepare('UPDATE neo_work SET updated_at = ? WHERE id = ?').run(at, 'work-1');
      sqlite.prepare('UPDATE neo_work_prs SET read_at = 0 WHERE work_id = ?').run('work-1');
      sqlite.prepare('UPDATE neo_work_checks SET told_at = ? WHERE work_id = ?').run(at, 'work-1');
      return at;
    };
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(notes.map(([id]) => id)).toEqual(['work-1:done-check:0:pr:1']);
      const signature = neoEvidenceSignature(neoWorkPrEvidence([ready]));
      expect(service.workChecks.get('work-1')).toMatchObject({ signature, reminded: null });
      reply = { ok: true, value: { status: 'done', lastActivityAt: 1 } };

      quietFor(10 * 60_000);
      await service.refreshDriverWork();
      expect(notes).toHaveLength(1);

      const toldAt = quietFor(31 * 60_000);
      await service.refreshDriverWork();
      expect(notes.map(([id]) => id)).toEqual([
        'work-1:done-check:0:pr:1',
        `work-1:done-check:0:pr:1:at:${toldAt}`,
      ]);
      expect(notes[1][1]).toContain('still open and nothing has moved');
      expect(service.workChecks.get('work-1')).toMatchObject({ signature, reminded: signature });
      expect(service.workPrs.get('work-1')).toMatchObject({
        reminded: neoWorkPrSignature([ready]),
      });

      quietFor(31 * 60_000);
      await service.refreshDriverWork();
      expect(notes).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("tracks the pull request a card's session opened on its branch without naming it", async () => {
    const ref = { adapter: 'hyperneo', id: 'card-session' };
    const url = 'https://github.com/lsm/HyperNeo/pull/6301';
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'done', lastActivityAt: Date.now() + 1_000, lastReply: 'Fixed it.' },
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
      urls.map((item) => ({ url: item, state: 'OPEN', checks: 'pending', review: 'none' }));
    Object.assign(service, { deliver: async () => {} });
    try {
      db.createSession({ ...createTestSession('card-session'), worktree });
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(branches).toContain('neo/font');
      expect(service.workPrs.get('work-1')?.prs.map((pr) => pr.url)).toEqual([url]);
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
        id: 'ask-icons',
        requestKey: 'neo:root:icons',
        concernId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [
        { text: 'Icons merged to dev', check: 'coding.pr_merged' },
        { text: 'App shows them', check: null },
      ]
    )!;
    service.askRecords.link(opened.id, 'work-1');
    service.readPrs = async () => [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }];
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, _id: string, content: string) => {
        notes.push(content);
      },
    });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.askRecords.get(opened.id)?.doneItems).toEqual([
        expect.objectContaining({
          id: 'i1',
          state: 'met',
          metBy: 'daemon',
          evidence: `Merged: ${url}`,
        }),
        expect.objectContaining({ id: 'i2', state: 'pending' }),
      ]);
      expect(notes.at(-1)).toContain('"state":"met"');
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
        id: 'ask-icons',
        requestKey: 'neo:root:icons',
        concernId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons and their docs',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [{ text: 'Icons and docs merged to dev', check: 'coding.pr_merged' }]
    )!;
    service.repo.proposeWork({
      id: 'work-2',
      requestKey: 'root:docs',
      concernId: null,
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
        id: 'ask-icons',
        requestKey: 'neo:root:icons',
        concernId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons and their docs',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [{ text: 'Icons and docs merged to dev', check: 'coding.pr_merged' }]
    )!;
    service.repo.proposeWork({
      id: 'work-2',
      requestKey: 'root:docs',
      concernId: null,
      originSessionId: 'neo:root',
      originMessageId: 'ask-1',
      title: 'Document the icons',
      instruction: 'Write the docs.',
    });
    for (const id of ['work-1', 'work-2']) service.askRecords.link(opened.id, id);
    service.readPrs = async () => [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }];
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

  test('reopens a waiting ask once its daemon-ticked item no longer needs the human', async () => {
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
        id: 'ask-icons',
        requestKey: 'neo:root:icons',
        concernId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [{ text: 'Icons merged to dev', check: 'coding.pr_merged' }]
    )!;
    service.askRecords.link(opened.id, 'work-1');
    service.askRecords.tickItem(
      opened.id,
      { id: 'i1', state: 'needs_you', evidence: null, metBy: null },
      Date.now()
    );
    service.askRecords.settle(
      service.askRecords.get(opened.id)!,
      'waiting',
      'Icons merged to dev',
      'Icons merged to dev'
    );
    service.readPrs = async () => [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }];
    Object.assign(service, { deliver: async () => {} });
    try {
      await service.start('work-1');
      await service.refreshDriverWork();
      expect(service.askRecords.get(opened.id)).toMatchObject({
        status: 'open',
        doneItems: [expect.objectContaining({ state: 'met', metBy: 'daemon' })],
      });
    } finally {
      db.close();
    }
  });

  test('ticks merged-PR items on the next refresh for asks told about the merge before', async () => {
    const { db, service } = await setup({ ok: true, value: { ref: { id: 't1' } } });
    db.createSession(createTestSession('neo:root'));
    const opened = service.askRecords.open(
      {
        id: 'ask-icons',
        requestKey: 'neo:root:icons',
        concernId: null,
        originSessionId: 'neo:root',
        originMessageId: 'ask-1',
        title: 'Icons',
        ask: 'Regenerate the icons',
        doneWhen: '- merged to dev',
        doneSource: 'human',
      },
      [{ text: 'Icons merged to dev', check: 'coding.pr_merged' }]
    )!;
    service.askRecords.link(opened.id, 'work-1');
    const url = 'https://github.com/lsm/HyperNeo/pull/6265';
    service.workPrs.record(
      'work-1',
      [{ url, state: 'MERGED', checks: 'passing', review: 'approved' }],
      Date.now()
    );
    try {
      await service.refreshDriverWork();
      expect(service.askRecords.get(opened.id)?.doneItems?.[0]).toMatchObject({
        state: 'met',
        metBy: 'daemon',
        evidence: `Merged: ${url}`,
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
        value: { workPrs: [{ workId: 'work-1', prs: [running], waiting: true }] },
      });

      prs = [{ ...running, checks: 'passing', review: 'approved' }];
      const changed = spyOn(service, 'notifyChanged');
      await refreshLater();
      expect(changed).toHaveBeenCalledTimes(1);
      await refreshLater();
      expect(notes.map(([id]) => id)).toEqual(['work-1:done-check:0:pr:2']);
      expect(notes[0][1]).toContain('trust it over the report');
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
      expect(notes[0][2]).toContain(NEO_WORK_SUMMARY_NOTE);
      expect(notes[0][2]).toContain('"workId":"work-1"');
    } finally {
      db.close();
    }
  });

  test('keeps refreshing when returning one report fails and returns it again on recovery', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } }, undefined, () => ({
      ok: true,
      value: { status: 'failed', lastActivityAt: Date.now() + 1_000 },
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

      service.workContinues.record('work-1', 'Also the footer.', Date.now());
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
      expect(notes[0][2]).toContain('work.stop');
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
      expect(notes[0][1]).toContain('neo.work.continue');
      expect(notes[1][1]).not.toContain('neo.work.continue {id');
      expect(notes[1][1]).toContain('tell the human');
      expect(notes[3][1]).toContain('propose closing it');
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
        concernId: null,
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
          concernId: null,
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
        report: 'Voice is durable.',
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

  test('Neo cannot close a work card; only the user can', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    const { db, service } = await setup({ ok: true, value: { ref } });
    try {
      await service.start('work-1');
      db.createSession(createTestSession('neo:root'));
      service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', concernId: null });
      const outcome = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.work.close',
        { id: 'work-1', outcome: 'done' },
        { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
      );
      expect(outcome).toMatchObject({
        kind: 'completed',
        value: { ok: false, reason: 'This action needs the user.' },
      });
      expect(service.repo.getWork('work-1')?.status).toBe('queued');
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
      expect(await service.retryWork('work-1')).toEqual({
        ok: false,
        reason:
          'Starting was interrupted and it may have started anyway; check work.find before proposing it again.',
      });
      expect(calls).toEqual([]);
      expect(service.repo.getWork('work-1')?.status).toBe('failed');
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
      const retried = service.retryWork('work-1');
      finish();
      expect(await retried).toMatchObject({ ok: true, work: { status: 'queued' } });
      expect(calls.filter((call) => call.name === 'work.start')).toHaveLength(2);
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
      expect(delivered[0][2]).toContain('call neo.work.retry {id} on this same work');

      expect(await service.retryWork('work-1')).toMatchObject({
        ok: true,
        work: { id: 'work-1', status: 'failed' },
      });
      expect(delivered.map(([, id]) => id)).toEqual(['work-1', 'work-1:retry:1']);
      expect(delivered[1][2]).toContain('it has been retried 1 time');

      delete reply.reason;
      delete reply.detail;
      Object.assign(reply, { ok: true, value: { ref: { adapter: 'codex-desktop', id: 't1' } } });
      expect(await service.retryWork('work-1')).toMatchObject({
        ok: true,
        work: { id: 'work-1', status: 'queued' },
      });
      expect(calls.filter((call) => call.name === 'work.start')).toHaveLength(3);
      expect(service.repo.listWork()).toHaveLength(1);
      expect(await service.retryWork('work-1')).toMatchObject({ ok: false });
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
      report: 'Shipped.',
    });
    expect(settle(status({ status: 'done' }))).toEqual({
      status: 'reported',
      report: 'It finished without a written reply.',
    });
    expect(settle(status({ status: 'failed', lastReply: 'Tests broke.' }))).toEqual({
      status: 'failed',
      report: 'It failed. Tests broke.',
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
  test('keeps a request key bound to its drivers target', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession('root'));
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
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
        { requestKey: 'font', title: work.title, instruction: work.instruction, ...target },
        neo
      );
    try {
      expect(await propose({ work: sendTarget })).toMatchObject({
        kind: 'completed',
        value: { ok: true },
      });
      expect(await propose({ work: sendTarget })).toMatchObject({ value: { ok: true } });
      expect(await propose({ targetSessionId: 'other' })).toMatchObject({
        value: { ok: false },
      });
      expect(await propose({ work: startTarget })).toMatchObject({ value: { ok: false } });
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
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
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
        {
          requestKey,
          title: 'Fix it',
          instruction: 'Fix the bug.',
          work: { verb: 'start', adapter, place },
        },
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
