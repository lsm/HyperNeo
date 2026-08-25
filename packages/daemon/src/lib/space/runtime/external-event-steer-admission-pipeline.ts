import superpipe, { type PipelineAPI } from 'superpipe';
import {
  classifyExternalEventDirectSteer,
  type DirectSteerEventClass,
} from '../../external-events/event-tiers.ts';

export type { DirectSteerEventClass } from '../../external-events/event-tiers.ts';
import type { ExternalEventEssenceEntry } from '../../external-events/deferred-event-digest.ts';

export type ExternalEventSteerAdmissionDecision =
  | { action: 'skip' }
  | { action: 'notDirect' }
  | { action: 'suppressBufferCap' }
  | {
      action: 'admit';
      eventClass: DirectSteerEventClass;
      essences: ExternalEventEssenceEntry[];
      steerEssences: ExternalEventEssenceEntry[];
      passengerEssences: ExternalEventEssenceEntry[];
      classes: DirectSteerEventClass[];
      droppedEventCount?: number;
    };

export interface ExternalEventSteerAdmissionCtx {
  deliveryV2Enabled: boolean;
  isSynthetic: boolean;
  inputKind: string;
  processingStatus: string;
  inRateLimitCooldown: boolean;
  parentTaskLimited: boolean;
  essences: ExternalEventEssenceEntry[];
  droppedEventCount?: number;
  bufferedDirectEventCount: number;
  bufferMaxEntries: number;
  hydrate: (essence: ExternalEventEssenceEntry) => ExternalEventEssenceEntry;
  decision: ExternalEventSteerAdmissionDecision | null;
  steerEssences?: ExternalEventEssenceEntry[];
  passengerEssences?: ExternalEventEssenceEntry[];
  classes?: DirectSteerEventClass[];
  eventClass?: DirectSteerEventClass;
}

export type ExternalEventSteerAdmissionInput = Omit<
  ExternalEventSteerAdmissionCtx,
  'decision' | 'steerEssences' | 'passengerEssences' | 'classes' | 'eventClass'
>;

const DIRECT_TOPIC_SUFFIXES: ReadonlySet<string> = new Set([
  'review_submitted',
  'review_comment_polled',
  'check_failed',
  'merge_conflict',
]);

function topicSuffix(topic: string): string {
  const dot = topic.lastIndexOf('.');
  return dot === -1 ? topic : topic.slice(dot + 1);
}

function potentiallyDirect(essence: ExternalEventEssenceEntry): boolean {
  return DIRECT_TOPIC_SUFFIXES.has(topicSuffix(essence.topic));
}

function hydratePotentiallyDirectEssences(
  essences: ExternalEventEssenceEntry[],
  hydrate: (essence: ExternalEventEssenceEntry) => ExternalEventEssenceEntry
): ExternalEventEssenceEntry[] {
  return essences.map((essence) => (potentiallyDirect(essence) ? hydrate(essence) : essence));
}

interface DirectSteerPartition {
  steerEssences: ExternalEventEssenceEntry[];
  passengerEssences: ExternalEventEssenceEntry[];
  classes: DirectSteerEventClass[];
  eventClass: DirectSteerEventClass | undefined;
}

function partitionDirectSteerEssences(essences: ExternalEventEssenceEntry[]): DirectSteerPartition {
  const steer: ExternalEventEssenceEntry[] = [];
  const passenger: ExternalEventEssenceEntry[] = [];
  const classes = new Set<DirectSteerEventClass>();
  for (const essence of essences) {
    const eventClass = classifyExternalEventDirectSteer(essence);
    if (eventClass) {
      steer.push(essence);
      classes.add(eventClass);
    } else {
      passenger.push(essence);
    }
  }
  return {
    steerEssences: steer,
    passengerEssences: passenger,
    classes: [...classes],
    eventClass: [...classes][0],
  };
}

function decided(
  ctx: ExternalEventSteerAdmissionCtx,
  decision: ExternalEventSteerAdmissionDecision
): ExternalEventSteerAdmissionCtx {
  return { ...ctx, decision };
}

function admissionSettled(ctx: ExternalEventSteerAdmissionCtx): boolean {
  return ctx.decision !== null;
}

export function gateDeliveryV2Enabled(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  return ctx.deliveryV2Enabled ? ctx : decided(ctx, { action: 'skip' });
}

export function gateSystemProvenance(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  return ctx.isSynthetic && ctx.inputKind === 'system' ? ctx : decided(ctx, { action: 'skip' });
}

export function gateSessionAdmissible(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  return ctx.processingStatus === 'processing' && !ctx.inRateLimitCooldown && !ctx.parentTaskLimited
    ? ctx
    : decided(ctx, { action: 'skip' });
}

export function enrichDirectEssences(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  return { ...ctx, essences: hydratePotentiallyDirectEssences(ctx.essences, ctx.hydrate) };
}

export function partitionDirectSteer(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  const partition = partitionDirectSteerEssences(ctx.essences);
  if (partition.steerEssences.length === 0) {
    return decided(ctx, { action: 'notDirect' });
  }
  return {
    ...ctx,
    essences: ctx.essences,
    steerEssences: partition.steerEssences,
    passengerEssences: partition.passengerEssences,
    classes: partition.classes,
    eventClass: partition.eventClass,
  };
}

export function gateBufferCapacity(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  const directCount = ctx.steerEssences?.length ?? 0;
  return ctx.bufferedDirectEventCount + directCount <= ctx.bufferMaxEntries
    ? ctx
    : decided(ctx, { action: 'suppressBufferCap' });
}

export function finalizeSteerAdmission(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  return decided(ctx, {
    action: 'admit',
    eventClass: ctx.eventClass!,
    essences: ctx.essences,
    steerEssences: ctx.steerEssences!,
    passengerEssences: ctx.passengerEssences!,
    classes: ctx.classes!,
    ...(ctx.droppedEventCount ? { droppedEventCount: ctx.droppedEventCount } : {}),
  });
}

const steerAdmissionPipeline = (
  superpipe<{ admissionSettled: (ctx: ExternalEventSteerAdmissionCtx) => boolean }>({
    admissionSettled,
  })('external-event-steer-admission') as PipelineAPI
)
  .input(['ctx'])
  .pipe(gateDeliveryV2Enabled, 'ctx', 'ctx')
  .pipe('!admissionSettled', 'ctx')
  .pipe(gateSystemProvenance, 'ctx', 'ctx')
  .pipe('!admissionSettled', 'ctx')
  .pipe(gateSessionAdmissible, 'ctx', 'ctx')
  .pipe('!admissionSettled', 'ctx')
  .pipe(enrichDirectEssences, 'ctx', 'ctx')
  .pipe('!admissionSettled', 'ctx')
  .pipe(partitionDirectSteer, 'ctx', 'ctx')
  .pipe('!admissionSettled', 'ctx')
  .pipe(gateBufferCapacity, 'ctx', 'ctx')
  .pipe('!admissionSettled', 'ctx')
  .pipe(finalizeSteerAdmission, 'ctx', 'ctx')
  .end('ctx');

const run = steerAdmissionPipeline as (input: ExternalEventSteerAdmissionCtx) => unknown;

export function decideExternalEventSteerAdmission(
  input: ExternalEventSteerAdmissionInput
): ExternalEventSteerAdmissionCtx {
  return run({ ...input, decision: null }) as ExternalEventSteerAdmissionCtx;
}
