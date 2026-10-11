import type {
  NeoAskView,
  NeoCardOpenTarget,
  NeoCardPrimary,
  NeoCardPrSummary,
  NeoCardView,
} from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';

type ZodShape<T> = { [K in keyof Required<T>]: z.ZodType<T[K]> };

const CardGroup = z.enum(['attention', 'running', 'outcomes']);

export const NeoCardViewSchema = z.object({
  workId: z.string(),
  phase: z.enum([
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
  ]),
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
  open: z.object({
    link: z.string().nullable(),
    remoteLink: z.string().nullable(),
    sessionId: z.string().nullable(),
    daemon: z.string().nullable(),
  } satisfies ZodShape<NeoCardOpenTarget>),
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
  unconfirmed: z.boolean(),
  abandoned: z.boolean(),
  retryable: z.boolean(),
} satisfies ZodShape<NeoCardView>);

export const NeoAskViewSchema = z.object({
  askId: z.string(),
  group: CardGroup,
  label: z.string(),
  settled: z.boolean(),
  needsYou: z.boolean(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  workIds: z.array(z.string()),
  doneWorkIds: z.array(z.string()),
  summary: z.string().nullable(),
} satisfies ZodShape<NeoAskView>);
