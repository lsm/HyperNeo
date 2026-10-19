import { describe, expect, test } from 'bun:test';
import { NEO_WORK_REPORT_LIMIT } from '../../../../src/lib/neo/work-blocker.ts';
import { admitNeoWorkReportInput } from '../../../../src/lib/neo/work-report.ts';
import { withWorkGoal } from '../../../../src/lib/neo/driver-work.ts';

const environment = { kind: 'environment' as const, what: 'no DNS and no GitHub token' };

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
    expect(
      admitted.value.report.endsWith('Blocked (environment): no DNS and no GitHub token')
    ).toBe(true);
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
        report: `Could not push.\n\nBlocked (environment): no DNS and no GitHub token`,
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
