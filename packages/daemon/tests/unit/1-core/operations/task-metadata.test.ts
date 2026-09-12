import { describe, expect, mock, test } from 'bun:test';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import {
  admitTaskMetadataEdit,
  createTaskMetadataEditor,
  persistTaskMetadata,
  resolveTaskMetadataOwner,
  selectTaskMetadata,
  type TaskMetadataDependencies,
  type TaskMetadataOwner,
} from '../../../../src/lib/operations/task-metadata.ts';
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

function dependencies(owner: TaskMetadataOwner | null = owners[0]) {
  return {
    resolveOwner: mock(async () => owner),
    admit: mock(async () => {}),
    editStandalone: mock(async () => task),
    editSpace: mock(async () => task),
  } satisfies TaskMetadataDependencies;
}

describe('shared task metadata stages', () => {
  test('copies only metadata without changing text or omitted fields', () => {
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
    });
    expect(selectTaskMetadata({ taskId: task.id })).toEqual({ taskId: task.id });
    expect(source.status).toBe('done');
  });

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
    expect(afterEdit).toHaveBeenCalledWith(owners[1], task);
  }
});
