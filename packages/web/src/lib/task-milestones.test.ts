import type { TaskMilestoneRow } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { curateTaskMilestones, formatRelativeTimestamp } from './task-milestones';

function row(
  partial: Partial<TaskMilestoneRow> & Pick<TaskMilestoneRow, 'id' | 'category'>
): TaskMilestoneRow {
  return {
    taskId: 't1',
    tone: 'neutral',
    title: 'x',
    body: null,
    sourceLabel: null,
    sourceKind: null,
    sourceId: null,
    createdAt: 0,
    ...partial,
  };
}

describe('curateTaskMilestones', () => {
  it('collapses a consecutive retry burst into one row with a count', () => {
    const input = [
      row({
        id: 'r1',
        category: 'retry',
        title: 'API retry',
        body: 'Attempt 1/10 · status 529',
        createdAt: 1000,
      }),
      row({
        id: 'r2',
        category: 'retry',
        title: 'API retry',
        body: 'Attempt 2/10 · status 529',
        createdAt: 2000,
      }),
      row({
        id: 'r3',
        category: 'retry',
        title: 'API retry',
        body: 'Attempt 3/10 · status 529',
        createdAt: 3000,
      }),
    ];
    const out = curateTaskMilestones(input);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('API retried 3×');
    expect(out[0].body).toBe('Attempt 3/10 · status 529');
    expect(out[0].createdAt).toBe(3000);
  });

  it('does not merge retries separated by another milestone', () => {
    const input = [
      row({ id: 'r1', category: 'retry', title: 'API retry', createdAt: 1000 }),
      row({ id: 'a1', category: 'answer', title: 'Answer', body: 'hi', createdAt: 2000 }),
      row({ id: 'r2', category: 'retry', title: 'API retry', createdAt: 3000 }),
    ];
    const out = curateTaskMilestones(input);
    expect(out.map((r) => r.category)).toEqual(['retry', 'answer', 'retry']);
  });

  it('does not merge retries that are far apart (separate episodes)', () => {
    const gap = 10 * 60_000;
    const input = [
      row({ id: 'r1', category: 'retry', title: 'API retry', createdAt: 1000 }),
      row({ id: 'r2', category: 'retry', title: 'API retry', createdAt: 1000 + gap }),
    ];
    const out = curateTaskMilestones(input);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.title === 'API retry')).toBe(true);
  });

  it('keeps identical answers from different producers (dedup is source-aware)', () => {
    const input = [
      row({
        id: 'a1',
        category: 'answer',
        title: 'Answer',
        body: 'Done',
        sourceLabel: 'coder',
        createdAt: 1000,
      }),
      row({
        id: 'a2',
        category: 'answer',
        title: 'Answer',
        body: 'Done',
        sourceLabel: 'reviewer',
        createdAt: 2000,
      }),
    ];
    const out = curateTaskMilestones(input);
    expect(out).toHaveLength(2);
  });

  it('keeps same-content milestones that differ in tone (different outcomes)', () => {
    const input = [
      row({
        id: 'g1',
        category: 'github',
        title: 'PR update',
        body: 'PR #9 opened',
        tone: 'neutral',
        createdAt: 1000,
      }),
      row({
        id: 'g2',
        category: 'github',
        title: 'PR update',
        body: 'PR #9 opened',
        tone: 'danger',
        createdAt: 2000,
      }),
    ];
    const out = curateTaskMilestones(input);
    expect(out).toHaveLength(2);
  });

  it('keeps identical answers repeated past the echo window (not just echoes)', () => {
    const input = [
      row({
        id: 'a1',
        category: 'answer',
        title: 'Answer',
        body: 'Done',
        sourceLabel: 'coder',
        createdAt: 1000,
      }),
      row({
        id: 'a2',
        category: 'answer',
        title: 'Answer',
        body: 'Done',
        sourceLabel: 'coder',
        createdAt: 1000 + 5 * 60_000,
      }),
    ];
    const out = curateTaskMilestones(input);
    expect(out).toHaveLength(2);
  });

  it('does not merge retries from different sessions sharing an agent label', () => {
    const input = [
      row({
        id: 'r1',
        category: 'retry',
        title: 'API retry',
        sourceLabel: 'coder',
        sourceId: 'sess-a',
        createdAt: 1000,
      }),
      row({
        id: 'r2',
        category: 'retry',
        title: 'API retry',
        sourceLabel: 'coder',
        sourceId: 'sess-b',
        createdAt: 2000,
      }),
    ];
    const out = curateTaskMilestones(input);
    expect(out).toHaveLength(2);
  });

  it('does not merge adjacent retries from different workers', () => {
    const input = [
      row({
        id: 'r1',
        category: 'retry',
        title: 'API retry',
        sourceLabel: 'coder',
        createdAt: 1000,
      }),
      row({
        id: 'r2',
        category: 'retry',
        title: 'API retry',
        sourceLabel: 'reviewer',
        createdAt: 2000,
      }),
    ];
    const out = curateTaskMilestones(input);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.title === 'API retry')).toBe(true);
  });

  it('drops consecutive identical milestones (e.g. echoed answers)', () => {
    const input = [
      row({ id: 'a1', category: 'answer', title: 'Answer', body: 'done', createdAt: 1000 }),
      row({ id: 'a2', category: 'answer', title: 'Answer', body: 'done', createdAt: 2000 }),
      row({ id: 'a3', category: 'answer', title: 'Answer', body: 'different', createdAt: 3000 }),
    ];
    const out = curateTaskMilestones(input);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.body)).toEqual(['done', 'different']);
  });

  it('keeps distinct milestones in order', () => {
    const input = [
      row({ id: 'c', category: 'creation', title: 'Task created', createdAt: 1000 }),
      row({ id: 'i', category: 'instruction', title: 'Instruction', body: 'go', createdAt: 2000 }),
      row({ id: 'p', category: 'artifact', title: 'PR opened', body: '#42', createdAt: 3000 }),
    ];
    const out = curateTaskMilestones(input);
    expect(out.map((r) => r.id)).toEqual(['c', 'i', 'p']);
  });

  it('returns an empty array unchanged', () => {
    expect(curateTaskMilestones([])).toEqual([]);
  });

  it('does not mutate the input rows', () => {
    const input = [row({ id: 'r1', category: 'retry', title: 'API retry', createdAt: 1000 })];
    curateTaskMilestones(input);
    expect(input[0].title).toBe('API retry');
  });
});

describe('formatRelativeTimestamp', () => {
  const now = 1_700_000_000_000;
  it('reports "just now" within a minute', () => {
    expect(formatRelativeTimestamp(now - 30_000, now)).toBe('just now');
  });
  it('reports minutes', () => {
    expect(formatRelativeTimestamp(now - 5 * 60_000, now)).toBe('5m');
  });
  it('reports hours', () => {
    expect(formatRelativeTimestamp(now - 3 * 3_600_000, now)).toBe('3h');
  });
  it('reports days within a week', () => {
    expect(formatRelativeTimestamp(now - 2 * 86_400_000, now)).toBe('2d');
  });
  it('clamps future timestamps to "just now"', () => {
    expect(formatRelativeTimestamp(now + 5_000, now)).toBe('just now');
  });
});
