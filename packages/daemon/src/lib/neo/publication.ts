import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
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
            kind: z.enum(['concern', 'work', 'consultation']),
            id: text(160),
          })
          .strict()
      )
      .max(16),
  })
  .strict();

export function admitNeoPublication(
  input: unknown
): { value: NeoPublicationInput } | { reason: 'invalid_publication' } {
  const parsed = NeoPublicationSchema.safeParse(input);
  return parsed.success ? { value: parsed.data } : { reason: 'invalid_publication' };
}
