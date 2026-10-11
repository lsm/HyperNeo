import type {
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
    kind: z.enum(['start', 'retry', 'close', 'answer', 'open', 'none']),
    label: z.string().nullable(),
    link: z.string().nullable(),
  } satisfies ZodShape<NeoCardPrimary>),
  actions: z.array(z.enum(['start', 'cancel', 'retry', 'close', 'done'])),
  adapter: z.string().nullable(),
  pr: z
    .object({
      number: z.string(),
      label: z.string(),
      count: z.number().int().nonnegative(),
      inProgress: z.boolean(),
      setback: z.boolean(),
    } satisfies ZodShape<NeoCardPrSummary>)
    .nullable(),
  goal: z.string().nullable(),
  doneWhen: z.string().nullable(),
  continued: z.number().int().nonnegative(),
  pooled: z.boolean(),
  superseded: z.boolean(),
  uncheckedSince: z.number().nullable(),
  unconfirmed: z.boolean(),
  abandoned: z.boolean(),
  retryable: z.boolean(),
} satisfies ZodShape<NeoCardView>);
