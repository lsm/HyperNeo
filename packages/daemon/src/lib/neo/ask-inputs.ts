import { z } from 'zod';
import { NEO_ASK_QUESTION_REASONS } from '@hyperneo/shared/types/neo-snapshot';

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

export type NeoAskSettleFacts = { offered: boolean; stalled: boolean; failed: boolean };
