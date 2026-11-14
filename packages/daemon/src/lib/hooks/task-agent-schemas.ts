import { z } from 'zod';

export const ApproveTaskSchema = z
  .object({})
  .strict()
  .describe(
    'Self-close the task as APPROVED. TERMINAL final action: closes the review/QA/workflow loop and should be your last tool call. Pre-condition: work is APPROVED/QA-passed, zero P0–P2 findings remain, prior findings are addressed, and required review/artifact evidence has been saved. While findings, QA failures, or dispatch work are open, request changes or continue the loop instead — do NOT call this tool.'
  );

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

export const MarkCompleteSchema = z.object({}).strict();
