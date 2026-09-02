import type { ActorRef } from '../../../../messaging/src/types.ts';
import type { SessionTarget } from './target.ts';

export function isCoordinatorActorId(actorId: string, spaceId: string): boolean {
  return actorId === `agent:coordinator:${spaceId}`;
}

export function actorRefToSessionTarget(actorRef: ActorRef, spaceId: string): SessionTarget | null {
  if (actorRef.spaceId !== spaceId) return null;
  switch (actorRef.kind) {
    case 'human':
    case 'session': {
      const prefix = actorRef.kind === 'human' ? 'human:' : 'session:';
      if (!actorRef.actorId.startsWith(prefix)) return null;
      const sessionId = actorRef.actorId.slice(prefix.length);
      return sessionId ? { kind: 'session', sessionId } : null;
    }
    case 'agent': {
      if (isCoordinatorActorId(actorRef.actorId, spaceId)) {
        return { kind: 'agent', spaceId, agentId: 'coordinator' };
      }
      if (!actorRef.actorId.startsWith('agent:')) return null;
      try {
        const agentId = decodeURIComponent(actorRef.actorId.slice('agent:'.length));
        return agentId ? { kind: 'agent', spaceId, agentId } : null;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
