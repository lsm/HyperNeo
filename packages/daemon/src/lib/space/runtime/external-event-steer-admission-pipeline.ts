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
  bufferedEventCount: number;
  bufferMaxEntries: number;
  decision: ExternalEventSteerAdmissionDecision | null;
}

export type ExternalEventSteerAdmissionInput = Omit<ExternalEventSteerAdmissionCtx, 'decision'>;

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
  return directSteerClassesOf(ctx.essences).length > 0
    ? ctx
    : decided(ctx, { action: 'notDirect' });
}

export function applyBufferCapacityGate(
  ctx: ExternalEventSteerAdmissionCtx
): ExternalEventSteerAdmissionCtx {
  return ctx.bufferedEventCount + ctx.essences.length <= ctx.bufferMaxEntries
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
