import type { NeoPublication, NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { z } from 'zod';

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !!value.trim());
const origin = z.object({ sessionId: text(160), messageId: text(160) }).strict();

export const NeoPublicationSchema = z
  .object({
    conversationId: z.string().uuid(),
    publicationId: z.string().uuid(),
    askOrigin: origin,
    producerInput: origin,
    shortText: text(2000),
    fullText: text(16000),
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
    triggerId: text(200).optional(),
    askSummary: text(300).optional(),
    awaiting: text(500).optional(),
    editedAt: z.string().datetime().optional(),
    editedBy: text(160).optional(),
    answerInput: origin.optional(),
    answerOrigin: origin.optional(),
    languageMismatch: text(120).optional(),
    requestedLanguage: text(60).optional(),
    revisionId: z.uuid().optional(),
    revisions: z
      .array(
        z
          .object({
            revisionId: z.uuid(),
            shortText: text(2000),
            fullText: text(16000),
            createdAt: z.string().datetime(),
            producerInput: origin,
            askOrigin: origin.optional(),
            awaiting: text(500).optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

export const NeoPublicationResultSchema = z.union([
  z.object({ accepted: z.literal(false), reason: z.string(), detail: z.string().optional() }),
  z.object({
    accepted: z.literal(true),
    created: z.boolean(),
    publication: NeoPublicationSchema.extend({
      sequence: z.number().int().positive(),
      createdAt: z.string(),
    }),
    answered: z
      .object({ message: origin, publicationId: z.uuid(), revisionId: z.uuid() })
      .nullable(),
  }),
]);

export function withNeoPublicationAnswer(
  receipt:
    | { accepted: false; reason: string; detail?: string }
    | { accepted: true; created: boolean; publication: NeoPublication },
  message: { sessionId: string; messageId: string } | null
) {
  return receipt.accepted
    ? {
        ...receipt,
        answered: message
          ? {
              message,
              publicationId: receipt.publication.publicationId,
              revisionId: receipt.publication.revisionId ?? receipt.publication.publicationId,
            }
          : null,
      }
    : receipt;
}

export function admitNeoPublication(
  input: unknown
): { value: NeoPublicationInput } | { reason: 'invalid_publication' } {
  const parsed = NeoPublicationSchema.safeParse(input);
  return parsed.success ? { value: parsed.data } : { reason: 'invalid_publication' };
}
