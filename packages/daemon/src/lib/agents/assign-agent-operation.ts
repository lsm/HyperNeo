import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
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

const goalOwnerSetInputSchema = goalInputSchema
  .extend({
    assigned: z.boolean().describe('True to make the agent the owner, false to drop the ownership'),
  })
  .strict();

const scopeOwnerSetInputSchema = scopeInputSchema
  .extend({
    assigned: z
      .boolean()
      .describe('True to route the scope to the agent, false to stop routing it'),
  })
  .strict();

type GoalInput = z.infer<typeof goalInputSchema>;
type ScopeInput = z.infer<typeof scopeInputSchema>;
type GoalOwnerSetInput = z.infer<typeof goalOwnerSetInputSchema>;
type ScopeOwnerSetInput = z.infer<typeof scopeOwnerSetInputSchema>;
type Result = { accepted: true; assigned: true } | AgentRejection;
type OwnerSetResult = { accepted: true; assigned: boolean } | AgentRejection;
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
  if (!caller.agentId) return { value: spaceId };
  const agent = deps.getAgent(caller.agentId);
  if (agent?.spaceId !== spaceId || agent.status !== 'active') {
    return {
      reason: rejectAgent(
        'agent_denied',
        'This action requires an active Space agent identity; the provenance agent is missing or inactive.'
      ),
    };
  }
  return { value: spaceId };
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
    return { accepted: true, assigned: true };
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
    return { accepted: true, assigned: true };
  };
}

function goalOwnerWriter(
  spaceId: string,
  input: GoalOwnerSetInput,
  caller: OperationCaller,
  deps: AgentAssignmentDependencies
): OwnerSetResult {
  if (input.assigned) deps.assignGoal(input.agentId, input.goalId);
  else deps.unassignGoal(input.agentId, input.goalId);
  deps.publishGoalOwnerChanged(spaceId, input.goalId, caller.sessionId ?? 'space-agent-tools');
  deps.audit(
    'goal.owner.set',
    { agentId: input.agentId, goalId: input.goalId, assigned: input.assigned },
    caller,
    spaceId
  );
  return { accepted: true, assigned: input.assigned };
}

function scopeOwnerWriter(
  spaceId: string,
  input: ScopeOwnerSetInput,
  caller: OperationCaller,
  deps: AgentAssignmentDependencies
): OwnerSetResult {
  if (input.assigned) deps.assignForgeScope(input.agentId, input.scopeId);
  else deps.unassignForgeScope(input.agentId, input.scopeId);
  deps.audit(
    'evolution.scope.owner.set',
    { agentId: input.agentId, scopeId: input.scopeId, assigned: input.assigned },
    caller,
    spaceId
  );
  return { accepted: true, assigned: input.assigned };
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
  z.object({ accepted: z.literal(true), assigned: z.literal(true) }).strict(),
  AgentRejectionSchema,
]);

const GOAL_OWNERSHIP_DOC =
  'Admitted for MCP callers whose session is active in the owning Space; a caller with no Space, or one whose session is not active in it, is rejected with agent_denied. A caller that presents an agent identity must own one that is active in this Space. Rejects agent_not_found or goal_not_found when either side belongs to another Space.';

export function createAssignAgentToGoalOperation(deps: AgentAssignmentDependencies) {
  const assign = buildGoalPipeline(deps, 'agent.assignGoal');
  return defineOperation({
    name: 'agent.assignGoal',
    description: `Make a long-horizon agent the owner of a goal in its Space, and announce the ownership change. ${GOAL_OWNERSHIP_DOC}`,
    policy: AGENT_MUTATE_POLICY,
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
    policy: AGENT_MUTATE_POLICY,
    inputSchema: goalInputSchema,
    resultSchema,
    execute: async (input, caller) => unassign(input, caller),
  });
}

const FORGE_SCOPE_DOC =
  'Admitted for MCP callers whose session is active in the owning Space; a caller with no Space, or one whose session is not active in it, is rejected with agent_denied. Rejects agent_not_found or scope_not_found when either side belongs to another Space.';

export function createAssignAgentToForgeScopeOperation(deps: AgentAssignmentDependencies) {
  const assign = buildScopePipeline(deps, 'agent.assignForgeScope');
  return defineOperation({
    name: 'agent.assignForgeScope',
    description: `Assign a long-horizon agent to a Forge scope in its Space, so the scope evidence loop routes to it. ${FORGE_SCOPE_DOC}`,
    policy: AGENT_MUTATE_POLICY,
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
    policy: AGENT_MUTATE_POLICY,
    inputSchema: scopeInputSchema,
    resultSchema,
    execute: async (input, caller) => unassign(input, caller),
  });
}

const ownerSetResultSchema = z.union([
  z.object({ accepted: z.literal(true), assigned: z.boolean() }).strict(),
  AgentRejectionSchema,
]);

export function createSetGoalOwnerOperation(deps: AgentAssignmentDependencies) {
  const access = 'mutate' as const;
  const set = (superpipe({ deps, access })('goal-owner-set-pipeline') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(admitGoalOwnershipCaller, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(gateGoalTargets, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(goalOwnerWriter, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: GoalOwnerSetInput,
    caller: OperationCaller
  ) => Promise<OwnerSetResult>;
  return defineOperation({
    name: 'goal.owner.set',
    description: `Set or drop the long-horizon agent that owns a goal in its Space, and announce the ownership change. assigned true makes the agent the owner, false drops the relationship; dropping one that is not there succeeds. The result reports the resulting state, so it echoes what you asked for. ${GOAL_OWNERSHIP_DOC}`,
    policy: AGENT_MUTATE_POLICY,
    inputSchema: goalOwnerSetInputSchema,
    resultSchema: ownerSetResultSchema,
    execute: async (input, caller) => set(input, caller),
  });
}

export function createSetScopeOwnerOperation(deps: AgentAssignmentDependencies) {
  const access = 'mutate' as const;
  const set = (superpipe({ deps, access })('scope-owner-set-pipeline') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(gateScopeTargets, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(scopeOwnerWriter, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: ScopeOwnerSetInput,
    caller: OperationCaller
  ) => Promise<OwnerSetResult>;
  return defineOperation({
    name: 'evolution.scope.owner.set',
    description: `Set or drop the long-horizon agent a Forge scope's evidence loop routes to. assigned true routes the scope to the agent, false stops routing it; dropping one that is not there succeeds. The result reports the resulting state. Read the current routing with evolution.scope.get include ["agents"]. ${FORGE_SCOPE_DOC}`,
    policy: AGENT_MUTATE_POLICY,
    inputSchema: scopeOwnerSetInputSchema,
    resultSchema: ownerSetResultSchema,
    execute: async (input, caller) => set(input, caller),
  });
}
