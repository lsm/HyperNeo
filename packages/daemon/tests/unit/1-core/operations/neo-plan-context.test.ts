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
    expect(lines[1].text).toContain('topic=邮件');
    expect(lines[2].text).toContain('topic=none');
  });
  test('lists the topics of the last 30 days first, folded for case and spacing', () => {
    const topics = [
      { topic: 'kids', count: 1 },
      { topic: 'Kids', count: 2 },
      { topic: '邮件', count: 1 },
      { topic: '家长控制', count: 4 },
    ];
    expect(neoPlanLines(asks.slice(0, 1), [], [], topics)[0].text).toBe(
      'Topics used in the last 30 days (asks open or settled): 家长控制 4, Kids 3, 邮件 1'
    );
    expect(neoPlanLines([], [], [], [])[0].text).toBe(
      'Topics used in the last 30 days (asks open or settled): none'
    );
  });
  test('keeps the topic list when over budget', () => {
    const lines = neoPlanLines(
      asks,
      asks.map((ask, i) => todo(`step-${i}`, { askId: ask.id, title: 'Detail '.repeat(1000) })),
      [],
      [{ topic: '邮件', count: 1 }]
    );
    expect(fitNeoPlanLines(lines, 400)[0].text).toContain('邮件 1');
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
    expect(fitted.map((line) => line.id)).toEqual(['topics', ...asks.map((ask) => ask.id)]);
    for (const ask of asks)
      expect(fitted.find((line) => line.id === ask.id)?.text).toContain(`neo.ask.read ${ask.id}`);
    expect(lines.filter((line) => line.kind === 'todo')).toHaveLength(12);
  });
  test('retains details under budget and counts encoded bytes', () => {
    const lines = neoPlanLines(asks.slice(0, 1), [todo('first', { title: '亮'.repeat(50) })], []);
    expect(fitNeoPlanLines(lines, 10000)).toEqual(lines);
    const text = lines.map((line) => line.text).join('\n');
    expect(fitNeoPlanLines(lines, text.length).map((line) => line.kind)).toEqual(['topics', 'ask']);
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
    expect(
      planNeoPlanContext(
        lines,
        changed.filter((line) => line.id !== 'ask-0'),
        'prompt'
      )
    ).toContain('ask-0');
  });
});

describe('unanswered messages', () => {
  test('caps each entry so one long message cannot refill the context', () => {
    const lines = neoPlanLines([], [], []);
    const long = 'x'.repeat(20_000);
    const context = planNeoPlanContext(null, lines, 'compact', [
      { id: 'first-id', text: long },
      { id: 'second-id', text: 'short' },
    ]);

    expect(context).toContain('first-id');
    expect(context).toContain('second-id');
    expect(context).toContain('short');
    expect(context).toContain('(truncated');
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThan(5_000);
  });

  test('bounds the whole unanswered section and points at the read for the rest', () => {
    const lines = neoPlanLines([], [], []);
    const pending = Array.from({ length: 40 }, (_, i) => ({
      id: `pending-${39 - i}`,
      text: 'y'.repeat(20_000),
    }));

    const context = planNeoPlanContext(null, lines, 'compact', pending);
    const section = context.slice(context.indexOf('Unanswered messages'));

    expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(8_192);
    expect(section).toContain('pending-39 (full id');
    expect(section).toContain('neo.conversation.read');
    expect(section).toContain('more pending');
    expect(section).not.toContain('pending-0 (full id');
  });
});
