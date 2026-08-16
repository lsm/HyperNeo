/**
 * Task Agent MCP Tool Schemas — Zod schemas and TypeScript types for the
 * tools available to the Task Agent session (send_message schema is shared
 * from node-agent-tool-schemas.ts).
 *
 * Tools (defined in this file):
 *   approve_task          — self-close the task (gated by autonomy level)
 *   submit_for_approval   — request human sign-off
 *   mark_complete         — finish post-approval work (`approved → done`)
 *   request_human_input   — pause execution and surface a question to the human user
 *   list_group_members    — list all members of the current task's session group
 *
 * This file is consumed by the MCP server factory. It intentionally
 * contains only schema definitions — no runtime logic or side effects.
 *
 * Style conventions (matching space-agent-tools.ts):
 *   - z.string().describe() on every field — .describe() before .optional()
 *   - optional fields use .optional() after .describe()
 *   - enum fields use z.enum([...])
 *
 * Note: For append-only audit records, use `save_artifact` (from
 * node-agent-tool-schemas.ts) with `append: true`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// approve_task
// ---------------------------------------------------------------------------

/**
 * Schema for `approve_task` input.
 *
 * Agent-self-close tool for end-node agents and the Task Agent. Conditionally
 * registered on the MCP server only when `space.autonomyLevel >= workflow.completionAutonomyLevel`.
 * Calling this tool sets `space_tasks.reportedStatus = 'done'`, triggering the
 * completion-action pipeline on the next runtime tick.
 *
 * Takes no arguments — the task, workflow, and node are implicit from the
 * calling session's context. Strict schema so future fields fail fast until
 * explicitly added.
 *
 * Pre-conditions (enforced by the agent's prompt, not the schema):
 *   - For review-style end-node agents: your verdict on the current round MUST
 *     be APPROVE (zero P0–P3 findings) AND any prior-round P0–P3 findings must
 *     be resolved in the commits you've reviewed.
 *   - This tool is a TERMINAL ACTION: it closes the review loop. Do NOT call
 *     it while findings are open — request changes and continue the loop instead.
 */
export const ApproveTaskSchema = z
  .object({})
  .strict()
  .describe(
    'Self-close the task as APPROVED. TERMINAL final action: closes the review/QA/workflow loop and should be your last tool call. Pre-condition: work is APPROVED/QA-passed, zero P0–P3 findings remain, prior findings are addressed, and required review/artifact evidence has been saved. While findings, QA failures, or dispatch work are open, request changes or continue the loop instead — do NOT call this tool.'
  );

export type ApproveTaskInput = z.infer<typeof ApproveTaskSchema>;

// ---------------------------------------------------------------------------
// submit_for_approval
// ---------------------------------------------------------------------------

/**
 * Schema for `submit_for_approval` input.
 *
 * Always available to end-node agents and the Task Agent (independent of
 * autonomy level). Marks the task as awaiting human sign-off: sets
 * `task.status = 'review'` and populates the pending-completion fields so the
 * UI can route a human to approve or reject. Even at high autonomy levels this
 * remains available — agents may want to escalate a risky result for attention.
 *
 * IMPORTANT: This tool is TERMINAL — it closes the review loop. It carries the
 * same approval semantic as `approve_task` ("the work is approved by me, but
 * autonomy rules block me from self-closing, so a human must rubber-stamp the
 * final close"). It is NOT a way to defer judgment while findings are open.
 *
 * Pre-conditions (enforced by the agent's prompt, not the schema):
 *   - Your current-round verdict MUST be APPROVE (zero P0–P3 findings) AND any
 *     prior-round P0–P3 findings must be resolved in the commits you've reviewed.
 *   - Do NOT use `submit_for_approval` to defer judgment while findings are
 *     open — request changes and continue the loop instead.
 */
export const SubmitForApprovalSchema = z
  .object({
    /**
     * Optional human-readable reason for requesting review. Surfaces in the
     * approval UI so the human reviewer knows why the agent escalated.
     */
    reason: z
      .string()
      .describe(
        'Optional note explaining why you are requesting human review (visible in the approval UI)'
      )
      .optional(),
  })
  .strict()
  .describe(
    'Request human sign-off as the final close action. TERMINAL final action: closes the review/QA/workflow loop and should be your last tool call. Same approval semantic as approve_task (both signal work is APPROVED by you). Pre-condition: work is APPROVED/QA-passed, zero P0–P3 findings remain, prior findings are resolved, and required review/artifact evidence has been saved. Do NOT use this to defer judgment while findings, QA failures, or dispatch work are open — request changes or continue the loop instead.'
  );

export type SubmitForApprovalInput = z.infer<typeof SubmitForApprovalSchema>;

// ---------------------------------------------------------------------------
// mark_complete
// ---------------------------------------------------------------------------

/**
 * Schema for `mark_complete` input.
 *
 * Post-approval completion tool. Added in PR 2/5 of the
 * task-agent-as-post-approval-executor refactor. Transitions the task from
 * `approved → done` once the post-approval agent (the Task Agent itself when
 * the workflow's `postApproval.targetAgent === 'task-agent'`, or a spawned
 * space-task-node-agent sub-session otherwise) has finished its work.
 *
 * Distinct from `approve_task`:
 *   - `approve_task`  covers `in_progress → approved` (work is good).
 *   - `mark_complete` covers `approved → done`       (post-approval finished).
 *
 * Takes no arguments — the task is implicit from the calling session's
 * context. Strict schema so future fields fail fast until explicitly added.
 */
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

// ---------------------------------------------------------------------------
// complete_validation_task
// ---------------------------------------------------------------------------

/**
 * Schema for `complete_validation_task` input (task #918).
 *
 * Validation-only (no-PR) completion — node-agent-exclusive (like
 * `mark_complete`), NOT shipped on `space-agent-tools`, and OPT-IN: a
 * workflow-backed task is only eligible when its workflow definition
 * declares an enabled `complete_validation_task` hook (the explicit
 * signal that the validation-only close is legitimate — inferring
 * eligibility cannot distinguish a PR workflow that gates its handoff
 * with a script validator). Captures the
 * validation outcome as `task.result` and transitions
 * `review`/`in_progress → done` without a pr_url, for tasks that complete
 * via validation rather than a reviewed PR (Forge review/automation,
 * diagnostics, already-complete work). Autonomy-gated to the workflow's
 * `completionAutonomyLevel`; rejects tasks whose run already has a PR.
 *
 * Intentionally not registered on any Task-Agent surface map: this tool is
 * wired exclusively through NodeAgentToolsConfig.onCompleteValidationTask
 * (workflow node agents), and no orchestration surface carries it.
 */
export const CompleteValidationTaskSchema = z
  .object({
    task_id: z.string().describe('ID of the no-PR task to complete'),
    validation_outcome: z
      .string()
      .min(1)
      .describe(
        'The validation result/outcome — what was checked and the verdict. Captured as the task result.'
      ),
    reason: z.string().describe('Optional note recorded on the task (approvalReason)').optional(),
  })
  .strict();

export type CompleteValidationTaskInput = z.infer<typeof CompleteValidationTaskSchema>;

// ---------------------------------------------------------------------------
// request_human_input
// ---------------------------------------------------------------------------

/**
 * Schema for `request_human_input` input.
 * Pauses workflow execution and surfaces a question to the human user.
 */
export const RequestHumanInputSchema = z.object({
  /** The question to ask the human. */
  question: z.string().describe('The question to surface to the human user'),
  /** Optional context to help the human understand why the question is being asked. */
  context: z
    .string()
    .describe('Optional context explaining why this question is being asked')
    .optional(),
});

export type RequestHumanInputInput = z.infer<typeof RequestHumanInputSchema>;

// ---------------------------------------------------------------------------
// list_group_members
// ---------------------------------------------------------------------------

/**
 * Schema for `list_group_members` input.
 * Lists all members of the current task's session group with their permitted channels.
 * No arguments — the group is inferred from the task context.
 */
export const ListGroupMembersSchema = z.object({});

export type ListGroupMembersInput = z.infer<typeof ListGroupMembersSchema>;

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

/**
 * Schema for `update_task` input.
 *
 * Edit an existing task's title, description, priority, or dependencies.
 * The task must be the current task managed by this Task Agent session.
 * Other tasks in the space cannot be modified through this tool.
 */
export const UpdateTaskSchema = z.object({
  task_id: z.string().describe('UUID of the task to update'),
  title: z.string().min(1).describe('New title for the task').optional(),
  description: z.string().describe('New description for the task').optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).describe('New priority').optional(),
  depends_on: z.array(z.string()).describe('New dependency list (replaces existing)').optional(),
});

export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

// ---------------------------------------------------------------------------
// Aggregate export for MCP server factory
// ---------------------------------------------------------------------------

/**
 * All Task Agent tool schemas keyed by tool name.
 * The MCP server factory can iterate this map to register tools.
 */
export const TASK_AGENT_TOOL_SCHEMAS = {
  approve_task: ApproveTaskSchema,
  submit_for_approval: SubmitForApprovalSchema,
  mark_complete: MarkCompleteSchema,
  request_human_input: RequestHumanInputSchema,
  list_group_members: ListGroupMembersSchema,
  update_task: UpdateTaskSchema,
} as const;

export type TaskAgentToolName = keyof typeof TASK_AGENT_TOOL_SCHEMAS;
