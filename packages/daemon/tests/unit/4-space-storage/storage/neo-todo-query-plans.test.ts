import { describe, expect, test } from 'bun:test';
import {
  syntheticTodoDb,
  todoPlan,
  todoQueries,
} from '../../../../../../.claude/skills/verify/todo-query-plans.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';

describe('Neo todo query plans at observed row counts', () => {
  test('recovery locates doing todos without a full todo scan', () => {
    const db = syntheticTodoDb();
    try {
      const plan = todoPlan(db, todoQueries.recovery, []);
      expect(plan.some((detail) => /^SCAN t\b/.test(detail))).toBe(false);
    } finally {
      db.close();
    }
  });

  test('per-ask ordering does not need a temporary sort', () => {
    const db = syntheticTodoDb();
    try {
      expect(
        todoPlan(db, todoQueries.list, ['a0']).some((detail) => detail.includes('TEMP B-TREE'))
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  test('PR attribution windows keep strict later starts and null bounds', () => {
    const db = syntheticTodoDb();
    try {
      const repo = new CodingTodoPrRepository(db);
      for (const id of ['t0', 't48', 't49', 't1000', 'missing']) {
        const expected = db.prepare(todoQueries.window).get(id) ?? { start: null, end: null };
        expect(repo.window(id)).toEqual(expected);
      }
      expect(repo.window('t48')).toEqual({ start: 24, end: 32 });
      expect(repo.window('t0')).toEqual({ start: null, end: null });
      expect(repo.window('t1000')).toEqual({ start: 500, end: null });
    } finally {
      db.close();
    }
  });
});
