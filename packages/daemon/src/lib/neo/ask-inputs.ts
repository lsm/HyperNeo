import { z } from 'zod';
import { NEO_ASK_QUESTION_REASONS } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';

export type Rejection = { ok: false; reason: string };

const NEO_ASK_ITEM_KINDS = ['decision', 'action', 'approval', 'wait'] as const;

const NEO_ASK_ITEM_OUTCOME_KINDS = ['state', 'answer'] as const;

export const NeoAskSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  approvedRevision: z.number().int().nonnegative().nullable().optional(),
  id: z.string(),
  requestKey: z.string(),
  projectId: z.string().nullable(),
  originSessionId: z.string(),
  originMessageId: z.string().nullable(),
  title: z.string(),
  ask: z.string(),
  doneWhen: z.string(),
  doneSource: z.string(),
  pack: z.string().nullable().optional(),
  approvedAt: z.number().nullable().optional(),
  approvedContinues: z.number().optional(),
  approvedUntil: z.number().optional(),
  approvedContinueLimit: z.number().optional(),
  pooled: z.boolean().optional(),
  approvalSpent: z.enum(['continues', 'expired']).nullable().optional(),
  stalledWorkIds: z.array(z.string()).optional(),
  summarized: z.literal(true).optional(),
  waitingItem: z.string().nullable().optional(),
  refused: z.string().nullable().optional(),
  refusedCount: z.number().int().nonnegative().optional(),
  status: z.enum(['open', 'waiting', 'achieved', 'abandoned', 'blocked']),
  outcome: z.string().nullable(),
  evidence: z.string().nullable().optional(),
  doneItems: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        state: z.enum(['pending', 'met', 'needs_you', 'reported']),
        evidence: z.string().nullable(),
        answer: z.object({ choice: z.string().nullable(), at: z.number().nullable() }).optional(),
        check: z.string().min(1).nullable(),
        verifiedDefinitionHash: z.string().nullable().optional(),
        deliveredBy: z.string().nullable().optional(),
        metBy: z.enum(['neo', 'daemon', 'human']).nullable(),
        removed: z.boolean(),
        removedReason: z.string().optional(),
        addedAt: z.number().nullable(),
        options: z.array(z.string()).optional(),
        decision: z.literal(true).optional(),
        action: z.string().optional(),
        waitCard: z.string().optional(),
        kind: z.enum(NEO_ASK_ITEM_KINDS).optional(),
        outcomeKind: z.enum(NEO_ASK_ITEM_OUTCOME_KINDS).optional(),
        question: z.string().optional(),
        decides: z.string().optional(),
        because: z
          .object({ card: z.string(), reason: z.enum(NEO_ASK_QUESTION_REASONS) })
          .optional(),
        watch: z.array(z.string()).optional(),
      })
    )
    .optional(),
  workIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  settledAt: z.number().nullable(),
});

const Options = z
  .array(z.string().trim().min(1).max(80))
  .min(2)
  .max(4)
  .refine((options) => new Set(options).size === options.length, 'Options must differ.');

const Decides = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .describe(
    'A short stable name for the decision this question asks (e.g. "release date", "slice 6 target"). Asking the same decision again, however worded, restates its open question instead of adding another.'
  );

const Because = z
  .object({ card: z.string().min(1), reason: z.enum(NEO_ASK_QUESTION_REASONS) })
  .describe(
    "Why this question exists, when a card under this ask is the reason: target_unavailable (the card can't start because its target is gone), card_waits (the card waits on the human), card_failed (the card failed). The daemon withdraws the question as no longer needed once that reason is gone: the card's target resolves, the card stops waiting on the human, or the card is no longer failed."
  );

export const Settle = z.preprocess(
  (input) =>
    input && typeof input === 'object' && !('id' in input) && 'askId' in input
      ? { ...input, id: (input as { askId: unknown }).askId }
      : input,
  z
    .object({
      id: z.string().min(1),
      outcome: z.enum(['achieved', 'abandoned', 'blocked', 'waiting']),
      summary: z.string().trim().min(1).max(200).optional(),
      evidence: z.string().trim().min(1).max(4000),
      kind: z.enum(NEO_ASK_ITEM_KINDS).optional(),
      question: z.string().trim().min(1).max(200).optional(),
      decides: Decides.optional(),
      because: Because.optional(),
      options: Options.optional(),
    })
    .refine(
      (input) => !input.question === !input.options && !input.question === !input.decides,
      'Pass question, decides and options together: one question, the decision it asks, and 2-4 short answers.'
    )
);

export type NeoOutcomeCard = Pick<NeoWork, 'id' | 'status'>;

export type NeoAskSettleFacts = { offered: boolean; stalled: boolean; failed: boolean };
