import { z } from 'zod';

export const NeoReadWorkTarget = z
  .object({
    verb: z.literal('read'),
    operation: z.string().trim().min(1).max(160),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
