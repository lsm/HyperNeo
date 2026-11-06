import type { Session } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import type { SendStatus } from '../../storage/repositories/sdk-message-repository.ts';
import type { SessionEventSubscriptionRepository } from '../../storage/repositories/session-event-subscription-repository.ts';
import { buildPrEventTopicPattern, parseGitHubTopic, parsePrUrl } from '../github/parse-pr-url.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationCallerRole,
  type OperationDefinition,
} from '../operations/registry.ts';
import { ExternalEventSchema, ExternalEventStateSchema } from './event-schema.ts';
import { sessionEventMessageUuid } from './session-event-delivery.ts';
import type { SessionExternalEventStore } from './session-external-event-store.ts';
import { validateGlobPattern } from './topic-validator.ts';
import type { ExternalEventRecord } from './types.ts';

const RECENT_EVENT_WINDOW = 500;
const DEFAULT_DELIVERY_LIMIT = 50;
const MAX_DELIVERY_LIMIT = 200;
const SESSION_EVENT_ROLES: readonly OperationCallerRole[] = ['universal_read', 'neo'];

type OwnSubscriptions = Pick<
  SessionEventSubscriptionRepository,
  'upsert' | 'listBySession' | 'delete'
>;

interface OwnSubscriptionDependencies {
  subscriptions: OwnSubscriptions;
  watchSessionRepo?: (owner: string, repo: string) => Promise<string | null>;
}

export interface SessionEventDependencies extends OwnSubscriptionDependencies {
  events: Pick<SessionExternalEventStore, 'getById' | 'listRecent'>;
  getSession: (sessionId: string) => Session | null;
  deliveryJob: (messageUuid: string) => Job | null;
  sendStatus: (sessionId: string, messageUuid: string) => SendStatus | null;
}

export const OutcomeSchema = z.union([
  z.object({ ok: z.literal(true), topicPattern: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const StoredSubscriptionSchema = z.object({
  topic: z.string(),
  label: z.string().nullable(),
  createdAt: z.number(),
});

export const TopicFields = {
  topicPattern: z.string().min(1).optional(),
  prUrl: z.string().min(1).optional(),
};

export function resolveTopicPattern<Input extends { topicPattern?: string; prUrl?: string }>(
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
  if (parsed.host.toLowerCase() !== 'github.com') {
    ctx.addIssue({
      code: 'custom',
      message: `Only github.com pull requests can be followed: ${prUrl}`,
    });
    return z.NEVER;
  }
  return { ...rest, topicPattern: buildPrEventTopicPattern(parsed) };
}

export function githubRepoOfTopic(topic: string): { owner: string; repo: string } | null {
  const parsed = parseGitHubTopic(topic);
  if (!parsed || parsed.owner.includes('*') || parsed.repo.includes('*')) return null;
  return { owner: parsed.owner, repo: parsed.repo };
}

export function invalidPattern(topicPattern: string): Outcome | null {
  const validation = validateGlobPattern(topicPattern.trim());
  return validation.valid ? null : { ok: false, error: validation.reason ?? 'invalid pattern' };
}

export async function subscribeOwnSession(
  sessionId: string,
  input: { topicPattern: string; label?: string },
  deps: OwnSubscriptionDependencies
): Promise<Outcome | 'invalid_pattern'> {
  const topicPattern = input.topicPattern.trim();
  if (invalidPattern(topicPattern)) return 'invalid_pattern';
  deps.subscriptions.upsert({ sessionId, topic: topicPattern, label: input.label });
  const watched = githubRepoOfTopic(topicPattern);
  const failure = watched
    ? await deps
        .watchSessionRepo?.(watched.owner, watched.repo)
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    : null;
  return failure ? { ok: false, error: failure } : { ok: true, topicPattern };
}

export function unsubscribeOwnSession(
  sessionId: string,
  input: { topicPattern: string },
  deps: OwnSubscriptionDependencies
): Outcome | 'invalid_pattern' {
  const topicPattern = input.topicPattern.trim();
  if (invalidPattern(topicPattern)) return 'invalid_pattern';
  deps.subscriptions.delete(sessionId, topicPattern);
  return { ok: true, topicPattern };
}

export function listOwnSubscriptions(sessionId: string, deps: OwnSubscriptionDependencies) {
  return {
    ok: true as const,
    owner: { type: 'session' as const, id: sessionId },
    stored: deps.subscriptions
      .listBySession(sessionId)
      .map(({ topic, label, createdAt }) => ({ topic, label, createdAt })),
    scope: { spaceId: null },
  };
}

export function admitSessionCaller(
  caller: OperationCaller,
  deps: Pick<SessionEventDependencies, 'getSession'>
): { value: string } | { reason: 'caller_denied' | 'session_inactive' } {
  if (caller.source !== 'mcp' || !caller.sessionId) return { reason: 'caller_denied' };
  return deps.getSession(caller.sessionId)?.status === 'active'
    ? { value: caller.sessionId }
    : { reason: 'session_inactive' };
}

const DeliverySchema = z.object({
  eventId: z.string(),
  state: z.enum(['pending', 'delivered', 'failed']),
  failureReason: z.string().nullable(),
  event: z.object({
    topic: z.string(),
    source: z.string(),
    summary: z.string(),
    externalUrl: z.string().nullable(),
    occurredAt: z.number(),
  }),
});
type Delivery = z.infer<typeof DeliverySchema>;

const DeliveryListInput = z
  .object({
    state: z.enum(['pending', 'delivered', 'failed']).optional(),
    limit: z.number().int().min(1).max(MAX_DELIVERY_LIMIT).optional(),
  })
  .strict();

export function deliveryState(job: Job, sendStatus: SendStatus | null): Delivery['state'] {
  if (sendStatus === 'consumed') return 'delivered';
  return sendStatus === 'failed' || job.status === 'failed' || job.status === 'dead'
    ? 'failed'
    : 'pending';
}

function toDelivery(
  { event }: ExternalEventRecord,
  job: Job,
  sendStatus: SendStatus | null
): Delivery {
  const state = deliveryState(job, sendStatus);
  return {
    eventId: event.id,
    state,
    failureReason: state === 'failed' ? job.error : null,
    event: {
      topic: event.topic,
      source: event.source,
      summary: event.summary,
      externalUrl: event.externalUrl ?? null,
      occurredAt: event.occurredAt,
    },
  };
}

export function readSessionDeliveries(
  sessionId: string,
  input: z.infer<typeof DeliveryListInput>,
  deps: Pick<SessionEventDependencies, 'events' | 'deliveryJob' | 'sendStatus'>
) {
  const deliveries = deps.events.listRecent(RECENT_EVENT_WINDOW).flatMap((record) => {
    const messageUuid = sessionEventMessageUuid(record.event.id, sessionId);
    const job = deps.deliveryJob(messageUuid);
    return job ? [toDelivery(record, job, deps.sendStatus(sessionId, messageUuid))] : [];
  });
  return {
    deliveries: deliveries
      .filter((delivery) => !input.state || delivery.state === input.state)
      .slice(0, input.limit ?? DEFAULT_DELIVERY_LIMIT),
  };
}

export function readSessionEvent(
  sessionId: string,
  input: { eventId: string },
  deps: Pick<SessionEventDependencies, 'events' | 'deliveryJob'>,
  caller: OperationCaller
) {
  const record = deps.events.getById(input.eventId);
  const visible =
    caller.role === 'neo' || deps.deliveryJob(sessionEventMessageUuid(input.eventId, sessionId));
  return record && visible ? { event: record.event, state: record.state } : 'event_not_found';
}

function ownSessionPipeline<Input, Result>(
  name: string,
  deps: SessionEventDependencies,
  apply: (
    sessionId: string,
    input: Input,
    deps: SessionEventDependencies,
    caller: OperationCaller
  ) => Result
) {
  return (superpipe({ deps })(name) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitSessionCaller, ['caller', 'deps'], 'result:outcome')
    .pipe(apply, ['outcome', 'input', 'deps', 'caller'], 'outcome')
    .endAsync('outcome') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<Awaited<Result> | 'caller_denied' | 'session_inactive'>;
}

const REJECTIONS = z.enum(['caller_denied', 'session_inactive']);
const TopicRejections = z.enum(['caller_denied', 'session_inactive', 'invalid_pattern']);
const SubscribeInput = z
  .object({ ...TopicFields, label: z.string().optional() })
  .strict()
  .transform(resolveTopicPattern);
const UnsubscribeInput = z.object(TopicFields).strict().transform(resolveTopicPattern);
const SESSION_DOC =
  'The calling session is always the subject. Rejects session_inactive when that session is not active, and caller_denied for a caller with no session.';

export function createSessionEventOperations(
  deps: SessionEventDependencies
): OperationDefinition[] {
  return [
    defineOperation({
      name: 'event.external.subscribe',
      policy: { safetyClass: 'mutate', roles: SESSION_EVENT_ROLES },
      description: `Subscribe this session to external events matching a topic glob (e.g. github/lsm/neokai/pull_request/*.review_*), or pass prUrl instead of topicPattern to follow one GitHub pull request; exactly one of the two is required. Returns { ok, topicPattern }, or { ok: false, error } naming the repo when its watch could not start; the subscription is kept, so subscribing again retries the watch. ${SESSION_DOC}`,
      inputSchema: SubscribeInput,
      resultSchema: z.union([OutcomeSchema, TopicRejections]),
      execute: ownSessionPipeline('subscribe-session-event', deps, subscribeOwnSession),
    }),
    defineOperation({
      name: 'event.external.unsubscribe',
      policy: { safetyClass: 'mutate', roles: SESSION_EVENT_ROLES },
      description: `Remove this session's subscription for a topic glob, or for the pull request named by prUrl; exactly one of the two is required. Idempotent. ${SESSION_DOC}`,
      inputSchema: UnsubscribeInput,
      resultSchema: z.union([OutcomeSchema, TopicRejections]),
      execute: ownSessionPipeline('unsubscribe-session-event', deps, unsubscribeOwnSession),
    }),
    defineOperation({
      name: 'event.external.subscription.list',
      policy: { safetyClass: 'read', roles: SESSION_EVENT_ROLES },
      description: `List this session's stored external-event subscriptions as { ok, owner, stored }. ${SESSION_DOC}`,
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([
        z.object({
          ok: z.literal(true),
          owner: z.object({ type: z.literal('session'), id: z.string() }),
          stored: z.array(StoredSubscriptionSchema),
          scope: z.object({ spaceId: z.null() }),
        }),
        REJECTIONS,
      ]),
      execute: ownSessionPipeline('list-session-event-subscriptions', deps, (sessionId) =>
        listOwnSubscriptions(sessionId, deps)
      ),
    }),
    defineOperation({
      name: 'event.external.get',
      policy: { safetyClass: 'read', roles: SESSION_EVENT_ROLES },
      description: `Fetch the full raw record for one external event by id, the on-demand counterpart to the lean summary injected as a message. Rejects event_not_found when the id is unknown or the event was not delivered to this session; Neo can read any event. ${SESSION_DOC}`,
      inputSchema: z.object({ eventId: z.string().min(1) }).strict(),
      resultSchema: z.union([
        z.object({ event: ExternalEventSchema, state: ExternalEventStateSchema }),
        z.enum(['caller_denied', 'session_inactive', 'event_not_found']),
      ]),
      execute: ownSessionPipeline('get-session-event', deps, readSessionEvent),
    }),
    defineOperation({
      name: 'event.external.delivery.list',
      policy: { safetyClass: 'read', roles: SESSION_EVENT_ROLES },
      description: `List the external events delivered to this session, newest first, with each delivery's state: delivered once the session consumed the message, pending while it waits. Covers the ${RECENT_EVENT_WINDOW} most recent events while their mailbox jobs are retained. ${SESSION_DOC}`,
      inputSchema: DeliveryListInput,
      resultSchema: z.union([z.object({ deliveries: z.array(DeliverySchema) }), REJECTIONS]),
      execute: ownSessionPipeline('list-session-event-deliveries', deps, readSessionDeliveries),
    }),
  ];
}
