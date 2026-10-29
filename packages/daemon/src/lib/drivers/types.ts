import { WorkerIdentitySchema } from './worker-identity-schema.ts';
import { z } from 'zod';
import type { WorkTurnPage } from '../../storage/work-turn-page.ts';
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

const DesktopUIEvidenceSchema = z.object({
  state: z.literal('ui-unconfirmed'),
  detail: z.string(),
});

export const WorkSummarySchema = z.object({
  worker: WorkerIdentitySchema.optional(),
  ref: WorkRefSchema,
  title: z.string(),
  place: PlaceSchema,
  status: WorkStatusSchema,
  lastActivityAt: z.number(),
  desktopUI: DesktopUIEvidenceSchema.optional(),
  permissionMode: z.string().optional(),
  waitingFor: z.string().max(200).optional(),
  link: z.string().optional(),
  watchHint: z
    .string()
    .describe(
      'Where the human can watch work when a harness app link is not available; relay this guidance instead of inventing a link.'
    )
    .optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  identityObservation: z
    .object({
      source: z.literal('assistant-transcript'),
      at: z.number().optional(),
      messageId: z.string().optional(),
    })
    .describe('Last observed assistant runtime identity; not a prediction of the next turn.')
    .optional(),
  remoteLink: z.string().optional(),
  remoteControl: z
    .boolean()
    .describe(
      "Whether the session's Remote Control is on, so the human can follow and reply from claude.ai or the phone."
    )
    .optional(),
  score: z.number().optional(),
  hits: z.number().int().nonnegative().optional(),
  lastHitAt: z.number().optional(),
  snippets: z.array(WorkSnippetSchema).optional(),
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
  'not_supported',
  'not_found',
  'not_open',
  'not_delivered',
  'claude_cli_login_expired',
  'unreachable',
  'invalid_place',
  'busy',
  'human_only',
  'live_todo',
  'todo_required',
]);

export function workResultSchema<Value extends z.ZodType>(value: Value) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value, records: z.array(z.string()).optional() }),
    z.object({
      ok: z.literal(false),
      reason: WorkRejectionSchema,
      detail: z.string(),
      uncertainDesktopInputId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Client input ID of an uncertain Desktop handoff; not a delivery receipt. Reconcile before retrying.'
        ),
      notSent: z
        .literal(true)
        .optional()
        .describe(
          'Proves no input was accepted: no dispatch or an explicit precondition refusal. Otherwise reconcile before retrying.'
        ),
    }),
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
  desktopUI: DesktopUIEvidenceSchema.optional(),
  delivered: z.boolean(),
  unconfirmed: z.literal(true).optional(),
  receipt: WorkInputReceiptSchema.optional(),
  queuedSubmissionId: z.string().min(1).optional(),
  steeredIntoTurnId: z.string().min(1).optional(),
  startedTurnId: z.string().min(1).optional(),
  confirmedAt: z.number().optional(),
  remoteControl: z
    .boolean()
    .describe(
      "Whether the session's Remote Control is on, so the human can follow and reply from claude.ai or the phone."
    )
    .optional(),
});

export type WorkDelivery = z.infer<typeof WorkDeliverySchema>;

export const WorkInputEvidenceSchema = z.discriminatedUnion('state', [
  z
    .object({
      receipt: WorkInputReceiptSchema,
      state: z.enum(['unavailable', 'pending']),
      transcriptState: z.literal('accepted').optional(),
      replyAvailability: z.literal('reply_unavailable').optional(),
    })
    .strict(),
  z
    .object({
      receipt: WorkInputReceiptSchema,
      state: z.literal('observed'),
      transcriptState: z.enum(['accepted', 'completed']).optional(),
      exchange: z.array(WorkExchangeEntrySchema).max(40),
      exchangeCut: z.boolean(),
      replyAvailability: z.enum(['complete', 'incomplete']).optional(),
      replyReport: z.string().optional(),
      replyAt: z.number().optional(),
    })
    .strict(),
]);

export const WorkStartedSchema = WorkSummarySchema.extend({
  receipt: WorkInputReceiptSchema.optional(),
  reused: z.literal(true).optional(),
});

export const WorkTurnEndSchema = z.object({
  startedAt: z.number().optional(),
  notify: z.literal(false).optional(),
  id: z.string().min(1),
  at: z.number(),
  message: z.string(),
});

export const WorkDetailSchema = WorkSummarySchema.extend({
  turnEnds: z.array(WorkTurnEndSchema).optional(),
  inputEvidence: WorkInputEvidenceSchema.optional(),
  startReceipt: WorkInputReceiptSchema.optional(),
  execution: z.object({ directory: z.string().min(1), machine: z.string().min(1) }).optional(),
  lastReply: z.string().optional(),
  lastReplyAt: z.number().optional(),
  waitingFor: z.string().max(200).optional(),
  recentInputs: z.array(WorkInputSchema).optional(),
  exchange: z.array(WorkExchangeEntrySchema).optional(),
  exchangeCut: z.boolean().optional(),
  openedPrs: z.array(z.string()).optional(),
  linkedPrs: z
    .array(
      z.object({
        url: z.string(),
        dismissed: z.literal(true).optional(),
        own: z.literal(true).optional(),
      })
    )
    .optional(),
  linkedPrsWindow: z.literal(true).optional(),
  branches: z.array(z.string()).optional(),
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
export type Rejected = {
  ok: false;
  reason: WorkRejection;
  detail: string;
  notSent?: true;
  uncertainDesktopInputId?: string;
};
export type Result<T> = { ok: true; value: T; records?: string[] } | Rejected;

export type WorkVerb =
  | 'find'
  | 'start'
  | 'rename'
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
  idPrefix?: string;
  text?: string;
  folder?: string;
  spaceId?: string;
  includeClosed: boolean;
  limit: number;
}

export interface StartRequest {
  prepareFolder?: () => { value: string } | { reason: Rejected };
  inPlace?: boolean;
  place: Place;
  title: string;
  message: string;
  createFolder?: boolean;
  provenance?: boolean;
  preparation?: z.infer<typeof workStartPreparation.schema>;
  model?: string;
  effort?: string;
}

export interface WorkCallContext {
  from: string;
  caller: OperationCaller;
}

export type WorkRenamed = { renamed: true; title: string };

export interface WorkAdapter {
  readonly id: string;
  readonly capabilities: readonly WorkVerb[];
  readonly unsupportedCapabilities?: Partial<Record<WorkVerb, string>>;
  readonly supportsStartEffort?: boolean;
  readonly supportsStartPreparation?: boolean;
  find(query: FindQuery): PlaceGroup[] | Promise<PlaceGroup[]>;
  readonly readTurns?: (
    sessionId: string,
    around: string | undefined,
    before: number,
    after: number,
    cursor?: WorkTurnPage['nextCursor']
  ) => WorkTurnPage | null;
  readonly start?: (
    request: StartRequest,
    context: WorkCallContext
  ) => Promise<Result<WorkStarted>>;
  readonly send?: (
    ref: WorkRef,
    message: string,
    context: WorkCallContext
  ) => Promise<Result<WorkDelivery>>;
  readonly rename?: (
    ref: WorkRef,
    title: string,
    context: WorkCallContext
  ) => Promise<Result<WorkRenamed>>;
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
