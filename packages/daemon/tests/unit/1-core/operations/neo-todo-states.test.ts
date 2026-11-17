import { describe, expect, test } from 'bun:test';
import { NeoTodoSchema } from '../../../../src/lib/neo/todo-operations.ts';

describe('Neo todo states', () => {
  test('a todo read never reports the removed failed state', () => {
    expect(NeoTodoSchema.shape.state.options).toEqual([
      'todo',
      'doing',
      'blocked',
      'done',
      'removed',
    ]);
  });
});
