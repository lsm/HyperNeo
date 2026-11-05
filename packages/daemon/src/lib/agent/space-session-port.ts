import type { Session, SpaceTask } from '@hyperneo/shared';

export interface SpaceSessionPolicy {
  readonly role: string;
  readonly owner: string;
  readonly spaceId?: string;
  readonly isWorkflowWorker: boolean;
}

export interface SpaceSessionPort {
  mcpPolicy(session: Session): SpaceSessionPolicy;
  taskForSession(session: Session): SpaceTask | null;
  workflowRunIdForSession(sessionId: string): string | undefined;
  queryStartGuard(getSession: () => Session): (() => void) | undefined;
}
