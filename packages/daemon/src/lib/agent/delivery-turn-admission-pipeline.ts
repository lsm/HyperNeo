import type { MessageContent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { IdleOwnerScope } from './processing-state-manager.ts';
import type {
  DeliveryAdmissionReservation,
  FencedDeliveryBatchWriteResult,
} from '../../storage/repositories/job-queue-repository.ts';
import type { SendStatus } from '../../storage/repositories/sdk-message-repository.ts';
import { MessageDeliveryRecoverableTurnError } from './message-delivery.ts';
import type { MessageDeliveryAttemptObserver } from './message-delivery.ts';

export interface ArmedDeliveryResponseObserver {
  generation: number;
  observer: MessageDeliveryAttemptObserver;
  pendingStart?: boolean;
}

export interface DeliveryTurnEndHandle {
  promise: Promise<void>;
  cancel: () => void;
  idleOwner: IdleOwnerScope;
}

interface ExistingQueueEntry {
  content: string | MessageContent[];
  acknowledgment: Promise<void>;
}

export type DeliveryTurnAdmissionOutcome =
  | { kind: 'aborted' }
  | { kind: 'blocked' }
  | { kind: 'turn_terminated' }
  | {
      kind: 'driving';
      queryPromise: Promise<void>;
      turnEnd: DeliveryTurnEndHandle;
      acknowledgment: Promise<void> | null;
      freshFeed: boolean;
      admittedBatchUuids?: string[];
      generation: number;
      clearEpoch: number;
      responseObserver: ArmedDeliveryResponseObserver | null;
      idleOwner: IdleOwnerScope;
    };

export interface DeliveryTurnAdmissionDeps {
  logDebug(message: string): void;
  sessionArchived(): boolean;
  loadDeliveryRow(
    messageUuid: string
  ): { content: string | MessageContent[]; sendStatus: SendStatus } | null;
  deliveryValid(messageUuid: string, alreadyConsumed: boolean): boolean;
  hasClaimGuard(): boolean;
  claimCurrent(): boolean;
  reclaimCheck(messageUuid: string): { terminated: boolean; clearedTurnEndMarker: boolean };
  recordTurnEndUnguarded(messageUuid: string): void;
  generation(): number;
  cleaningUp(): boolean;
  armResponseObserver(
    observer: MessageDeliveryAttemptObserver
  ): ArmedDeliveryResponseObserver | null;
  disarmResponseObserver(armed: ArmedDeliveryResponseObserver): void;
  startQuery(signal?: AbortSignal): Promise<'started' | 'already-running' | 'blocked'>;
  currentQueryPromise(): Promise<void> | null;
  pendingContentSnapshot(messageUuid: string): string | MessageContent[] | null;
  waitForTurnEnd(): DeliveryTurnEndHandle;
  existingQueueEntry(messageUuid: string): ExistingQueueEntry | null;
  removeQueueEntry(messageUuid: string): boolean;
  queueEntryYielded(messageUuid: string): boolean;
  queueClearEpoch(): number;
  rebuildBatch(
    kickoffUuid: string,
    kickoffContent: string | MessageContent[],
    batchUuids: string[]
  ): { content: string | MessageContent[]; admittedUuids?: string[] };
  contentMatches(queued: string | MessageContent[], expected: string | MessageContent[]): boolean;
  reserveAdmission(messageUuid: string): DeliveryAdmissionReservation | null;
  narrowBatchFenced(
    kickoffUuid: string,
    expectedBatchUuids: string[],
    batchUuids: string[]
  ): FencedDeliveryBatchWriteResult | null;
  narrowBatchLegacy(kickoffUuid: string, admitted: string[]): boolean;
  submitMembersFenced(kickoffUuid: string, uuids: string[]): string[];
  submitMembersLegacy(uuids: string[]): void;
  restoreBatchFenced(
    kickoffUuid: string,
    writtenBatchUuids: string[],
    priorBatchUuids: string[],
    priorDroppedBatchUuids: string[]
  ): boolean;
  unsubmitMembersFenced(kickoffUuid: string, uuids: string[]): string[];
  resolveMessageIds(uuids: string[]): string[];
  publishSubmitted(messageDbIds: string[]): void;
  admitToQueue(messageUuid: string, content: string | MessageContent[]): Promise<void>;
}

export interface DeliveryTurnAdmissionInput {
  messageUuid: string;
  content: string | MessageContent[];
  alreadyConsumed: boolean;
  batchUuids?: string[];
  signal?: AbortSignal;
  attemptObserver?: MessageDeliveryAttemptObserver;
  claimToken?: string;
}

interface DeliveryTurnAdmissionCtx extends DeliveryTurnAdmissionInput {
  deps: DeliveryTurnAdmissionDeps;
  outcome?: DeliveryTurnAdmissionOutcome;
  armedObserver?: ArmedDeliveryResponseObserver | null;
  pendingContentBeforeStart: string | MessageContent[] | null;
  queryPromiseAnchor?: Promise<void> | null;
  generationAtAnchor?: number;
  turnEndMarkerCleared?: boolean;
  turnEnd?: DeliveryTurnEndHandle;
  idleOwner?: IdleOwnerScope;
  existing?: ExistingQueueEntry | null;
  freshFeed?: boolean;
  feedContent?: string | MessageContent[];
  admittedBatchUuids?: string[];
  narrowedWrite?: {
    kickoffUuid: string;
    writtenBatchUuids: string[];
    priorBatchUuids: string[];
    priorDroppedBatchUuids: string[];
  };
  submittedMemberUuids?: string[];
  queuedAcknowledgment?: Promise<void>;
}

function releaseAdmissionEffects(ctx: DeliveryTurnAdmissionCtx): void {
  const narrowed = ctx.narrowedWrite;
  if (narrowed) {
    ctx.narrowedWrite = undefined;
    ctx.deps.restoreBatchFenced(
      narrowed.kickoffUuid,
      narrowed.writtenBatchUuids,
      narrowed.priorBatchUuids,
      narrowed.priorDroppedBatchUuids
    );
  }
  const submitted = ctx.submittedMemberUuids;
  if (ctx.claimToken && submitted && submitted.length > 0) {
    ctx.submittedMemberUuids = undefined;
    ctx.deps.unsubmitMembersFenced(ctx.messageUuid, submitted);
  }
}

function releaseAdmissionResources(ctx: DeliveryTurnAdmissionCtx): void {
  if (ctx.turnEnd) {
    ctx.turnEnd.cancel();
    ctx.turnEnd = undefined;
  }
  if (ctx.armedObserver) {
    const armed = ctx.armedObserver;
    ctx.armedObserver = null;
    ctx.deps.disarmResponseObserver(armed);
  }
  if (ctx.turnEndMarkerCleared) {
    ctx.turnEndMarkerCleared = false;
    ctx.deps.recordTurnEndUnguarded(ctx.messageUuid);
  }
}

function haltAdmission(
  ctx: DeliveryTurnAdmissionCtx,
  outcome: { kind: 'aborted' } | { kind: 'blocked' } | { kind: 'turn_terminated' }
): DeliveryTurnAdmissionCtx {
  releaseAdmissionEffects(ctx);
  releaseAdmissionResources(ctx);
  return { ...ctx, outcome };
}

function gatherEntryGates(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome) return ctx;
  if (!ctx.deps.deliveryValid(ctx.messageUuid, ctx.alreadyConsumed)) {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  if (ctx.deps.hasClaimGuard() && !ctx.deps.claimCurrent()) {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  if (ctx.alreadyConsumed) {
    const reclaim = ctx.deps.reclaimCheck(ctx.messageUuid);
    if (reclaim.clearedTurnEndMarker) ctx.turnEndMarkerCleared = true;
    if (reclaim.terminated) return haltAdmission(ctx, { kind: 'turn_terminated' });
  }
  return ctx;
}

function armResponseObserverStage(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome) return ctx;
  ctx.armedObserver = ctx.attemptObserver
    ? ctx.deps.armResponseObserver(ctx.attemptObserver)
    : null;
  return ctx;
}

function snapshotPendingQueueContent(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.alreadyConsumed) return ctx;
  ctx.pendingContentBeforeStart = ctx.deps.pendingContentSnapshot(ctx.messageUuid);
  return ctx;
}

function reserveStartupIntent(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome || !ctx.claimToken) return ctx;
  const reservation = ctx.deps.reserveAdmission(ctx.messageUuid);
  if (reservation?.status === 'staleClaim') {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  return ctx;
}

async function startQueryForDelivery(
  ctx: DeliveryTurnAdmissionCtx
): Promise<DeliveryTurnAdmissionCtx> {
  if (ctx.outcome) return ctx;
  const startedAt = Date.now();
  const result = await ctx.deps.startQuery(ctx.signal);
  ctx.deps.logDebug(
    `delivery-turn: ensureQueryStarted → ${result} ` +
      `(${Date.now() - startedAt}ms, uuid=${ctx.messageUuid})`
  );
  if (result === 'blocked') return haltAdmission(ctx, { kind: 'blocked' });
  return ctx;
}

function resnapshotLifecycleAfterStartup(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome) return ctx;
  if (ctx.deps.cleaningUp() || (ctx.signal?.aborted ?? false)) {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  if (ctx.deps.hasClaimGuard() && !ctx.deps.claimCurrent()) {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  if (!ctx.deps.deliveryValid(ctx.messageUuid, ctx.alreadyConsumed)) {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  const queryPromise = ctx.deps.currentQueryPromise();
  if (!queryPromise) {
    throw new Error('message_delivery: query did not start; cannot drive turn');
  }
  if (ctx.armedObserver) ctx.armedObserver.pendingStart = false;
  ctx.queryPromiseAnchor = queryPromise;
  ctx.generationAtAnchor = ctx.armedObserver?.generation ?? ctx.deps.generation();
  ctx.attemptObserver?.reportStage('query_ready', { generation: ctx.generationAtAnchor });
  return ctx;
}

function reclaimTurnStateAfterStartup(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome || !ctx.alreadyConsumed) return ctx;
  const reclaim = ctx.deps.reclaimCheck(ctx.messageUuid);
  if (reclaim.clearedTurnEndMarker) ctx.turnEndMarkerCleared = true;
  if (reclaim.terminated) return haltAdmission(ctx, { kind: 'turn_terminated' });
  return ctx;
}

function installTurnEndWaiter(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome) return ctx;
  const turnEnd = ctx.deps.waitForTurnEnd();
  ctx.turnEnd = turnEnd;
  ctx.idleOwner = turnEnd.idleOwner;
  return ctx;
}

function resolveExistingOrFreshEntry(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome || ctx.alreadyConsumed) return ctx;
  if (ctx.deps.hasClaimGuard() && !ctx.deps.claimCurrent()) {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  const existing = ctx.deps.existingQueueEntry(ctx.messageUuid);
  if (existing) void existing.acknowledgment.catch(() => {});
  ctx.existing = existing;
  ctx.freshFeed = existing === null;
  ctx.feedContent = ctx.content;
  if (existing) return ctx;
  const loaded = ctx.deps.loadDeliveryRow(ctx.messageUuid);
  if (ctx.deps.sessionArchived() || loaded?.sendStatus !== 'enqueued') {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  ctx.feedContent = loaded.content;
  return ctx;
}

function rebuildBatchContent(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome || ctx.alreadyConsumed || !ctx.batchUuids || ctx.batchUuids.length <= 1) {
    return ctx;
  }
  const rebuilt = ctx.deps.rebuildBatch(
    ctx.messageUuid,
    ctx.feedContent ?? ctx.content,
    ctx.batchUuids
  );
  ctx.feedContent = rebuilt.content;
  ctx.admittedBatchUuids = rebuilt.admittedUuids;
  if (ctx.freshFeed && !rebuilt.admittedUuids?.includes(ctx.messageUuid)) {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  return ctx;
}

function narrowBatchJobRows(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (
    ctx.outcome ||
    ctx.alreadyConsumed ||
    !ctx.admittedBatchUuids ||
    !ctx.batchUuids ||
    ctx.admittedBatchUuids.length === ctx.batchUuids.length
  ) {
    return ctx;
  }
  let applied = false;
  try {
    if (ctx.claimToken) {
      const fenced = ctx.deps.narrowBatchFenced(
        ctx.messageUuid,
        ctx.batchUuids,
        ctx.admittedBatchUuids
      );
      applied = fenced?.applied ?? false;
      if (applied && fenced) {
        ctx.narrowedWrite = {
          kickoffUuid: ctx.messageUuid,
          writtenBatchUuids: [...ctx.admittedBatchUuids],
          priorBatchUuids: fenced.priorBatchUuids ?? [],
          priorDroppedBatchUuids: fenced.priorDroppedBatchUuids,
        };
      }
    } else {
      applied = ctx.deps.narrowBatchLegacy(ctx.messageUuid, ctx.admittedBatchUuids);
    }
  } catch (error) {
    throw new MessageDeliveryRecoverableTurnError(
      `batch narrowing failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!applied) return haltAdmission(ctx, { kind: 'aborted' });
  return ctx;
}

function verifyFreshFeedPendingContent(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (
    ctx.outcome ||
    ctx.alreadyConsumed ||
    !ctx.freshFeed ||
    ctx.pendingContentBeforeStart === null
  ) {
    return ctx;
  }
  if (!ctx.deps.contentMatches(ctx.pendingContentBeforeStart, ctx.feedContent ?? ctx.content)) {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  throw new MessageDeliveryRecoverableTurnError(
    'Pending queue entry disappeared before delivery admission'
  );
}

function verifyExistingEntryContent(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  const existing = ctx.existing;
  if (ctx.outcome || ctx.alreadyConsumed || !existing) return ctx;
  if (ctx.deps.contentMatches(existing.content, ctx.feedContent ?? ctx.content)) return ctx;
  if (!ctx.deps.queueEntryYielded(ctx.messageUuid)) {
    ctx.deps.removeQueueEntry(ctx.messageUuid);
  }
  return haltAdmission(ctx, { kind: 'aborted' });
}

function markBatchMembersSubmitted(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome || ctx.alreadyConsumed) return ctx;
  const memberUuids = (ctx.admittedBatchUuids ?? []).filter((uuid) => uuid !== ctx.messageUuid);
  if (memberUuids.length === 0) return ctx;
  if (ctx.claimToken) {
    ctx.submittedMemberUuids = ctx.deps.submitMembersFenced(ctx.messageUuid, memberUuids);
  } else {
    ctx.deps.submitMembersLegacy(memberUuids);
  }
  return ctx;
}

function admitKickoffUnderLiveClaim(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome || ctx.alreadyConsumed) return ctx;
  if (
    ctx.deps.cleaningUp() ||
    (ctx.signal?.aborted ?? false) ||
    (ctx.deps.hasClaimGuard() && !ctx.deps.claimCurrent()) ||
    ctx.deps.generation() !== ctx.generationAtAnchor ||
    ctx.deps.currentQueryPromise() !== ctx.queryPromiseAnchor
  ) {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  if (ctx.claimToken && ctx.deps.reserveAdmission(ctx.messageUuid)?.status === 'staleClaim') {
    return haltAdmission(ctx, { kind: 'aborted' });
  }
  if (!ctx.existing) {
    ctx.queuedAcknowledgment = ctx.deps.admitToQueue(
      ctx.messageUuid,
      ctx.feedContent ?? ctx.content
    );
  }
  return ctx;
}

function assembleDrivingOutcome(ctx: DeliveryTurnAdmissionCtx): DeliveryTurnAdmissionCtx {
  if (ctx.outcome) return ctx;
  const queryPromiseAnchor = ctx.queryPromiseAnchor;
  const turnEnd = ctx.turnEnd;
  const generationAtAnchor = ctx.generationAtAnchor;
  if (!queryPromiseAnchor || !turnEnd || generationAtAnchor === undefined) {
    throw new Error('message_delivery: admission anchors missing; cannot drive turn');
  }
  if (ctx.claimToken && ctx.submittedMemberUuids && ctx.submittedMemberUuids.length > 0) {
    ctx.deps.publishSubmitted(ctx.deps.resolveMessageIds(ctx.submittedMemberUuids));
  }
  return {
    ...ctx,
    outcome: {
      kind: 'driving',
      queryPromise: queryPromiseAnchor,
      turnEnd,
      acknowledgment: ctx.existing?.acknowledgment ?? ctx.queuedAcknowledgment ?? null,
      freshFeed: ctx.freshFeed ?? false,
      admittedBatchUuids: ctx.admittedBatchUuids,
      generation: generationAtAnchor,
      clearEpoch: ctx.deps.queueClearEpoch(),
      responseObserver: ctx.armedObserver ?? null,
      idleOwner: ctx.idleOwner!,
    },
  };
}

function compensateFailedAdmission(error: unknown, ctx: DeliveryTurnAdmissionCtx): void {
  releaseAdmissionEffects(ctx);
  releaseAdmissionResources(ctx);
  throw error;
}

const runDeliveryTurnAdmissionPipeline = (
  superpipe({
    hasOutcome: (ctx: DeliveryTurnAdmissionCtx) => ctx.outcome !== undefined,
  })('delivery-turn-admission') as PipelineAPI
)
  .input(['ctx'])
  .pipe(gatherEntryGates, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(armResponseObserverStage, 'ctx', 'ctx')
  .pipe(snapshotPendingQueueContent, 'ctx', 'ctx')
  .pipe(reserveStartupIntent, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(startQueryForDelivery, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(resnapshotLifecycleAfterStartup, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(reclaimTurnStateAfterStartup, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(installTurnEndWaiter, 'ctx', 'ctx')
  .pipe(resolveExistingOrFreshEntry, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(rebuildBatchContent, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(narrowBatchJobRows, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(verifyFreshFeedPendingContent, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(verifyExistingEntryContent, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(markBatchMembersSubmitted, 'ctx', 'ctx')
  .pipe(admitKickoffUnderLiveClaim, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(assembleDrivingOutcome, 'ctx', 'ctx')
  .error(compensateFailedAdmission, ['error', 'ctx'])
  .endAsync('ctx') as unknown as (
  ctx: DeliveryTurnAdmissionCtx
) => Promise<DeliveryTurnAdmissionCtx>;

export async function runDeliveryTurnAdmission(
  deps: DeliveryTurnAdmissionDeps,
  input: DeliveryTurnAdmissionInput
): Promise<DeliveryTurnAdmissionOutcome> {
  const result = await runDeliveryTurnAdmissionPipeline({
    ...input,
    deps,
    pendingContentBeforeStart: null,
  });
  const outcome = result?.outcome;
  if (!outcome) throw new Error('delivery-turn admission: pipeline settled without an outcome');
  return outcome;
}
