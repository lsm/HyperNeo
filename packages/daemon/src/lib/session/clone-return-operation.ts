import type { Session, Space } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { ensurePrompt } from '../agent/message-delivery-outbox.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { hashString32 } from '../runtime-hash.ts';
import { admitSpaceStage } from './ensure-agent-session.ts';

const ReturnInputSchema = z.object({ summary: z.string().min(1).max(20000) }).strict();

const RETURN_REJECTIONS = ['caller_session_required', 'not_a_clone', 'parent_unavailable'] as const;

type ReturnInput = z.infer<typeof ReturnInputSchema>;
type ReturnRejectionReason = (typeof RETURN_REJECTIONS)[number];
type ReturnRejection = { accepted: false; reason: ReturnRejectionReason; message: string };
type ReturnResult =
  | { accepted: true; parentSessionId: string; messageId: string; mechanics: 'steer' | 'turn' }
  | ReturnRejection;

const ReturnResultSchema = z.union([
  z
    .object({
      accepted: z.literal(true),
      parentSessionId: z.string(),
      messageId: z.string(),
      mechanics: z.enum(['steer', 'turn']),
    })
    .strict(),
  z
    .object({
      accepted: z.literal(false),
      reason: z.enum(RETURN_REJECTIONS),
      message: z.string(),
    })
    .strict(),
]);

export interface ReturnSessionCloneDependencies {
  readonly getSession: (sessionId: string) => Session | null;
  readonly getSpace: (spaceId: string) => Promise<Space | null>;
  readonly getSessionStatus: (sessionId: string) => string;
  readonly markReturned: (sessionId: string, returnedAt: string) => void;
  readonly getDatabase: () => BunDatabase;
  readonly getSdkMessageRepo: () => SDKMessageRepository;
  readonly jobQueue: JobQueueRepository;
}

function reject(reason: ReturnRejectionReason, message: string): ReturnRejection {
  return { accepted: false, reason, message };
}

export function loadClone(
  caller: OperationCaller,
  deps: ReturnSessionCloneDependencies
): { value: Session } | { reason: ReturnRejection } {
  if (!caller.sessionId) {
    return { reason: reject('caller_session_required', 'Only a session can return to its parent') };
  }
  const clone = deps.getSession(caller.sessionId);
  if (!clone?.parentSessionId) {
    return { reason: reject('not_a_clone', 'This session has no parent to return to') };
  }
  return { value: clone };
}

type CloneAndParent = { clone: Session; parent: Session };

export async function loadParent(
  clone: Session,
  deps: ReturnSessionCloneDependencies
): Promise<{ value: CloneAndParent } | { reason: ReturnRejection }> {
  const parent = deps.getSession(clone.parentSessionId!);
  if (!parent || parent.status !== 'active') {
    return { reason: reject('parent_unavailable', 'The parent session is not active') };
  }
  const spaceId = parent.context?.spaceId;
  if (spaceId && 'reason' in admitSpaceStage(await deps.getSpace(spaceId))) {
    return { reason: reject('parent_unavailable', `Space is not active: ${spaceId}`) };
  }
  return { value: { clone, parent } };
}

export function buildReturnText(clone: Session, summary: string): string {
  return `## 分身 returned: "${clone.title}" (${clone.id})\n\n${summary}`;
}

export function buildReturnMessageUuid(cloneId: string, text: string): string {
  return `clone-return:${cloneId}:${hashString32(text).toString(16)}`;
}

export function buildReturnMessage(parent: Session, text: string, uuid: string): SDKUserMessage {
  return {
    type: 'user',
    uuid: uuid as SDKUserMessage['uuid'],
    session_id: parent.id,
    parent_tool_use_id: null,
    isSynthetic: true,
    inputKind: 'system',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  } as SDKUserMessage;
}

export function deliverReport(
  { clone, parent }: CloneAndParent,
  input: ReturnInput,
  deps: ReturnSessionCloneDependencies
): ReturnResult {
  const text = buildReturnText(clone, input.summary);
  const uuid = buildReturnMessageUuid(clone.id, text);
  const mechanics = deps.getSessionStatus(parent.id) === 'processing' ? 'steer' : 'turn';
  ensurePrompt({
    db: deps.getDatabase(),
    sdkMessageRepo: deps.getSdkMessageRepo(),
    jobQueue: deps.jobQueue,
    sessionId: parent.id,
    message: buildReturnMessage(parent, text, uuid),
    origin: 'system',
    delivery: {
      origin: 'space_inject',
      ...(mechanics === 'steer' ? { injectedMidTurn: true } : {}),
    },
  });
  deps.markReturned(clone.id, new Date().toISOString());
  return { accepted: true, parentSessionId: parent.id, messageId: uuid, mechanics };
}

const RETURN_DESCRIPTION =
  'Report back to the session that spawned this 分身 (clone). The summary is delivered to the parent as a message: it starts a turn when the parent is idle and is steered into the running turn otherwise. The caller is always the clone itself; the parent is read from its own record. Repeating an identical summary is a no-op; a different summary is a new report. The clone stays open afterwards. Rejects not_a_clone when the caller was not spawned, and parent_unavailable when the parent is not active or its Space is paused, stopped or archived.';

export function createReturnSessionCloneOperation(deps: ReturnSessionCloneDependencies) {
  const run = (superpipe({ deps })('return-session-clone') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(loadClone, ['caller', 'deps'], 'result:outcome')
    .pipe(loadParent, ['outcome', 'deps'], 'result:outcome')
    .pipe(deliverReport, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (input: ReturnInput, caller: OperationCaller) => Promise<ReturnResult>;
  return defineOperation({
    name: 'session.clone.return',
    description: RETURN_DESCRIPTION,
    inputSchema: ReturnInputSchema,
    resultSchema: ReturnResultSchema,
    execute: (input, caller) => run(input, caller),
  });
}
