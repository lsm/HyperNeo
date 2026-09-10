import { describe, expect, test } from 'bun:test';
import { decodeTaskCoreRow } from '../../../../src/storage/tasks/task-row';

const row = { id: 'task', title: 'Work', status: 'open', priority: 'normal', created_at: 10 };

describe('task core row decoding', () => {
  test('decodes work data without any Space or execution fields', () => {
    expect(decodeTaskCoreRow(row)).toEqual({
      id: 'task',
      title: 'Work',
      description: '',
      status: 'open',
      priority: 'normal',
      labels: [],
      dependsOn: [],
      result: null,
      createdAt: 10,
      startedAt: null,
      completedAt: null,
      archivedAt: null,
      updatedAt: 10,
    });
  });

  test('preserves persisted values and ignores ownership and execution metadata', () => {
    const input = {
      ...row,
      description: 'Details',
      labels: '["urgent"]',
      depends_on: '["other"]',
      result: '',
      started_at: 0,
      completed_at: 20,
      archived_at: 30,
      updated_at: 0,
      space_id: 'space-a',
      task_number: 5,
      workflow_run_id: 'run-a',
    };
    const core = decodeTaskCoreRow(input);
    expect(core).toMatchObject({
      description: 'Details',
      labels: ['urgent'],
      dependsOn: ['other'],
      result: '',
      startedAt: 0,
      completedAt: 20,
      archivedAt: 30,
      updatedAt: 0,
    });
    expect(core).not.toHaveProperty('spaceId');
    expect(core).not.toHaveProperty('workflowRunId');
    expect(input.labels).toBe('["urgent"]');
  });

  test('preserves null fallbacks', () => {
    expect(
      decodeTaskCoreRow({
        ...row,
        description: null,
        labels: null,
        depends_on: null,
        updated_at: null,
      })
    ).toMatchObject({ description: '', labels: [], dependsOn: [], updatedAt: 10 });
  });

  test.each(['labels', 'depends_on'])('retains malformed JSON errors for %s', (column) => {
    expect(() => decodeTaskCoreRow({ ...row, [column]: '{' })).toThrow();
  });
});
