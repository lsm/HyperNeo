import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { z } from 'zod';
import { ArtifactRefSchema } from '../artifacts/file-contracts.ts';
import { PublicHandoffReference } from '../handoffs/outbox.ts';
import { WorkerOpenSourceSchema } from '../drivers/worker-identity-schema.ts';

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
    shortText: text(4000)
      .describe('What the human reads first; it must stand alone and summarize the message.')
      .optional(),
    verbatim: z
      .literal(true)
      .describe(
        'Send the reply as one field: the full content in fullText with no shortText; a request with both is rejected.'
      )
      .optional(),
    fullText: text(16000).describe('The details of the topic(s) shortText names.'),
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
    revisions: z
      .array(
        z
          .object({
            revisionId: z.uuid(),
            shortText: text(4000).optional(),
            fullText: text(16000),
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
  text: text(16000),
  details: text(16000).optional(),
};

export function publicationTextRule(
  value: { verbatim?: true; shortText?: string; cardReply?: unknown },
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
}

export function foldPublicationDetails(value: { text: string; details?: string }): {
  text: string;
  details?: string;
} {
  return value.details !== undefined && value.details.length < value.text.length
    ? { text: `${value.text}\n\n${value.details}` }
    : value;
}

const wordSegments = new Intl.Segmenter(undefined, { granularity: 'word' });

export function wordCount(text: string): number {
  let count = 0;
  for (const segment of wordSegments.segment(text)) if (segment.isWordLike) count++;
  return count;
}

export const SUMMARY_WORD_LIMIT = 300;
export const SUMMARY_CHAR_LIMIT = 4000;

export function replySummaryTooLong(body: { text: string; details?: string }): boolean {
  return (
    body.details !== undefined &&
    (wordCount(body.text) > SUMMARY_WORD_LIMIT || body.text.length > SUMMARY_CHAR_LIMIT)
  );
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
