import type { MessageOrigin } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type {
  SDKMessageRepository,
  SendStatus,
} from '../../storage/repositories/sdk-message-repository.ts';
import {
  decideMessageAdmission,
  normalizeMessageAdmissionInput,
  type MessageAdmissionRecord,
} from '../../storage/repositories/sdk-message-admission.ts';
import { extractSdkUuid } from '../../storage/repositories/sdk-message-repository.ts';
import { MESSAGE_DELIVERY } from '../job-queue-constants.ts';
import {
  planDeliveryRoleArbitration,
  type DeliveryRoleArbitration,
} from './delivery-turn-routing.ts';
import {
  isUniqueConstraintError,
  MESSAGE_DELIVERY_MAX_RETRIES,
  type MessageDeliveryOrigin,
  type MessageDeliveryPayload,
  type MessageDeliveryRole,
} from './message-delivery.ts';

interface PersistAndEnqueueDeliveryInput {
  sessionId: string;
  message: SDKMessage;
  sendStatus: SendStatus;
  origin?: MessageOrigin;
  delivery: { origin: MessageDeliveryOrigin; parentToolUseId?: string | null };
}

export interface PersistAndEnqueueDeliveryArgs extends PersistAndEnqueueDeliveryInput {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
}

export interface PersistAndEnqueueDeliveryResult {
  dbMessageId: string;
  role: MessageDeliveryRole;
}

type EnqueueDeliveryRoleArbitration = Extract<DeliveryRoleArbitration, { action: 'enqueue' }>;

interface PersistAndEnqueueDeliverySnapshot extends PersistAndEnqueueDeliveryInput {
  id: string;
}

interface PersistAndEnqueueDeliveryValidated extends PersistAndEnqueueDeliverySnapshot {
  messageUuid: string;
}

interface PersistAndEnqueueDeliveryArbitrated extends PersistAndEnqueueDeliveryValidated {
  basePayload: MessageDeliveryPayload;
  arbitration: EnqueueDeliveryRoleArbitration;
}

interface PersistAndEnqueueDeliveryAdmitted extends PersistAndEnqueueDeliveryArbitrated {
  admission: MessageAdmissionRecord;
}

interface PersistAndEnqueueDeliveryEnqueued extends PersistAndEnqueueDeliveryAdmitted {
  dbMessageId: string;
  countsTowardsBadge: boolean;
  role: MessageDeliveryRole;
}

interface PersistAndEnqueueDeliveryDeps {
  persistAndEnqueueAdmittedUserMessage(ctx: PersistAndEnqueueDeliveryAdmitted): {
    dbMessageId: string;
    countsTowardsBadge: boolean;
    role: MessageDeliveryRole;
  };
  runPostSaveSideEffects(sessionId: string, id: string, countsTowardsBadge: boolean): void;
}

type PersistAndEnqueueDeliveryCtx = PersistAndEnqueueDeliveryInput & {
  deps: PersistAndEnqueueDeliveryDeps;
};
type PersistAndEnqueueDeliverySnapshotCtx = PersistAndEnqueueDeliverySnapshot &
  PersistAndEnqueueDeliveryCtx;
type PersistAndEnqueueDeliveryValidatedCtx = PersistAndEnqueueDeliveryValidated &
  PersistAndEnqueueDeliveryCtx;
type PersistAndEnqueueDeliveryArbitratedCtx = PersistAndEnqueueDeliveryArbitrated &
  PersistAndEnqueueDeliveryCtx;
type PersistAndEnqueueDeliveryAdmittedCtx = PersistAndEnqueueDeliveryAdmitted &
  PersistAndEnqueueDeliveryCtx;
type PersistAndEnqueueDeliveryEnqueuedCtx = PersistAndEnqueueDeliveryEnqueued &
  PersistAndEnqueueDeliveryCtx;

const DELIVERY_MAX_RETRIES = MESSAGE_DELIVERY_MAX_RETRIES;

function snapshotDeliveryMessage(
  ctx: PersistAndEnqueueDeliveryCtx
): PersistAndEnqueueDeliverySnapshotCtx {
  return { ...ctx, id: generateUUID() };
}

function validateMessageUuid(
  ctx: PersistAndEnqueueDeliverySnapshotCtx
): PersistAndEnqueueDeliveryValidatedCtx {
  const messageUuid = extractSdkUuid(ctx.message);
  if (!messageUuid) {
    throw new Error('persistAndEnqueueDelivery: message has no uuid; cannot enqueue delivery');
  }
  return { ...ctx, messageUuid };
}

function arbitrateDeliveryRole(
  ctx: PersistAndEnqueueDeliveryValidatedCtx
): PersistAndEnqueueDeliveryArbitratedCtx {
  const basePayload: MessageDeliveryPayload = {
    sessionId: ctx.sessionId,
    messageUuid: ctx.messageUuid,
    role: 'turn',
    origin: ctx.delivery.origin,
    parentToolUseId: ctx.delivery.parentToolUseId ?? null,
  };
  const arbitration = planDeliveryRoleArbitration({
    existingActiveRole: null,
    requestedRole: undefined,
  });
  if (arbitration.action === 'reuse') {
    throw new Error('persistAndEnqueueDelivery: arbitration returned reuse without an active role');
  }
  return { ...ctx, basePayload, arbitration };
}

function admitDeliveryMessage(
  ctx: PersistAndEnqueueDeliveryArbitratedCtx
): PersistAndEnqueueDeliveryAdmittedCtx {
  const admission = decideMessageAdmission(normalizeMessageAdmissionInput(ctx.message), {
    variant: 'user',
    sendStatus: ctx.sendStatus,
    origin: ctx.origin,
  });
  return { ...ctx, admission };
}

function persistAndEnqueueAdmittedUserMessage(
  args: PersistAndEnqueueDeliveryArgs,
  ctx: PersistAndEnqueueDeliveryAdmitted
): { dbMessageId: string; countsTowardsBadge: boolean; role: MessageDeliveryRole } {
  return args.db.transaction(() => {
    const core = args.sdkMessageRepo.saveUserMessageCoreWithAdmission(
      ctx.sessionId,
      ctx.id,
      ctx.message,
      ctx.sendStatus,
      ctx.origin,
      ctx.admission
    );
    let role: MessageDeliveryRole;
    try {
      args.jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: { ...ctx.basePayload, role: ctx.arbitration.role },
        maxRetries: DELIVERY_MAX_RETRIES,
      });
      role = ctx.arbitration.role;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      if (ctx.arbitration.uniqueConstraintFallback === null) throw err;
      args.jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: { ...ctx.basePayload, role: ctx.arbitration.uniqueConstraintFallback },
        maxRetries: DELIVERY_MAX_RETRIES,
      });
      role = ctx.arbitration.uniqueConstraintFallback;
    }
    return { dbMessageId: core.id, countsTowardsBadge: core.countsTowardsBadge, role };
  })();
}

function persistAndEnqueueAtomic(
  ctx: PersistAndEnqueueDeliveryAdmittedCtx
): PersistAndEnqueueDeliveryEnqueuedCtx {
  const { dbMessageId, countsTowardsBadge, role } =
    ctx.deps.persistAndEnqueueAdmittedUserMessage(ctx);
  return { ...ctx, dbMessageId, countsTowardsBadge, role };
}

function publishDeliveryMessage(
  ctx: PersistAndEnqueueDeliveryEnqueuedCtx
): PersistAndEnqueueDeliveryEnqueuedCtx {
  try {
    ctx.deps.runPostSaveSideEffects(ctx.sessionId, ctx.dbMessageId, ctx.countsTowardsBadge);
  } catch {}
  return ctx;
}

const runPersistAndEnqueueDelivery = (superpipe({})('persist-and-enqueue-delivery') as PipelineAPI)
  .input(['ctx'])
  .pipe(snapshotDeliveryMessage, 'ctx', 'ctx')
  .pipe(validateMessageUuid, 'ctx', 'ctx')
  .pipe(arbitrateDeliveryRole, 'ctx', 'ctx')
  .pipe(admitDeliveryMessage, 'ctx', 'ctx')
  .pipe(persistAndEnqueueAtomic, 'ctx', 'ctx')
  .pipe(publishDeliveryMessage, 'ctx', 'ctx')
  .end('ctx') as (ctx: PersistAndEnqueueDeliveryCtx) => PersistAndEnqueueDeliveryEnqueuedCtx;

export function persistAndEnqueueDelivery(
  args: PersistAndEnqueueDeliveryArgs
): PersistAndEnqueueDeliveryResult {
  const deps: PersistAndEnqueueDeliveryDeps = {
    persistAndEnqueueAdmittedUserMessage: (ctx) => persistAndEnqueueAdmittedUserMessage(args, ctx),
    runPostSaveSideEffects: (sessionId, id, countsTowardsBadge) =>
      args.sdkMessageRepo.runPostSaveSideEffects(sessionId, id, countsTowardsBadge),
  };
  const ctx = runPersistAndEnqueueDelivery({
    sessionId: args.sessionId,
    message: args.message,
    sendStatus: args.sendStatus,
    origin: args.origin,
    delivery: args.delivery,
    deps,
  });
  return { dbMessageId: ctx.dbMessageId, role: ctx.role };
}
