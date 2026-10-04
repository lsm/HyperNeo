import { z } from 'zod';

export const WorkStatusSchema = z.enum([
  'queued',
  'running',
  'needs_you',
  'done',
  'failed',
  'stopped',
]);

export const PlaceSchema = z.object({
  machine: z.string(),
  folder: z.string().optional(),
  spaceId: z.string().optional(),
  name: z.string(),
});

export const WorkRefSchema = z.object({
  adapter: z.string().min(1),
  daemon: z.string().min(1).optional(),
  id: z.string().min(1),
});

export const WorkSummarySchema = z.object({
  ref: WorkRefSchema,
  title: z.string(),
  place: PlaceSchema,
  status: WorkStatusSchema,
  lastActivityAt: z.number(),
  link: z.string().optional(),
});

export const PlaceGroupSchema = z.object({
  place: PlaceSchema,
  lastActivityAt: z.number(),
  openCount: z.number().int().nonnegative(),
  archivedCount: z.number().int().nonnegative(),
  adapters: z.array(z.string()),
  work: z.array(WorkSummarySchema),
});

export type WorkStatus = z.infer<typeof WorkStatusSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type WorkRef = z.infer<typeof WorkRefSchema>;
export type WorkSummary = z.infer<typeof WorkSummarySchema>;
export type PlaceGroup = z.infer<typeof PlaceGroupSchema>;

export type WorkVerb = 'find' | 'start' | 'send' | 'status' | 'stop';

export interface FindQuery {
  text?: string;
  folder?: string;
  spaceId?: string;
  includeClosed: boolean;
  limit: number;
}

export interface WorkAdapter {
  readonly id: string;
  readonly capabilities: readonly WorkVerb[];
  find(query: FindQuery): PlaceGroup[] | Promise<PlaceGroup[]>;
}
