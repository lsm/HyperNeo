import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoWorkDriverReceipt, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { neoCardPhase } from '../../../../src/lib/neo/card-phase.ts';
import { NeoCardViewSchema } from '../../../../src/lib/neo/card-view-schema.ts';
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
      primary: { kind: 'none', label: null, link: null },
      actions: [],
    });
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
});
