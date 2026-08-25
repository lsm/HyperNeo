import {
  classifyExternalEventDirectSteer,
  type DirectSteerEventClass,
} from '../../external-events/event-tiers.ts';

export type { DirectSteerEventClass } from '../../external-events/event-tiers.ts';
import type { ExternalEventEssenceEntry } from '../../external-events/deferred-event-digest.ts';
import { decisionRun } from './decision-pipeline.ts';

export type ExternalEventSteerAdmissionDecision =
  | { action: 'skip' }
  | { action: 'notDirect' }
  | { action: 'suppressBufferCap' }
  | {
      action: 'admit';
      eventClass: DirectSteerEventClass;
      essences: ExternalEventEssenceEntry[];
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
}

export type ExternalEventSteerAdmissionInput = Omit<ExternalEventSteerAdmissionCtx, 'decision'>;

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

export function directSteerClassesOf(
  essences: ExternalEventEssenceEntry[]
): DirectSteerEventClass[] {
  const classes = new Set<DirectSteerEventClass>();
  for (const essence of essences) {
    const eventClass = classifyExternalEventDirectSteer(essence);
    if (eventClass) classes.add(eventClass);
  }
  return [...classes];
}

export function enrichDirectSteerEssences(
  essences: ExternalEventEssenceEntry[],
  hydrate: (essence: ExternalEventEssenceEntry) => ExternalEventEssenceEntry
): ExternalEventEssenceEntry[] {
  return essences.map((essence) => (potentiallyDirect(essence) ? hydrate(essence) : essence));
}

function decided<Ctx extends { decision: unknown }>(
  ctx: Ctx,
  decision: NonNullable<Ctx['decision']>
): Ctx {
  return { ...ctx, decision };
}

export function applyDeliveryV2Gate(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  return ctx.deliveryV2Enabled ? ctx : decided(ctx, { action: 'skip' });
}

export function applyProvenanceGate(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  return ctx.isSynthetic && ctx.inputKind === 'system' ? ctx : decided(ctx, { action: 'skip' });
}

export function applySessionStateGate(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  return ctx.processingStatus === 'processing' && !ctx.inRateLimitCooldown && !ctx.parentTaskLimited
    ? ctx
    : decided(ctx, { action: 'skip' });
}

export function applyDirectClassGate(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  const enriched = enrichDirectSteerEssences(ctx.essences, ctx.hydrate);
  const withEnriched = enriched === ctx.essences ? ctx : { ...ctx, essences: enriched };
  return directSteerClassesOf(enriched).length > 0
    ? withEnriched
    : decided(withEnriched, { action: 'notDirect' });
}

export function applyBufferCapacityGate(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  const directCount = ctx.essences.filter(
    (essence) => classifyExternalEventDirectSteer(essence) !== null
  ).length;
  return ctx.bufferedDirectEventCount + directCount <= ctx.bufferMaxEntries
    ? ctx
    : decided(ctx, { action: 'suppressBufferCap' });
}

export function applyAdmissionFinalGate(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  const eventClass = directSteerClassesOf(ctx.essences)[0]!;
  return decided(ctx, {
    action: 'admit',
    eventClass,
    essences: ctx.essences,
    ...(ctx.droppedEventCount ? { droppedEventCount: ctx.droppedEventCount } : {}),
  });
}

export const decideExternalEventSteerAdmission = decisionRun('external-event-steer-admission', [
  applyDeliveryV2Gate,
  applyProvenanceGate,
  applySessionStateGate,
  applyDirectClassGate,
  applyBufferCapacityGate,
  applyAdmissionFinalGate,
]);
