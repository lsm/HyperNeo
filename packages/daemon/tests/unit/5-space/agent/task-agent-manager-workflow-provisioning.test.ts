import { describe, expect, it, mock } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

const TASK_ID = 'task-1';
const SESSION_ID = `space:space-1:task:${TASK_ID}:post-approval:worker`;

function makeManager(input: {
  taskStatus?: string;
  runStatus?: string;
  spaceStopped?: boolean;
  cooldown?: boolean;
  spaceError?: Error;
}) {
  const restorePostApprovalWorkerSession = mock(async () => null);
  const manager = Object.create(TaskAgentManager.prototype) as TaskAgentManager;
  Object.defineProperty(manager, 'config', {
    value: {
      taskRepo: {
        getTask: () => ({
          id: TASK_ID,
          spaceId: 'space-1',
          workflowRunId: 'run-1',
          status: input.taskStatus ?? 'in_progress',
        }),
      },
      workflowRunRepo: {
        getRun: () => ({ id: 'run-1', status: input.runStatus ?? 'in_progress' }),
      },
      spaceManager: {
        getSpace: async () => {
          if (input.spaceError) throw input.spaceError;
          return { id: 'space-1', stopped: input.spaceStopped ?? false };
        },
      },
    },
  });
  Object.defineProperty(manager, 'restorePostApprovalWorkerSession', {
    value: restorePostApprovalWorkerSession,
  });
  if (input.cooldown) {
    Object.defineProperty(manager, 'readPersistedRateLimitCooldown', {
      value: () => ({ retryAt: Date.now() + 60_000 }),
    });
  }
  return { manager, restorePostApprovalWorkerSession };
}

function workflowSession(): AgentSession {
  return { getSessionData: () => ({ id: SESSION_ID }) } as unknown as AgentSession;
}

describe('TaskAgentManager workflow session provisioning', () => {
  it('does not revive a post-approval worker for a stopped space', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({ spaceStopped: true });

    await manager.provisionWorkflowSession(workflowSession());

    expect(restorePostApprovalWorkerSession).not.toHaveBeenCalled();
  });

  it('does not revive a post-approval worker for a completed task', async () => {
    const completedTask = makeManager({ taskStatus: 'done' });

    await completedTask.manager.provisionWorkflowSession(workflowSession());

    expect(completedTask.restorePostApprovalWorkerSession).not.toHaveBeenCalled();
  });

  it('restores an approved post-approval worker after workflow completion', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({
      taskStatus: 'approved',
      runStatus: 'done',
    });

    await manager.provisionWorkflowSession(workflowSession());

    expect(restorePostApprovalWorkerSession).toHaveBeenCalledWith(
      TASK_ID,
      SESSION_ID,
      expect.anything(),
      {}
    );
  });

  it('leaves a cooling-down post-approval worker available to control paths', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({ cooldown: true });

    await manager.provisionWorkflowSession(workflowSession());

    expect(restorePostApprovalWorkerSession).not.toHaveBeenCalled();
  });

  it('rejects the lookup when workflow provisioning fails', async () => {
    const { manager } = makeManager({ spaceError: new Error('space lookup failed') });

    await expect(manager.provisionWorkflowSession(workflowSession())).rejects.toThrow(
      'space lookup failed'
    );
  });
});
