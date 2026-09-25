import { describe, expect, test } from 'bun:test';
import { applyProgressToolUses } from '../../../../src/lib/session/session-progress.ts';

const now = () => '2026-09-25T00:00:00.000Z';

describe('applyProgressToolUses', () => {
  test('TodoWrite replaces the list', () => {
    const progress = applyProgressToolUses(
      {
        source: 'todo',
        items: [{ id: 'todo:0', content: 'old', status: 'pending' }],
        updatedAt: 'x',
      },
      [
        {
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'a', status: 'completed', activeForm: 'Doing a' },
              { content: 'b', status: 'in_progress', activeForm: '' },
              { content: '', status: 'pending' },
            ],
          },
        },
      ],
      now
    );
    expect(progress).toEqual({
      source: 'todo',
      updatedAt: now(),
      items: [
        { id: 'todo:0', content: 'a', status: 'completed', activeForm: 'Doing a' },
        { id: 'todo:1', content: 'b', status: 'in_progress' },
      ],
    });
  });

  test('TaskCreate appends sequential tasks and TaskUpdate changes them by id', () => {
    const created = applyProgressToolUses(
      undefined,
      [
        { name: 'TaskCreate', input: { subject: 'First', description: '' } },
        {
          name: 'TaskCreate',
          input: { subject: 'Second', description: '', activeForm: 'Seconding' },
        },
      ],
      now
    );
    expect(created?.items.map((i) => [i.id, i.content, i.status])).toEqual([
      ['task:1', 'First', 'pending'],
      ['task:2', 'Second', 'pending'],
    ]);

    const updated = applyProgressToolUses(
      created ?? undefined,
      [
        { name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } },
        { name: 'TaskUpdate', input: { taskId: '2', subject: 'Renamed', status: 'deleted' } },
        { name: 'TaskUpdate', input: { taskId: '9', status: 'completed' } },
      ],
      now
    );
    expect(updated?.items).toEqual([{ id: 'task:1', content: 'First', status: 'in_progress' }]);
  });

  test('a TodoWrite after tasks switches source; a TaskCreate after todos starts fresh', () => {
    const tasks = applyProgressToolUses(
      undefined,
      [{ name: 'TaskCreate', input: { subject: 'T', description: '' } }],
      now
    );
    const todos = applyProgressToolUses(
      tasks ?? undefined,
      [{ name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending' }] } }],
      now
    );
    expect(todos?.source).toBe('todo');
    const again = applyProgressToolUses(
      todos ?? undefined,
      [{ name: 'TaskCreate', input: { subject: 'U', description: '' } }],
      now
    );
    expect(again?.items.map((i) => i.content)).toEqual(['U']);
  });

  test('returns null when nothing relevant happened', () => {
    expect(
      applyProgressToolUses(undefined, [{ name: 'Read', input: { file_path: 'x' } }])
    ).toBeNull();
    expect(
      applyProgressToolUses(undefined, [{ name: 'TaskUpdate', input: { taskId: '1' } }])
    ).toBeNull();
    expect(applyProgressToolUses(undefined, [{ name: 'TodoWrite', input: {} }])).toBeNull();
  });
});
