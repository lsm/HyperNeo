import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkTarget } from '../../storage/repositories/neo-repository.ts';
import type { ExecutionSession, NeoWorkTargetRejection } from './work-target.ts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkOrigin } from './work-origin.ts';

export interface NeoAgentWorkOwner {
  agentId: string;
  spaceId: string;
  sessionId: string | null;
  agentStatus: string;
  spaceStatus: string;
  paused: number;
  stopped: number;
  nativeSpaceId: string | null;
  ownerCount: number;
}
type Gate = { value: NeoWorkTarget } | { reason: NeoWorkTargetRejection };
const reject = (reason: NeoWorkTargetRejection['reason']): Gate => ({
  reason: { accepted: false, reason },
});

export function requireNeoAgentWorkReference(target: NeoWorkTarget): Gate {
  const agent = target.agent;
  return agent === undefined ||
    (agent &&
      typeof agent.spaceId === 'string' &&
      !!agent.spaceId.trim() &&
      typeof agent.agentId === 'string' &&
      !!agent.agentId.trim() &&
      typeof agent.sessionId === 'string' &&
      !!agent.sessionId.trim() &&
      agent.sessionId === target.targetSessionId)
    ? { value: target }
    : reject('invalid_agent_reference');
}

export function requireNeoAgentWorkSession(
  target: NeoWorkTarget,
  session: ExecutionSession | null,
  owner: NeoAgentWorkOwner | null
): Gate {
  if (!session || session.id !== target.targetSessionId) return reject('target_session_not_found');
  if (session.status !== 'active') return reject('target_session_not_active');
  if (session.neoBound) return reject('target_owned_context');
  const agent = target.agent;
  if (
    !agent ||
    !owner ||
    owner.agentId !== agent.agentId ||
    owner.spaceId !== agent.spaceId ||
    owner.sessionId !== agent.sessionId ||
    (owner.nativeSpaceId !== null && owner.nativeSpaceId !== agent.spaceId)
  )
    return reject('target_agent_unavailable');
  if (owner.ownerCount !== 1) return reject('ambiguous_target_agent');
  if (owner.agentStatus !== 'active') return reject('target_agent_not_active');
  return owner.spaceStatus === 'active' && owner.paused === 0 && owner.stopped === 0
    ? { value: target }
    : reject('target_space_not_active');
}

export function requireNeoAgentWorkBinding(
  target: NeoWorkTarget,
  binding: NeoBinding | null
): Gate {
  return binding === null ? { value: target } : reject('target_owned_context');
}

export function requireNeoProposalReceipt(
  target: NeoWorkTarget,
  origin: NeoWorkOrigin,
  receipt: { work: NeoWork; agent: NeoWorkTarget['agent'] | null }
): { value: { ok: true; work: NeoWork } } | { reason: { ok: false; reason: string } } {
  const { work, agent } = receipt;
  if (
    work.originMessageId !== origin.originMessageId ||
    work.originSessionId !== origin.originSessionId
  )
    return { reason: { ok: false, reason: 'This request key belongs to another input.' } };
  if (work.targetSessionId !== target.targetSessionId)
    return {
      reason: { ok: false, reason: 'This request key belongs to another execution target.' },
    };
  return target.agent
    ? agent?.spaceId === target.agent.spaceId &&
      agent.agentId === target.agent.agentId &&
      agent.sessionId === target.agent.sessionId
      ? { value: { ok: true, work } }
      : { reason: { ok: false, reason: 'This request key belongs to another native target.' } }
    : agent === null
      ? { value: { ok: true, work } }
      : { reason: { ok: false, reason: 'This request key belongs to another native target.' } };
}
