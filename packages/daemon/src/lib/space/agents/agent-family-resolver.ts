import type { SpaceWorkerAgent, SpaceLongHorizonAgent } from '@hyperneo/shared';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceAgentManager } from '../managers/space-agent-manager.ts';

export type AgentFamily = 'worker' | 'long_horizon';
export type AgentFamilyClassification =
  | 'worker_only'
  | 'long_horizon_only'
  | 'shared'
  | 'cross_space'
  | 'missing';

export interface AgentFamilyResolution {
  spaceId: string;
  agentId: string;
  expected: AgentFamily;
  classification: AgentFamilyClassification;
  ok: boolean;
  error?: string;
  sharedId: boolean;
  workerAgent: SpaceWorkerAgent | null;
  longHorizonAgent: SpaceLongHorizonAgent | null;
}

interface ResolveAgentFamilyParams {
  spaceId: string;
  agentId: string;
  expected: AgentFamily;
  spaceAgentManager: Pick<SpaceAgentManager, 'getById'>;
  longHorizonAgentRepo: Pick<SpaceLongHorizonAgentRepository, 'getById'>;
}

export function resolveAgentFamily(params: ResolveAgentFamilyParams): AgentFamilyResolution {
  const workerAgent = params.spaceAgentManager.getById(params.agentId);
  const longHorizonAgent = params.longHorizonAgentRepo.getById(params.agentId);
  const workerInSpace = workerAgent?.spaceId === params.spaceId;
  const longHorizonInSpace = longHorizonAgent?.spaceId === params.spaceId;
  const classification = classifyAgentFamily({
    workerAgent,
    longHorizonAgent,
    workerInSpace,
    longHorizonInSpace,
  });
  const sharedId = classification === 'shared';
  const ok =
    (params.expected === 'worker' && workerInSpace) ||
    (params.expected === 'long_horizon' && longHorizonInSpace);

  return {
    spaceId: params.spaceId,
    agentId: params.agentId,
    expected: params.expected,
    classification,
    ok,
    error: ok ? undefined : agentFamilyError(params.expected, params.agentId, classification),
    sharedId,
    workerAgent: workerInSpace ? workerAgent : null,
    longHorizonAgent: longHorizonInSpace ? longHorizonAgent : null,
  };
}

export function requireAgentFamily(params: ResolveAgentFamilyParams): AgentFamilyResolution {
  const resolution = resolveAgentFamily(params);
  if (!resolution.ok) throw new Error(resolution.error);
  return resolution;
}

function classifyAgentFamily(params: {
  workerAgent: SpaceWorkerAgent | null;
  longHorizonAgent: SpaceLongHorizonAgent | null;
  workerInSpace: boolean;
  longHorizonInSpace: boolean;
}): AgentFamilyClassification {
  if (params.workerInSpace && params.longHorizonInSpace) return 'shared';
  if (params.workerInSpace) return 'worker_only';
  if (params.longHorizonInSpace) return 'long_horizon_only';
  if (params.workerAgent || params.longHorizonAgent) return 'cross_space';
  return 'missing';
}

function agentFamilyError(
  expected: AgentFamily,
  agentId: string,
  classification: AgentFamilyClassification
): string {
  if (expected === 'long_horizon' && classification === 'worker_only') {
    return 'Expected long-horizon agent id, got worker agent id.';
  }
  if (expected === 'worker' && classification === 'long_horizon_only') {
    return 'Expected worker agent id, got long-horizon agent id.';
  }
  if (classification === 'cross_space') {
    return `${expected === 'worker' ? 'Agent' : 'Long-horizon agent'} not found: ${agentId}`;
  }
  return `${expected === 'worker' ? 'Agent' : 'Long-horizon agent'} not found: ${agentId}`;
}
