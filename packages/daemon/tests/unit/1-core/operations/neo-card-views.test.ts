import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type {
  NeoAsk,
  NeoAskItem,
  NeoWorkDriverReceipt,
  NeoWorkPr,
} from '@hyperneo/shared/types/neo-snapshot';
import { projectNeoAskViews } from '../../../../src/lib/neo/ask-views.ts';
import { neoCardPhase } from '../../../../src/lib/neo/card-phase.ts';
import { NeoAskViewSchema, NeoCardViewSchema } from '../../../../src/lib/neo/card-view-schema.ts';
import { type NeoCardViewParts, projectNeoCardViews } from '../../../../src/lib/neo/card-views.ts';

const work = (id: string, status: NeoWork['status'], sessionId: string | null = null): NeoWork => ({
  id,
  requestKey: id,
  concernId: null,
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
  concernId: null,
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
        continues: [{ workId: 'w', count: 2, continuedAt: 1, lastMessage: 'go' }],
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
      })
    );
    expect(NeoCardViewSchema.parse(cards[0])).toEqual(cards[0]);
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
        continues: [{ workId: 'w', count: 1, continuedAt: 1, lastMessage: 'Fix CI' }],
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
      work: [work('old', 'failed'), work('new', 'queued'), work('done', 'reported')],
      drivers: [driver('new', 'needs_you')],
      supersessions: [{ workId: 'old', supersededBy: 'new', supersededAt: 1 }],
      asks: [ask({ workIds: ['old', 'new', 'done'] })],
    });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(views[0]).toEqual({
      askId: 'a1',
      group: 'attention',
      label: 'Needs you',
      settled: false,
      needsYou: true,
      done: 1,
      total: 2,
      workIds: ['new', 'done'],
      doneWorkIds: ['done'],
      summary: null,
    });
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

  test('the snapshot schema keeps every ask view field', () => {
    const input = parts({ work: [work('w', 'queued')], asks: [ask({ workIds: ['w'] })] });
    const views = projectNeoAskViews(input.asks, projectNeoCardViews(input), input.prs);
    expect(NeoAskViewSchema.parse(views[0])).toEqual(views[0]);
  });
});
