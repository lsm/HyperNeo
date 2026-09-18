import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { ExternalEventStore } from './external-event-store.ts';
import type { ExternalEvent, ExternalEventState } from './types.ts';
import {
  admitEventCallerSpace,
  type EventCallerRejection,
  EXTERNAL_EVENT_READ_ROLES,
} from './operation-admission.ts';

export const ExternalEventSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  topic: z.string(),
  occurredAt: z.number(),
  ingestedAt: z.number(),
  source: z.string(),
  sourceEventId: z.string().optional(),
  summary: z.string(),
  externalUrl: z.string().optional(),
  payload: z.record(z.string(), z.json()),
  dedupeKey: z.string(),
  urgency: z.enum(['immediate', 'queued']).optional(),
  render: z.string().optional(),
});

export const ExternalEventStateSchema = z.enum(['published', 'delivered', 'failed', 'ignored']);

const inputSchema = z
  .object({
    eventId: z.string().min(1),
    spaceId: z.string().min(1).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Rejection = EventCallerRejection | 'event_not_found';
type Result = { event: ExternalEvent; state: ExternalEventState } | Rejection;

export interface GetExternalEventDependencies {
  eventStore: Pick<ExternalEventStore, 'getById'>;
}

export function admitEventReader(input: Input, caller: OperationCaller) {
  return admitEventCallerSpace(input, caller);
}

export function readScopedEvent(
  spaceId: string,
  input: Input,
  events: GetExternalEventDependencies
): Result {
  const record = events.eventStore.getById(input.eventId);
  if (!record || record.event.spaceId !== spaceId) return 'event_not_found';
  return { event: record.event, state: record.state };
}

const GET_EXTERNAL_EVENT_DESCRIPTION =
  'Fetch the full raw record for one external event by id — the on-demand deep-dive counterpart to the lean event summary injected as a message. Returns the event and its delivery state. MCP callers are scoped to their own Space and must be a Space member, long-term agent, or workflow worker; RPC callers pass spaceId explicitly. Rejects caller_denied when the caller has no admitted Space scope, and event_not_found when the id is unknown or belongs to another Space.';

export function createGetExternalEventOperation(events: GetExternalEventDependencies) {
  const read = (superpipe({ events })('get-external-event') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEventReader, ['input', 'caller'], 'result:outcome')
    .pipe(readScopedEvent, ['outcome', 'input', 'events'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'externalEvent.get',
    description: GET_EXTERNAL_EVENT_DESCRIPTION,
    policy: { safetyClass: 'read', roles: EXTERNAL_EVENT_READ_ROLES },
    inputSchema,
    resultSchema: z.union([
      z.object({ event: ExternalEventSchema, state: ExternalEventStateSchema }),
      z.enum(['caller_denied', 'event_not_found']),
    ]),
    execute: async (input, caller) => read(input, caller),
  });
}
