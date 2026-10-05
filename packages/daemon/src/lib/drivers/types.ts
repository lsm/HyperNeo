import { z } from 'zod';
import type { OperationCaller } from '../operations/registry.ts';

export const WorkStatusSchema = z.enum([
  'queued',
  'running',
  'needs_you',
  'done',
  'failed',
  'stopped',
]);

export const PlaceSchema = z.object({
  machine: z.string(),
  daemon: z.string().min(1).optional(),
  folder: z.string().optional(),
  spaceId: z.string().optional(),
  name: z.string(),
});

export const WorkRefSchema = z.object({
  adapter: z.string().min(1),
  daemon: z.string().min(1).optional(),
  id: z.string().min(1),
});

export const WorkSnippetSchema = z.object({
  match: z.enum(['exact', 'semantic']),
  at: z.number(),
  role: z.string(),
  text: z.string(),
  handle: z.object({ sessionId: z.string(), messageId: z.string() }).optional(),
});

export const WorkSummarySchema = z.object({
  ref: WorkRefSchema,
  title: z.string(),
  place: PlaceSchema,
  status: WorkStatusSchema,
  lastActivityAt: z.number(),
  link: z.string().optional(),
  score: z.number().optional(),
  hits: z.number().int().nonnegative().optional(),
  lastHitAt: z.number().optional(),
  snippets: z.array(WorkSnippetSchema).optional(),
});

export const PlaceGroupSchema = z.object({
  place: PlaceSchema,
  lastActivityAt: z.number(),
  openCount: z.number().int().nonnegative(),
  archivedCount: z.number().int().nonnegative(),
  adapters: z.array(z.string()),
  work: z.array(WorkSummarySchema),
});

export const WorkRejectionSchema = z.enum([
  'unknown_adapter',
  'unsupported',
  'not_found',
  'not_open',
  'not_delivered',
  'unreachable',
  'invalid_place',
]);

export function workResultSchema<Value extends z.ZodType>(value: Value) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), reason: WorkRejectionSchema, detail: z.string() }),
  ]);
}

export const WorkDetailSchema = WorkSummarySchema.extend({ lastReply: z.string().optional() });

export type WorkStatus = z.infer<typeof WorkStatusSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type WorkRef = z.infer<typeof WorkRefSchema>;
export type WorkSummary = z.infer<typeof WorkSummarySchema>;
export type PlaceGroup = z.infer<typeof PlaceGroupSchema>;
export type WorkRejection = z.infer<typeof WorkRejectionSchema>;
export type WorkDetail = z.infer<typeof WorkDetailSchema>;
export type Rejected = { ok: false; reason: WorkRejection; detail: string };
export type Result<T> = { ok: true; value: T } | Rejected;

export type WorkVerb = 'find' | 'start' | 'send' | 'status' | 'stop';

export interface FindQuery {
  text?: string;
  folder?: string;
  spaceId?: string;
  includeClosed: boolean;
  limit: number;
}

export interface StartRequest {
  place: Place;
  title: string;
  message: string;
}

export interface WorkCallContext {
  from: string;
  caller: OperationCaller;
}

export interface WorkAdapter {
  readonly id: string;
  readonly capabilities: readonly WorkVerb[];
  find(query: FindQuery): PlaceGroup[] | Promise<PlaceGroup[]>;
  readonly start?: (
    request: StartRequest,
    context: WorkCallContext
  ) => Promise<Result<WorkSummary>>;
  readonly send?: (
    ref: WorkRef,
    message: string,
    context: WorkCallContext
  ) => Promise<Result<{ delivered: boolean }>>;
  readonly status?: (ref: WorkRef) => Promise<Result<WorkDetail>>;
  readonly stop?: (ref: WorkRef, context: WorkCallContext) => Promise<Result<{ stopped: boolean }>>;
}
