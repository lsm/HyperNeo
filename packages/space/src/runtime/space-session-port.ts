import type { Session } from '@hyperneo/shared';
import type { SpaceSessionPort } from '../../../daemon/src/lib/agent/space-session-port.ts';
import type { NodeExecutionRepository } from '../../../daemon/src/storage/repositories/node-execution-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../daemon/src/storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../../daemon/src/storage/repositories/space-task-repository.ts';
import type { Database } from '../../../daemon/src/storage/sqlite-compat.ts';
import { createDirectQueryStartGuard } from '../../../daemon/src/lib/tasks/direct-query-start-guard.ts';
import { resolveSpaceMcpSessionPolicy } from '../../../daemon/src/lib/session-resolution/space-mcp-session-policy.ts';

export function createSpaceSessionPort(
  db: Database,
  taskRepo: SpaceTaskRepository,
  nodeExecutionRepo: NodeExecutionRepository,
  longHorizonAgentRepo: SpaceLongHorizonAgentRepository
): SpaceSessionPort {
  return {
    mcpPolicy: (session: Session) =>
      resolveSpaceMcpSessionPolicy(session, { nodeExecutionRepo, taskRepo, longHorizonAgentRepo }),
    taskForSession: (session) => {
      const task = taskRepo.getTaskBySessionId(session.id);
      if (task) return task;
      const taskId = session.context?.taskId;
      return taskId ? taskRepo.getTask(taskId) : null;
    },
    workflowRunIdForSession: (sessionId) =>
      nodeExecutionRepo.getByAgentSessionId(sessionId)?.workflowRunId,
    queryStartGuard: (getSession) => createDirectQueryStartGuard(db, getSession),
  };
}
