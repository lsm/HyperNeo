import { longTermAgentSessionId } from '../space/long-term-agent-session.ts';
import {
  coordinatorLongHorizonAgentId,
  coordinatorSessionId,
} from '../../storage/repositories/space-long-horizon-agent-repository.ts';

export interface SessionTargetSession {
  kind: 'session';
  sessionId: string;
}

export interface SessionTargetAgent {
  kind: 'agent';
  spaceId: string;
  agentId: string;
}

export interface SessionTargetWorker {
  kind: 'worker';
  taskId: string;
  agentName: string;
  workflowNodeId?: string;
}

export type SessionTarget = SessionTargetSession | SessionTargetAgent | SessionTargetWorker;

export type FindTarget = Exclude<SessionTarget, SessionTargetWorker>;

export type EnsureSessionOutcome =
  | { kind: 'resolved'; sessionId: string; created: boolean }
  | { kind: 'unresolved'; reason: string };

export function agentSessionIdOf(
  spaceId: string,
  agentId: string,
  coordinatorAgentId?: string
): string {
  if (
    agentId === 'coordinator' ||
    (coordinatorAgentId !== undefined && agentId === coordinatorAgentId) ||
    agentId === coordinatorLongHorizonAgentId(spaceId)
  ) {
    return coordinatorSessionId(spaceId);
  }
  return longTermAgentSessionId(spaceId, agentId);
}
