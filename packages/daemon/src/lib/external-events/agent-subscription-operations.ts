import type { SpaceLongHorizonAgentEventSubscription } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { McpAuditLogRepository } from '../../storage/repositories/mcp-audit-log-repository.ts';
import type { SpaceAgentSubscriptionRepository } from '../../storage/repositories/space-agent-subscription-repository.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import {
  admitEventCallerSpace,
  AGENT_EVENT_ROLES,
  callerSessionActiveIn,
  type EventCallerDependencies,
} from './operation-admission.ts';
import { validateGlobPattern } from './topic-validator.ts';

export type AgentSubscriptionRepo = Pick<
  SpaceAgentSubscriptionRepository,
  | 'upsertSubscription'
  | 'getSubscriptionByRoute'
  | 'deleteSubscriptionByRoute'
  | 'listSubscriptions'
>;

export interface AgentSubscriptionDependencies extends EventCallerDependencies {
  subscriptionRepo: AgentSubscriptionRepo;
  refreshSubscription: SpaceRuntimeService['refreshLongHorizonSubscription'];
  removeSubscription: SpaceRuntimeService['removeLongHorizonSubscription'];
  auditLogRepo?: Pick<McpAuditLogRepository, 'createEntry'>;
}

export interface AgentSubscriptionScope {
  spaceId: string;
  agentId: string;
}

const REJECTIONS = z.object({
  accepted: z.literal(false),
  reason: z.enum([
    'caller_denied',
    'session_inactive',
    'agent_not_found',
    'invalid_pattern',
    'refresh_failed',
  ]),
});
type Rejection = z.infer<typeof REJECTIONS>;

const SubscribeInput = z
  .object({
    agent_id: z.string().min(1),
    topic_pattern: z.string().min(1),
    label: z.string().optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict();
const UnsubscribeInput = z
  .object({
    agent_id: z.string().min(1),
    topic_pattern: z.string().min(1),
    spaceId: z.string().min(1).optional(),
  })
  .strict();
const ListInput = z
  .object({
    agent_id: z.string().min(1),
    spaceId: z.string().min(1).optional(),
  })
  .strict();

const SubscriptionStatusSchema = z.enum(['active', 'paused', 'disabled']);

export const SubscriptionRecordSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  source: z.string(),
  topic: z.string(),
  filter: z.record(z.string(), z.unknown()),
  status: SubscriptionStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

const SubscribeResultSchema = z.union([
  z.object({ subscription: SubscriptionRecordSchema }),
  REJECTIONS,
]);
const UnsubscribeResultSchema = z.union([
  z.object({ ok: z.literal(true), topicPattern: z.string() }),
  REJECTIONS,
]);
const ListResultSchema = z.union([
  z.object({
    subscriptions: z.array(SubscriptionRecordSchema),
    scope: z.object({ spaceId: z.string() }),
  }),
  REJECTIONS,
]);

export function subscriptionRecord(
  subscription: SpaceLongHorizonAgentEventSubscription
): z.infer<typeof SubscriptionRecordSchema> {
  return {
    id: subscription.id,
    agentId: subscription.agentId,
    source: subscription.source,
    topic: subscription.topic,
    filter: subscription.filter,
    status: subscription.status,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

export function admitAgentSubscriptionWriter(
  input: { spaceId?: string },
  caller: OperationCaller,
  deps: AgentSubscriptionDependencies
): { value: string } | { reason: Rejection } {
  const space = admitEventCallerSpace(input, caller);
  if ('reason' in space) return { reason: { accepted: false, reason: 'caller_denied' } };
  if (!callerSessionActiveIn(caller, space.value, deps))
    return { reason: { accepted: false, reason: 'session_inactive' } };
  return { value: space.value };
}

export function admitAgentSubscriptionReader(
  input: { spaceId?: string },
  caller: OperationCaller
): { value: string } | { reason: Rejection } {
  const space = admitEventCallerSpace(input, caller);
  if ('reason' in space) return { reason: { accepted: false, reason: 'caller_denied' } };
  return { value: space.value };
}

export function gateAgentSubscription(
  spaceId: string,
  input: { agent_id: string },
  deps: AgentSubscriptionDependencies
): { value: AgentSubscriptionScope } | { reason: Rejection } {
  return deps.longHorizonAgentRepo.getById(input.agent_id)?.spaceId === spaceId
    ? { value: { spaceId, agentId: input.agent_id } }
    : { reason: { accepted: false, reason: 'agent_not_found' } };
}

export function auditAgentSubscription(
  deps: AgentSubscriptionDependencies,
  caller: OperationCaller,
  scope: AgentSubscriptionScope,
  operationName: string,
  paramsSummary: Record<string, unknown>
): void {
  if (!deps.auditLogRepo) return;
  try {
    deps.auditLogRepo.createEntry({
      agentName: caller.agentName,
      sessionId: caller.sessionId,
      toolName: operationName,
      paramsSummary: JSON.stringify(paramsSummary),
      spaceId: scope.spaceId,
    });
  } catch {}
}

export function subscribeAgentTopic(
  scope: AgentSubscriptionScope,
  input: z.infer<typeof SubscribeInput>,
  caller: OperationCaller,
  deps: AgentSubscriptionDependencies,
  operationName: string
): z.infer<typeof SubscribeResultSchema> {
  const topicPattern = input.topic_pattern.trim();
  const validation = validateGlobPattern(topicPattern);
  if (!validation.valid) return { accepted: false, reason: 'invalid_pattern' };
  const subscription = deps.subscriptionRepo.upsertSubscription({
    spaceId: scope.spaceId,
    agentId: scope.agentId,
    source: topicPattern.split('/')[0] ?? '',
    topic: topicPattern,
    filter: input.label ? { label: input.label } : {},
    status: 'active',
  });
  if (!deps.refreshSubscription(scope.spaceId, subscription.id).success)
    return { accepted: false, reason: 'refresh_failed' };
  auditAgentSubscription(deps, caller, scope, operationName, {
    agent_id: input.agent_id,
    topic_pattern: input.topic_pattern,
    label: input.label,
  });
  return { subscription: subscriptionRecord(subscription) };
}

export function unsubscribeAgentTopic(
  scope: AgentSubscriptionScope,
  input: z.infer<typeof UnsubscribeInput>,
  caller: OperationCaller,
  deps: AgentSubscriptionDependencies,
  operationName: string
): z.infer<typeof UnsubscribeResultSchema> {
  const topicPattern = input.topic_pattern.trim();
  const validation = validateGlobPattern(topicPattern);
  if (!validation.valid) return { accepted: false, reason: 'invalid_pattern' };
  const source = topicPattern.split('/')[0] ?? '';
  const existing = deps.subscriptionRepo.getSubscriptionByRoute(
    scope.spaceId,
    scope.agentId,
    source,
    topicPattern
  );
  deps.subscriptionRepo.deleteSubscriptionByRoute(
    scope.spaceId,
    scope.agentId,
    source,
    topicPattern
  );
  if (existing) deps.removeSubscription(scope.spaceId, existing.id);
  auditAgentSubscription(deps, caller, scope, operationName, {
    agent_id: input.agent_id,
    topic_pattern: input.topic_pattern,
  });
  return { ok: true, topicPattern };
}

export function listAgentSubscriptionTopics(
  scope: AgentSubscriptionScope,
  _input: z.infer<typeof ListInput>,
  _caller: OperationCaller,
  deps: AgentSubscriptionDependencies
): z.infer<typeof ListResultSchema> {
  return {
    subscriptions: deps.subscriptionRepo.listSubscriptions(scope.agentId).map(subscriptionRecord),
    scope: { spaceId: scope.spaceId },
  };
}

type ApplyStage<Input, Result> = (
  scope: AgentSubscriptionScope,
  input: Input,
  caller: OperationCaller,
  deps: AgentSubscriptionDependencies
) => Result;

function agentPipeline<Input, Result>(
  name: string,
  deps: AgentSubscriptionDependencies,
  admit: (
    input: { spaceId?: string },
    caller: OperationCaller,
    deps: AgentSubscriptionDependencies
  ) => { value: string } | { reason: Rejection },
  apply: ApplyStage<Input, Result>
) {
  return (superpipe({ deps })(name) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admit, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(gateAgentSubscription, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(apply, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
}

const SCOPE_DOC =
  'The target long-horizon agent is taken from agent_id and must belong to the caller Space; the Space is derived from the calling session, never guessed, and omitted spaceId defaults to the trusted caller Space. List results report the resolved Space in scope. Returns { accepted: false, reason } on rejection: caller_denied for any other caller, session_inactive when the calling session is not active in that Space, agent_not_found when the agent is unknown or belongs to another Space, and invalid_pattern when topic_pattern is not a valid topic glob.';

export function createAgentSubscriptionOperations(
  deps: AgentSubscriptionDependencies
): OperationDefinition[] {
  return [
    defineOperation({
      name: 'externalEvent.agent.subscribe',
      policy: { safetyClass: 'mutate', roles: AGENT_EVENT_ROLES },
      description: `Subscribe a long-horizon agent to external events matching a topic glob (e.g. github/lsm/neokai/pull_request/*.review_*), upserting the stored subscription and refreshing the live delivery trie. ${SCOPE_DOC} Returns the stored subscription record; rejects refresh_failed when the live trie could not be refreshed.`,
      inputSchema: SubscribeInput,
      resultSchema: SubscribeResultSchema,
      execute: agentPipeline(
        'subscribe-agent-external-event',
        deps,
        admitAgentSubscriptionWriter,
        (scope, input: z.infer<typeof SubscribeInput>, caller, agentDeps) =>
          subscribeAgentTopic(scope, input, caller, agentDeps, 'externalEvent.agent.subscribe')
      ),
    }),
    defineOperation({
      name: 'externalEvent.agent.unsubscribe',
      policy: { safetyClass: 'mutate', roles: AGENT_EVENT_ROLES },
      description: `Remove a long-horizon agent subscription for a topic glob, deleting the stored record and its live delivery-trie entry. Idempotent: removing a pattern the agent never subscribed to still succeeds. ${SCOPE_DOC}`,
      inputSchema: UnsubscribeInput,
      resultSchema: UnsubscribeResultSchema,
      execute: agentPipeline(
        'unsubscribe-agent-external-event',
        deps,
        admitAgentSubscriptionWriter,
        (scope, input: z.infer<typeof UnsubscribeInput>, caller, agentDeps) =>
          unsubscribeAgentTopic(scope, input, caller, agentDeps, 'externalEvent.agent.unsubscribe')
      ),
    }),
    defineOperation({
      name: 'externalEvent.agent.listSubscriptions',
      policy: { safetyClass: 'read', roles: AGENT_EVENT_ROLES },
      description:
        'List the external-event subscriptions of a long-horizon agent, oldest first, each with its source, topic glob, filter, and status. Returns { accepted: false, reason } on rejection: caller_denied for any other caller and agent_not_found when the agent is unknown or belongs to another Space.',
      inputSchema: ListInput,
      resultSchema: ListResultSchema,
      execute: agentPipeline(
        'list-agent-external-event-subscriptions',
        deps,
        admitAgentSubscriptionReader,
        listAgentSubscriptionTopics
      ),
    }),
  ];
}
