import { z } from 'zod';

export const ApproveTaskSchema = z
  .object({})
  .strict()
  .describe(
    'Self-close the task as APPROVED. TERMINAL final action: closes the review/QA/workflow loop and should be your last tool call. Pre-condition: work is APPROVED/QA-passed, zero P0–P2 findings remain, prior findings are addressed, and required review/artifact evidence has been saved. While findings, QA failures, or dispatch work are open, request changes or continue the loop instead — do NOT call this tool.'
  );

export type ApproveTaskInput = z.infer<typeof ApproveTaskSchema>;

export const SubmitForApprovalSchema = z
  .object({
    reason: z
      .string()
      .describe(
        'Optional note explaining why you are requesting human review (visible in the approval UI)'
      )
      .optional(),
  })
  .strict()
  .describe(
    'Request human sign-off as the final close action. TERMINAL final action: closes the review/QA/workflow loop and should be your last tool call. Same approval semantic as approve_task (both signal work is APPROVED by you). Pre-condition: work is APPROVED/QA-passed, zero P0–P2 findings remain, prior findings are resolved, and required review/artifact evidence has been saved. Do NOT use this to defer judgment while findings, QA failures, or dispatch work are open — request changes or continue the loop instead.'
  );

export type SubmitForApprovalInput = z.infer<typeof SubmitForApprovalSchema>;

export const GoalUpdateSchema = z
  .object({
    summary: z.string().describe('Updated rolling summary for the linked goal').optional(),
    progress: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe('Updated goal progress percentage from 0 to 100')
      .optional(),
    metrics: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .describe('Updated structured metric state for the linked goal')
      .optional(),
    nextSteps: z
      .array(z.string())
      .describe('Updated list of next steps for the linked goal')
      .optional(),
  })
  .strict();

export const MarkCompleteSchema = z
  .object({
    goal_update: GoalUpdateSchema.describe(
      "Optional rolling-state update for the task's linked goal. Provide this when completed work changes long-horizon goal state."
    ).optional(),
  })
  .strict();

export type MarkCompleteInput = z.infer<typeof MarkCompleteSchema>;

export const RequestHumanInputSchema = z.object({
  question: z.string().describe('The question to surface to the human user'),
  context: z
    .string()
    .describe('Optional context explaining why this question is being asked')
    .optional(),
});

export type RequestHumanInputInput = z.infer<typeof RequestHumanInputSchema>;

export const ListGroupMembersSchema = z.object({});

export type ListGroupMembersInput = z.infer<typeof ListGroupMembersSchema>;

export const UpdateTaskSchema = z.object({
  task_id: z.string().describe('UUID of the task to update'),
  title: z.string().min(1).describe('New title for the task').optional(),
  description: z.string().describe('New description for the task').optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).describe('New priority').optional(),
  depends_on: z.array(z.string()).describe('New dependency list (replaces existing)').optional(),
});

export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export const TASK_AGENT_TOOL_SCHEMAS = {
  approve_task: ApproveTaskSchema,
  submit_for_approval: SubmitForApprovalSchema,
  mark_complete: MarkCompleteSchema,
  request_human_input: RequestHumanInputSchema,
  list_group_members: ListGroupMembersSchema,
  update_task: UpdateTaskSchema,
} as const;

export type TaskAgentToolName = keyof typeof TASK_AGENT_TOOL_SCHEMAS;
