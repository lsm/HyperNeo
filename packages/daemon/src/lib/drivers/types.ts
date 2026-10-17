import { z } from 'zod';
import { workStartConfiguration } from './start-configuration.ts';
import { workStartPreparation } from './start-preparation.ts';
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
  codeIdentity: z.string().optional(),
  remotes: z.array(z.string()).optional(),
  repoName: z.string().optional(),
  toolProject: z.object({ id: z.string(), name: z.string() }).optional(),
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
  model: z.string().optional(),
  effort: z.string().optional(),
  remoteLink: z.string().optional(),
  score: z.number().optional(),
  hits: z.number().int().nonnegative().optional(),
  lastHitAt: z.number().optional(),
  snippets: z.array(WorkSnippetSchema).optional(),
  liveCards: z.number().int().positive().optional(),
  busy: z.literal(true).optional(),
});

export const PlaceGroupSchema = z.object({
  place: PlaceSchema,
  projectId: z.string().optional(),
  workspaces: z.array(PlaceSchema).optional(),
  lastActivityAt: z.number(),
  openCount: z.number().int().nonnegative(),
  archivedCount: z.number().int().nonnegative(),
  adapters: z.array(z.string()),
  work: z.array(WorkSummarySchema),
});

export const WorkRejectionSchema = z.enum([
  ...workStartConfiguration.refusalSchema.options,
  ...workStartPreparation.refusalSchema.options,
  'unknown_adapter',
  'unsupported',
  'not_found',
  'not_open',
  'not_delivered',
  'claude_cli_login_expired',
  'unreachable',
  'invalid_place',
  'busy',
  'human_only',
  'live_card',
]);

export function workResultSchema<Value extends z.ZodType>(value: Value) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), reason: WorkRejectionSchema, detail: z.string() }),
  ]);
}

export const WorkInputSchema = z.object({
  at: z.number(),
  text: z.string(),
  human: z.boolean().optional(),
});
export const WorkExchangeEntrySchema = z.object({
  at: z.number(),
  role: z.enum(['user', 'agent']),
  text: z.string(),
});

export const WorkInputReceiptSchema = z.object({
  executionId: z.string().min(1),
  inputId: z.string().min(1),
});

export const WorkDeliverySchema = z.object({
  delivered: z.boolean(),
  unconfirmed: z.literal(true).optional(),
  receipt: WorkInputReceiptSchema.optional(),
  queuedSubmissionId: z.string().min(1).optional(),
  steeredIntoTurnId: z.string().min(1).optional(),
  confirmedAt: z.number().optional(),
});

export type WorkDelivery = z.infer<typeof WorkDeliverySchema>;

export const WorkInputEvidenceSchema = z.discriminatedUnion('state', [
  z
    .object({
      receipt: WorkInputReceiptSchema,
      state: z.enum(['unavailable', 'pending']),
    })
    .strict(),
  z
    .object({
      receipt: WorkInputReceiptSchema,
      state: z.literal('observed'),
      exchange: z.array(WorkExchangeEntrySchema).max(40),
      exchangeCut: z.boolean(),
    })
    .strict(),
]);

export const WorkStartedSchema = WorkSummarySchema.extend({
  receipt: WorkInputReceiptSchema.optional(),
});

export const WorkDetailSchema = WorkSummarySchema.extend({
  inputEvidence: WorkInputEvidenceSchema.optional(),
  startReceipt: WorkInputReceiptSchema.optional(),
  execution: z.object({ directory: z.string().min(1), machine: z.string().min(1) }).optional(),
  lastReply: z.string().optional(),
  lastReplyAt: z.number().optional(),
  recentInputs: z.array(WorkInputSchema).optional(),
  exchange: z.array(WorkExchangeEntrySchema).optional(),
  exchangeCut: z.boolean().optional(),
  openedPrs: z.array(z.string()).optional(),
});

export type WorkStatus = z.infer<typeof WorkStatusSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type WorkRef = z.infer<typeof WorkRefSchema>;
export type WorkSummary = z.infer<typeof WorkSummarySchema>;
export type WorkStarted = z.infer<typeof WorkStartedSchema>;
export type PlaceGroup = z.infer<typeof PlaceGroupSchema>;
export type WorkRejection = z.infer<typeof WorkRejectionSchema>;
export type WorkDetail = z.infer<typeof WorkDetailSchema>;
export type WorkInput = z.infer<typeof WorkInputSchema>;
export type WorkExchangeEntry = z.infer<typeof WorkExchangeEntrySchema>;
export type Rejected = { ok: false; reason: WorkRejection; detail: string };
export type Result<T> = { ok: true; value: T } | Rejected;

export type WorkVerb =
  | 'find'
  | 'start'
  | 'send'
  | 'steer'
  | 'queue'
  | 'withdraw'
  | 'status'
  | 'stop'
  | 'archive';
export type WorkWithdrawal = {
  queuedSubmissionId: string;
  withdrawn: boolean;
  reason?: 'not_queued';
};

export type ArchiveAdmission = () => Rejected | null;

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
  createFolder?: boolean;
  preparation?: z.infer<typeof workStartPreparation.schema>;
  model?: string;
  effort?: string;
}

export interface WorkCallContext {
  from: string;
  caller: OperationCaller;
}

export interface WorkAdapter {
  readonly id: string;
  readonly capabilities: readonly WorkVerb[];
  readonly supportsStartEffort?: boolean;
  readonly supportsStartPreparation?: boolean;
  find(query: FindQuery): PlaceGroup[] | Promise<PlaceGroup[]>;
  readonly start?: (
    request: StartRequest,
    context: WorkCallContext
  ) => Promise<Result<WorkStarted>>;
  readonly send?: (
    ref: WorkRef,
    message: string,
    context: WorkCallContext
  ) => Promise<Result<WorkDelivery>>;
  readonly steer?: WorkAdapter['send'];
  readonly queue?: WorkAdapter['send'];
  readonly withdraw?: (
    ref: WorkRef,
    queuedSubmissionId: string,
    context: WorkCallContext
  ) => Promise<Result<WorkWithdrawal>>;
  readonly status?: (
    ref: WorkRef,
    since?: number,
    receipt?: WorkDelivery['receipt']
  ) => Promise<Result<WorkDetail>>;
  readonly stop?: (ref: WorkRef, context: WorkCallContext) => Promise<Result<{ stopped: boolean }>>;
  readonly archive?: (
    ref: WorkRef,
    admit: ArchiveAdmission
  ) => Promise<Result<{ archived: boolean }>>;
}
