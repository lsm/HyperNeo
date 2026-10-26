import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import { WorkerIdentitySchema } from '../drivers/worker-identity-schema.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SessionInspectionRecord } from '../../storage/repositories/daemon-inventory-repository.ts';
import {
  defineOperation,
  isAgentSessionCaller,
  type OperationCaller,
} from '../operations/registry.ts';
import type { SpaceSessionMessage } from '../session/space-session-reads.ts';

const InputSchema = z
  .object({
    sessionId: z.string().min(1),
    limit: z.number().int().min(1).max(20).default(5),
    before: z.string().min(1).optional(),
    includeArchived: z.boolean().default(false),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;
const RejectionSchema = z.object({
  accepted: z.literal(false),
  reason: z.enum(['inspection_forbidden', 'session_not_found', 'session_archived']),
});
const ResultSchema = z.union([
  RejectionSchema,
  z.object({
    accepted: z.literal(true),
    capturedAt: z.number().int().nonnegative(),
    resource: z.object({
      worker: WorkerIdentitySchema.optional(),
      kind: z.literal('session'),
      id: z.string(),
      name: z.string().max(160),
      status: z.string().max(160),
      recordedProcessingStatus: z.string().max(160).nullable(),
      lastActiveAt: z.string().max(128),
      workspacePath: z.string().nullable(),
    }),
    messages: z
      .array(
        z.object({
          id: z.string(),
          type: z.string(),
          subtype: z.string().nullable(),
          isTerminal: z.boolean(),
          timestamp: z.string(),
          cursor: z.string(),
          excerpt: z.string().max(300),
        })
      )
      .max(20),
    nextBefore: z.string().nullable(),
  }),
]);
type Result = z.infer<typeof ResultSchema>;
type Rejection = z.infer<typeof RejectionSchema>;
type Gate<T> = { value: T } | { reason: Rejection };
export interface SessionInspectionDependencies {
  readSession(sessionId: string): SessionInspectionRecord | null;
  readMessages(sessionId: string, limit: number, before?: string): readonly SpaceSessionMessage[];
  now?: () => number;
}

export function admitSessionInspection(input: Input, caller: OperationCaller): Gate<Input> {
  return (caller.source === 'rpc' && caller.principal === 'local') || isAgentSessionCaller(caller)
    ? { value: input }
    : { reason: { accepted: false, reason: 'inspection_forbidden' } };
}

export function requireInspectionTarget(
  input: Input,
  row: SessionInspectionRecord | null
): Gate<SessionInspectionRecord> {
  if (!row || row.id !== input.sessionId)
    return { reason: { accepted: false, reason: 'session_not_found' } };
  return row.status === 'archived' && !input.includeArchived
    ? { reason: { accepted: false, reason: 'session_archived' } }
    : { value: row };
}

export function presentSessionInspection(
  input: Input,
  row: SessionInspectionRecord,
  history: readonly SpaceSessionMessage[],
  capturedAt: number
): Extract<Result, { accepted: true }> {
  const messages = history.slice(0, input.limit).map((message) => ({
    id: message.id,
    type: message.message_type,
    subtype: message.message_subtype,
    isTerminal: message.is_terminal,
    timestamp: message.timestamp,
    cursor: message.cursor,
    excerpt: message.content_summary.slice(0, 300),
  }));
  return {
    accepted: true,
    capturedAt,
    resource: {
      worker: workerIdentity({ adapter: 'hyperneo', id: row.id }, row.name),
      kind: 'session',
      id: row.id,
      name: row.name.slice(0, 160),
      status: row.status.slice(0, 160),
      recordedProcessingStatus:
        typeof row.processingStatus === 'string' ? row.processingStatus.slice(0, 160) : null,
      lastActiveAt: row.lastActiveAt.slice(0, 128),
      workspacePath: row.workspacePath,
    },
    messages,
    nextBefore: messages.length === input.limit ? messages.at(-1)!.cursor : null,
  };
}

export function createSessionInspectionOperation(deps: SessionInspectionDependencies) {
  const inspect = (
    superpipe({ now: deps.now ?? Date.now })('ordinary-session-inspection') as PipelineAPI
  )
    .input(['input', 'caller'])
    .pipe(admitSessionInspection, ['input', 'caller'], 'result:inspection')
    .pipe(
      (input: Input) => ({ row: deps.readSession(input.sessionId) ?? null }),
      'inspection',
      'row'
    )
    .pipe(
      (input: Input, { row }: { row: SessionInspectionRecord | null }) =>
        requireInspectionTarget(input, row),
      ['inspection', 'row'],
      'result:inspection'
    )
    .pipe(
      (input: Input) => deps.readMessages(input.sessionId, input.limit, input.before),
      'input',
      'messages'
    )
    .pipe((now: () => number) => now(), 'now', 'capturedAt')
    .pipe(presentSessionInspection, ['input', 'inspection', 'messages', 'capturedAt'], 'inspection')
    .end('inspection') as (input: Input, caller: OperationCaller) => Result;
  return defineOperation({
    name: 'daemon.session.inspect',
    description:
      'Inspect any existing session by its exact daemon.snapshot session ID: ordinary chats, Space/task/workflow/execution sessions and Neo holders alike. The local human or any daemon-local session. Returns bounded newest-first excerpts with optional earlier-history cursor, never configs, prompts or raw transcripts. A filled page/cursor does not prove more history exists. Recorded processing status is not live progress or proof of completion. Archived history requires includeArchived. Starts no work and writes nothing.',
    policy: {
      safetyClass: 'read',
      roles: ['neo', 'workflow_worker', 'direct_task_worker', 'long_term_agent'],
    },
    inputSchema: InputSchema,
    resultSchema: ResultSchema,
    execute: async (input, caller) => inspect(input, caller),
  });
}
