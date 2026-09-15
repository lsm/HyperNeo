import type { Session, SpaceLongHorizonAgent } from '@hyperneo/shared';
import type { OperationCaller } from '../../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import { resolveMetadataSessionSpace } from './task-metadata.ts';

export type AgentReadAdmission = Pick<SpaceMcpSessionPolicyContext, 'longHorizonAgentRepo'> & {
  getSession: (sessionId: string) => Session | null;
};

type RawAgentListReader = (spaceId: string) => SpaceLongHorizonAgent[];
type RawAgentReader = (agentId: string) => SpaceLongHorizonAgent | null;

function resolveCallerSpace(
  caller: OperationCaller,
  getSession: (sessionId: string) => Session | null,
  policyContext: SpaceMcpSessionPolicyContext
): string | undefined {
  if (caller.source !== 'mcp' || !caller.sessionId) return undefined;
  const session = getSession(caller.sessionId);
  if (!session) return undefined;
  return resolveMetadataSessionSpace(session, policyContext);
}

function isAgentReadDenied(
  spaceId: string,
  caller: OperationCaller,
  admission: AgentReadAdmission
): boolean {
  const callerSpaceId = resolveCallerSpace(caller, admission.getSession, admission);
  if (caller.source === 'rpc' || caller.source === 'internal') return false;
  return callerSpaceId !== spaceId;
}

export function listScopedAgents(
  caller: OperationCaller,
  admission: AgentReadAdmission,
  listAgents: RawAgentListReader,
  spaceId: string
): SpaceLongHorizonAgent[] {
  if (isAgentReadDenied(spaceId, caller, admission)) return [];
  return listAgents(spaceId);
}

export function readScopedAgent(
  caller: OperationCaller,
  admission: AgentReadAdmission,
  getAgent: RawAgentReader,
  agentId: string
): SpaceLongHorizonAgent {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Long-horizon agent not found');
  if (isAgentReadDenied(agent.spaceId, caller, admission)) {
    throw new Error('Long-horizon agent not found');
  }
  return agent;
}
