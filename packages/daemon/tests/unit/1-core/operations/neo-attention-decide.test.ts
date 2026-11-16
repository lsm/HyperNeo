import { describe, expect, test } from 'bun:test';
import {
  type NeoAttentionEvent,
  type NeoAttentionKnown,
  decideNeoAttention,
  NEO_ATTENTION_KINDS,
  renderNeoAttention,
} from '../../../../src/lib/neo/attention/decide.ts';

const HOUR = 3_600_000;
const known = (change: Partial<NeoAttentionKnown> = {}): NeoAttentionKnown => ({
  covered: false,
  latestReportAt: null,
  ...change,
});
const event = (
  kind: string,
  facts: Record<string, unknown> = {},
  since = 1_000
): NeoAttentionEvent => ({ kind, subject: { type: 'todo', id: 'todo-1' }, since, facts });
const step = event('todo.neo_step', { title: 'Ship it', reason: 'no_worker' });
const decide = (item: NeoAttentionEvent, facts = known(), now = item.since) =>
  decideNeoAttention(item, facts, now, NEO_ATTENTION_KINDS);

describe('the attention decision', () => {
  test.each<[string, NeoAttentionEvent, ReturnType<typeof decide>]>([
    ['a Neo step wakes', step, { value: { action: 'wake', step: 0 } }],
    [
      'a done or running report is a digest item',
      event('turn.report', { status: 'done' }),
      { value: { action: 'digest', step: 0 } },
    ],
    [
      'a report with a question wakes',
      event('turn.report', { status: 'done', question: true }),
      { value: { action: 'wake', step: 0 } },
    ],
    [
      'a report with a Blocked line wakes',
      event('turn.report', { status: 'done', blocked: true }),
      { value: { action: 'wake', step: 0 } },
    ],
    [
      'a report on a blocked todo wakes',
      event('turn.report', { status: 'running', todoState: 'blocked' }),
      { value: { action: 'wake', step: 0 } },
    ],
    [
      'a failed report wakes',
      event('turn.report', { status: 'failed' }),
      { value: { action: 'wake', step: 0 } },
    ],
    [
      'a needs_you report wakes',
      event('turn.report', { status: 'needs_you' }),
      { value: { action: 'wake', step: 0 } },
    ],
    [
      'a focused report with a question wakes',
      event('turn.report', { status: 'done', focused: true, question: true }),
      { value: { action: 'wake', step: 0 } },
    ],
    [
      'a focused report with a Blocked line wakes',
      event('turn.report', { status: 'running', focused: true, blocked: true }),
      { value: { action: 'wake', step: 0 } },
    ],
    [
      'a focused report on a blocked todo wakes',
      event('turn.report', { status: 'running', focused: true, todoState: 'blocked' }),
      { value: { action: 'wake', step: 0 } },
    ],
    [
      'a focused status report is dropped',
      event('turn.report', { status: 'running', focused: true }),
      { reason: 'status only, focused' },
    ],
    [
      'a done todo is not its own item',
      event('todo.done'),
      { reason: 'a finished todo is told with its ask' },
    ],
    [
      'a todo waiting for a worker is dropped',
      event('todo.unworked', { reason: 'queue' }),
      { reason: 'daemon starts it' },
    ],
    [
      'an unapproved todo is a digest item',
      event('todo.unworked', { reason: 'not_approved' }),
      { value: { action: 'digest', step: 0 } },
    ],
    [
      'a blocked todo is a digest item',
      event('todo.blocked'),
      { value: { action: 'digest', step: 0 } },
    ],
    [
      'a one-off notice about a todo is a digest item',
      event('todo.notice'),
      { value: { action: 'digest', step: 0 } },
    ],
    ['a finished ask wakes', event('ask.finished'), { value: { action: 'wake', step: 0 } }],
    [
      'a missing follow-up wakes',
      event('todo.follow_up_missing'),
      { value: { action: 'wake', step: 0 } },
    ],
    ['an unknown kind is dropped', event('made.up'), { reason: 'unknown kind made.up' }],
  ])('%s', (_name, item, decision) => {
    expect(decide(item)).toEqual(decision);
  });

  test.each(['todo.neo_step', 'todo.blocked', 'turn.report', 'todo.stalled'])(
    'a %s whose subject an open card covers is dropped',
    (kind) => {
      expect(decide(event(kind, { status: 'failed' }), known({ covered: true }))).toEqual({
        reason: 'covered by card',
      });
    }
  );

  test('a report superseded by a newer report from the same worker is dropped', () => {
    const report = event('turn.report', { status: 'failed' }, 5_000);
    expect(decide(report, known({ latestReportAt: 5_001 }))).toEqual({
      reason: 'superseded by a newer report',
    });
    expect(decide(report, known({ latestReportAt: 5_000 }))).toEqual({
      value: { action: 'wake', step: 0 },
    });
    expect(decide({ ...step, since: 5_000 }, known({ latestReportAt: 5_001 }))).toEqual({
      value: { action: 'wake', step: 0 },
    });
  });

  test.each([
    [0, 0],
    [HOUR - 1, 0],
    [HOUR, 1],
    [4 * HOUR, 2],
    [24 * HOUR - 1, 2],
    [24 * HOUR, 3],
    [48 * HOUR - 1, 3],
    [48 * HOUR, 4],
    [72 * HOUR, 5],
  ])('a Neo step %i ms old is on step %i, daily after its last rung', (age, expected) => {
    expect(decide(step, known(), step.since + age)).toEqual({
      value: { action: 'wake', step: expected },
    });
  });

  test('a kind without daily repeats stops at its last rung', () => {
    const blocked = event('todo.blocked');
    const at = (age: number) => decide(blocked, known(), blocked.since + age);
    expect(at(4 * HOUR)).toEqual({ value: { action: 'digest', step: 1 } });
    expect(at(24 * HOUR)).toEqual({ value: { action: 'digest', step: 2 } });
    expect(at(240 * HOUR)).toEqual({ value: { action: 'digest', step: 2 } });
  });

  test('a one-shot kind never leaves step 0', () => {
    const report = event('turn.report', { status: 'done' });
    expect(decide(report, known(), report.since + 240 * HOUR)).toEqual({
      value: { action: 'digest', step: 0 },
    });
  });
});

describe('renderNeoAttention', () => {
  test('the same event renders the same text', () => {
    const again = structuredClone(step);
    expect(renderNeoAttention(step, NEO_ATTENTION_KINDS)).toBe(
      renderNeoAttention(again, NEO_ATTENTION_KINDS)
    );
  });

  test("a Neo step names the todo, why the step is Neo's and the action that unblocks it", () => {
    expect(renderNeoAttention(step, NEO_ATTENTION_KINDS)).toBe(
      'Todo "Ship it" (todo-1) needs your next step: its prerequisites are done and it has no instruction or worker. Write the instruction and start it, or remove it.'
    );
  });

  test('a failed step carries the failure', () => {
    expect(
      renderNeoAttention(
        event('todo.neo_step', { title: 'Ship it', reason: 'failed', detail: 'CI keeps failing' }),
        NEO_ATTENTION_KINDS
      )
    ).toBe(
      'Todo "Ship it" (todo-1) needs your next step: it failed: CI keeps failing. Continue it with new direction, start a fresh worker, or remove it.'
    );
  });

  test('a carried report renders its own words', () => {
    expect(
      renderNeoAttention(
        event('turn.report', { status: 'done', text: 'Opened #12' }),
        NEO_ATTENTION_KINDS
      )
    ).toBe('Opened #12');
  });
});
