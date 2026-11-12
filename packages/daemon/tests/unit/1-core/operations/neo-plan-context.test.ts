import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  fitNeoPlanLines,
  neoPlanLines,
  planNeoPlanContext,
} from '../../../../src/lib/neo/plan-context.ts';

const asks = Array.from({ length: 12 }, (_, i) => ({
  id: `ask-${i}`,
  title: `Plan ${i}`,
  status: 'open',
})) as NeoAsk[];
const todo = (id: string, patch: Partial<NeoTodo> = {}) =>
  ({
    id,
    askId: 'ask-0',
    title: `Step ${id}`,
    position: 0,
    state: 'todo',
    dependsOn: [],
    approvedAt: 1,
    startedAt: null,
    blockedBy: null,
    blockedReason: null,
    reason: null,
    ...patch,
  }) as NeoTodo;
const question = {
  id: 'question',
  askId: 'ask-0',
  todos: ['second'],
  state: 'open',
  kind: 'reply',
} as NeoQuestion;

describe('neoPlanLines', () => {
  test('shows unmet dependencies, holds and open questions without completed steps', () => {
    const todos = [
      todo('first'),
      todo('second', { position: 1, dependsOn: ['first'] }),
      todo('done', { state: 'done' }),
    ];
    const lines = neoPlanLines(asks, todos, [question]);
    expect(lines.find((line) => line.id === 'ask-0')?.text).toContain('questions=1');
    const first = lines.find((line) => line.id === 'first')!.text;
    expect(first).toContain('ready=true');
    expect(first).toMatch(/questions=0$/);
    const second = lines.find((line) => line.id === 'second')!.text;
    expect(second).toMatch(/questions=1$/);
    expect(second).toContain('waits=first');
    expect(second).toContain('ready=false');
    expect(lines.some((line) => line.id === 'done')).toBe(false);
    expect(
      neoPlanLines(asks, [todo('held', { blockedBy: 'held' })], []).find(
        (line) => line.id === 'held'
      )?.text
    ).toContain('todo_held');
    expect(
      neoPlanLines(asks, [todo('unapproved', { approvedAt: null })], []).find(
        (line) => line.id === 'unapproved'
      )?.text
    ).toContain('ready=false');
  });
  test('shows each open ask topic, none when unset', () => {
    const labelled = [
      { ...asks[0], topic: '邮件' },
      { ...asks[1], topic: null },
    ];
    const lines = neoPlanLines(labelled, [], []);
    expect(lines[0].text).toContain('topic=邮件');
    expect(lines[1].text).toContain('topic=none');
  });
  test('describes an absent reason as display text', () => {
    const line = neoPlanLines(asks, [todo('first')], []).find((item) => item.id === 'first');
    expect(line?.text).toContain('reason=not recorded');
  });

  test('keeps every open ask when over budget', () => {
    const lines = neoPlanLines(
      asks,
      asks.map((ask, i) => todo(`step-${i}`, { askId: ask.id, title: 'Detail '.repeat(1000) })),
      []
    );
    const fitted = fitNeoPlanLines(lines, 400);
    expect(fitted.map((line) => line.id)).toEqual(asks.map((ask) => ask.id));
    for (const ask of asks)
      expect(fitted.find((line) => line.id === ask.id)?.text).toContain(`neo.ask.read ${ask.id}`);
    expect(lines.filter((line) => line.id !== line.askId)).toHaveLength(12);
  });
  test('retains details under budget and counts encoded bytes', () => {
    const lines = neoPlanLines(asks.slice(0, 1), [todo('first', { title: '亮'.repeat(50) })], []);
    expect(fitNeoPlanLines(lines, 10000)).toEqual(lines);
    const text = lines.map((line) => line.text).join('\n');
    expect(fitNeoPlanLines(lines, text.length)).toHaveLength(1);
  });
});

describe('planNeoPlanContext', () => {
  test('announces a completed last step even when unrelated owner headers exceed budget', () => {
    const previous = fitNeoPlanLines(neoPlanLines(asks, [todo('first')], []), 10_000);
    const current = fitNeoPlanLines(neoPlanLines(asks, [todo('first', { state: 'done' })], []), 1);
    expect(planNeoPlanContext(previous, current, 'prompt')).toContain(
      'todo first: no longer open or pending.'
    );
  });

  test('does not announce budget-omitted steps as finished', () => {
    const lines = neoPlanLines(asks, [todo('first')], []);
    const fitted = fitNeoPlanLines(lines, 1);
    const delta = planNeoPlanContext(lines, fitted, 'prompt');
    expect(delta).toContain('neo.ask.read ask-0');
    expect(delta).not.toContain('no longer open or pending');
  });

  test('sends full after compact, changed lines after, nothing when unchanged', () => {
    const lines = neoPlanLines(asks, [todo('first')], []);
    expect(planNeoPlanContext(lines, lines, 'compact')).toContain('ask-11');
    expect(planNeoPlanContext(null, lines, 'resume')).toContain('ask-11');
    expect(planNeoPlanContext(lines, lines, 'prompt')).toBe('');
    const changed = neoPlanLines(asks, [todo('first', { state: 'doing' })], []);
    const delta = planNeoPlanContext(lines, changed, 'prompt');
    expect(delta).toContain('doing');
    expect(delta).not.toContain('ask-11');
    expect(planNeoPlanContext(lines, changed.slice(1), 'prompt')).toContain('ask-0');
  });
});
