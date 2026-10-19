import { describe, expect, test } from 'bun:test';
import type { NeoAskEntry, NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { fitNeoSnapshotBudget } from '../../../../src/lib/neo/snapshot-compact.ts';

const entry = (id: string, status: 'open' | 'done', text = 'x'.repeat(2000)) =>
  ({
    ask: { id, title: `Ask ${id}`, request: text, status },
    todos: [
      {
        id: `${id}-t`,
        title: 'Todo',
        doneWhen: 'Done',
        status: 'Not started',
        instruction: text,
        report: text,
        evidence: null,
      },
    ],
    questions: [{ id: `${id}-q`, text: 'Which one?' }],
  }) as unknown as NeoAskEntry;

const snapshot = (open: number, done: number): NeoSnapshot => ({
  ok: true,
  sessionId: 'neo:root',
  projects: [],
  todoAsks: [
    ...Array.from({ length: open }, (_, n) => entry(`o${n}`, 'open')),
    ...Array.from({ length: done }, (_, n) => entry(`d${n}`, 'done')),
  ],
});

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('fitNeoSnapshotBudget', () => {
  test('leaves a snapshot under budget untouched', () => {
    const small = snapshot(1, 1);
    expect(fitNeoSnapshotBudget(small, 1_000_000)).toBe(small);
  });

  test('drops settled asks before open ones and says it trimmed', () => {
    const full = snapshot(2, 10);
    const fitted = fitNeoSnapshotBudget(full, bytes(snapshot(2, 0)) + 600);
    expect(fitted.todoAsks?.map((item) => item.ask.id)).toEqual(['o0', 'o1']);
    expect(fitted.trimmed).toContain('settled asks are left out');
  });

  test('says how many open asks it left out when even the open ones do not fit', () => {
    const fitted = fitNeoSnapshotBudget(snapshot(40, 0), 4_000);
    expect(bytes(fitted)).toBeLessThanOrEqual(4_000);
    expect(fitted.trimmed).toMatch(/older open asks are also left out|only open asks/);
  });

  test('the trimmed note never pushes the result past the budget', () => {
    for (const budget of [2_000, 6_000, 20_000]) {
      const fitted = fitNeoSnapshotBudget(snapshot(30, 30), budget);
      expect(bytes(fitted)).toBeLessThanOrEqual(budget);
    }
  });

  test('the skeleton stays under budget with long todo titles, statuses and many todos', () => {
    const long = 'y'.repeat(5_000);
    const heavy = (id: string) =>
      ({
        ask: { id, title: long, request: long, status: 'open' },
        todos: Array.from({ length: 60 }, (_, n) => ({
          id: `${id}-${n}`,
          title: long,
          doneWhen: long,
          status: long,
          reason: long,
          instruction: long,
          report: long,
          evidence: long,
        })),
        questions: [{ id: `${id}-q`, text: long }],
      }) as unknown as NeoAskEntry;
    const full: NeoSnapshot = {
      ok: true,
      sessionId: 'neo:root',
      projects: [],
      todoAsks: Array.from({ length: 8 }, (_, n) => heavy(`h${n}`)),
    };
    for (const budget of [3_000, 12_000, 40_000]) {
      const fitted = fitNeoSnapshotBudget(full, budget);
      expect(bytes(fitted)).toBeLessThanOrEqual(budget);
    }
    expect(fitNeoSnapshotBudget(full, 40_000).todoAsks?.length).toBeGreaterThan(0);
  });
});
