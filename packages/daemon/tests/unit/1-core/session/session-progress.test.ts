import { describe, expect, test } from 'bun:test';
import {
  applyProgressToolResults,
  applyProgressToolUses,
} from '../../../../src/lib/session/session-progress.ts';

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

  test('TaskCreate is provisional until its tool result reveals the task id', () => {
    const created = applyProgressToolUses(
      undefined,
      [
        { id: 'tu-1', name: 'TaskCreate', input: { subject: 'First', description: '' } },
        {
          id: 'tu-2',
          name: 'TaskCreate',
          input: { subject: 'Second', description: '', activeForm: 'Seconding' },
        },
      ],
      now
    );
    expect(created?.items.map((i) => i.id)).toEqual(['task:pending:tu-1', 'task:pending:tu-2']);
    expect(created?.pendingTaskIds).toEqual({
      'tu-1': 'task:pending:tu-1',
      'tu-2': 'task:pending:tu-2',
    });

    const resolved = applyProgressToolResults(
      created ?? undefined,
      [
        { toolUseId: 'tu-1', content: JSON.stringify({ task: { id: '7', subject: 'First' } }) },
        { toolUseId: 'tu-2', content: [{ type: 'text', text: 'Task #8 created: Second' }] },
        { toolUseId: 'tu-9', content: 'unrelated' },
      ],
      now
    );
    expect(resolved?.items.map((i) => i.id)).toEqual(['task:7', 'task:8']);
    expect(resolved?.pendingTaskIds).toBeUndefined();

    const updated = applyProgressToolUses(
      resolved ?? undefined,
      [
        { id: 'tu-3', name: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' } },
        {
          id: 'tu-4',
          name: 'TaskUpdate',
          input: { taskId: '8', subject: 'Renamed', status: 'deleted' },
        },
        { id: 'tu-5', name: 'TaskUpdate', input: { taskId: '9', status: 'completed' } },
      ],
      now
    );
    expect(updated?.items).toEqual([{ id: 'task:7', content: 'First', status: 'in_progress' }]);
  });

  test('a result that reveals no id drops the pending entry but keeps the item', () => {
    const created = applyProgressToolUses(
      undefined,
      [{ id: 'tu-1', name: 'TaskCreate', input: { subject: 'Loose', description: '' } }],
      now
    );
    const resolved = applyProgressToolResults(
      created ?? undefined,
      [{ toolUseId: 'tu-1', content: 'created' }],
      now
    );
    expect(resolved?.items.map((i) => i.id)).toEqual(['task:pending:tu-1']);
    expect(resolved?.pendingTaskIds).toBeUndefined();
    expect(
      applyProgressToolResults(resolved ?? undefined, [{ toolUseId: 'tu-1', content: 'x' }])
    ).toBeNull();
  });

  test('a TodoWrite after tasks switches source; a TaskCreate after todos starts fresh', () => {
    const tasks = applyProgressToolUses(
      undefined,
      [{ id: 'tu-1', name: 'TaskCreate', input: { subject: 'T', description: '' } }],
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
      [{ id: 'tu-2', name: 'TaskCreate', input: { subject: 'U', description: '' } }],
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
