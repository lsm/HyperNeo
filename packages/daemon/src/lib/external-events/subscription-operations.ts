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
  admitEventCallerSpace,
  callerSessionActiveIn,
  type EventCallerDependencies,
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

export interface SubscriptionDependencies extends EventCallerDependencies {
  registerSubscription: (slot: SubscriptionSlot, topicPattern: string) => RunOutcome;
  unregisterSubscription: (slot: SubscriptionSlot, topicPattern: string) => RunOutcome;
  listRunSubscriptions: (workflowRunId: string, spaceId: string, nodeId?: string) => ListOutcome;
  resolvePrimaryLinkUrl: (workflowRunId: string) => string;
}

const REJECTIONS = z.enum(['caller_denied', 'session_inactive', 'node_unresolved']);
type Rejection = z.infer<typeof REJECTIONS>;

const OutcomeSchema = z.union([
  z.object({ ok: z.literal(true), topicPattern: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
type Outcome = z.infer<typeof OutcomeSchema>;

const SubscribeInput = z
  .object({ topicPattern: z.string().min(1), label: z.string().optional() })
  .strict();
const UnsubscribeInput = z.object({ topicPattern: z.string().min(1) }).strict();
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

export function admitSubscriptionWriter(
  input: { spaceId?: string },
  caller: OperationCaller,
  subs: SubscriptionDependencies
): { value: SubscriptionSlot } | { reason: Rejection } {
  const space = admitEventCallerSpace(input, caller, NODE_EVENT_ROLES);
  if ('reason' in space) return { reason: 'caller_denied' };
  if (!callerSessionActiveIn(caller, space.value, subs)) return { reason: 'session_inactive' };
  const slot = resolveWorkerNodeSlot(caller, subs);
  return slot?.taskId ? { value: { ...slot, taskId: slot.taskId } } : { reason: 'node_unresolved' };
}

export function admitSubscriptionReader(
  input: z.infer<typeof ListInput>,
  caller: OperationCaller,
  subs: SubscriptionDependencies
): { value: { spaceId: string; workflowRunId: string } } | { reason: Rejection } {
  const space = admitEventCallerSpace(input, caller, NODE_EVENT_ROLES);
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
    ? { ok: true as const, subscriptions: outcome.result }
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

const SLOT_DOC =
  'The subscribing slot (workflow run, node, agent, task) is resolved from the calling session, never from input, so only an active workflow worker can change its own subscriptions. Rejects caller_denied for any other caller, session_inactive when that session is not active in its Space, and node_unresolved when no node execution backs it.';

export function createSubscriptionOperations(
  subs: SubscriptionDependencies
): OperationDefinition[] {
  return [
    defineOperation({
      name: 'externalEvent.subscribe',
      policy: { safetyClass: 'mutate', roles: NODE_EVENT_ROLES },
      description: `Subscribe this node-agent session to external events matching a topic glob (e.g. github/lsm/neokai/pull_request/*.review_*). ${SLOT_DOC}`,
      inputSchema: SubscribeInput,
      resultSchema: z.union([OutcomeSchema, REJECTIONS]),
      execute: writePipeline('subscribe-external-event', subs, subscribeTopic),
    }),
    defineOperation({
      name: 'externalEvent.unsubscribe',
      policy: { safetyClass: 'mutate', roles: NODE_EVENT_ROLES },
      description: `Remove this session external-event subscription for a topic pattern. ${SLOT_DOC}`,
      inputSchema: UnsubscribeInput,
      resultSchema: z.union([OutcomeSchema, REJECTIONS]),
      execute: writePipeline('unsubscribe-external-event', subs, unsubscribeTopic),
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
      name: 'externalEvent.listSubscriptions',
      policy: { safetyClass: 'read', roles: NODE_EVENT_ROLES },
      description:
        'Snapshot a workflow run external-event subscriptions across the declared, persisted, and active layers, with the mismatch counts between them. Defaults to the calling worker own run. Rejects caller_denied when the caller is not a workflow worker in that Space and node_unresolved when no run can be determined.',
      inputSchema: ListInput,
      resultSchema: z.union([
        z.object({ ok: z.literal(true), subscriptions: SubscriptionListSchema }),
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
