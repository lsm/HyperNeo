import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { buildPrEventTopicPattern, parsePrUrl } from '../github/parse-pr-url.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import {
  type AgentSubscriptionDependencies,
  type AgentSubscriptionScope,
  gateAgentSubscription,
  subscribeAgentTopic,
  SubscriptionRecordSchema,
  unsubscribeAgentTopic,
} from './agent-subscription-operations.ts';
import {
  admitEventCallerSpace,
  AGENT_EVENT_ROLES,
  callerSessionActiveIn,
  NODE_EVENT_ROLES,
  resolveWorkerNodeSlot,
  type WorkerNodeSlot,
} from './operation-admission.ts';
import { validateGlobPattern } from './topic-validator.ts';

export interface SubscriptionSlot extends Omit<WorkerNodeSlot, 'taskId'> {
  taskId: string;
}

type RunOutcome = { success: boolean; error?: string };
type ListOutcome = ReturnType<SpaceRuntimeService['listSubscriptions']>;
type SubscriptionList = Extract<ListOutcome, { success: true }>['result'];

export interface SubscriptionDependencies extends AgentSubscriptionDependencies {
  registerSubscription: (slot: SubscriptionSlot, topicPattern: string) => RunOutcome;
  unregisterSubscription: (slot: SubscriptionSlot, topicPattern: string) => RunOutcome;
  listRunSubscriptions: (workflowRunId: string, spaceId: string, nodeId?: string) => ListOutcome;
  resolvePrimaryLinkUrl: (workflowRunId: string) => string;
}

const REJECTIONS = z.enum(['caller_denied', 'session_inactive', 'node_unresolved']);
type Rejection = z.infer<typeof REJECTIONS>;

const SUBJECT_REJECTIONS = z.enum([
  'caller_denied',
  'session_inactive',
  'node_unresolved',
  'agent_not_found',
  'invalid_pattern',
  'refresh_failed',
]);
type SubjectRejection = z.infer<typeof SUBJECT_REJECTIONS>;

const OutcomeSchema = z.union([
  z.object({ ok: z.literal(true), topicPattern: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
type Outcome = z.infer<typeof OutcomeSchema>;

const AgentSubscribeOutcomeSchema = z.object({
  ok: z.literal(true),
  topicPattern: z.string(),
  subscription: SubscriptionRecordSchema,
});
type AgentSubscribeOutcome = z.infer<typeof AgentSubscribeOutcomeSchema>;

const SubjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('node') }).strict(),
  z.object({ type: z.literal('agent'), agentId: z.string().min(1) }).strict(),
]);
type Subject = z.infer<typeof SubjectSchema>;

export type SubscriptionSubject =
  | { kind: 'node'; slot: SubscriptionSlot }
  | { kind: 'agent'; scope: AgentSubscriptionScope };

const SubscribeInput = z
  .object({
    topicPattern: z.string().min(1),
    label: z.string().optional(),
    subject: SubjectSchema.optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict();
const UnsubscribeInput = z
  .object({
    topicPattern: z.string().min(1),
    subject: SubjectSchema.optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict();
const PrInput = z.object({ prUrl: z.string().optional(), label: z.string().optional() }).strict();
const ListInput = z
  .object({
    workflowRunId: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict();

const DeclaredSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  agentName: z.string(),
  topic: z.string().nullable(),
  topicFrom: z.object({ source: z.literal('primaryLink'), pattern: z.string() }).nullable(),
  label: z.string().nullable(),
  active: z.boolean(),
});

const PersistedSchema = z.object({
  nodeId: z.string(),
  agentName: z.string(),
  taskId: z.string(),
  topic: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  active: z.boolean(),
});

const ActiveSchema = z.object({
  nodeId: z.string(),
  agentName: z.string(),
  taskId: z.string(),
  topic: z.string(),
  subscriptionKind: z.enum(['static', 'dynamic']),
  source: z.enum(['declared', 'persisted', 'orphan', 'unknown']),
});

const SubscriptionListSchema = z.object({
  workflowRunId: z.string(),
  nodeId: z.string().nullable(),
  definitionResolved: z.boolean(),
  declared: z.array(DeclaredSchema),
  persisted: z.array(PersistedSchema),
  active: z.array(ActiveSchema),
  mismatches: z.object({
    declaredNotActive: z.number(),
    persistedNotActive: z.number(),
    orphanActive: z.number(),
  }),
}) satisfies z.ZodType<SubscriptionList>;

export function admitSubscriptionSpace(
  input: { spaceId?: string },
  caller: OperationCaller,
  subs: SubscriptionDependencies
): { value: string } | { reason: 'caller_denied' | 'session_inactive' } {
  const space = admitEventCallerSpace(input, caller);
  if ('reason' in space) return { reason: 'caller_denied' };
  return callerSessionActiveIn(caller, space.value, subs)
    ? { value: space.value }
    : { reason: 'session_inactive' };
}

function resolveWriterSlot(
  caller: OperationCaller,
  subs: SubscriptionDependencies
): { value: SubscriptionSlot } | { reason: 'node_unresolved' } {
  const slot = resolveWorkerNodeSlot(caller, subs);
  return slot?.taskId ? { value: { ...slot, taskId: slot.taskId } } : { reason: 'node_unresolved' };
}

export function admitSubscriptionWriter(
  input: { spaceId?: string },
  caller: OperationCaller,
  subs: SubscriptionDependencies
): { value: SubscriptionSlot } | { reason: Rejection } {
  const space = admitSubscriptionSpace(input, caller, subs);
  return 'reason' in space ? space : resolveWriterSlot(caller, subs);
}

export function resolveSubscriptionSubject(
  spaceId: string,
  input: { subject?: Subject },
  caller: OperationCaller,
  subs: SubscriptionDependencies
): { value: SubscriptionSubject } | { reason: SubjectRejection } {
  const subject: Subject = input.subject ?? { type: 'node' };
  if (subject.type === 'node') {
    const slot = resolveWriterSlot(caller, subs);
    return 'reason' in slot ? slot : { value: { kind: 'node', slot: slot.value } };
  }
  const gated = gateAgentSubscription(spaceId, { agent_id: subject.agentId }, subs);
  return 'reason' in gated
    ? { reason: 'agent_not_found' }
    : { value: { kind: 'agent', scope: gated.value } };
}

export function admitSubscriptionReader(
  input: z.infer<typeof ListInput>,
  caller: OperationCaller,
  subs: SubscriptionDependencies
): { value: { spaceId: string; workflowRunId: string } } | { reason: Rejection } {
  const space = admitEventCallerSpace(input, caller);
  if ('reason' in space) return { reason: 'caller_denied' };
  const workflowRunId = input.workflowRunId ?? resolveWorkerNodeSlot(caller, subs)?.workflowRunId;
  return workflowRunId
    ? { value: { spaceId: space.value, workflowRunId } }
    : { reason: 'node_unresolved' };
}

function applyOutcome(topicPattern: string, outcome: RunOutcome): Outcome {
  return outcome.success
    ? { ok: true, topicPattern }
    : { ok: false, error: outcome.error ?? 'Subscription rejected.' };
}

function invalidPattern(topicPattern: string): Outcome | null {
  const validation = validateGlobPattern(topicPattern.trim());
  return validation.valid ? null : { ok: false, error: validation.reason ?? 'invalid pattern' };
}

function subscribeTopic(
  slot: SubscriptionSlot,
  input: z.infer<typeof SubscribeInput>,
  subs: SubscriptionDependencies
): Outcome {
  const invalid = invalidPattern(input.topicPattern);
  if (invalid) return invalid;
  try {
    return applyOutcome(input.topicPattern, subs.registerSubscription(slot, input.topicPattern));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function unsubscribeTopic(
  slot: SubscriptionSlot,
  input: z.infer<typeof UnsubscribeInput>,
  subs: SubscriptionDependencies
): Outcome {
  const invalid = invalidPattern(input.topicPattern);
  if (invalid) return invalid;
  return applyOutcome(input.topicPattern, subs.unregisterSubscription(slot, input.topicPattern));
}

function subscribeSubject(
  subject: SubscriptionSubject,
  input: z.infer<typeof SubscribeInput>,
  caller: OperationCaller,
  subs: SubscriptionDependencies
): Outcome | AgentSubscribeOutcome | SubjectRejection {
  if (subject.kind === 'node') return subscribeTopic(subject.slot, input, subs);
  const result = subscribeAgentTopic(
    subject.scope,
    {
      agent_id: subject.scope.agentId,
      topic_pattern: input.topicPattern,
      label: input.label,
    },
    caller,
    subs,
    'event.external.subscribe'
  );
  if ('accepted' in result) return result.reason;
  return { ok: true, topicPattern: result.subscription.topic, subscription: result.subscription };
}

function unsubscribeSubject(
  subject: SubscriptionSubject,
  input: z.infer<typeof UnsubscribeInput>,
  caller: OperationCaller,
  subs: SubscriptionDependencies
): Outcome | SubjectRejection {
  if (subject.kind === 'node') return unsubscribeTopic(subject.slot, input, subs);
  const result = unsubscribeAgentTopic(
    subject.scope,
    { agent_id: subject.scope.agentId, topic_pattern: input.topicPattern },
    caller,
    subs,
    'event.external.unsubscribe'
  );
  return 'accepted' in result ? result.reason : result;
}

function subscribePrEvents(
  slot: SubscriptionSlot,
  input: z.infer<typeof PrInput>,
  subs: SubscriptionDependencies
): Outcome {
  const prUrl = input.prUrl || subs.resolvePrimaryLinkUrl(slot.workflowRunId) || '';
  const parsed = prUrl ? parsePrUrl(prUrl) : null;
  if (!parsed) {
    return {
      ok: false,
      error: input.prUrl
        ? `Could not parse GitHub PR URL: ${input.prUrl}`
        : 'No PR URL found for this workflow run. Open a PR first or pass prUrl explicitly.',
    };
  }
  const topicPattern = buildPrEventTopicPattern(parsed);
  try {
    return applyOutcome(topicPattern, subs.registerSubscription(slot, topicPattern));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readSubscriptions(
  scope: { spaceId: string; workflowRunId: string },
  input: z.infer<typeof ListInput>,
  subs: SubscriptionDependencies
) {
  const outcome = subs.listRunSubscriptions(scope.workflowRunId, scope.spaceId, input.nodeId);
  return outcome.success
    ? { ok: true as const, subscriptions: outcome.result, scope: { spaceId: scope.spaceId } }
    : { ok: false as const, error: outcome.error };
}

function writePipeline<Input, Result>(
  name: string,
  subs: SubscriptionDependencies,
  apply: (slot: SubscriptionSlot, input: Input, subs: SubscriptionDependencies) => Result
) {
  return (superpipe({ subs })(name) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitSubscriptionWriter, ['input', 'caller', 'subs'], 'result:outcome')
    .pipe(apply, ['outcome', 'input', 'subs'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result | Rejection>;
}

function subjectPipeline<Input extends { subject?: Subject }, Result>(
  name: string,
  subs: SubscriptionDependencies,
  apply: (
    subject: SubscriptionSubject,
    input: Input,
    caller: OperationCaller,
    subs: SubscriptionDependencies
  ) => Result
) {
  return (superpipe({ subs })(name) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitSubscriptionSpace, ['input', 'caller', 'subs'], 'result:outcome')
    .pipe(resolveSubscriptionSubject, ['outcome', 'input', 'caller', 'subs'], 'result:outcome')
    .pipe(apply, ['outcome', 'input', 'caller', 'subs'], 'outcome')
    .endAsync('outcome') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<Result | SubjectRejection>;
}

const SLOT_DOC =
  'The subscribing slot (workflow run, node, agent, task) is resolved from the calling session, never from input, so only an active workflow worker can change its own subscriptions. Rejects caller_denied for any other caller, session_inactive when that session is not active in its Space, and node_unresolved when no node execution backs it.';

const SUBJECT_DOC =
  'subject names what the subscription is recorded against and defaults to { type: "node" }. For the node subject the slot (workflow run, node, agent, task) is resolved from the calling session and never from input, so a worker can only change its own subscriptions. For { type: "agent", agentId } the target long-horizon agent must belong to the caller Space, which is derived from the calling session; an omitted spaceId defaults to that Space. Rejections are returned as a bare reason: caller_denied for a caller with no Space scope or one naming another Space, session_inactive when the calling session is not active in that Space, node_unresolved when no node execution backs a node-subject caller, agent_not_found when the named agent is unknown or belongs to another Space, and invalid_pattern when topicPattern is not a valid topic glob.';

const SUBSCRIPTION_ROLES = [...NODE_EVENT_ROLES, ...AGENT_EVENT_ROLES];

export function createSubscriptionOperations(
  subs: SubscriptionDependencies
): OperationDefinition[] {
  return [
    defineOperation({
      name: 'event.external.subscribe',
      policy: { safetyClass: 'mutate', roles: SUBSCRIPTION_ROLES },
      description: `Subscribe a subject to external events matching a topic glob (e.g. github/lsm/neokai/pull_request/*.review_*). A node subject registers the calling worker slot on its workflow run and returns { ok, topicPattern }; an agent subject upserts the stored long-horizon subscription, refreshes the live delivery trie, and returns the same { ok, topicPattern } with the stored record under subscription, rejecting refresh_failed when the trie could not be refreshed. Both subjects answer in the same shape, so a caller reads ok without knowing which subject it passed. ${SUBJECT_DOC}`,
      inputSchema: SubscribeInput,
      resultSchema: z.union([AgentSubscribeOutcomeSchema, OutcomeSchema, SUBJECT_REJECTIONS]),
      execute: subjectPipeline('subscribe-external-event', subs, subscribeSubject),
    }),
    defineOperation({
      name: 'event.external.unsubscribe',
      policy: { safetyClass: 'mutate', roles: SUBSCRIPTION_ROLES },
      description: `Remove a subject external-event subscription for a topic glob. A node subject drops the calling worker registration on its workflow run; an agent subject deletes the stored long-horizon record and its live delivery-trie entry, and is idempotent when the agent never subscribed to that pattern. ${SUBJECT_DOC}`,
      inputSchema: UnsubscribeInput,
      resultSchema: z.union([OutcomeSchema, SUBJECT_REJECTIONS]),
      execute: subjectPipeline('unsubscribe-external-event', subs, unsubscribeSubject),
    }),
    defineOperation({
      name: 'subscribe_pr_events',
      policy: { safetyClass: 'mutate', roles: NODE_EVENT_ROLES },
      description: `Subscribe to GitHub PR events scoped to this run's PR, or to an explicit prUrl when the PR is not recorded on the run yet. ${SLOT_DOC}`,
      inputSchema: PrInput,
      resultSchema: z.union([OutcomeSchema, REJECTIONS]),
      execute: writePipeline('subscribe-pr-events', subs, subscribePrEvents),
    }),
    defineOperation({
      name: 'event.external.subscription.list',
      policy: { safetyClass: 'read', roles: NODE_EVENT_ROLES },
      description:
        'Snapshot a workflow run external-event subscriptions across the declared, persisted, and active layers, with the mismatch counts between them. Defaults to the calling worker own run. Rejects caller_denied when the caller carries no Space scope and node_unresolved when no run can be determined.',
      inputSchema: ListInput,
      resultSchema: z.union([
        z.object({
          ok: z.literal(true),
          subscriptions: SubscriptionListSchema,
          scope: z.object({ spaceId: z.string() }),
        }),
        z.object({ ok: z.literal(false), error: z.string() }),
        REJECTIONS,
      ]),
      execute: (superpipe({ subs })('list-external-event-subscriptions') as PipelineAPI)
        .input(['input', 'caller'])
        .pipe(admitSubscriptionReader, ['input', 'caller', 'subs'], 'result:outcome')
        .pipe(readSubscriptions, ['outcome', 'input', 'subs'], 'outcome')
        .endAsync('outcome') as (
        input: z.infer<typeof ListInput>,
        caller: OperationCaller
      ) => Promise<unknown>,
    }),
  ];
}
