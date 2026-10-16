import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type {
  NeoAsk,
  NeoAskItem,
  NeoWorkDriverReceipt,
  NeoWorkPr,
} from '@hyperneo/shared/types/neo-snapshot';
import { NEO_ASK_IDLE_LABEL, projectNeoAskViews } from '../../../../src/lib/neo/ask-views.ts';
import { busyNeoAskSessions } from '../../../../src/lib/neo/session-ask-links.ts';
import { neoCardPhase } from '../../../../src/lib/neo/card-phase.ts';
import { runMigration381 } from '../../../../src/storage/schema/m381-neo-ask-refusal.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';
import { NeoAskViewSchema, NeoCardViewSchema } from '../../../../src/lib/neo/card-view-schema.ts';
import { type NeoCardViewParts, projectNeoCardViews } from '../../../../src/lib/neo/card-views.ts';
import {
  NEO_WORK_UNANCHORED_NOTE,
  NEO_WORK_UNVERIFIED_REPLY_NOTE,
} from '../../../../src/lib/neo/driver-work.ts';

const work = (id: string, status: NeoWork['status'], sessionId: string | null = null): NeoWork => ({
  id,
  requestKey: id,
  projectId: null,
  originSessionId: 'neo',
  originMessageId: null,
  title: id,
  instruction: '',
  sessionId,
  status,
  report: null,
  createdAt: 1,
  updatedAt: 1,
});

const driver = (
  workId: string,
  status: NeoWorkDriverReceipt['status'],
  extra: Partial<NeoWorkDriverReceipt> = {}
): NeoWorkDriverReceipt => ({
  workId,
  adapter: 'codex-desktop',
  daemon: null,
  status,
  link: 'codex://threads/t1',
  ...extra,
});

const pr = (n: number, extra: Partial<NeoWorkPr> = {}): NeoWorkPr => ({
  url: `https://github.com/o/r/pull/${n}`,
  state: 'OPEN',
  checks: 'passing',
  review: 'none',
  ...extra,
});

const ask = (extra: Partial<NeoAsk>): NeoAsk => ({
  id: 'a1',
  requestKey: 'a1',
  projectId: null,
  originSessionId: 'neo',
  originMessageId: null,
  title: 'Ask',
  ask: 'Ask',
  doneWhen: '',
  doneSource: '',
  status: 'open',
  outcome: null,
  workIds: [],
  createdAt: 1,
  updatedAt: 1,
  settledAt: null,
  ...extra,
});

const parts = (extra: Partial<NeoCardViewParts>): NeoCardViewParts => ({
  work: [],
  drivers: [],
  prs: [],
  goals: [],
  continues: [],
  supersessions: [],
  asks: [],
  ...extra,
});

describe('neoCardPhase', () => {
  test('reads the driver for queued work and the PRs for reported work', () => {
    expect(neoCardPhase(work('w', 'queued'), undefined, [])).toBe('handed');
    expect(neoCardPhase(work('w', 'queued'), driver('w', 'running'), [])).toBe('running');
    expect(neoCardPhase(work('w', 'queued'), driver('w', 'needs_you'), [])).toBe('needs_you');
    expect(neoCardPhase(work('w', 'queued'), driver('w', 'done'), [])).toBe('checking');
    expect(neoCardPhase(work('w', 'queued'), driver('w', 'stopped'), [])).toBe('stopped');
    expect(neoCardPhase(work('w', 'queued'), driver('w', 'running', { abandoned: true }), [])).toBe(
      'abandoned'
    );
    expect(neoCardPhase(work('w', 'reported'), undefined, [])).toBe('reported');
    expect(neoCardPhase(work('w', 'reported'), undefined, [pr(1)])).toBe('pr_open');
    expect(neoCardPhase(work('w', 'reported'), undefined, [pr(1, { checks: 'failing' })])).toBe(
      'pr_setback'
    );
    expect(neoCardPhase(work('w', 'reported'), undefined, [pr(1, { state: 'MERGED' })])).toBe(
      'merged'
    );
    expect(neoCardPhase(work('w', 'proposed'), undefined, [])).toBe('proposed');
  });
});

describe('projectNeoCardViews', () => {
  test('a waiting card carries its unverified prerequisites, its automatic start and any uncertain start', () => {
    const waitingFor = [
      {
        workId: 'p',
        title: 'Land the API',
        reason: 'outcomes_unverified',
        items: [{ id: 'i1', text: 'API merged to dev' }],
      },
    ];
    const cards = projectNeoCardViews(
      parts({
        work: [work('w', 'proposed'), work('u', 'failed'), work('plain', 'proposed')],
        waits: [
          { workId: 'w', waitingFor, autoStart: true, uncertain: false },
          { workId: 'u', waitingFor: [], autoStart: false, uncertain: true },
        ],
      })
    );
    expect(cards[0]).toMatchObject({ waitingFor, autoStart: true, phase: 'proposed' });
    expect(cards[0]).not.toHaveProperty('uncertain');
    expect(cards[1]).toMatchObject({ uncertain: true });
    expect(cards[1]).not.toHaveProperty('waitingFor');
    expect(cards[2]).not.toHaveProperty('waitingFor');
    expect(cards[2]).not.toHaveProperty('autoStart');
    for (const card of cards) expect(NeoCardViewSchema.parse(card)).toEqual(card);
  });

  test('a queued card waiting on Codex asks the user to answer there', () => {
    const cards = projectNeoCardViews(
      parts({
        work: [work('w', 'queued')],
        drivers: [driver('w', 'needs_you', { unconfirmed: true, uncheckedSince: 5 })],
      })
    );
    expect(cards[0]).toMatchObject({
      phase: 'needs_you',
      group: 'attention',
      tone: 'warning',
      label: 'Needs you in Codex Desktop · not confirmed it got this',
      primary: { kind: 'answer', label: 'Answer in Codex', link: 'codex://threads/t1' },
      actions: ['done', 'close'],
      uncheckedSince: 5,
      unconfirmed: true,
    });
  });

  test('a retryable or abandoned card leads with retry or close', () => {
    const cards = projectNeoCardViews(
      parts({
        work: [work('r', 'failed'), work('x', 'queued', 's1')],
        drivers: [
          driver('r', 'failed', { retryable: true }),
          driver('x', 'running', { abandoned: true }),
        ],
      })
    );
    expect(cards[0]).toMatchObject({
      primary: { kind: 'retry', label: 'Retry' },
      actions: ['retry', 'done', 'close'],
      retryable: true,
    });
    expect(cards[1]).toMatchObject({
      phase: 'abandoned',
      group: 'attention',
      primary: { kind: 'close', label: 'Close', link: null },
    });
  });

  test('a reported card carries its PR summary, goal and continues', () => {
    const cards = projectNeoCardViews(
      parts({
        work: [work('w', 'reported', 's1')],
        prs: [{ workId: 'w', prs: [pr(7, { checks: 'pending' }), pr(8)], waiting: true }],
        goals: [{ workId: 'w', goal: 'Ship it', doneWhen: 'Merged' }],
        continues: [
          { workId: 'w', count: 2, continuedAt: 1, lastMessage: 'go', progress: null, stalled: 0 },
        ],
        asks: [ask({ workIds: ['w'], pooled: true })],
      })
    );
    expect(cards[0]).toMatchObject({
      phase: 'pr_open',
      group: 'running',
      tone: 'accent',
      label: 'Waiting on CI · #7 +1',
      pr: { number: '#7', count: 2, inProgress: true, setback: false },
      goal: 'Ship it',
      doneWhen: 'Merged',
      continued: 2,
      pooled: true,
      primary: { kind: 'chat', label: 'Open chat', link: null },
      actions: [],
    });
  });

  test('an abandoned card that still needs you keeps the warning tone', () => {
    const cards = projectNeoCardViews(
      parts({
        work: [work('a', 'queued'), work('b', 'queued')],
        drivers: [
          driver('a', 'needs_you', { abandoned: true }),
          driver('b', 'running', { abandoned: true }),
        ],
      })
    );
    expect(cards.map((card) => [card.phase, card.tone])).toEqual([
      ['abandoned', 'warning'],
      ['abandoned', 'accent'],
    ]);
  });

  test('only a merged card is a success; a reply or an open PR is not', () => {
    const cards = projectNeoCardViews(
      parts({
        work: [work('r', 'reported'), work('o', 'reported'), work('m', 'reported')],
        prs: [
          { workId: 'o', prs: [pr(1, { checks: 'pending' })], waiting: false },
          { workId: 'm', prs: [pr(2, { state: 'MERGED' })], waiting: false },
        ],
      })
    );
    expect(cards.map((card) => [card.phase, card.label, card.tone])).toEqual([
      ['reported', 'Reply received', 'accent'],
      ['pr_open', 'Waiting on CI · #1', 'accent'],
      ['merged', 'Merged · #2', 'success'],
    ]);
  });

  test('a reply that cannot be attributed says so and where it came from', () => {
    const reported = (id: string, report: string) => ({ ...work(id, 'reported'), report });
    const cards = projectNeoCardViews(
      parts({
        work: [
          reported('u', `${NEO_WORK_UNVERIFIED_REPLY_NOTE}\n\nAgent: Done.`),
          reported('a', `${NEO_WORK_UNANCHORED_NOTE}\n\nDone.`),
          reported('v', 'Agent: Done.'),
          reported('p', `${NEO_WORK_UNVERIFIED_REPLY_NOTE}\n\nAgent: Opened it.`),
          { ...work('f', 'failed'), report: `It stopped. ${NEO_WORK_UNVERIFIED_REPLY_NOTE}` },
        ],
        prs: [{ workId: 'p', prs: [pr(3, { state: 'MERGED' })], waiting: false }],
      })
    );
    expect(cards.map((card) => [card.label, card.tone, card.replyUnverified])).toEqual([
      [
        'Reply received · not verified',
        'accent',
        "This is the session's latest reply. Its history could not show which message it answers.",
      ],
      [
        'Reply received · not verified',
        'accent',
        "This is the session's latest reply. Neo's message was not found in its history.",
      ],
      ['Reply received', 'accent', undefined],
      ['Merged · #3', 'success', undefined],
      ['Failed', 'warning', undefined],
    ]);
    expect(NeoCardViewSchema.parse(cards[0])).toEqual(cards[0]);
  });

  test('a card carries when Neo last checked it, checked or not', () => {
    const cards = projectNeoCardViews(
      parts({
        work: [work('a', 'queued'), work('b', 'queued'), work('c', 'queued')],
        drivers: [
          driver('a', 'running', { checkedAt: 7 }),
          driver('b', 'running', { checkedAt: 5, uncheckedSince: 5 }),
          driver('c', 'running'),
        ],
      })
    );
    expect(cards.map((card) => [card.checkedAt, card.uncheckedSince])).toEqual([
      [7, null],
      [5, 5],
      [null, null],
    ]);
  });

  test('a proposed card can start or be declined; a sessionless cancel is hidden', () => {
    const cards = projectNeoCardViews(
      parts({ work: [work('p', 'proposed'), work('c', 'cancelled')] })
    );
    expect(cards[0]).toMatchObject({
      label: 'Your call',
      primary: { kind: 'start', label: 'Start work' },
      actions: ['start', 'cancel'],
    });
    expect(cards[1]).toMatchObject({ phase: 'cancelled', hidden: true, label: 'Stopped' });
  });

  test('the snapshot schema keeps every card field', () => {
    const cards = projectNeoCardViews(
      parts({
        work: [work('w', 'reported')],
        prs: [{ workId: 'w', prs: [pr(1)], waiting: false }],
        asks: [ask({ workIds: ['w'] })],
        drivers: [driver('w', 'done', { model: 'gpt-6.1-sol', effort: 'medium' })],
      })
    );
    expect(NeoCardViewSchema.parse(cards[0])).toEqual(cards[0]);
    expect(cards[0]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
  });

  test('does not invent configuration for a legacy receipt', () => {
    const [card] = projectNeoCardViews(
      parts({ work: [work('w', 'queued')], drivers: [driver('w', 'running')] })
    );
    expect(card.model).toBeUndefined();
    expect(card.effort).toBeUndefined();
  });

  test('a card needing you in its own chat still asks for an answer', () => {
    const cards = projectNeoCardViews(
      parts({
        work: [work('w', 'queued', 's1')],
        drivers: [driver('w', 'needs_you', { adapter: 'hyperneo', link: '/session/s1' })],
      })
    );
    expect(cards[0].primary).toEqual({ kind: 'answer', label: 'Answer in chat', link: null });
  });

  test('the open target carries the raw link, Remote Control link and session', () => {
    const cards = projectNeoCardViews(
      parts({
        work: [work('h', 'queued'), work('c', 'queued', 's9')],
        drivers: [
          driver('h', 'running', { adapter: 'hyperneo', link: '/session/abc-1' }),
          driver('c', 'running', {
            adapter: 'claude-desktop',
            daemon: 'imac',
            link: 'claude://claude.ai/epitaxy/x',
            remoteLink: 'https://claude.ai/code/session_1',
          }),
        ],
      })
    );
    expect(cards.map((card) => card.open)).toEqual([
      { link: '/session/abc-1', remoteLink: null, sessionId: 'abc-1', daemon: null },
      {
        link: 'claude://claude.ai/epitaxy/x',
        remoteLink: 'https://claude.ai/code/session_1',
        sessionId: 's9',
        daemon: 'imac',
      },
    ]);
  });

  test('a card carries its last continue message and merged PR numbers', () => {
    const cards = projectNeoCardViews(
      parts({
        work: [work('w', 'reported')],
        prs: [{ workId: 'w', prs: [pr(3, { state: 'MERGED' }), pr(4)], waiting: false }],
        continues: [
          {
            workId: 'w',
            count: 1,
            continuedAt: 1,
            lastMessage: 'Fix CI',
            progress: null,
            stalled: 0,
          },
        ],
      })
    );
    expect(cards[0]).toMatchObject({ continuedMessage: 'Fix CI', pr: { merged: ['#3'] } });
  });
});

const item = (id: string, state: NeoAskItem['state'], removed = false): NeoAskItem => ({
  id,
  text: id,
  state,
  evidence: null,
  check: null,
  metBy: state === 'met' ? 'neo' : null,
  removed,
  addedAt: null,
});

describe('projectNeoAskViews', () => {
  test('an open ask needs you when a live card does, and skips a superseded failure', () => {
    const input = parts({
      work: [
        work('old', 'failed'),
        work('new', 'queued'),
        work('done', 'reported'),
        work('replied', 'reported'),
      ],
      drivers: [driver('new', 'needs_you')],
      prs: [{ workId: 'done', prs: [pr(3, { state: 'MERGED' })], waiting: false }],
      supersessions: [{ workId: 'old', supersededBy: 'new', supersededAt: 1 }],
      asks: [ask({ workIds: ['old', 'new', 'done', 'replied'] })],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]).toEqual({
      askId: 'a1',
      group: 'attention',
      label: 'Needs you',
      settled: false,
      needsYou: true,
      done: 1,
      total: 3,
      workIds: ['new', 'done', 'replied'],
      doneWorkIds: ['done'],
      summary: null,
      sessions: [],
      answer: null,
      humanActions: [],
    });
  });

  test('a linked session that needs the human puts a running ask in attention, and a settled ask drops its sessions', () => {
    const linked = {
      key: 'codex-desktop::t1',
      title: 'Ship the fix',
      adapter: 'codex-desktop',
      status: 'needs_you' as const,
      kind: 'needs_you' as const,
      open: { link: 'codex://threads/t1', remoteLink: null, sessionId: null, daemon: null },
    };
    const input = parts({
      work: [work('w', 'queued')],
      asks: [ask({ workIds: ['w'] }), ask({ id: 'a2', status: 'achieved', workIds: [] })],
    });
    const views = projectNeoAskViews(
      input.asks,
      projectNeoCardViews(input),
      input.prs,
      new Map([
        ['a1', [linked]],
        ['a2', [linked]],
      ])
    );
    expect(views[0]).toMatchObject({
      group: 'attention',
      label: 'Needs you',
      needsYou: true,
      sessions: [linked],
    });
    expect(NeoAskViewSchema.parse(views[0])).toEqual(views[0]);
    expect(views[1]).toMatchObject({ group: 'outcomes', needsYou: false, sessions: [] });
    const quiet = projectNeoAskViews(
      input.asks,
      projectNeoCardViews(input),
      input.prs,
      new Map([['a1', [{ ...linked, status: 'running' as const, kind: null }]]])
    );
    expect(quiet[0]).toMatchObject({ group: 'running', needsYou: false });
  });

  test('an open ask whose cards all ended says nothing is running, and only then', () => {
    const input = parts({
      work: [work('gone', 'cancelled', 's1'), work('live', 'queued'), work('unsent', 'cancelled')],
      asks: [
        ask({ workIds: ['gone'] }),
        ask({ id: 'a2', workIds: ['gone', 'live'] }),
        ask({ id: 'a3', workIds: ['gone'], doneItems: [item('a', 'met')] }),
      ],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]).toMatchObject({
      group: 'attention',
      label: NEO_ASK_IDLE_LABEL,
      idle: true,
      humanActions: [],
    });
    expect(NeoAskViewSchema.parse(views[0])).toEqual(views[0]);
    expect(views[1]).toMatchObject({ group: 'running', label: 'Working on it' });
    expect(views[1]).not.toHaveProperty('idle');
    expect(views[2]).not.toHaveProperty('idle');
    expect(
      projectNeoAskViews(
        [ask({ id: 'a5', workIds: ['unsent'] })],
        projectNeoCardViews(input),
        input.prs
      )[0]
    ).toMatchObject({ idle: true, label: NEO_ASK_IDLE_LABEL });
    const running = {
      key: 'codex-desktop::t1',
      title: 'Ship the fix',
      adapter: 'codex-desktop',
      status: 'running' as const,
      kind: null,
      open: { link: null, remoteLink: null, sessionId: null, daemon: null },
    };
    const linked = projectNeoAskViews(
      [...input.asks, ask({ id: 'a4', workIds: [] })],
      projectNeoCardViews(input),
      input.prs,
      new Map([['a1', [running]]])
    );
    expect(linked[0]).toMatchObject({ group: 'running', label: 'Working on it' });
    expect(linked[0]).not.toHaveProperty('idle');
    expect(linked[3]).toMatchObject({ idle: true, humanActions: [] });
    const muted = projectNeoAskViews(
      input.asks,
      projectNeoCardViews(input),
      input.prs,
      new Map(),
      busyNeoAskSessions(new Map([['a1', [running]]]))
    );
    expect(muted[0]).toMatchObject({ label: 'Working on it', sessions: [] });
    expect(muted[0]).not.toHaveProperty('idle');
  });

  test('an open ask that never got a card is idle, and says why its propose was refused', () => {
    const input = parts({ work: [], asks: [] });
    const [quiet, refused] = projectNeoAskViews(
      [
        ask({ id: 'quiet', doneItems: [item('a', 'pending')] }),
        ask({
          id: 'refused',
          doneItems: [item('a', 'pending')],
          refused:
            'The claude-code adapter cannot start work. Adapters that can: hyperneo, codex-desktop.',
        }),
      ],
      projectNeoCardViews(input),
      input.prs
    );
    expect(quiet).toMatchObject({
      group: 'attention',
      label: 'Not started · Neo is trying another way',
      idle: true,
      humanActions: [],
    });
    expect(quiet).not.toHaveProperty('idleReason');
    expect(refused).toMatchObject({
      label: 'Not started · Neo is trying another way',
      idleReason: "Couldn't start: The claude-code adapter cannot start work",
      humanActions: [],
    });
    expect(NeoAskViewSchema.parse(refused)).toEqual(refused);
    const busy = projectNeoAskViews(
      [ask({ id: 'refused', refused: 'No adapter.' })],
      projectNeoCardViews(input),
      input.prs,
      new Map(),
      new Set(['refused'])
    )[0];
    expect(busy).not.toHaveProperty('idle');
    expect(busy.label).toBe('Working on it');
  });

  test('refusal counts stay factual and only a real question needs the human', () => {
    const input = parts({ work: [], asks: [] });
    const view = (refusedCount: number) =>
      projectNeoAskViews(
        [ask({ refused: 'No adapter can start work.', refusedCount })],
        projectNeoCardViews(input),
        input.prs
      )[0];
    expect(view(2)).toMatchObject({
      label: 'Not started · Neo is trying another way',
      needsYou: false,
    });
    expect(view(100)).toMatchObject({
      group: 'attention',
      label: 'Not started · Neo is trying another way',
      needsYou: false,
      idle: true,
      humanActions: [],
    });
    const asked = projectNeoAskViews(
      [
        ask({
          status: 'waiting',
          refused: 'No adapter can start work.',
          refusedCount: 100,
          doneItems: [
            { ...item('q', 'needs_you'), kind: 'decision', options: ['Use Codex', 'Stop'] },
          ],
        }),
      ],
      projectNeoCardViews(input),
      input.prs
    )[0];
    expect(asked).toMatchObject({ group: 'attention', label: 'Waiting on you' });
    expect(asked.answer).toMatchObject({ itemId: 'q', options: ['Use Codex', 'Stop'] });
    expect(asked).not.toHaveProperty('idle');
  });

  test('done items count instead of cards when the ask has them', () => {
    const input = parts({
      work: [work('w', 'queued')],
      asks: [
        ask({
          workIds: ['w'],
          doneItems: [item('a', 'met'), item('b', 'pending'), item('c', 'met', true)],
        }),
      ],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]).toMatchObject({ group: 'running', label: 'Working on it', done: 1, total: 2 });
  });

  test('an ask waiting on a decision answers it in chat, with the item options', () => {
    const decision = { ...item('b', 'needs_you'), options: ['Yes', 'No'] };
    const input = parts({
      work: [work('w', 'queued')],
      asks: [
        ask({
          workIds: ['w'],
          status: 'waiting',
          waitingItem: 'b',
          doneItems: [item('a', 'met'), decision],
        }),
        ask({ id: 'a2', status: 'achieved', workIds: [], doneItems: [decision] }),
      ],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]?.answer).toEqual({
      itemId: 'b',
      question: decision.text,
      label: 'Answer in chat',
      options: ['Yes', 'No'],
    });
    expect(NeoAskViewSchema.parse(views[0])).toEqual(views[0]);
    expect(views[1]?.answer).toBeNull();
  });

  test('an achieved ask with a long outcome summarizes its merged PRs', () => {
    const input = parts({
      work: [work('w', 'reported')],
      prs: [{ workId: 'w', prs: [pr(9, { state: 'MERGED' })], waiting: false }],
      asks: [ask({ status: 'achieved', outcome: 'x'.repeat(200), workIds: ['w'] })],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]).toMatchObject({
      group: 'outcomes',
      label: 'Done',
      settled: true,
      summary: 'Merged in #9.',
    });
  });

  test('human actions come from cards, approval and items, never from item prose', () => {
    const input = parts({
      work: [work('p', 'proposed'), work('r', 'failed'), work('q', 'queued')],
      drivers: [driver('r', 'failed', { retryable: true }), driver('q', 'running')],
      asks: [
        ask({
          workIds: ['p', 'r', 'q'],
          approvalSpent: 'expired',
          doneItems: [
            { ...item('d', 'needs_you'), options: ['A', 'B'], kind: 'decision' },
            {
              ...item('s', 'needs_you'),
              kind: 'action',
              question: '这一步成功了吗？',
              options: ['成功了', '没成功'],
            },
            { ...item('g', 'needs_you'), kind: 'action' },
            {
              ...item('o', 'needs_you'),
              kind: 'action',
              question: 'o',
              options: ['It hid', 'Still showing'],
            },
            { ...item('c', 'needs_you'), kind: 'action', waitCard: 'p' },
            item('m', 'reported'),
            { ...item('w', 'needs_you'), kind: 'wait' },
            item('x', 'pending'),
          ],
        }),
      ],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]?.humanActions).toEqual([
      { kind: 'start', workId: 'p' },
      { kind: 'retry', workId: 'r' },
      { kind: 'approve', reason: 'expired' },
      { kind: 'answer', itemId: 'd', step: null, question: 'd', options: ['A', 'B'] },
      {
        kind: 'answer',
        itemId: 's',
        step: 's',
        question: '这一步成功了吗？',
        options: ['成功了', '没成功'],
      },
      {
        kind: 'answer',
        itemId: 'o',
        step: null,
        question: 'o',
        options: ['It hid', 'Still showing'],
      },
      { kind: 'confirm', itemId: 'm', step: 'm' },
    ]);
    expect(NeoAskViewSchema.parse(views[0])).toEqual(views[0]);
  });

  test('the old continue-count stall no longer asks for Approve', () => {
    const input = parts({
      work: [work('q', 'queued')],
      drivers: [driver('q', 'running')],
      asks: [ask({ workIds: ['q'], approvedAt: 5, approvalSpent: 'continues' })],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]?.humanActions).toEqual([]);
  });

  test('a card stalled by three wakes without progress asks for Approve, naming the card', () => {
    const input = parts({
      work: [work('q', 'queued'), work('r', 'queued')],
      drivers: [driver('q', 'running'), driver('r', 'running')],
      asks: [ask({ workIds: ['q', 'r'], approvedAt: 5, stalledWorkIds: ['r'] })],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]?.humanActions).toEqual([
      { kind: 'approve', reason: 'stalled', workIds: ['r'] },
    ]);
    expect(NeoAskViewSchema.parse(views[0])).toEqual(views[0]);
  });

  test('an expired approval asks once, even with a stalled card', () => {
    const input = parts({
      work: [work('q', 'queued')],
      drivers: [driver('q', 'running')],
      asks: [ask({ workIds: ['q'], approvalSpent: 'expired', stalledWorkIds: ['q'] })],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]?.humanActions).toEqual([{ kind: 'approve', reason: 'expired' }]);
  });

  test('a proposed card under an approved ask keeps Start, and a settled ask asks nothing', () => {
    const input = parts({
      work: [work('p', 'proposed'), work('q', 'queued')],
      drivers: [driver('q', 'running', { abandoned: true })],
      asks: [
        ask({ workIds: ['p', 'q'], approvedAt: 5 }),
        ask({ id: 'a2', status: 'achieved', workIds: ['p'], approvalSpent: 'expired' }),
      ],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]?.humanActions).toEqual([
      { kind: 'start', workId: 'p' },
      { kind: 'close', workId: 'q' },
    ]);
    expect(views[1]?.humanActions).toEqual([]);
  });

  test('the snapshot schema keeps every ask view field', () => {
    const input = parts({ work: [work('w', 'queued')], asks: [ask({ workIds: ['w'] })] });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(NeoAskViewSchema.parse(views[0])).toEqual(views[0]);
  });
});

describe('runMigration381', () => {
  test('m381 repairs a partly added refusal column pair', () => {
    const db = new Sqlite(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY, refused TEXT)');
    runMigration381(db);
    runMigration381(db);
    const columns = (db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).map(
      (column) => column.name
    );
    expect(columns).toEqual(['id', 'refused', 'refused_count']);
  });
});
