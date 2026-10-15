import { describe, expect, test } from 'bun:test';
import {
  classifyNeoWorkerEnvironmentFailure,
  neoEnvironmentMoveNote,
  planNeoEnvironmentMove,
} from '../../../../src/lib/neo/worker-environment.ts';
import { driverDoneCheckNote } from '../../../../src/lib/neo/driver-work.ts';

const roundSix = [
  'GitHub access is currently blocked: the shell cannot resolve GitHub, and the connector cannot access this repository.',
  'A direct connection reaches GitHub, but the CLI has no usable token and the connector lacks repository access.',
  'PR creation is blocked by unavailable GitHub authentication.',
];
const place = { machine: 'laptop', folder: '/work/review-test', name: 'review-test' };
const start = { verb: 'start' as const, adapter: 'codex-desktop', place };
const adapters = [
  { id: 'codex-desktop', capabilities: ['find', 'start', 'send'] },
  { id: 'claude-desktop', capabilities: ['find', 'start', 'send'] },
  { id: 'claude-code', capabilities: ['find', 'send'] },
  { id: 'hyperneo', capabilities: ['find', 'start', 'send'] },
  { id: 'space', capabilities: ['find', 'start'] },
];

describe('classifyNeoWorkerEnvironmentFailure', () => {
  test.each(roundSix)('the round-six report counts as the worker’s own environment: %s', (line) => {
    expect(classifyNeoWorkerEnvironmentFailure(line)).not.toBeNull();
  });

  test.each([
    'Merged #12 to dev; all checks pass.',
    'The test fails because Discount does not clamp negative values.',
    'Waiting for the human to choose a pricing rule.',
    null,
  ])('a report with no environment failure is not one: %s', (report) => {
    expect(classifyNeoWorkerEnvironmentFailure(report)).toBeNull();
  });
});

describe('planNeoEnvironmentMove', () => {
  test('offers the other adapters that can start work in the same folder', () => {
    expect(planNeoEnvironmentMove('cannot resolve GitHub', start, adapters)).toEqual({
      value: { failure: 'cannot resolve GitHub', adapters: ['claude-desktop', 'hyperneo'] },
    });
  });

  test('a Space place moves only to a Space', () => {
    expect(
      planNeoEnvironmentMove(
        'no usable token',
        { verb: 'start', adapter: 'hyperneo', place: { ...place, spaceId: 's1' } },
        adapters
      )
    ).toEqual({ value: { failure: 'no usable token', adapters: ['space'] } });
  });

  test('no failure, no started place, no readable adapters or no alternative means no move', () => {
    expect(planNeoEnvironmentMove(null, start, adapters)).toEqual({ reason: null });
    expect(
      planNeoEnvironmentMove(
        'no usable token',
        { verb: 'send', ref: { adapter: 'codex-desktop', id: 't1' } },
        adapters
      )
    ).toEqual({ reason: null });
    expect(planNeoEnvironmentMove('no usable token', start, null)).toEqual({ reason: null });
    expect(planNeoEnvironmentMove('no usable token', start, [adapters[0]])).toEqual({
      reason: null,
    });
  });
});

describe('neoEnvironmentMoveNote', () => {
  test('tells Neo to propose the move and ask the human only to approve it', () => {
    const note = neoEnvironmentMoveNote({
      failure: 'cannot resolve GitHub',
      adapters: ['claude-desktop', 'hyperneo'],
    });
    expect(note).toContain('cannot resolve GitHub');
    expect(note).toContain('claude-desktop, hyperneo');
    expect(note).toContain('do not ask the human for access');
    expect(neoEnvironmentMoveNote(null)).toBe('');
  });

  test('the done-check note carries the move line', () => {
    const move = neoEnvironmentMoveNote({ failure: 'no usable token', adapters: ['hyperneo'] });
    const note = driverDoneCheckNote(
      { id: 'w1', title: 'Open a PR', report: roundSix[1], originSessionId: 'neo:root' },
      { goal: 'Open a PR', doneWhen: '- PR open' },
      0,
      null,
      { move }
    );
    expect(note).toContain(move.trim());
  });
});
