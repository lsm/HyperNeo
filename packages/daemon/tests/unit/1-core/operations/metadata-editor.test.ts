import { describe, expect, mock, test } from 'bun:test';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import {
  admitTaskMetadataEdit,
  createTaskMetadataEditor,
  persistTaskMetadata,
  replaceTaskMetadataDependencies,
  resolveTaskMetadataOwner,
  selectTaskMetadata,
  writesTaskMetadata,
  type TaskMetadataDependencies,
  type TaskMetadataOwner,
} from '../../../../src/lib/tasks/metadata-editor.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';

const task: TaskCore = {
  id: 'task-1',
  title: 'Task',
  description: '',
  status: 'open',
  priority: 'normal',
  labels: [],
  dependsOn: [],
  result: null,
  createdAt: 1,
  startedAt: null,
  completedAt: null,
  archivedAt: null,
  updatedAt: 2,
};
const input = { taskId: task.id, title: ' Updated ' };
const caller: OperationCaller = { source: 'mcp', sessionId: 'session-1' };
const owners: TaskMetadataOwner[] = [{ kind: 'standalone' }, { kind: 'space', spaceId: 'space-1' }];

const depended: TaskCore = { ...task, dependsOn: ['other'] };

function dependencies(owner: TaskMetadataOwner | null = owners[0]) {
  return {
    resolveOwner: mock(async () => owner),
    admit: mock(async () => {}),
    replaceDependencies: mock(async () => depended),
    editStandalone: mock(async () => task),
    editSpace: mock(async () => task),
  } satisfies TaskMetadataDependencies;
}

describe('shared task metadata stages', () => {
  test('copies only editable fields without changing text or omitted fields', () => {
    const source = {
      ...input,
      description: '',
      priority: undefined,
      labels: [],
      status: 'done',
      dependsOn: ['other'],
      workflowRunId: 'run-1',
      workspacePath: '/repo',
    };
    expect(selectTaskMetadata(source)).toEqual({
      ...input,
      description: '',
      priority: undefined,
      labels: [],
      dependsOn: ['other'],
    });
    expect(selectTaskMetadata({ taskId: task.id })).toEqual({ taskId: task.id });
    expect(source.status).toBe('done');
  });

  test.each([
    [{ taskId: task.id }, true],
    [{ taskId: task.id, dependsOn: ['other'] }, false],
    [{ taskId: task.id, priority: undefined, dependsOn: [] }, false],
    [{ taskId: task.id, description: '' }, true],
    [{ taskId: task.id, labels: [], dependsOn: [] }, true],
  ])('writes metadata for %j only alongside an editable field', (candidate, writes) => {
    expect(writesTaskMetadata(candidate)).toBe(writes);
  });

  test('skips replacement entirely when dependsOn is absent', async () => {
    const replaceDependencies = mock(async () => depended);
    expect(await replaceTaskMetadataDependencies(replaceDependencies, owners[0], input)).toEqual({
      value: null,
    });
    expect(replaceDependencies).not.toHaveBeenCalled();
  });

  test.each([depended, null, 'dependency_cycle' as const])(
    'forwards the owner and dependency list, keeping %j on its own arm',
    async (outcome) => {
      const replaceDependencies = mock(async () => outcome);
      expect(
        await replaceTaskMetadataDependencies(replaceDependencies, owners[1], {
          ...input,
          dependsOn: ['other'],
        })
      ).toEqual(outcome === depended ? { value: outcome } : { reason: outcome });
      expect(replaceDependencies).toHaveBeenCalledWith(owners[1], {
        taskId: task.id,
        dependsOn: ['other'],
      });
    }
  );

  test.each([...owners, null])(
    'resolves trusted owner %j with explicit missing arm',
    async (owner) => {
      const resolveOwner = mock(async () => owner);
      expect(await resolveTaskMetadataOwner(resolveOwner, input)).toEqual(
        owner === null ? { reason: null } : { value: owner }
      );
      expect(resolveOwner).toHaveBeenCalledWith(task.id);
    }
  );

  test('passes trusted owner and caller to admission without policy assumptions', async () => {
    const admit = mock(async () => {});
    await admitTaskMetadataEdit(admit, owners[1], caller);
    expect(admit).toHaveBeenCalledWith(owners[1], caller);
    const failure = new Error('Existing caller policy denied edit');
    await expect(
      admitTaskMetadataEdit(
        async () => {
          throw failure;
        },
        owners[1],
        caller
      )
    ).rejects.toBe(failure);
  });

  test.each(owners)('dispatches to only the persistence effect for %j', async (owner) => {
    for (const result of [task, null]) {
      const editStandalone = mock(async () => result);
      const editSpace = mock(async () => result);
      expect(await persistTaskMetadata(editStandalone, editSpace, owner, input)).toEqual(
        result === null ? { reason: null } : { value: result }
      );
      if (owner.kind === 'standalone') {
        expect(editStandalone).toHaveBeenCalledWith(input);
        expect(editSpace).not.toHaveBeenCalled();
      } else {
        expect(editSpace).toHaveBeenCalledWith(owner.spaceId, input);
        expect(editStandalone).not.toHaveBeenCalled();
      }
    }
  });

  test.each(owners)('returns the replaced task without a metadata write for %j', async (owner) => {
    const editStandalone = mock(async () => task);
    const editSpace = mock(async () => task);
    expect(
      await persistTaskMetadata(
        editStandalone,
        editSpace,
        owner,
        { taskId: task.id, dependsOn: ['other'] },
        depended
      )
    ).toEqual({ value: depended });
    expect(editStandalone).not.toHaveBeenCalled();
    expect(editSpace).not.toHaveBeenCalled();
  });

  test.each(owners)('keeps dependsOn out of the metadata write for %j', async (owner) => {
    const editStandalone = mock(async () => task);
    const editSpace = mock(async () => task);
    await persistTaskMetadata(
      editStandalone,
      editSpace,
      owner,
      { ...input, dependsOn: ['other'] },
      depended
    );
    const write = owner.kind === 'standalone' ? editStandalone : editSpace;
    expect(write.mock.calls[0]?.at(-1)).toEqual(input);
  });
});

describe('shared task metadata editor', () => {
  test.each(owners)('uses trusted owner %j and preserves full task results', async (owner) => {
    const deps = dependencies(owner);
    const edit = createTaskMetadataEditor(deps);
    expect(
      await edit({ ...input, spaceId: 'untrusted-space', status: 'done' } as typeof input, caller)
    ).toBe(task);
    expect(deps.resolveOwner).toHaveBeenCalledWith(task.id);
    expect(deps.admit).toHaveBeenCalledWith(owner, caller);
    if (owner.kind === 'standalone') {
      expect(deps.editStandalone).toHaveBeenCalledWith(input);
      expect(deps.editSpace).not.toHaveBeenCalled();
    } else {
      expect(deps.editSpace).toHaveBeenCalledWith(owner.spaceId, input);
      expect(deps.editStandalone).not.toHaveBeenCalled();
    }
  });

  test('missing tasks skip admission and every mutation', async () => {
    const deps = dependencies(null);
    expect(await createTaskMetadataEditor(deps)(input, caller)).toBeNull();
    expect(deps.admit).not.toHaveBeenCalled();
    expect(deps.editStandalone).not.toHaveBeenCalled();
    expect(deps.editSpace).not.toHaveBeenCalled();
  });

  test.each(owners)('preserves persistence null for owner %j', async (owner) => {
    const deps = {
      ...dependencies(owner),
      editStandalone: async () => null,
      editSpace: async () => null,
    };
    expect(await createTaskMetadataEditor(deps)(input, caller)).toBeNull();
  });

  test('awaits admission before persistence and stops on its original error', async () => {
    const deps = dependencies(owners[1]);
    let deny!: (reason: Error) => void;
    let started!: () => void;
    const admissionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const failure = new Error('Wrong caller scope');
    const edit = createTaskMetadataEditor({
      ...deps,
      admit: () =>
        new Promise<void>((_resolve, reject) => {
          deny = reject;
          started();
        }),
    });
    const pending = edit(input, caller);
    await admissionStarted;
    expect(deps.editSpace).not.toHaveBeenCalled();
    deny(failure);
    await expect(pending).rejects.toBe(failure);
    expect(deps.editSpace).not.toHaveBeenCalled();
    expect(deps.editStandalone).not.toHaveBeenCalled();
  });

  test.each(['resolveOwner', 'editStandalone', 'editSpace'] as const)(
    'preserves errors from %s',
    async (stage) => {
      const failure = new Error(`${stage} failed`);
      const deps = dependencies(stage === 'editSpace' ? owners[1] : owners[0]);
      const edit = createTaskMetadataEditor({
        ...deps,
        [stage]: async () => {
          throw failure;
        },
      });
      await expect(edit(input, caller)).rejects.toBe(failure);
    }
  );

  test.each(owners)('replaces dependencies before metadata for %j', async (owner) => {
    const order: string[] = [];
    const deps = dependencies(owner);
    const edit = createTaskMetadataEditor({
      ...deps,
      replaceDependencies: async () => {
        order.push('dependencies');
        return depended;
      },
      editStandalone: async () => {
        order.push('metadata');
        return task;
      },
      editSpace: async () => {
        order.push('metadata');
        return task;
      },
    });
    expect(await edit({ ...input, dependsOn: ['other'] }, caller)).toBe(task);
    expect(order).toEqual(['dependencies', 'metadata']);
  });

  test.each(owners)('returns the replaced task for a dependency-only edit of %j', async (owner) => {
    const deps = dependencies(owner);
    expect(
      await createTaskMetadataEditor(deps)({ taskId: task.id, dependsOn: ['other'] }, caller)
    ).toBe(depended);
    expect(deps.replaceDependencies).toHaveBeenCalledWith(owner, {
      taskId: task.id,
      dependsOn: ['other'],
    });
    expect(deps.editStandalone).not.toHaveBeenCalled();
    expect(deps.editSpace).not.toHaveBeenCalled();
  });

  test.each(['dependency_cycle', 'self_dependency', null] as const)(
    'halts before the metadata write on %j',
    async (outcome) => {
      const deps = dependencies(owners[1]);
      const edit = createTaskMetadataEditor({ ...deps, replaceDependencies: async () => outcome });
      expect(await edit({ ...input, dependsOn: ['other'] }, caller)).toBe(outcome);
      expect(deps.editSpace).not.toHaveBeenCalled();
      expect(deps.editStandalone).not.toHaveBeenCalled();
    }
  );

  test('denied callers never reach the dependency replacement', async () => {
    const deps = dependencies(owners[1]);
    const denial = { accepted: false, reason: 'task_update_denied' } as const;
    const edit = createTaskMetadataEditor({ ...deps, admit: async () => denial });
    expect(await edit({ taskId: task.id, dependsOn: ['other'] }, caller)).toEqual(denial);
    expect(deps.replaceDependencies).not.toHaveBeenCalled();
  });

  test('delegates empty metadata unchanged rather than inventing validation', async () => {
    const deps = dependencies();
    await createTaskMetadataEditor(deps)({ taskId: task.id }, { source: 'rpc' });
    expect(deps.editStandalone).toHaveBeenCalledWith({ taskId: task.id });
    expect(deps.admit).toHaveBeenCalledWith(owners[0], { source: 'rpc' });
  });
});

test.each([task, null])('post-edit effects run only for a persisted task %j', async (result) => {
  const afterEdit = mock(async () => {});
  const edit = createTaskMetadataEditor({
    ...dependencies(owners[1]),
    editSpace: async () => result,
    afterEdit,
  });
  expect(await edit(input, caller)).toBe(result);
  if (result === null) expect(afterEdit).not.toHaveBeenCalled();
  else {
    expect(afterEdit).toHaveBeenCalledTimes(1);
    expect(afterEdit).toHaveBeenCalledWith(owners[1], task, input);
  }
});

test('post-edit effects see the requested dependency list', async () => {
  const afterEdit = mock(async () => {});
  const edit = createTaskMetadataEditor({ ...dependencies(owners[1]), afterEdit });
  await edit({ taskId: task.id, dependsOn: ['other'] }, caller);
  expect(afterEdit).toHaveBeenCalledWith(owners[1], depended, {
    taskId: task.id,
    dependsOn: ['other'],
  });
});
