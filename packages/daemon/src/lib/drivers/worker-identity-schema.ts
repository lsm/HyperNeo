import { z } from 'zod';
export const WorkerIdentitySchema = z.object({
  id: z.string(),
  adapter: z.string(),
  name: z.string().nullable(),
  label: z.string(),
  daemon: z.string().optional(),
});
