import type { MessageOrigin } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { withBusyRetry } from '../../storage/busy-retry.ts';
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
  MESSAGE_DELIVERY_MAX_RETRIES,
  type MessageDeliveryOrigin,
  type MessageDeliveryPayload,
} from './message-delivery.ts';

export type PromptHold = 'immediate' | 'manual';

type ReleasedDeliveryPayload = MessageDeliveryPayload & { released: boolean };

export type OutboxStatusPublisher = (messageIds: string[], status: 'enqueued') => unknown;

interface PromptInput {
  sessionId: string;
  message: SDKMessage;
  origin?: MessageOrigin;
  hold?: PromptHold;
  delivery: {
    origin: MessageDeliveryOrigin;
    parentToolUseId?: string | null;
    injectedMidTurn?: boolean;
  };
}

export interface PersistPromptArgs extends PromptInput {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
}

export interface PersistPromptResult {
  dbMessageId: string;
  released: boolean;
}

export interface PersistAndEnqueueDeliveryInput {
  sessionId: string;
  message: SDKMessage;
  sendStatus: 'deferred' | 'enqueued';
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
}

export interface EnsurePromptResult {
  dbMessageId: string;
  activated: boolean;
  released: boolean;
  created: boolean;
}

export interface ActivatePromptsArgs {
  db: BunDatabase;
  jobQueue: JobQueueRepository;
  sessionId: string;
  messageUuids: string[];
  dbIds?: Array<string | undefined>;
  origin: MessageDeliveryOrigin;
  parentToolUseId?: string | null;
  publishStatusChanged?: OutboxStatusPublisher;
}

export interface ActivatedPromptEntry {
  dbId: string;
  messageUuid: string;
}

export interface ActivatePromptsResult {
  activated: ActivatedPromptEntry[];
}

export interface RetryPromptArgs {
  db: BunDatabase;
  jobQueue: JobQueueRepository;
  sdkMessageRepo?: SDKMessageRepository;
  sessionId: string;
  messageUuid: string;
  dbId?: string;
  origin: MessageDeliveryOrigin;
  parentToolUseId?: string | null;
  injectedMidTurn?: boolean;
  publishStatusChanged?: OutboxStatusPublisher;
}

export interface RetryPromptResult {
  dbId: string;
  messageUuid: string;
}

interface PromptDeps {
  persistAdmittedPrompt(ctx: PersistPromptAdmitted): {
    dbMessageId: string;
    countsTowardsBadge: boolean;
  };
  runPostSaveSideEffects(sessionId: string, id: string, countsTowardsBadge: boolean): void;
}

type PromptCtx = PromptInput & {
  deps: PromptDeps;
};

type PromptSnapshotCtx = PromptCtx & {
  id: string;
};

type PromptValidatedCtx = PromptSnapshotCtx & {
  messageUuid: string;
};

type PromptHeldCtx = PromptValidatedCtx & {
  sendStatus: SendStatus;
  released: boolean;
};

type PromptPayloadCtx = PromptHeldCtx & {
  basePayload: ReleasedDeliveryPayload;
};

type PersistPromptAdmitted = PromptPayloadCtx & {
  admission: MessageAdmissionRecord;
};

type PersistPromptEnqueued = PersistPromptAdmitted & {
  dbMessageId: string;
  countsTowardsBadge: boolean;
};

type EnsurePromptCtx = PromptValidatedCtx &
  PersistPromptArgs & {
    existing: EnsurePromptRow | null;
  };

type EnsurePromptRow = {
  dbId: string;
  sdkMessage: string;
  sendStatus: SendStatus;
};

type EnsurePromptSettledCtx = EnsurePromptCtx & {
  existing: EnsurePromptRow | null;
  created: boolean;
  ensureStatus: SendStatus;
};

type EnsurePromptAppliedCtx = EnsurePromptSettledCtx & {
  dbMessageId: string;
  countsTowardsBadge: boolean;
  activated: boolean;
  released: boolean;
};

type ActivatePromptsCtx = ActivatePromptsArgs & {
  uuids: string[];
  rowIds: Array<string | undefined>;
};

type ActivatePromptsCommittedCtx = ActivatePromptsCtx & {
  activated: ActivatedPromptEntry[];
};

type RetryPromptCtx = RetryPromptArgs & {
  retried: RetryPromptResult | null;
};

const DELIVERY_MAX_RETRIES = MESSAGE_DELIVERY_MAX_RETRIES;

const ACTIVE_DELIVERY_JOBS_SQL = `SELECT id AS job_id, status AS job_status,
    COALESCE(json_extract(payload, '$.released'), 1) AS released
  FROM job_queue
  WHERE queue = 'message_delivery'
    AND json_extract(payload, '$.sessionId') = ?
    AND json_extract(payload, '$.messageUuid') = ?
    AND status IN ('pending', 'processing')
  ORDER BY created_at ASC, rowid ASC`;

const LATEST_DELIVERY_JOB_SQL = `SELECT id AS job_id
  FROM job_queue
  WHERE queue = 'message_delivery'
    AND json_extract(payload, '$.sessionId') = ?
    AND json_extract(payload, '$.messageUuid') = ?
  ORDER BY created_at DESC, rowid DESC
  LIMIT 1`;

const RELEASE_DELIVERY_JOB_SQL = `UPDATE job_queue
  SET payload = json_set(payload, '$.released', json('true'))
  WHERE id = ?`;

const HOLD_DELIVERY_JOB_SQL = `UPDATE job_queue
  SET payload = json_set(payload, '$.released', json('false'))
  WHERE id = ?`;

const REVIVE_DELIVERY_JOB_SQL = `UPDATE job_queue
  SET status = 'pending', run_at = ?, retry_count = 0, max_retries = ?, error = NULL,
      result = NULL,
      started_at = NULL, heartbeat_at = NULL, completed_at = NULL,
      payload = json_remove(
        json_set(
          json_set(
            json_set(
              json_set(payload, '$.released', json('true')),
              '$.origin', ?
            ),
            '$.parentToolUseId', ?
          ),
          '$.injectedMidTurn',
          CASE WHEN ? THEN json('true') ELSE json('null') END
        ),
        '$.__claimToken', '$.__parkCount'
      )
  WHERE id = ?`;

const REQUEUE_HELD_CLAIM_SQL = `UPDATE job_queue
  SET status = 'pending', run_at = ?, started_at = NULL, heartbeat_at = NULL,
      payload = json_remove(
        json_set(payload, '$.released', json('true')),
        '$.__claimToken', '$.__parkCount'
      )
  WHERE id = ? AND status = 'processing'`;

const ACTIVATE_PROMPT_ROW_BY_ID_SQL = `UPDATE sdk_messages
  SET send_status = 'enqueued'
  WHERE id = (
    SELECT id FROM sdk_messages
    WHERE id = ? AND session_id = ? AND message_type = 'user' AND sdk_uuid = ?
      AND send_status IN ('deferred', 'enqueued')
      AND NOT EXISTS (
        SELECT 1 FROM sdk_messages sibling
        WHERE sibling.session_id = ? AND sibling.message_type = 'user'
          AND sibling.sdk_uuid = ? AND (sibling.consumed_seq IS NOT NULL OR COALESCE(sibling.send_status, 'consumed') = 'consumed')
      )
  )
  AND send_status IN ('deferred', 'enqueued')
  RETURNING id AS db_id`;

const ACTIVATE_PROMPT_ROW_BY_UUID_SQL = `UPDATE sdk_messages
  SET send_status = 'enqueued'
  WHERE id = (
    SELECT id FROM sdk_messages
    WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
      AND send_status IN ('deferred', 'enqueued')
      AND NOT EXISTS (
        SELECT 1 FROM sdk_messages sibling
        WHERE sibling.session_id = ? AND sibling.message_type = 'user'
          AND sibling.sdk_uuid = ? AND (sibling.consumed_seq IS NOT NULL OR COALESCE(sibling.send_status, 'consumed') = 'consumed')
      )
    ORDER BY timestamp ASC, rowid ASC LIMIT 1
  )
  AND send_status IN ('deferred', 'enqueued')
  RETURNING id AS db_id`;

const RETRY_PROMPT_ROW_BY_ID_SQL = `UPDATE sdk_messages
  SET send_status = 'enqueued'
  WHERE id = (
    SELECT id FROM sdk_messages
    WHERE id = ? AND session_id = ? AND message_type = 'user' AND sdk_uuid = ?
      AND send_status = 'failed'
      AND NOT EXISTS (
        SELECT 1 FROM sdk_messages sibling
        WHERE sibling.session_id = ? AND sibling.message_type = 'user'
          AND sibling.sdk_uuid = ? AND (sibling.consumed_seq IS NOT NULL OR COALESCE(sibling.send_status, 'consumed') = 'consumed')
      )
  )
  AND send_status = 'failed'
  RETURNING id AS db_id`;

const RETRY_PROMPT_ROW_BY_UUID_SQL = `UPDATE sdk_messages
  SET send_status = 'enqueued'
  WHERE id = (
    SELECT id FROM sdk_messages
    WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
      AND send_status = 'failed'
      AND NOT EXISTS (
        SELECT 1 FROM sdk_messages sibling
        WHERE sibling.session_id = ? AND sibling.message_type = 'user'
          AND sibling.sdk_uuid = ? AND (sibling.consumed_seq IS NOT NULL OR COALESCE(sibling.send_status, 'consumed') = 'consumed')
      )
    ORDER BY timestamp ASC, rowid ASC LIMIT 1
  )
  AND send_status = 'failed'
  RETURNING id AS db_id`;

const PROMPT_ROW_BY_UUID_SQL = `SELECT id AS "dbId", sdk_message AS "sdkMessage",
    COALESCE(send_status, 'consumed') AS "sendStatus"
  FROM sdk_messages
  WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
  ORDER BY timestamp ASC, rowid ASC
  LIMIT 1`;

const ENSURABLE_PROMPT_STATUSES: readonly SendStatus[] = ['deferred', 'enqueued', 'submitted'];

interface ActiveDeliveryJob {
  jobId: string;
  released: boolean;
  processing: boolean;
}

function listActiveDeliveryJobs(
  db: BunDatabase,
  sessionId: string,
  messageUuid: string
): ActiveDeliveryJob[] {
  const rows = db.prepare(ACTIVE_DELIVERY_JOBS_SQL).all(sessionId, messageUuid) as Array<{
    job_id: string;
    job_status: string;
    released: number;
  }>;
  return rows.map((row) => ({
    jobId: row.job_id,
    released: row.released === 1,
    processing: row.job_status === 'processing',
  }));
}

function findActiveDeliveryJob(
  db: BunDatabase,
  sessionId: string,
  messageUuid: string
): ActiveDeliveryJob | null {
  return listActiveDeliveryJobs(db, sessionId, messageUuid)[0] ?? null;
}

function setDeliveryJobReleased(db: BunDatabase, jobId: string, released: boolean): void {
  db.prepare(released ? RELEASE_DELIVERY_JOB_SQL : HOLD_DELIVERY_JOB_SQL).run(jobId);
}

function enqueueDeliveryJob(
  jobQueue: JobQueueRepository,
  basePayload: ReleasedDeliveryPayload
): void {
  jobQueue.enqueue({
    queue: MESSAGE_DELIVERY,
    payload: { ...basePayload },
    maxRetries: DELIVERY_MAX_RETRIES,
  });
}

function reviveDeliveryJob(
  db: BunDatabase,
  jobQueue: JobQueueRepository,
  basePayload: ReleasedDeliveryPayload,
  jobId: string
): boolean {
  const res = db
    .prepare(REVIVE_DELIVERY_JOB_SQL)
    .run(
      Date.now(),
      DELIVERY_MAX_RETRIES,
      basePayload.origin,
      basePayload.parentToolUseId ?? null,
      basePayload.injectedMidTurn === true ? 1 : 0,
      jobId
    );
  if (res.changes > 0) return true;
  enqueueDeliveryJob(jobQueue, basePayload);
  return true;
}

function requeueHeldClaim(
  db: BunDatabase,
  jobQueue: JobQueueRepository,
  basePayload: ReleasedDeliveryPayload,
  active: { jobId: string }
): void {
  const res = db.prepare(REQUEUE_HELD_CLAIM_SQL).run(Date.now(), active.jobId);
  if (res.changes > 0) return;
  enqueueDeliveryJob(jobQueue, basePayload);
}

function releaseActiveDeliveryJob(
  db: BunDatabase,
  jobQueue: JobQueueRepository,
  basePayload: ReleasedDeliveryPayload,
  active: NonNullable<ReturnType<typeof findActiveDeliveryJob>>,
  desiredReleased: boolean
): void {
  if (active.processing && !active.released) {
    requeueHeldClaim(db, jobQueue, basePayload, active);
    return;
  }
  if (active.processing) return;
  if (active.released !== desiredReleased)
    setDeliveryJobReleased(db, active.jobId, desiredReleased);
}

function releaseActiveDeliveryJobs(
  db: BunDatabase,
  jobQueue: JobQueueRepository,
  basePayload: ReleasedDeliveryPayload,
  desiredReleased: boolean
): void {
  for (const job of listActiveDeliveryJobs(db, basePayload.sessionId, basePayload.messageUuid)) {
    releaseActiveDeliveryJob(db, jobQueue, basePayload, job, desiredReleased);
  }
}

function ensureReleasedDeliveryJob(
  db: BunDatabase,
  jobQueue: JobQueueRepository,
  basePayload: ReleasedDeliveryPayload
): void {
  if (findActiveDeliveryJob(db, basePayload.sessionId, basePayload.messageUuid) !== null) {
    releaseActiveDeliveryJobs(db, jobQueue, basePayload, true);
    return;
  }
  enqueueDeliveryJob(jobQueue, basePayload);
}

function rePendingDeliveryJob(
  db: BunDatabase,
  jobQueue: JobQueueRepository,
  basePayload: ReleasedDeliveryPayload
): boolean {
  const active = findActiveDeliveryJob(db, basePayload.sessionId, basePayload.messageUuid);
  if (active) {
    return reviveDeliveryJob(db, jobQueue, basePayload, active.jobId);
  }
  const latest = db
    .prepare(LATEST_DELIVERY_JOB_SQL)
    .get(basePayload.sessionId, basePayload.messageUuid) as { job_id: string } | undefined;
  if (latest) return reviveDeliveryJob(db, jobQueue, basePayload, latest.job_id);
  enqueueDeliveryJob(jobQueue, basePayload);
  return true;
}

function buildReleasedPayload(args: {
  sessionId: string;
  messageUuid: string;
  origin: MessageDeliveryOrigin;
  parentToolUseId?: string | null;
  released: boolean;
  injectedMidTurn?: boolean;
}): ReleasedDeliveryPayload {
  return {
    sessionId: args.sessionId,
    messageUuid: args.messageUuid,
    origin: args.origin,
    parentToolUseId: args.parentToolUseId ?? null,
    released: args.released,
    ...(args.injectedMidTurn === true ? { injectedMidTurn: true } : {}),
  };
}

function snapshotPromptMessage(ctx: PromptCtx): PromptSnapshotCtx {
  return { ...ctx, id: generateUUID() };
}

function validatePromptUuid(ctx: PromptSnapshotCtx): PromptValidatedCtx {
  const messageUuid = extractSdkUuid(ctx.message);
  if (!messageUuid) {
    throw new Error('persistPrompt: message has no uuid; cannot enqueue delivery');
  }
  return { ...ctx, messageUuid };
}

function resolvePromptHold(ctx: PromptValidatedCtx): PromptHeldCtx {
  const manual = ctx.hold === 'manual';
  return { ...ctx, sendStatus: manual ? 'deferred' : 'enqueued', released: !manual };
}

function buildPromptPayload(ctx: PromptHeldCtx): PromptPayloadCtx {
  return {
    ...ctx,
    basePayload: buildReleasedPayload({
      sessionId: ctx.sessionId,
      messageUuid: ctx.messageUuid,
      origin: ctx.delivery.origin,
      parentToolUseId: ctx.delivery.parentToolUseId,
      released: ctx.released,
    }),
  };
}

function admitPromptMessage(ctx: PromptPayloadCtx): PersistPromptAdmitted {
  const admission = decideMessageAdmission(normalizeMessageAdmissionInput(ctx.message), {
    variant: 'user',
    sendStatus: ctx.sendStatus,
    origin: ctx.origin,
  });
  return { ...ctx, admission };
}

function persistAdmittedPrompt(
  args: PersistPromptArgs,
  ctx: PersistPromptAdmitted
): { dbMessageId: string; countsTowardsBadge: boolean } {
  return args.db.transaction(() => {
    const core = args.sdkMessageRepo.saveUserMessageCoreWithAdmission(
      ctx.sessionId,
      ctx.id,
      ctx.message,
      ctx.sendStatus,
      ctx.origin,
      ctx.admission
    );
    enqueueDeliveryJob(args.jobQueue, ctx.basePayload);
    return { dbMessageId: core.id, countsTowardsBadge: core.countsTowardsBadge };
  })();
}

function persistPromptAtomic(ctx: PersistPromptAdmitted): PersistPromptEnqueued {
  const { dbMessageId, countsTowardsBadge } = ctx.deps.persistAdmittedPrompt(ctx);
  return { ...ctx, dbMessageId, countsTowardsBadge };
}

function publishPromptMessage(ctx: PersistPromptEnqueued): PersistPromptEnqueued {
  try {
    ctx.deps.runPostSaveSideEffects(ctx.sessionId, ctx.dbMessageId, ctx.countsTowardsBadge);
  } catch {}
  return ctx;
}

const runPersistPrompt = (superpipe({})('persist-prompt') as PipelineAPI)
  .input(['ctx'])
  .pipe(snapshotPromptMessage, 'ctx', 'ctx')
  .pipe(validatePromptUuid, 'ctx', 'ctx')
  .pipe(resolvePromptHold, 'ctx', 'ctx')
  .pipe(buildPromptPayload, 'ctx', 'ctx')
  .pipe(admitPromptMessage, 'ctx', 'ctx')
  .pipe(persistPromptAtomic, 'ctx', 'ctx')
  .pipe(publishPromptMessage, 'ctx', 'ctx')
  .end('ctx') as (ctx: PromptCtx) => PersistPromptEnqueued;

export function persistPrompt(args: PersistPromptArgs): PersistPromptResult {
  const deps: PromptDeps = {
    persistAdmittedPrompt: (ctx) => persistAdmittedPrompt(args, ctx),
    runPostSaveSideEffects: (sessionId, id, countsTowardsBadge) =>
      args.sdkMessageRepo.runPostSaveSideEffects(sessionId, id, countsTowardsBadge),
  };
  const ctx = runPersistPrompt({
    sessionId: args.sessionId,
    message: args.message,
    origin: args.origin,
    hold: args.hold,
    delivery: args.delivery,
    deps,
  });
  return { dbMessageId: ctx.dbMessageId, released: ctx.released };
}

export function persistAndEnqueueDelivery(
  args: PersistAndEnqueueDeliveryArgs
): PersistAndEnqueueDeliveryResult {
  const { sendStatus, ...rest } = args;
  const result = persistPrompt({
    ...rest,
    hold: sendStatus === 'deferred' ? 'manual' : 'immediate',
  });
  return { dbMessageId: result.dbMessageId };
}

function lookupPromptRow(ctx: PromptValidatedCtx & PersistPromptArgs): EnsurePromptCtx {
  const row = ctx.db.prepare(PROMPT_ROW_BY_UUID_SQL).get(ctx.sessionId, ctx.messageUuid) as
    | EnsurePromptRow
    | undefined;
  return { ...ctx, existing: row ?? null };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export class PromptContentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptContentConflictError';
  }
}

export function verifyPromptContent(args: {
  db: BunDatabase;
  sessionId: string;
  messageUuid: string;
  message: SDKMessage;
}): void {
  const rows = args.db
    .prepare(
      `SELECT sdk_message AS "sdkMessage" FROM sdk_messages
        WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?`
    )
    .all(args.sessionId, args.messageUuid) as Array<{ sdkMessage: string }>;
  for (const row of rows) {
    const stored = JSON.parse(row.sdkMessage) as SDKMessage;
    if (canonicalJson(stored) !== canonicalJson(args.message)) {
      throw new PromptContentConflictError(
        `prompt handoff: message ${args.messageUuid} in session ${args.sessionId} ` +
          'already exists with different content'
      );
    }
  }
}

function checkPromptContent(ctx: EnsurePromptCtx): EnsurePromptSettledCtx {
  if (ctx.existing === null) {
    return { ...ctx, created: true, ensureStatus: ctx.hold === 'manual' ? 'deferred' : 'enqueued' };
  }
  const stored = JSON.parse(ctx.existing.sdkMessage) as SDKMessage;
  if (canonicalJson(stored) !== canonicalJson(ctx.message)) {
    throw new PromptContentConflictError(
      `ensurePrompt: message ${ctx.messageUuid} in session ${ctx.sessionId} ` +
        'already exists with different content'
    );
  }
  return { ...ctx, created: false, ensureStatus: ctx.existing.sendStatus };
}

function hasSettledUuidSibling(db: BunDatabase, sessionId: string, messageUuid: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM sdk_messages sibling
        WHERE sibling.session_id = ? AND sibling.message_type = 'user'
          AND sibling.sdk_uuid = ? AND (sibling.consumed_seq IS NOT NULL OR COALESCE(sibling.send_status, 'consumed') = 'consumed')
        LIMIT 1`
    )
    .get(sessionId, messageUuid);
  return row !== null && row !== undefined;
}

function applyEnsurePrompt(ctx: EnsurePromptSettledCtx): EnsurePromptAppliedCtx {
  const outcome = ctx.db.transaction(() => {
    if (ctx.existing !== null) {
      const fresh = ctx.db.prepare(PROMPT_ROW_BY_UUID_SQL).get(ctx.sessionId, ctx.messageUuid) as
        | EnsurePromptRow
        | undefined;
      if (fresh === null || fresh === undefined) {
        return {
          dbId: ctx.existing.dbId,
          activated: false,
          released: false,
          countsTowardsBadge: false,
        };
      }
      const ensureStatus = fresh.sendStatus;
      const released = ensureStatus !== 'deferred';
      if (
        !ENSURABLE_PROMPT_STATUSES.includes(ensureStatus) ||
        hasSettledUuidSibling(ctx.db, ctx.sessionId, ctx.messageUuid)
      ) {
        return { dbId: fresh.dbId, activated: false, released, countsTowardsBadge: false };
      }
      const active = findActiveDeliveryJob(ctx.db, ctx.sessionId, ctx.messageUuid);
      if (active === null) {
        enqueueDeliveryJob(
          ctx.jobQueue,
          buildReleasedPayload({
            sessionId: ctx.sessionId,
            messageUuid: ctx.messageUuid,
            origin: ctx.delivery.origin,
            parentToolUseId: ctx.delivery.parentToolUseId,
            released,
            injectedMidTurn: ctx.delivery.injectedMidTurn,
          })
        );
        return { dbId: fresh.dbId, activated: true, released, countsTowardsBadge: false };
      }
      if (active.processing) {
        return {
          dbId: fresh.dbId,
          activated: true,
          released: active.released,
          countsTowardsBadge: false,
        };
      }
      releaseActiveDeliveryJobs(
        ctx.db,
        ctx.jobQueue,
        buildReleasedPayload({
          sessionId: ctx.sessionId,
          messageUuid: ctx.messageUuid,
          origin: ctx.delivery.origin,
          parentToolUseId: ctx.delivery.parentToolUseId,
          released,
          injectedMidTurn: ctx.delivery.injectedMidTurn,
        }),
        released
      );
      return { dbId: fresh.dbId, activated: true, released, countsTowardsBadge: false };
    }
    const admission = decideMessageAdmission(normalizeMessageAdmissionInput(ctx.message), {
      variant: 'user',
      sendStatus: ctx.ensureStatus,
      origin: ctx.origin,
    });
    const core = ctx.sdkMessageRepo.saveUserMessageCoreWithAdmission(
      ctx.sessionId,
      ctx.id,
      ctx.message,
      ctx.ensureStatus,
      ctx.origin,
      admission
    );
    enqueueDeliveryJob(
      ctx.jobQueue,
      buildReleasedPayload({
        sessionId: ctx.sessionId,
        messageUuid: ctx.messageUuid,
        origin: ctx.delivery.origin,
        parentToolUseId: ctx.delivery.parentToolUseId,
        released: ctx.ensureStatus !== 'deferred',
        injectedMidTurn: ctx.delivery.injectedMidTurn,
      })
    );
    return {
      dbId: core.id,
      activated: true,
      released: ctx.ensureStatus !== 'deferred',
      countsTowardsBadge: core.countsTowardsBadge,
    };
  })();
  return {
    ...ctx,
    dbMessageId: outcome.dbId,
    activated: outcome.activated,
    released: outcome.released,
    countsTowardsBadge: outcome.countsTowardsBadge,
  };
}

function publishEnsuredPrompt(ctx: EnsurePromptAppliedCtx): EnsurePromptAppliedCtx {
  if (!ctx.created) return ctx;
  try {
    ctx.deps.runPostSaveSideEffects(ctx.sessionId, ctx.dbMessageId, ctx.countsTowardsBadge);
  } catch {}
  return ctx;
}

const runEnsurePrompt = (superpipe({})('ensure-prompt') as PipelineAPI)
  .input(['ctx'])
  .pipe(snapshotPromptMessage, 'ctx', 'ctx')
  .pipe(validatePromptUuid, 'ctx', 'ctx')
  .pipe(lookupPromptRow, 'ctx', 'ctx')
  .pipe(checkPromptContent, 'ctx', 'ctx')
  .pipe(applyEnsurePrompt, 'ctx', 'ctx')
  .pipe(publishEnsuredPrompt, 'ctx', 'ctx')
  .end('ctx') as (ctx: PromptCtx & PersistPromptArgs) => EnsurePromptAppliedCtx;

export function ensurePrompt(args: PersistPromptArgs): EnsurePromptResult {
  const deps: PromptDeps = {
    persistAdmittedPrompt: (ctx) => persistAdmittedPrompt(args, ctx),
    runPostSaveSideEffects: (sessionId, id, countsTowardsBadge) =>
      args.sdkMessageRepo.runPostSaveSideEffects(sessionId, id, countsTowardsBadge),
  };
  const ctx = runEnsurePrompt({
    ...args,
    deps,
  });
  return {
    dbMessageId: ctx.dbMessageId,
    activated: ctx.activated,
    released: ctx.released,
    created: ctx.created,
  };
}

function normalizeActivateUuids(ctx: ActivatePromptsArgs): ActivatePromptsCtx {
  const seen = new Set<string>();
  const uuids: string[] = [];
  const rowIds: Array<string | undefined> = [];
  ctx.messageUuids.forEach((uuid, index) => {
    if (typeof uuid !== 'string' || uuid.length === 0 || seen.has(uuid)) return;
    seen.add(uuid);
    uuids.push(uuid);
    rowIds.push(ctx.dbIds?.[index]);
  });
  return { ...ctx, uuids, rowIds };
}

function commitActivatePrompts(ctx: ActivatePromptsCtx): ActivatePromptsCommittedCtx {
  const activated: ActivatedPromptEntry[] = [];
  const txn = ctx.db.transaction(() => {
    const rowByIdStmt = ctx.db.prepare(ACTIVATE_PROMPT_ROW_BY_ID_SQL);
    const rowByUuidStmt = ctx.db.prepare(ACTIVATE_PROMPT_ROW_BY_UUID_SQL);
    ctx.uuids.forEach((messageUuid, index) => {
      const rowId = ctx.rowIds[index];
      const rows = (
        rowId !== undefined
          ? rowByIdStmt.all(rowId, ctx.sessionId, messageUuid, ctx.sessionId, messageUuid)
          : rowByUuidStmt.all(ctx.sessionId, messageUuid, ctx.sessionId, messageUuid)
      ) as Array<{ db_id: string }>;
      const row = rows[0];
      if (!row) return;
      ensureReleasedDeliveryJob(
        ctx.db,
        ctx.jobQueue,
        buildReleasedPayload({
          sessionId: ctx.sessionId,
          messageUuid,
          origin: ctx.origin,
          parentToolUseId: ctx.parentToolUseId,
          released: true,
        })
      );
      activated.push({ dbId: row.db_id, messageUuid });
    });
  }, 'immediate');
  withBusyRetry(() => txn());
  return { ...ctx, activated };
}

async function publishActivatedPrompts(
  ctx: ActivatePromptsCommittedCtx
): Promise<ActivatePromptsCommittedCtx> {
  if (!ctx.publishStatusChanged || ctx.activated.length === 0) return ctx;
  try {
    await ctx.publishStatusChanged(
      ctx.activated.map((entry) => entry.dbId),
      'enqueued'
    );
  } catch {}
  return ctx;
}

const runActivatePrompts = (superpipe({})('activate-prompts') as PipelineAPI)
  .input(['ctx'])
  .pipe(normalizeActivateUuids, 'ctx', 'ctx')
  .pipe(commitActivatePrompts, 'ctx', 'ctx')
  .pipe(publishActivatedPrompts, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: ActivatePromptsArgs) => Promise<ActivatePromptsCommittedCtx>;

export async function activatePrompts(args: ActivatePromptsArgs): Promise<ActivatePromptsResult> {
  const ctx = await runActivatePrompts(args);
  return { activated: ctx.activated };
}

function validateRetryPromptUuid(ctx: RetryPromptArgs): RetryPromptCtx {
  if (typeof ctx.messageUuid !== 'string' || ctx.messageUuid.length === 0) {
    throw new Error('retryPrompt: messageUuid is required');
  }
  return { ...ctx, retried: null };
}

function commitRetryPrompt(ctx: RetryPromptCtx): RetryPromptCtx {
  const retried = withBusyRetry(() =>
    ctx.db.transaction(() => {
      const rows = (
        ctx.dbId !== undefined
          ? ctx.db
              .prepare(RETRY_PROMPT_ROW_BY_ID_SQL)
              .all(ctx.dbId, ctx.sessionId, ctx.messageUuid, ctx.sessionId, ctx.messageUuid)
          : ctx.db
              .prepare(RETRY_PROMPT_ROW_BY_UUID_SQL)
              .all(ctx.sessionId, ctx.messageUuid, ctx.sessionId, ctx.messageUuid)
      ) as Array<{
        db_id: string;
      }>;
      const row = rows[0];
      if (!row) return null;
      rePendingDeliveryJob(
        ctx.db,
        ctx.jobQueue,
        buildReleasedPayload({
          sessionId: ctx.sessionId,
          messageUuid: ctx.messageUuid,
          origin: ctx.origin,
          parentToolUseId: ctx.parentToolUseId,
          released: true,
          injectedMidTurn: ctx.injectedMidTurn,
        })
      );
      ctx.sdkMessageRepo?.updateMessageStatus([row.db_id], 'enqueued');
      return { dbId: row.db_id, messageUuid: ctx.messageUuid };
    }, 'immediate')()
  );
  return { ...ctx, retried };
}

async function publishRetriedPrompt(ctx: RetryPromptCtx): Promise<RetryPromptCtx> {
  if (ctx.retried === null || !ctx.publishStatusChanged) return ctx;
  try {
    await ctx.publishStatusChanged([ctx.retried.dbId], 'enqueued');
  } catch {}
  return ctx;
}

const runRetryPrompt = (superpipe({})('retry-prompt') as PipelineAPI)
  .input(['ctx'])
  .pipe(validateRetryPromptUuid, 'ctx', 'ctx')
  .pipe(commitRetryPrompt, 'ctx', 'ctx')
  .pipe(publishRetriedPrompt, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: RetryPromptArgs) => Promise<RetryPromptCtx>;

export async function retryPrompt(args: RetryPromptArgs): Promise<RetryPromptResult | null> {
  const ctx = await runRetryPrompt(args);
  return ctx.retried;
}
