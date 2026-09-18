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
      'Legacy field. Goal rolling state is owned by the goal owner, who reviews this outcome and applies updates via goal.reviewOutcome. Record your outcome in the task result instead of providing this.'
    ).optional(),
  })
  .strict();

export type MarkCompleteInput = z.infer<typeof MarkCompleteSchema>;
