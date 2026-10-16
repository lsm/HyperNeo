import type { Session, SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { SpaceTaskManager } from './task-manager.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';

export interface SpaceTaskDependencyDependencies extends SpaceMcpSessionPolicyContext {
  db: Database;
  getSession: (sessionId: string) => Session | null;
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'getTask' | 'updateTask'>;
  notifyStandalone: () => void;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>;
  blockExecution: (
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams
  ) => Promise<SpaceTask | null>;
  stopForStatus?: (
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams
  ) => Promise<SpaceTask | null>;
}
