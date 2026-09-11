import { PendingCompletionSupersededError } from '../../../../src/lib/space/operations/pending-completion-guard';
import { expect, mock, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import {
  createPendingCompletionOperation,
  hasCommittedPendingApproval,
  normalizePendingCompletion,
  readPendingCompletionResult,
  rejectPendingCompletion,
  type PendingCompletionDependencies,
} from '../../../../src/lib/space/operations/pending-completion';
import { mapPostApprovalDispatchWarning } from '../../../../src/lib/space/runtime/post-approval-router';

const approved = { id: 'task', status: 'approved', spaceId: 'space' } as SpaceTask;
const reopened = { ...approved, status: 'in_progress' } as SpaceTask;
const decision = { taskId: 'task', approved: true, reason: null };

function setup(overrides: Partial<PendingCompletionDependencies> = {}) {
  const dependencies = {
    getTask: mock(async () => approved),
    dispatchApproval: mock(async () => undefined),
    reopenTask: mock(async () => reopened),
    updateTask: mock(async () => approved),
    warn: mock(() => {}),
    ...overrides,
  };
  return { dependencies, resolve: createPendingCompletionOperation(dependencies) };
}

test.each([undefined, null, '', '  raw reason  '])(
  'normalizes reason %j without trimming',
  (reason) => {
    expect(normalizePendingCompletion({ taskId: 'task', approved: true, reason })).toEqual({
      taskId: 'task',
      approved: true,
      reason: reason ?? null,
    });
  }
);

test('committed approval predicate accepts only approved tasks', () => {
  expect(hasCommittedPendingApproval(null)).toBe(false);
  expect(hasCommittedPendingApproval(reopened)).toBe(false);
  expect(hasCommittedPendingApproval(approved)).toBe(true);
});

test('approval gate does not run rejection effects', async () => {
  const { dependencies } = setup();
  expect(
    await rejectPendingCompletion(decision, dependencies.reopenTask, dependencies.updateTask)
  ).toEqual({ value: decision });
  expect(dependencies.reopenTask).not.toHaveBeenCalled();
  expect(dependencies.updateTask).not.toHaveBeenCalled();
});

test('result read returns explicit gate and rejects missing task', async () => {
  expect(await readPendingCompletionResult(() => approved, decision)).toEqual({ value: approved });
  await expect(readPendingCompletionResult(async () => null, decision)).rejects.toThrow(
    'Task not found: task'
  );
});

test.each([undefined, { mode: 'skipped', reason: 'not wired' }])(
  'approval ignores dispatch result %j and refreshes',
  async (outcome) => {
    const order: string[] = [];
    const { resolve, dependencies } = setup({
      dispatchApproval: async (id, reason) => {
        expect([id, reason]).toEqual(['task', '  raw  ']);
        order.push('dispatch');
        return outcome;
      },
      getTask: async () => {
        order.push('read');
        return approved;
      },
    });
    expect(await resolve({ taskId: 'task', approved: true, reason: '  raw  ' })).toBe(approved);
    expect(order).toEqual(['dispatch', 'read']);
    expect(dependencies.reopenTask).not.toHaveBeenCalled();
    expect(dependencies.updateTask).not.toHaveBeenCalled();
  }
);

test.each([null, reopened])(
  'pre-commit failure preserves original thrown value with task %j',
  async (task) => {
    const error = { message: 'dispatch failed' };
    const { resolve, dependencies } = setup({
      dispatchApproval: async () => {
        throw error;
      },
      getTask: async () => task,
    });
    await expect(resolve(decision)).rejects.toBe(error);
    expect(dependencies.warn).not.toHaveBeenCalled();
    expect(dependencies.updateTask).not.toHaveBeenCalled();
  }
);

test.each([new Error('interrupted'), 'network failure'])(
  'committed failure captures warning then refreshes (%j)',
  async (error) => {
    const detail = error instanceof Error ? error.message : error;
    const order: string[] = [];
    const warned = {
      ...approved,
      postApprovalBlockedReason: mapPostApprovalDispatchWarning(detail),
    };
    let reads = 0;
    const { resolve } = setup({
      dispatchApproval: async () => {
        order.push('dispatch');
        throw error;
      },
      getTask: async () => {
        order.push('read');
        return ++reads === 1 ? approved : warned;
      },
      warn: (id, message) => {
        expect([id, message]).toEqual(['task', detail]);
        order.push('warn');
      },
      updateTask: async (id, fields) => {
        expect([id, fields]).toEqual([
          'task',
          { postApprovalBlockedReason: warned.postApprovalBlockedReason },
        ]);
        order.push('update');
        return approved;
      },
    });
    expect(await resolve(decision)).toBe(warned);
    expect(order).toEqual(['dispatch', 'read', 'warn', 'update', 'read']);
  }
);

test('warning persistence failure propagates without final refresh', async () => {
  const failure = new Error('write failed');
  const getTask = mock(async () => approved);
  const { resolve } = setup({
    dispatchApproval: async () => {
      throw new Error('dispatch');
    },
    getTask,
    updateTask: async () => {
      throw failure;
    },
  });
  await expect(resolve(decision)).rejects.toBe(failure);
  expect(getTask).toHaveBeenCalledTimes(1);
});

test('missing final refresh throws rather than retaining an earlier pipeline value', async () => {
  const { resolve } = setup({ getTask: async () => null });
  await expect(resolve(decision)).rejects.toThrow('Task not found: task');
});

test.each([undefined, null, '', 'raw'])(
  'rejection writes in order and returns update without refresh (%j)',
  async (reason) => {
    const order: string[] = [];
    const result = { ...reopened, approvalReason: reason ?? null };
    const { resolve, dependencies } = setup({
      reopenTask: async (id) => {
        expect(id).toBe('task');
        order.push('reopen');
        return reopened;
      },
      updateTask: async (id, fields) => {
        expect([id, fields]).toEqual(['task', { approvalReason: reason ?? null }]);
        order.push('update');
        return result;
      },
    });
    expect(await resolve({ taskId: 'task', approved: false, reason })).toBe(result);
    expect(order).toEqual(['reopen', 'update']);
    expect(dependencies.getTask).not.toHaveBeenCalled();
    expect(dependencies.dispatchApproval).not.toHaveBeenCalled();
  }
);

test('failed rejection transition prevents reason write', async () => {
  const error = new Error('transition failed');
  const { resolve, dependencies } = setup({
    reopenTask: async () => {
      throw error;
    },
  });
  await expect(resolve({ ...decision, approved: false })).rejects.toBe(error);
  expect(dependencies.updateTask).not.toHaveBeenCalled();
  expect(dependencies.getTask).not.toHaveBeenCalled();
});

test('superseded dispatch never becomes a committed warning', async () => {
  const error = new PendingCompletionSupersededError('task');
  const { resolve, dependencies } = setup({
    dispatchApproval: async () => {
      throw error;
    },
  });
  await expect(resolve(decision)).rejects.toBe(error);
  expect(dependencies.getTask).not.toHaveBeenCalled();
  expect(dependencies.warn).not.toHaveBeenCalled();
  expect(dependencies.updateTask).not.toHaveBeenCalled();
});
