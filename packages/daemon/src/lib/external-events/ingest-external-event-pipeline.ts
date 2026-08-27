import superpipe, { type PipelineAPI } from 'superpipe';
import { type ExternalEventEssenceEntry, renderEventBlock } from './deferred-event-digest.ts';
import { essenceEntryFromExternalEvent } from './event-essence-entry.ts';
import { classifyUrgency, type ExternalEventUrgency } from './event-urgency.ts';
import { validateExternalEvent } from './external-event-store.ts';
import type { ExternalEvent, StoreResult } from './types.ts';

export type IngestExternalEventOutcome =
  | { action: 'invalid'; reason: string }
  | { action: 'ingested'; eventId: string; urgency: ExternalEventUrgency; render: string }
  | { action: 'duplicate'; eventId: string; terminal: boolean }
  | { action: 'failed'; stage: 'persist'; error: unknown };

export interface IngestExternalEventDeps {
  store(event: ExternalEvent): StoreResult;
}

export interface IngestExternalEventInput {
  event: ExternalEvent;
  deps: IngestExternalEventDeps;
}

export interface IngestExternalEventCtx extends IngestExternalEventInput {
  urgency?: ExternalEventUrgency;
  render?: string;
  outcome?: IngestExternalEventOutcome;
}

function essenceFromExternalEvent(event: ExternalEvent): ExternalEventEssenceEntry {
  return essenceEntryFromExternalEvent(event) ?? { eventId: event.id, topic: event.topic };
}

export function validateIngestEvent(ctx: IngestExternalEventCtx): IngestExternalEventCtx {
  const reason = validateExternalEvent(ctx.event);
  return reason === null ? ctx : { ...ctx, outcome: { action: 'invalid', reason } };
}

export function classifyIngestEvent(ctx: IngestExternalEventCtx): IngestExternalEventCtx {
  return { ...ctx, urgency: classifyUrgency(ctx.event) };
}

export function renderIngestEvent(ctx: IngestExternalEventCtx): IngestExternalEventCtx {
  return { ...ctx, render: renderEventBlock(essenceFromExternalEvent(ctx.event)) };
}

export function persistIngestEvent(ctx: IngestExternalEventCtx): IngestExternalEventCtx {
  const event: ExternalEvent = { ...ctx.event, urgency: ctx.urgency, render: ctx.render };
  try {
    const stored = ctx.deps.store(event);
    if (stored.duplicate) {
      return {
        ...ctx,
        outcome: { action: 'duplicate', eventId: stored.event.id, terminal: stored.terminal },
      };
    }
    return {
      ...ctx,
      outcome: {
        action: 'ingested',
        eventId: event.id,
        urgency: event.urgency!,
        render: event.render!,
      },
    };
  } catch (error) {
    return { ...ctx, outcome: { action: 'failed', stage: 'persist', error } };
  }
}

function ingestSettled(ctx: IngestExternalEventCtx): boolean {
  return ctx.outcome !== undefined;
}

const run = (
  superpipe<{ ingestSettled: (ctx: IngestExternalEventCtx) => boolean }>({
    ingestSettled,
  })('ingest-external-event') as PipelineAPI
)
  .input(['ctx'])
  .pipe(validateIngestEvent, 'ctx', 'ctx')
  .pipe('!ingestSettled', 'ctx')
  .pipe(classifyIngestEvent, 'ctx', 'ctx')
  .pipe(renderIngestEvent, 'ctx', 'ctx')
  .pipe(persistIngestEvent, 'ctx', 'ctx')
  .end('ctx') as (input: IngestExternalEventCtx) => IngestExternalEventCtx;

export function ingestExternalEvent(
  deps: IngestExternalEventDeps,
  event: ExternalEvent
): IngestExternalEventOutcome {
  const ctx = run({ event, deps });
  return ctx.outcome ?? { action: 'failed', stage: 'persist', error: new Error('missing outcome') };
}
