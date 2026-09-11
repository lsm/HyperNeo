import { describe, expect, mock, test } from 'bun:test';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import {
  createTaskDependencyEditor,
  requireReplacedTaskDependencies,
  requireTaskDependencyOwner,
  selectTaskDependencies,
  type TaskDependencyOwner,
  type TaskDependencyResult,
} from '../../../../src/lib/operations/task-dependency-editor';

const standalone = { kind: 'standalone' } as const;
const space = { kind: 'space', spaceId: 'space-1' } as const;
const input = { taskId: 'task', dependsOn: ['b', 'a', 'b'] };
const task = { id: 'task', dependsOn: input.dependsOn } as TaskCore;
const caller = { source: 'mcp', sessionId: 'session' } as const;

function fixture(owner: TaskDependencyOwner | null = standalone) {
  const resolveOwner = mock(async () => owner);
  const admit = mock(async () => {});
  const replaceStandalone = mock(async (): Promise<TaskDependencyResult> => task);
  const replaceSpace = mock(async (): Promise<TaskDependencyResult> => task);
  const afterReplace = mock(async () => {});
  const dependencies = { resolveOwner, admit, replaceStandalone, replaceSpace, afterReplace };
  return { ...dependencies, edit: createTaskDependencyEditor(dependencies) };
}

describe('task dependency editor', () => {
  test('copies only dependency fields without normalizing duplicate IDs or order', () => {
    const supplied = { ...input, status: 'done' };
    const selected = selectTaskDependencies(supplied);
    expect(selected).toEqual(input);
    expect(selected.dependsOn).not.toBe(input.dependsOn);
    expect(selectTaskDependencies({ taskId: 'task', dependsOn: [] })).toEqual({
      taskId: 'task',
      dependsOn: [],
    });
  });

  test.each([standalone, space, null])(
    'owner gate preserves owner or missing result (%j)',
    (owner) => {
      expect(requireTaskDependencyOwner(owner)).toEqual(
        owner === null ? { reason: null } : { value: owner }
      );
    }
  );

  test.each([
    null,
    'task_not_found',
    'self_dependency',
    'duplicate_dependency',
    'dependency_not_found',
    'dependency_cycle',
    task,
  ] satisfies TaskDependencyResult[])(
    'result gate preserves persistence outcome (%j)',
    (result) => {
      expect(requireReplacedTaskDependencies(result)).toEqual(
        result === task ? { value: task } : { reason: result }
      );
    }
  );

  test.each([standalone, space])(
    'routes only the selected owner and preserves duplicates (%j)',
    async (owner) => {
      const f = fixture(owner);
      expect(await f.edit(input, caller)).toBe(task);
      expect(f.resolveOwner).toHaveBeenCalledWith('task');
      expect(f.admit).toHaveBeenCalledWith(owner, caller);
      if (owner.kind === 'standalone') {
        expect(f.replaceStandalone).toHaveBeenCalledWith(input);
        expect(f.replaceSpace).not.toHaveBeenCalled();
      } else {
        expect(f.replaceSpace).toHaveBeenCalledWith('space-1', input);
        expect(f.replaceStandalone).not.toHaveBeenCalled();
      }
      expect(f.afterReplace).toHaveBeenCalledWith(owner, task);
    }
  );

  test('missing owner halts before admission or persistence', async () => {
    const f = fixture(null);
    expect(await f.edit(input, caller)).toBeNull();
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.replaceStandalone).not.toHaveBeenCalled();
    expect(f.replaceSpace).not.toHaveBeenCalled();
    expect(f.afterReplace).not.toHaveBeenCalled();
  });

  test.each([null, 'duplicate_dependency', 'dependency_cycle'] as const)(
    'failed persistence skips success effects (%s)',
    async (result) => {
      const f = fixture();
      f.replaceStandalone.mockResolvedValue(result);
      expect(await f.edit(input, caller)).toBe(result);
      expect(f.afterReplace).not.toHaveBeenCalled();
    }
  );

  test('denied admission stops persistence and preserves the error', async () => {
    const f = fixture(space);
    f.admit.mockRejectedValue(new Error('Wrong Space'));
    await expect(f.edit(input, caller)).rejects.toThrow('Wrong Space');
    expect(f.replaceSpace).not.toHaveBeenCalled();
    expect(f.afterReplace).not.toHaveBeenCalled();
  });

  test('preserves Space manager failures without success effects', async () => {
    const f = fixture(space);
    f.replaceSpace.mockRejectedValue(new Error('Dependency task not found in space: other'));
    await expect(f.edit(input, caller)).rejects.toThrow(
      'Dependency task not found in space: other'
    );
    expect(f.afterReplace).not.toHaveBeenCalled();
  });

  test('awaits owner, admission, persistence and optional effects in order', async () => {
    const effects: string[] = [];
    const edit = createTaskDependencyEditor({
      resolveOwner: async () => {
        await Promise.resolve();
        effects.push('owner');
        return space;
      },
      admit: async () => {
        await Promise.resolve();
        effects.push('admit');
      },
      replaceStandalone: async () => {
        throw new Error('Wrong owner');
      },
      replaceSpace: async () => {
        await Promise.resolve();
        effects.push('persist');
        return task;
      },
      afterReplace: async () => {
        await Promise.resolve();
        effects.push('after');
      },
    });
    expect(await edit(input, caller)).toBe(task);
    expect(effects).toEqual(['owner', 'admit', 'persist', 'after']);
    const f = fixture();
    expect(await createTaskDependencyEditor({ ...f, afterReplace: undefined })(input, caller)).toBe(
      task
    );
  });
});
