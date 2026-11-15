import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import {
  NEO_DELIVERABLE_CHAR_LIMIT,
  NEO_REPLY_CHAR_LIMIT,
  NEO_REPLY_FIELD_LIMIT,
  NEO_REPLY_LINE_LIMIT,
  NEO_SHORT_TEXT_LIMIT,
  neoCharCount,
} from '@hyperneo/shared/types/neo-publication';
import { z } from 'zod';
import { ArtifactRefSchema } from '../artifacts/file-contracts.ts';
import { PublicHandoffReference } from '../handoffs/outbox.ts';
import { WorkerOpenSourceSchema } from '../drivers/worker-identity-schema.ts';

export const REPLY_CHAR_LIMIT = NEO_REPLY_CHAR_LIMIT;
export const REPLY_LINE_LIMIT = NEO_REPLY_LINE_LIMIT;
export const REPLY_FIELD_LIMIT = NEO_REPLY_FIELD_LIMIT;
export const DELIVERABLE_CHAR_LIMIT = NEO_DELIVERABLE_CHAR_LIMIT;

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !!value.trim());
const origin = z.object({ sessionId: text(160), messageId: text(160) }).strict();

export const NeoPublicationObject = z
  .object({
    cardReply: z
      .object({
        sourceMessageIds: z.array(z.uuid()).min(1).max(100),
        askId: text(160),
        questionId: text(160),
        mutationId: z.uuid(),
      })
      .strict()
      .optional(),
    conversationId: z.string().uuid(),
    publicationId: z.string().uuid(),
    askOrigin: origin.optional(),
    producerInput: origin.optional(),
    shortText: text(NEO_SHORT_TEXT_LIMIT)
      .describe('What the human reads first; it must stand alone and summarize the message.')
      .optional(),
    verbatim: z
      .literal(true)
      .describe(
        'Send the reply as one field: the full content in fullText with no shortText; a request with both is rejected.'
      )
      .optional(),
    fullText: text(DELIVERABLE_CHAR_LIMIT).describe(
      'The details of the topic(s) shortText names, or the whole deliverable.'
    ),
    deliverable: z
      .literal(true)
      .describe(
        'The publication is a copyable deliverable: fullText is the whole message and may exceed the ordinary reply cap.'
      )
      .optional(),
    session: text(500).optional(),
    links: z
      .array(
        z
          .object({
            label: text(120),
            kind: z.enum(['project', 'work', 'consultation']),
            id: text(160),
          })
          .strict()
      )
      .max(16)
      .default([]),
    artifacts: z
      .array(z.union([ArtifactRefSchema, PublicHandoffReference]))
      .max(16)
      .optional(),
    triggerId: text(200).optional(),
    replyTo: z.array(z.uuid()).max(100).optional(),
    askSummary: text(300).optional(),
    awaiting: text(500).optional(),
    editedAt: z.string().datetime().optional(),
    editedBy: text(160).optional(),
    answerInput: origin.optional(),
    answerOrigin: origin.optional(),
    languageMismatch: text(120).optional(),
    requestedLanguage: text(60).optional(),
    revisionId: z.uuid().optional(),
    publishedBy: z.enum(['front', 'neo']).optional(),
    workOn: z.boolean().optional(),
    revisions: z
      .array(
        z
          .object({
            revisionId: z.uuid(),
            shortText: text(NEO_SHORT_TEXT_LIMIT).optional(),
            fullText: text(DELIVERABLE_CHAR_LIMIT),
            session: text(500).optional(),
            createdAt: z.string().datetime(),
            producerInput: origin.optional(),
            askOrigin: origin.optional(),
            awaiting: text(500).optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

export const workerSession = (session?: string | null) =>
  session && !session.startsWith('neo:') ? session : undefined;

export const NeoPublicationReplyFields = {
  text: text(DELIVERABLE_CHAR_LIMIT),
  details: text(REPLY_FIELD_LIMIT).optional(),
};

export function publicationTextRule(
  value: {
    verbatim?: true;
    shortText?: string;
    cardReply?: unknown;
    fullText: string;
    deliverable?: true;
  },
  ctx: z.RefinementCtx
): void {
  if (value.verbatim === true && value.cardReply !== undefined)
    ctx.addIssue({ code: 'custom', message: 'verbatim rejects cardReply notices' });
  if (value.verbatim === true && value.shortText !== undefined)
    ctx.addIssue({
      code: 'custom',
      message: 'verbatim rejects shortText; pass the whole content as fullText',
    });
  if (value.verbatim !== true && value.shortText === undefined)
    ctx.addIssue({ code: 'custom', message: 'shortText is required without verbatim' });
  if (value.deliverable !== true && value.fullText.length > REPLY_FIELD_LIMIT)
    ctx.addIssue({
      code: 'custom',
      message: `A publication body fits ${REPLY_FIELD_LIMIT} characters; a longer deliverable sets deliverable: true, up to ${DELIVERABLE_CHAR_LIMIT}.`,
    });
}

function replyLines(text: string): number {
  return text.replace(/\n$/, '').split('\n').length;
}

export function replyBodyRefusal({
  text,
  details,
}: {
  text: string;
  details?: string;
}): 'reply_needs_details' | 'reply_summary_too_long' | undefined {
  if (neoCharCount(text) <= REPLY_CHAR_LIMIT && replyLines(text) <= REPLY_LINE_LIMIT)
    return undefined;
  return details === undefined ? 'reply_needs_details' : 'reply_summary_too_long';
}

export function foldPublicationDetails(value: { text: string; details?: string }): {
  text: string;
  details?: string;
} {
  if (value.details === undefined || value.details.length >= value.text.length) return value;
  const folded = { text: `${value.text}\n\n${value.details}` };
  return replyBodyRefusal(folded) === undefined ? folded : value;
}

export const NeoPublicationSchema = NeoPublicationObject.superRefine(publicationTextRule);

export const NeoPublicationOutputObject = NeoPublicationObject.extend({
  sessionSource: WorkerOpenSourceSchema.nullable().optional(),
  revisions: NeoPublicationObject.shape.revisions
    .unwrap()
    .element.extend({ sessionSource: WorkerOpenSourceSchema.nullable().optional() })
    .array()
    .optional(),
});

export const NeoPublicationResultSchema = z.union([
  z.object({ accepted: z.literal(false), reason: z.string(), detail: z.string().optional() }),
  z.object({
    accepted: z.literal(true),
    created: z.boolean(),
    publication: NeoPublicationOutputObject.extend({
      sequence: z.number().int().positive(),
      createdAt: z.string(),
    }).superRefine(publicationTextRule),
  }),
]);

export function admitNeoPublication(
  input: unknown
): { value: NeoPublicationInput } | { reason: 'invalid_publication' } {
  const parsed = NeoPublicationSchema.safeParse(input);
  return parsed.success ? { value: parsed.data } : { reason: 'invalid_publication' };
}
