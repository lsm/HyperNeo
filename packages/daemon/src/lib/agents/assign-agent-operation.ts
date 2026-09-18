import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { decideGoalOwnershipMutationAdmission } from '../goals/ownership-gates.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitAgentCaller,
  AGENT_MUTATE_POLICY,
  AgentRejectionSchema,
  AgentSpaceScopeSchema,
  rejectAgent,
  type AgentOperationDeps,
  type AgentRejection,
} from './operation-contracts.ts';

const goalInputSchema = AgentSpaceScopeSchema.extend({
  agentId: z.string().min(1).describe('Long-horizon agent ID'),
  goalId: z.string().min(1).describe('Goal ID'),
}).strict();

const scopeInputSchema = AgentSpaceScopeSchema.extend({
  agentId: z.string().min(1).describe('Long-horizon agent ID'),
  scopeId: z.string().min(1).describe('Forge scope ID'),
}).strict();

type GoalInput = z.infer<typeof goalInputSchema>;
type ScopeInput = z.infer<typeof scopeInputSchema>;
type Result = { assigned: true } | AgentRejection;
type Gate<T> = { value: T } | { reason: AgentRejection };

export interface AgentAssignmentDependencies extends AgentOperationDeps {
  readonly getAgent: (agentId: string) => SpaceLongHorizonAgent | null;
  readonly getGoalSpace: (goalId: string) => string | null;
  readonly getForgeScopeSpace: (scopeId: string) => string | null;
  readonly assignGoal: (agentId: string, goalId: string) => void;
  readonly unassignGoal: (agentId: string, goalId: string) => void;
  readonly assignForgeScope: (agentId: string, scopeId: string) => void;
  readonly unassignForgeScope: (agentId: string, scopeId: string) => void;
  readonly publishGoalOwnerChanged: (spaceId: string, goalId: string, sessionId: string) => void;
  readonly audit: (
    operationName: string,
    summary: Record<string, unknown>,
    caller: OperationCaller,
    spaceId: string
  ) => void;
}

export function admitGoalOwnershipCaller(
  spaceId: string,
  caller: OperationCaller,
  deps: AgentAssignmentDependencies
): Gate<string> {
  if (caller.source !== 'mcp') return { value: spaceId };
  const hasSpaceAuthority = caller.role === 'long_term_agent';
  if (hasSpaceAuthority) {
    const agent = caller.agentId ? deps.getAgent(caller.agentId) : null;
    if (agent?.spaceId !== spaceId || agent.status !== 'active') {
      return {
        reason: rejectAgent(
          'agent_denied',
          'This action requires an active Space agent identity; the provenance agent is missing or inactive.'
        ),
      };
    }
  }
  const admission = decideGoalOwnershipMutationAdmission({ hasSpaceAuthority, hasSession: true });
  return admission.action === 'deny'
    ? { reason: rejectAgent('agent_denied', admission.message) }
    : { value: spaceId };
}

export function gateAssignmentTargets(
  spaceId: string,
  agentId: string,
  targetId: string,
  resolveTargetSpace: (id: string) => string | null,
  targetLabel: 'Goal' | 'EvolutionScope',
  deps: AgentAssignmentDependencies
): Gate<string> {
  if (deps.getAgent(agentId)?.spaceId !== spaceId) {
    return { reason: rejectAgent('agent_not_found', `Long-horizon agent not found: ${agentId}`) };
  }
  if (resolveTargetSpace(targetId) !== spaceId) {
    return {
      reason: rejectAgent(
        targetLabel === 'Goal' ? 'goal_not_found' : 'scope_not_found',
        `${targetLabel} not found: ${targetId}`
      ),
    };
  }
  return { value: spaceId };
}

function gateGoalTargets(
  spaceId: string,
  input: GoalInput,
  deps: AgentAssignmentDependencies
): Gate<string> {
  return gateAssignmentTargets(
    spaceId,
    input.agentId,
    input.goalId,
    deps.getGoalSpace,
    'Goal',
    deps
  );
}

function gateScopeTargets(
  spaceId: string,
  input: ScopeInput,
  deps: AgentAssignmentDependencies
): Gate<string> {
  return gateAssignmentTargets(
    spaceId,
    input.agentId,
    input.scopeId,
    deps.getForgeScopeSpace,
    'EvolutionScope',
    deps
  );
}

function goalWriter(operationName: 'agent.assignGoal' | 'agent.unassignGoal') {
  return (
    spaceId: string,
    input: GoalInput,
    caller: OperationCaller,
    deps: AgentAssignmentDependencies
  ): Result => {
    if (operationName === 'agent.assignGoal') deps.assignGoal(input.agentId, input.goalId);
    else deps.unassignGoal(input.agentId, input.goalId);
    deps.publishGoalOwnerChanged(spaceId, input.goalId, caller.sessionId ?? 'space-agent-tools');
    deps.audit(operationName, { agentId: input.agentId, goalId: input.goalId }, caller, spaceId);
    return { assigned: true };
  };
}

function scopeWriter(operationName: 'agent.assignForgeScope' | 'agent.unassignForgeScope') {
  return (
    spaceId: string,
    input: ScopeInput,
    caller: OperationCaller,
    deps: AgentAssignmentDependencies
  ): Result => {
    if (operationName === 'agent.assignForgeScope')
      deps.assignForgeScope(input.agentId, input.scopeId);
    else deps.unassignForgeScope(input.agentId, input.scopeId);
    deps.audit(operationName, { agentId: input.agentId, scopeId: input.scopeId }, caller, spaceId);
    return { assigned: true };
  };
}

function buildGoalPipeline(
  deps: AgentAssignmentDependencies,
  operationName: 'agent.assignGoal' | 'agent.unassignGoal'
) {
  const access = 'mutate' as const;
  return (superpipe({ deps, access })(`${operationName}-pipeline`) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(admitGoalOwnershipCaller, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(gateGoalTargets, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(goalWriter(operationName), ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (input: GoalInput, caller: OperationCaller) => Promise<Result>;
}

function buildScopePipeline(
  deps: AgentAssignmentDependencies,
  operationName: 'agent.assignForgeScope' | 'agent.unassignForgeScope'
) {
  const access = 'mutate' as const;
  return (superpipe({ deps, access })(`${operationName}-pipeline`) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(gateScopeTargets, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(scopeWriter(operationName), ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (input: ScopeInput, caller: OperationCaller) => Promise<Result>;
}

const resultSchema = z.union([
  z.object({ assigned: z.literal(true) }).strict(),
  AgentRejectionSchema,
]);

const GOAL_OWNERSHIP_DOC =
  'Reassigning goal ownership needs Space authority: a human (RPC) caller, or a long-term agent whose own agent record is active in this Space. Ad-hoc member and worker sessions are rejected. Rejects agent_not_found or goal_not_found when either side belongs to another Space.';

export function createAssignAgentToGoalOperation(deps: AgentAssignmentDependencies) {
  const assign = buildGoalPipeline(deps, 'agent.assignGoal');
  return defineOperation({
    name: 'agent.assignGoal',
    description: `Make a long-horizon agent the owner of a goal in its Space, and announce the ownership change. ${GOAL_OWNERSHIP_DOC}`,
    policy: { ...AGENT_MUTATE_POLICY, audit: { selfAudited: true } },
    inputSchema: goalInputSchema,
    resultSchema,
    execute: async (input, caller) => assign(input, caller),
  });
}

export function createUnassignAgentFromGoalOperation(deps: AgentAssignmentDependencies) {
  const unassign = buildGoalPipeline(deps, 'agent.unassignGoal');
  return defineOperation({
    name: 'agent.unassignGoal',
    description: `Drop a long-horizon agent owner relationship on a goal in its Space, and announce the ownership change. Removing an assignment that is not there succeeds. ${GOAL_OWNERSHIP_DOC}`,
    policy: { ...AGENT_MUTATE_POLICY, audit: { selfAudited: true } },
    inputSchema: goalInputSchema,
    resultSchema,
    execute: async (input, caller) => unassign(input, caller),
  });
}

const FORGE_SCOPE_DOC =
  'Admitted for ad-hoc members and long-term agents whose session is active in the owning Space; read-only and worker sessions are rejected. Rejects agent_not_found or scope_not_found when either side belongs to another Space.';

export function createAssignAgentToForgeScopeOperation(deps: AgentAssignmentDependencies) {
  const assign = buildScopePipeline(deps, 'agent.assignForgeScope');
  return defineOperation({
    name: 'agent.assignForgeScope',
    description: `Assign a long-horizon agent to a Forge scope in its Space, so the scope evidence loop routes to it. ${FORGE_SCOPE_DOC}`,
    policy: { ...AGENT_MUTATE_POLICY, audit: { selfAudited: true } },
    inputSchema: scopeInputSchema,
    resultSchema,
    execute: async (input, caller) => assign(input, caller),
  });
}

export function createUnassignAgentFromForgeScopeOperation(deps: AgentAssignmentDependencies) {
  const unassign = buildScopePipeline(deps, 'agent.unassignForgeScope');
  return defineOperation({
    name: 'agent.unassignForgeScope',
    description: `Remove a long-horizon agent Forge scope assignment in its Space. Removing an assignment that is not there succeeds. ${FORGE_SCOPE_DOC}`,
    policy: { ...AGENT_MUTATE_POLICY, audit: { selfAudited: true } },
    inputSchema: scopeInputSchema,
    resultSchema,
    execute: async (input, caller) => unassign(input, caller),
  });
}
