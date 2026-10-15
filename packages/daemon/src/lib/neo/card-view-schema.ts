import type {
  NeoAskSessionView,
  NeoAskView,
  NeoCardOpenTarget,
  NeoCardPrimary,
  NeoCardPrSummary,
  NeoCardView,
  NeoCardWaiting,
} from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';

type ZodShape<T> = { [K in keyof Required<T>]: z.ZodType<T[K]> };

const CardGroup = z.enum(['attention', 'running', 'outcomes']);

const OpenTarget = z.object({
  link: z.string().nullable(),
  remoteLink: z.string().nullable(),
  sessionId: z.string().nullable(),
  daemon: z.string().nullable(),
} satisfies ZodShape<NeoCardOpenTarget>);

const CardPhase = z.enum([
  'proposed',
  'handed',
  'running',
  'needs_you',
  'checking',
  'abandoned',
  'stopped',
  'pr_open',
  'pr_setback',
  'merged',
  'reported',
  'failed',
  'cancelled',
]);

export const NeoCardViewSchema = z.object({
  waitingFor: z
    .array(
      z.object({
        workId: z.string(),
        title: z.string(),
        reason: z.string(),
        items: z.array(z.object({ id: z.string(), text: z.string() })),
      } satisfies ZodShape<NeoCardWaiting>)
    )
    .optional(),
  autoStart: z.boolean().optional(),
  uncertain: z.boolean().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  talk: z.string().optional(),
  replyUnverified: z.string().optional(),
  workId: z.string(),
  phase: CardPhase,
  group: CardGroup,
  tone: z.enum(['accent', 'warning', 'success']),
  label: z.string(),
  hidden: z.boolean(),
  primary: z.object({
    kind: z.enum(['start', 'retry', 'close', 'answer', 'open', 'chat', 'none']),
    label: z.string().nullable(),
    link: z.string().nullable(),
  } satisfies ZodShape<NeoCardPrimary>),
  actions: z.array(z.enum(['start', 'cancel', 'retry', 'close', 'done'])),
  adapter: z.string().nullable(),
  open: OpenTarget,
  pr: z
    .object({
      number: z.string(),
      label: z.string(),
      count: z.number().int().nonnegative(),
      inProgress: z.boolean(),
      setback: z.boolean(),
      merged: z.array(z.string()),
    } satisfies ZodShape<NeoCardPrSummary>)
    .nullable(),
  goal: z.string().nullable(),
  doneWhen: z.string().nullable(),
  continued: z.number().int().nonnegative(),
  continuedMessage: z.string().nullable(),
  pooled: z.boolean(),
  superseded: z.boolean(),
  uncheckedSince: z.number().nullable(),
  checkedAt: z.number().nullable(),
  unconfirmed: z.boolean(),
  abandoned: z.boolean(),
  retryable: z.boolean(),
} satisfies ZodShape<NeoCardView>);

const HumanAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), workId: z.string() }),
  z.object({
    kind: z.literal('approve'),
    reason: z.enum(['expired', 'stalled']),
    workIds: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('answer'),
    itemId: z.string(),
    step: z.string().nullable(),
    question: z.string(),
    options: z.array(z.string()),
  }),
  z.object({ kind: z.literal('confirm'), itemId: z.string(), step: z.string() }),
  z.object({ kind: z.literal('retry'), workId: z.string() }),
  z.object({ kind: z.literal('close'), workId: z.string() }),
  z.object({ kind: z.literal('talk'), workId: z.string(), what: z.string() }),
]);

export const NeoAskViewSchema = z.object({
  askId: z.string(),
  group: CardGroup,
  label: z.string(),
  settled: z.boolean(),
  needsYou: z.boolean(),
  idle: z.literal(true).optional(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  workIds: z.array(z.string()),
  doneWorkIds: z.array(z.string()),
  summary: z.string().nullable(),
  sessions: z
    .array(
      z.object({
        key: z.string(),
        title: z.string(),
        adapter: z.string(),
        status: z.enum(['queued', 'running', 'needs_you', 'done', 'failed', 'stopped']),
        kind: z.enum(['needs_you', 'failed']).nullable(),
        open: OpenTarget,
      } satisfies ZodShape<NeoAskSessionView>)
    )
    .optional(),
  answer: z
    .object({
      itemId: z.string(),
      question: z.string(),
      label: z.literal('Answer in chat'),
      options: z.array(z.string()),
      action: z.string().optional(),
      kind: z.enum(['decision', 'action', 'approval', 'wait']).optional(),
    })
    .nullable()
    .optional(),
  humanActions: z.array(HumanAction).optional(),
} satisfies ZodShape<NeoAskView>);

export const NeoAskStateViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  outcome: z.string().nullable(),
  items: z.array(z.object({ id: z.string(), state: z.string(), text: z.string().optional() })),
  cards: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      phase: CardPhase.nullable(),
      pr: z.enum(['done', 'failed', 'waiting', 'ready', 'pending']).nullable(),
    })
  ),
  humanActions: z.array(HumanAction),
});
