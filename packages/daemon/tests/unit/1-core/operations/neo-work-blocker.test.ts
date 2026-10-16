import { describe, expect, test } from 'bun:test';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import {
  neoEnvironmentMoveNote,
  neoWorkBlockerLine,
  planNeoEnvironmentMove,
  readNeoWorkBlocker,
  NEO_WORK_EARLIER_REPORT,
  NEO_WORK_REPORT_LIMIT,
} from '../../../../src/lib/neo/work-blocker.ts';
import { admitNeoWorkReportInput } from '../../../../src/lib/neo/work-report.ts';
import {
  driverDoneCheckNote,
  NEO_WORK_LATER_REPLIES_CUT,
  withWorkGoal,
} from '../../../../src/lib/neo/driver-work.ts';

const roundSix = `Implemented and committed as 7536941 on fix/clamp-discount-pct.
PR creation is blocked by unavailable GitHub authentication.

Blocked (environment): the shell cannot resolve GitHub and gh has no token`;
const place = { machine: 'laptop', folder: '/work/review-test', name: 'review-test' };
const start = { verb: 'start' as const, adapter: 'codex-desktop', place };
const environment = { kind: 'environment' as const, what: 'no DNS and no GitHub token' };
const adapters = [
  { id: 'codex-desktop', capabilities: ['find', 'start', 'send'] },
  { id: 'claude-desktop', capabilities: ['find', 'start', 'send'] },
  { id: 'claude-code', capabilities: ['find', 'send'] },
  { id: 'hyperneo', capabilities: ['find', 'start', 'send'] },
  { id: 'space', capabilities: ['find', 'start'] },
];

describe('readNeoWorkBlocker', () => {
  test('reads the blocker the worker declared on its last blocked line', () => {
    expect(readNeoWorkBlocker(roundSix)).toEqual({
      kind: 'environment',
      what: 'the shell cannot resolve GitHub and gh has no token',
    });
    expect(
      readNeoWorkBlocker(
        'Blocked (environment): no DNS\nRetried.\nBlocked (needs_human): pick a pricing rule\n'
      )
    ).toEqual({ kind: 'needs_human', what: 'pick a pricing rule' });
    expect(
      readNeoWorkBlocker(
        `Agent: Blocked (needs_human): pick a rule${NEO_WORK_EARLIER_REPORT}Blocked (environment): no DNS`
      )
    ).toEqual({ kind: 'needs_human', what: 'pick a rule' });
    expect(
      readNeoWorkBlocker(`Agent: Blocked (environment): no DNS\n\n${NEO_WORK_LATER_REPLIES_CUT}`)
    ).toEqual({ kind: 'environment', what: 'no DNS' });
    expect(readNeoWorkBlocker('Agent: Blocked (environment): no DNS')).toEqual({
      kind: 'environment',
      what: 'no DNS',
    });
  });

  test.each([
    'The shell cannot resolve GitHub, but I pushed over SSH and opened the PR.',
    'Blocked (other): something',
    `Agent: Recovered and opened the PR.${NEO_WORK_EARLIER_REPORT}Blocked (environment): no DNS`,
    'Blocked (environment): no DNS\n\nAgent: Recovered over SSH and opened the PR.',
    'Blocked (environment):',
    null,
  ])('a report with no declared blocker has none: %s', (report) => {
    expect(readNeoWorkBlocker(report)).toBeNull();
  });

  test('a declared blocker round-trips through its line', () => {
    expect(readNeoWorkBlocker(neoWorkBlockerLine(environment))).toEqual(environment);
  });
});

describe('neo.work.report blocker', () => {
  test('a near-limit report with a blocker still fits the report limit and ends with the line', () => {
    const admitted = admitNeoWorkReportInput({
      id: 'w1',
      status: 'failed',
      report: 'x'.repeat(12000),
      blocker: environment,
    });
    if (!('value' in admitted)) throw new Error('Expected admission');
    expect(admitted.value.report.length).toBeLessThanOrEqual(NEO_WORK_REPORT_LIMIT);
    expect(readNeoWorkBlocker(admitted.value.report)).toEqual(environment);
    expect(admitNeoWorkReportInput(admitted.value)).toEqual(admitted);
  });

  test('a reported blocker is written into the report as the declared line', () => {
    expect(
      admitNeoWorkReportInput({
        id: 'w1',
        status: 'failed',
        report: 'Could not push.',
        blocker: environment,
      })
    ).toEqual({
      value: {
        id: 'w1',
        status: 'failed',
        report: `Could not push.\n\n${neoWorkBlockerLine(environment)}`,
      },
    });
  });
});

describe('the brief asks the worker to declare a blocker', () => {
  test.each([
    ['a goal brief', { workId: 'w1', goal: 'Open a PR', doneWhen: '- PR open' }],
    ['a brief with no goal or done-when', null],
  ])('%s names both blocker lines', (_name, goal) => {
    const brief = withWorkGoal('Open a PR.', goal);
    expect(brief).toContain('Blocked (environment):');
    expect(brief).toContain('Blocked (needs_human):');
  });
});

describe('planNeoEnvironmentMove', () => {
  test('an environment blocker offers the other adapters that can start in the same folder', () => {
    expect(planNeoEnvironmentMove(environment, start, adapters)).toEqual({
      value: { failure: environment.what, adapters: ['claude-desktop', 'hyperneo'] },
    });
  });

  test('a Space place moves only to a Space', () => {
    expect(
      planNeoEnvironmentMove(
        environment,
        { verb: 'start', adapter: 'hyperneo', place: { ...place, spaceId: 's1' } },
        adapters
      )
    ).toEqual({ value: { failure: environment.what, adapters: ['space'] } });
  });

  test('a needs_human blocker, no blocker, no started place, no adapters or no alternative means no move', () => {
    expect(
      planNeoEnvironmentMove({ kind: 'needs_human', what: 'choose' }, start, adapters)
    ).toEqual({ reason: null });
    expect(planNeoEnvironmentMove(null, start, adapters)).toEqual({ reason: null });
    expect(
      planNeoEnvironmentMove(
        environment,
        { verb: 'send', ref: { adapter: 'codex-desktop', id: 't1' } },
        adapters
      )
    ).toEqual({ reason: null });
    expect(planNeoEnvironmentMove(environment, start, null)).toEqual({ reason: null });
    expect(planNeoEnvironmentMove(environment, start, [adapters[0]])).toEqual({ reason: null });
  });
});

describe('neoEnvironmentMoveNote', () => {
  test('states the failure and the adapters; the system prompt says to propose the move', () => {
    const note = neoEnvironmentMoveNote({
      failure: environment.what,
      adapters: ['claude-desktop', 'hyperneo'],
    });
    expect(note).toContain(environment.what);
    expect(note).toContain('claude-desktop, hyperneo');
    expect(note).not.toMatch(/[Dd]o not|[Pp]ropose/);
    expect(neoPrompt(null)).toContain("When the worker's own environment failed");
    expect(neoEnvironmentMoveNote(null)).toBe('');
  });

  test('the done-check note carries the move line', () => {
    const move = neoEnvironmentMoveNote({ failure: environment.what, adapters: ['hyperneo'] });
    const note = driverDoneCheckNote(
      { id: 'w1', title: 'Open a PR', report: roundSix, originSessionId: 'neo:root' },
      { goal: 'Open a PR', doneWhen: '- PR open' },
      0,
      { move }
    );
    expect(note).toContain(move.trim());
  });
});
