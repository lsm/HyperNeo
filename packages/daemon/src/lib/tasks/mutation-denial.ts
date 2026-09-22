import { z } from 'zod';

export const TaskMutationDenialSchema = z.object({
  accepted: z.literal(false),
  reason: z.enum([
    'task_update_denied',
    'task_transition_denied',
    'task_workflow_selection_denied',
  ]),
});
export type TaskMutationDenial = z.infer<typeof TaskMutationDenialSchema>;
