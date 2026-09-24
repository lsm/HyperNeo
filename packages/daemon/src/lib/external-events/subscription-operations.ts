import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { buildPrEventTopicPattern, parsePrUrl } from '../github/parse-pr-url.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import type { SpaceSessionEventSubscriptionRepository } from '../../storage/repositories/space-session-event-subscription-repository.ts';
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
  sessionSubscriptions: Pick<
    SpaceSessionEventSubscriptionRepository,
    'upsert' | 'listBySpace' | 'delete'
  >;
  refreshSessionSubscription: (spaceId: string, subscriptionId: string) => RunOutcome;
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
  z.object({ type: z.literal('session') }).strict(),
]);
type Subject = z.infer<typeof SubjectSchema>;

export type SubscriptionSubject =
  | { kind: 'node'; slot: SubscriptionSlot }
  | { kind: 'agent'; scope: AgentSubscriptionScope }
  | { kind: 'session'; spaceId: string; sessionId: string };

function resolveTopicPattern<Input extends { topicPattern?: string; prUrl?: string }>(
  input: Input,
  ctx: z.RefinementCtx
): Omit<Input, 'prUrl' | 'topicPattern'> & { topicPattern: string } {
  const { prUrl, topicPattern, ...rest } = input;
  if ((topicPattern === undefined) === (prUrl === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Pass exactly one of topicPattern or prUrl.' });
    return z.NEVER;
  }
  if (topicPattern !== undefined) return { ...rest, topicPattern };
  const parsed = parsePrUrl(prUrl ?? '');
  if (!parsed) {
    ctx.addIssue({ code: 'custom', message: `Could not parse GitHub PR URL: ${prUrl}` });
    return z.NEVER;
  }
  return { ...rest, topicPattern: buildPrEventTopicPattern(parsed) };
}

const TopicFields = {
  topicPattern: z.string().min(1).optional(),
  prUrl: z.string().min(1).optional(),
};

const SubscribeInput = z
  .object({
    ...TopicFields,
    label: z.string().optional(),
    subject: SubjectSchema.optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict()
  .transform(resolveTopicPattern);
const UnsubscribeInput = z
  .object({
    ...TopicFields,
    subject: SubjectSchema.optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict()
  .transform(resolveTopicPattern);
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

export function defaultSubject(
  caller: OperationCaller,
  subs: SubscriptionDependencies
): Subject | null {
  if (caller.role === 'direct_task_worker') return { type: 'session' };
  if (caller.role !== 'long_term_agent') return { type: 'node' };
  const session = caller.sessionId ? subs.getSession(caller.sessionId) : null;
  const agentId = session?.metadata.promptProvenance?.agentId;
  return agentId ? { type: 'agent', agentId } : null;
}

export function resolveSubscriptionSubject(
  spaceId: string,
  input: { subject?: Subject },
  caller: OperationCaller,
  subs: SubscriptionDependencies
): { value: SubscriptionSubject } | { reason: SubjectRejection } {
  const subject = input.subject ?? defaultSubject(caller, subs);
  if (!subject) return { reason: 'agent_not_found' };
  if (subject.type === 'node') {
    const slot = resolveWriterSlot(caller, subs);
    return 'reason' in slot ? slot : { value: { kind: 'node', slot: slot.value } };
  }
  if (subject.type === 'session') {
    return caller.sessionId
      ? { value: { kind: 'session', spaceId, sessionId: caller.sessionId } }
      : { reason: 'caller_denied' };
  }
  const gated = gateAgentSubscription(spaceId, { agent_id: subject.agentId }, subs);
  return 'reason' in gated
    ? { reason: 'agent_not_found' }
    : { value: { kind: 'agent', scope: gated.value } };
}

type ReaderScope =
  | { spaceId: string; workflowRunId: string }
  | { spaceId: string; owner: { type: 'agent' | 'session'; id: string } };

const StoredSubscriptionSchema = z.object({
  topic: z.string(),
  label: z.string().nullable(),
  createdAt: z.number(),
});

function readStoredSubscriptions(
  scope: { spaceId: string; owner: { type: 'agent' | 'session'; id: string } },
  subs: SubscriptionDependencies
) {
  const rows =
    scope.owner.type === 'agent'
      ? subs.subscriptionRepo.listSubscriptions(scope.owner.id).map((row) => ({
          topic: row.topic,
          label: typeof row.filter.label === 'string' ? row.filter.label : null,
          createdAt: row.createdAt,
        }))
      : subs.sessionSubscriptions
          .listBySpace(scope.spaceId)
          .filter((row) => row.sessionId === scope.owner.id)
          .map((row) => ({ topic: row.topic, label: row.label, createdAt: row.createdAt }));
  return { ok: true as const, owner: scope.owner, stored: rows, scope: { spaceId: scope.spaceId } };
}

export function admitSubscriptionReader(
  input: z.infer<typeof ListInput>,
  caller: OperationCaller,
  subs: SubscriptionDependencies
): { value: ReaderScope } | { reason: Rejection } {
  const space = admitEventCallerSpace(input, caller);
  if ('reason' in space) return { reason: 'caller_denied' };
  if (input.workflowRunId === undefined && caller.role !== 'workflow_worker') {
    const subject = defaultSubject(caller, subs);
    if (subject?.type === 'agent') {
      return { value: { spaceId: space.value, owner: { type: 'agent', id: subject.agentId } } };
    }
    if (subject?.type === 'session' && caller.sessionId) {
      return { value: { spaceId: space.value, owner: { type: 'session', id: caller.sessionId } } };
    }
  }
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

function subscribeSession(
  subject: { spaceId: string; sessionId: string },
  input: { topicPattern: string; label?: string },
  subs: SubscriptionDependencies
): Outcome | SubjectRejection {
  const topicPattern = input.topicPattern.trim();
  if (invalidPattern(topicPattern)) return 'invalid_pattern';
  const stored = subs.sessionSubscriptions.upsert({
    spaceId: subject.spaceId,
    sessionId: subject.sessionId,
    topic: topicPattern,
    label: input.label,
  });
  const refreshed = subs.refreshSessionSubscription(subject.spaceId, stored.id);
  return refreshed.success ? { ok: true, topicPattern } : 'refresh_failed';
}

function unsubscribeSession(
  subject: { spaceId: string; sessionId: string },
  input: { topicPattern: string },
  subs: SubscriptionDependencies
): Outcome | SubjectRejection {
  const topicPattern = input.topicPattern.trim();
  if (invalidPattern(topicPattern)) return 'invalid_pattern';
  const stored = subs.sessionSubscriptions
    .listBySpace(subject.spaceId)
    .find((row) => row.sessionId === subject.sessionId && row.topic === topicPattern);
  if (stored) {
    subs.sessionSubscriptions.delete(stored.id);
    subs.refreshSessionSubscription(subject.spaceId, stored.id);
  }
  return { ok: true, topicPattern };
}

function subscribeSubject(
  subject: SubscriptionSubject,
  input: z.infer<typeof SubscribeInput>,
  caller: OperationCaller,
  subs: SubscriptionDependencies
): Outcome | AgentSubscribeOutcome | SubjectRejection {
  if (subject.kind === 'node') return subscribeTopic(subject.slot, input, subs);
  if (subject.kind === 'session') return subscribeSession(subject, input, subs);
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
  if (subject.kind === 'session') return unsubscribeSession(subject, input, subs);
  const result = unsubscribeAgentTopic(
    subject.scope,
    { agent_id: subject.scope.agentId, topic_pattern: input.topicPattern },
    caller,
    subs,
    'event.external.unsubscribe'
  );
  return 'accepted' in result ? result.reason : result;
}

function readSubscriptions(
  scope: ReaderScope,
  input: z.infer<typeof ListInput>,
  subs: SubscriptionDependencies
) {
  if ('owner' in scope) return readStoredSubscriptions(scope, subs);
  const outcome = subs.listRunSubscriptions(scope.workflowRunId, scope.spaceId, input.nodeId);
  return outcome.success
    ? { ok: true as const, subscriptions: outcome.result, scope: { spaceId: scope.spaceId } }
    : { ok: false as const, error: outcome.error };
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

const SUBJECT_DOC =
  'subject names what the subscription is recorded against and defaults to the caller itself: a long-horizon agent\'s own record, a direct task worker\'s own session ({ type: "session" }), otherwise { type: "node" }. For the node subject the slot (workflow run, node, agent, task) is resolved from the calling session and never from input, so a worker can only change its own subscriptions. For { type: "agent", agentId } the target long-horizon agent must belong to the caller Space, which is derived from the calling session; an omitted spaceId defaults to that Space. Rejections are returned as a bare reason: caller_denied for a caller with no Space scope or one naming another Space, session_inactive when the calling session is not active in that Space, node_unresolved when no node execution backs a node-subject caller, agent_not_found when the named agent is unknown or belongs to another Space, and invalid_pattern when topicPattern is not a valid topic glob.';

const SUBSCRIPTION_ROLES = [
  ...NODE_EVENT_ROLES,
  ...AGENT_EVENT_ROLES,
  'direct_task_worker' as const,
];

export function createSubscriptionOperations(
  subs: SubscriptionDependencies
): OperationDefinition[] {
  return [
    defineOperation({
      name: 'event.external.subscribe',
      policy: { safetyClass: 'mutate', roles: SUBSCRIPTION_ROLES },
      description: `Subscribe a subject to external events matching a topic glob (e.g. github/lsm/neokai/pull_request/*.review_*), or pass prUrl instead of topicPattern to follow one GitHub pull request; exactly one of the two is required. A node subject registers the calling worker slot on its workflow run and returns { ok, topicPattern }; an agent subject upserts the stored long-horizon subscription, refreshes the live delivery trie, and returns the same { ok, topicPattern } with the stored record under subscription, rejecting refresh_failed when the trie could not be refreshed. Both subjects answer in the same shape, so a caller reads ok without knowing which subject it passed. ${SUBJECT_DOC}`,
      inputSchema: SubscribeInput,
      resultSchema: z.union([AgentSubscribeOutcomeSchema, OutcomeSchema, SUBJECT_REJECTIONS]),
      execute: subjectPipeline('subscribe-external-event', subs, subscribeSubject),
    }),
    defineOperation({
      name: 'event.external.unsubscribe',
      policy: { safetyClass: 'mutate', roles: SUBSCRIPTION_ROLES },
      description: `Remove a subject external-event subscription for a topic glob, or for the pull request named by prUrl; exactly one of the two is required. A node subject drops the calling worker registration on its workflow run; an agent subject deletes the stored long-horizon record and its live delivery-trie entry, and is idempotent when the agent never subscribed to that pattern. ${SUBJECT_DOC}`,
      inputSchema: UnsubscribeInput,
      resultSchema: z.union([OutcomeSchema, SUBJECT_REJECTIONS]),
      execute: subjectPipeline('unsubscribe-external-event', subs, unsubscribeSubject),
    }),
    defineOperation({
      name: 'event.external.subscription.list',
      policy: { safetyClass: 'read', roles: SUBSCRIPTION_ROLES },
      description:
        'Snapshot a workflow run external-event subscriptions across the declared, persisted, and active layers, with the mismatch counts between them. Defaults to the calling worker own run. A long-horizon agent or direct task worker with no workflowRunId gets its own stored subscriptions as { ok, owner, stored }. Rejects caller_denied when the caller carries no Space scope and node_unresolved when no run can be determined.',
      inputSchema: ListInput,
      resultSchema: z.union([
        z.object({
          ok: z.literal(true),
          subscriptions: SubscriptionListSchema,
          scope: z.object({ spaceId: z.string() }),
        }),
        z.object({
          ok: z.literal(true),
          owner: z.object({ type: z.enum(['agent', 'session']), id: z.string() }),
          stored: z.array(StoredSubscriptionSchema),
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
