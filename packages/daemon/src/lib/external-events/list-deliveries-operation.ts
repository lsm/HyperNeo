import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { ExternalEventStore } from './external-event-store.ts';
import { ExternalEventStateSchema } from './get-event-operation.ts';
import {
  admitEventCallerSpace,
  type EventCallerDependencies,
  type EventCallerRejection,
  NODE_EVENT_ROLES,
  resolveWorkerNodeSlot,
} from './operation-admission.ts';

const DEFAULT_DELIVERY_LIMIT = 50;
const MAX_DELIVERY_LIMIT = 200;

const inputSchema = z
  .object({
    workflowRunId: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    state: z.enum(['pending', 'delivered', 'failed']).optional(),
    limit: z.number().int().min(1).max(MAX_DELIVERY_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict();

const DeliverySchema = z.object({
  eventId: z.string(),
  deliveryKey: z.string(),
  workflowRunId: z.string(),
  taskId: z.string(),
  nodeId: z.string(),
  agentName: z.string(),
  state: z.enum(['pending', 'delivered', 'failed']),
  failureReason: z.string().nullable(),
  deliveredAt: z.number().nullable(),
  updatedAt: z.number(),
  event: z.object({
    topic: z.string(),
    source: z.string(),
    summary: z.string(),
    externalUrl: z.string().nullable(),
    occurredAt: z.number(),
    state: ExternalEventStateSchema,
  }),
});

type Input = z.infer<typeof inputSchema>;
type Rejection = EventCallerRejection | 'run_unresolved';
type Result = { deliveries: z.infer<typeof DeliverySchema>[] } | Rejection;

export interface ListDeliveriesDependencies extends EventCallerDependencies {
  eventStore: Pick<ExternalEventStore, 'listDeliveryLog'>;
}

interface DeliveryScope {
  spaceId: string;
  workflowRunId: string;
}

export function admitDeliveryReader(input: Input, caller: OperationCaller) {
  return admitEventCallerSpace(input, caller, NODE_EVENT_ROLES);
}

export function resolveDeliveryScope(
  spaceId: string,
  input: Input,
  events: ListDeliveriesDependencies,
  caller: OperationCaller
): { value: DeliveryScope } | { reason: Rejection } {
  const workflowRunId = input.workflowRunId ?? resolveWorkerNodeSlot(caller, events)?.workflowRunId;
  return workflowRunId ? { value: { spaceId, workflowRunId } } : { reason: 'run_unresolved' };
}

export function readDeliveryLog(
  scope: DeliveryScope,
  input: Input,
  events: ListDeliveriesDependencies
): Result {
  const records = events.eventStore.listDeliveryLog({
    spaceId: scope.spaceId,
    workflowRunId: scope.workflowRunId,
    nodeId: input.nodeId,
    status: input.state,
    limit: Math.min(input.limit ?? DEFAULT_DELIVERY_LIMIT, MAX_DELIVERY_LIMIT),
    offset: input.offset ?? 0,
  });
  return {
    deliveries: records.map((record) => ({
      eventId: record.eventId,
      deliveryKey: record.deliveryKey,
      workflowRunId: record.workflowRunId,
      taskId: record.taskId,
      nodeId: record.nodeId,
      agentName: record.agentName,
      state: record.state,
      failureReason: record.failureReason,
      deliveredAt: record.deliveredAt,
      updatedAt: record.updatedAt,
      event: {
        topic: record.event.topic,
        source: record.event.source,
        summary: record.event.summary,
        externalUrl: record.event.externalUrl ?? null,
        occurredAt: record.event.occurredAt,
        state: record.eventState,
      },
    })),
  };
}

const LIST_DELIVERIES_DESCRIPTION =
  'List recent external-event deliveries for a workflow run with delivery state and event essence. Defaults to the calling worker own run; pass workflowRunId to inspect another run in the same Space. Only workflow workers are admitted over MCP; RPC callers pass spaceId and workflowRunId explicitly. Rejects caller_denied without an admitted Space scope and run_unresolved when no workflow run can be determined.';

export function createListDeliveriesOperation(events: ListDeliveriesDependencies) {
  const list = (superpipe({ events })('list-external-event-deliveries') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitDeliveryReader, ['input', 'caller'], 'result:outcome')
    .pipe(resolveDeliveryScope, ['outcome', 'input', 'events', 'caller'], 'result:outcome')
    .pipe(readDeliveryLog, ['outcome', 'input', 'events'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'externalEvent.listDeliveries',
    description: LIST_DELIVERIES_DESCRIPTION,
    policy: { safetyClass: 'read', roles: NODE_EVENT_ROLES },
    inputSchema,
    resultSchema: z.union([
      z.object({ deliveries: z.array(DeliverySchema) }),
      z.enum(['caller_denied', 'run_unresolved']),
    ]),
    execute: async (input, caller) => list(input, caller),
  });
}
