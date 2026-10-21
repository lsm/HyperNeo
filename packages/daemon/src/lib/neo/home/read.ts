import type { HomeFailure } from './conflicts.ts';
import { z } from 'zod';

export const HomeReadInput = z.object({ path: z.string().min(1) });
export const HomeReadResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string(), questionId: z.string().optional() }),
  z.object({
    ok: z.literal(true),
    path: z.string(),
    content: z.string(),
    sha256: z.string(),
  }),
]);
export type HomeReadInput = z.infer<typeof HomeReadInput>;
export type HomeReadResult = z.infer<typeof HomeReadResult> | HomeFailure;
