/**
 * Space Chat Agent — System prompt builder for the Space's conversational coordinator.
 *
 * The Space chat agent is the interactive session where the human user talks to an
 * AI coordinator that manages work within the Space. It is workflow-aware: it knows
 * which workflows are available, what agents exist, and can recommend workflows or
 * kick off standalone tasks.
 *
 * This file is in the Space namespace — it does NOT modify Room agent prompts.
 *
 * ## Tool contract
 * The prompt references the following tools by name. They must be registered in the
 * MCP server(s) composed with this agent's session at runtime:
 *
 *   All tools are provided by createSpaceAgentMcpServer in space-agent-tools.ts:
 *     Workflow tools:
 *       - list_workflows
 *       - get_workflow_run
 *       - change_plan
 *       - get_workflow_detail
 *       - suggest_workflow
 *     Task tools:
 *       - list_tasks
 *       - create_standalone_task
 *       - get_task_detail
 *       - retry_task
 *       - cancel_task
 *       - reassign_task
 *     Task agent communication tools:
 *       - send_message_to_task
 *       - list_task_members
 *
 * See: docs/plans/multi-agent-v2-customizable-agents-workflows/07-workflow-selection-intelligence.md
 */

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

import type { SpaceAutonomyLevel } from '@hyperneo/shared/types/space';

/** Minimal workflow summary for prompt embedding (avoids exposing full node graph). */
export interface WorkflowSummary {
  id: string;
  /** Human-readable slug usable as an alternative identifier in tool calls. */
  handle?: string;
  name: string;
  description?: string;
  tags: string[];
  /** Number of nodes in the workflow — gives the agent a complexity signal. */
  nodeCount: number;
}

/** Minimal agent summary for prompt embedding. */
export interface AgentSummary {
  id: string;
  name: string;
  description?: string;
}

export interface SpaceChatAgentContext {
  /** Optional Space background context (operator-supplied). */
  background?: string;
  /** Optional Space instructions (operator-supplied). */
  instructions?: string;
  /** Workflows available in this Space. */
  workflows?: WorkflowSummary[];
  /** Agents configured in this Space. */
  agents?: AgentSummary[];
  /** Autonomy level for this Space — controls how much the agent can decide without human approval. */
  autonomyLevel?: SpaceAutonomyLevel;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the Space chat agent.
 *
 * The prompt includes:
 *   1. Role and purpose statement
 *   2. Available workflows (names, descriptions, tags, node count)
 *   3. Available agents (names, descriptions)
 *   4. Task-first guidance for workflow-aware execution
 *   5. Operator-supplied background and instructions
 *
 * Background and instructions are interpolated directly — they are
 * operator-controlled fields on a self-hosted tool so no sanitization is needed.
 */
export function buildSpaceChatSystemPrompt(context: SpaceChatAgentContext = {}): string {
  const sections: string[] = [];

  sections.push(
    `You are the Space Agent — HyperNeo's conversational coordinator for creating, inspecting, ` +
      `and unblocking work in a Space.`
  );

  if (context.workflows && context.workflows.length > 0) {
    sections.push(`\n## Workflow Summary\n`);
    sections.push(
      `Configured workflows are listed below for quick naming only. Use \`suggest_workflow\` and ` +
        `\`get_workflow_detail\` for selection details, steps, gates, and workflow-specific rules.`
    );
    for (const wf of context.workflows) {
      const tagStr = wf.tags.length > 0 ? ` [${wf.tags.join(', ')}]` : '';
      sections.push(`- **${wf.name}** (id: \`${wf.id}\`, ${wf.nodeCount} node(s))${tagStr}`);
    }
  } else {
    sections.push(`\n## Workflow Summary\n\nNo workflows are currently configured in this Space.`);
  }

  if (context.agents && context.agents.length > 0) {
    sections.push(`\n## Agents\n`);
    for (const agent of context.agents) {
      const desc = agent.description ? ` — ${agent.description}` : '';
      sections.push(`- **${agent.name}**${desc}`);
    }
  }

  sections.push(`\n## Work Creation\n`);
  sections.push(
    `Create real work with \`create_standalone_task\`; runtime attaches and starts workflows. ` +
      `Never start workflow runs directly. For multi-step or ambiguous work, call ` +
      `\`suggest_workflow\` then \`get_workflow_detail\` before creating the task. Ask clarifying ` +
      `questions only to understand the request — when scope or success criteria are genuinely ` +
      `unclear — not to hand back to the user decisions you could reasonably make yourself. Do not ` +
      `create tasks from vague goals.`
  );

  sections.push(`\n## Subagents\n`);
  sections.push(
    `Use SDK Task/TaskOutput/TaskStop only for quick read-only investigation. If implementation, ` +
      `PR work, or persisted artifacts are needed, create a standalone task instead.`
  );

  sections.push(`\n## Event Handling\n`);
  sections.push(
    `SpaceRuntime may inject [TASK_EVENT] JSON for task_blocked, workflow_run_needs_attention, ` +
      `or task_timeout. Inspect with get_task_detail/get_workflow_run, then recommend retry, ` +
      `reassign, cancel, wait, or human escalation according to autonomy level.`
  );

  const level = context.autonomyLevel ?? 1;
  sections.push(`\n## Autonomy Level\n`);
  sections.push(`This Space is configured at autonomy level **${level}** (scale 1-5).`);
  // Decision-style guidance graduates with the level. Autonomy level is fundamentally a
  // risk-tolerance threshold for checkpoints (space.autonomyLevel >= requiredLevel auto-passes
  // a gate); the text below derives *decision style* (act vs. ask) from it, gated on
  // reversibility rather than "uncertainty" — a coordinator is always somewhat uncertain, so
  // treating uncertainty as an escalation trigger caused over-escalation at L4.
  if (level === 5) {
    sections.push(
      `Act broadly, then report. Make the best decision even when unsure and carry out routine ` +
        `actions — including normally irreversible ones — yourself, then report what you did. ` +
        `Escalate only when you are genuinely blocked or an action would be catastrophic and ` +
        `irreversible. Never bypass gates above the current level.`
    );
  } else if (level === 4) {
    sections.push(
      `Default to acting, then reporting. Routine routing, single retries, and reassignments are ` +
        `reversible — do them and tell the user what you did; do not ask permission first. Escalate ` +
        `ONLY when (a) a retry has already failed once, (b) the action is irreversible, high-cost, ` +
        `or crosses a boundary that cannot be undone, or (c) a wrong guess would be costly AND not ` +
        `recoverable. When genuinely torn between two safe, reversible options, pick the better one ` +
        `and report it rather than asking. Never bypass gates above the current level.`
    );
  } else if (level === 3) {
    sections.push(
      `You may act on routine, reversible decisions without asking — retry a failed task once, ` +
        `reassign when clearly better, or re-route work — then report what you did. Confirm with the ` +
        `user before any irreversible or high-cost action. Escalate after one failed retry, or when ` +
        `an action is irreversible and needs sign-off. Never bypass gates above the current level.`
    );
  } else {
    // Levels 1–2: recommend and wait for explicit human instruction.
    sections.push(
      `Do not retry, reassign, or cancel without explicit human instruction. Provide recommendation ` +
        `and wait.`
    );
  }

  sections.push(`\n## Escalation\n`);
  if (level >= 3) {
    sections.push(
      `When escalating, state what happened, the options considered, and your recommendation. ` +
        `Prefer acting and reporting over asking — include one direct question only if you genuinely ` +
        `cannot proceed without input.`
    );
  } else {
    sections.push(
      `When escalating, state what happened, options considered, recommendation, and one direct ` +
        `question.`
    );
  }

  sections.push(`\n## Coordination Invariants\n`);
  sections.push(
    `space-agent-tools MCP must be available every turn, including after compaction/resume. If ` +
      `coordination tools are missing, tell the user the Space MCP surface is unavailable; use ` +
      `space-coordination fallback only when direct coordination is still required. Task agents may ` +
      `message you; verify sender task/workflow context before acting.`
  );

  if (context.background) {
    sections.push(`\n## Space Background\n\n${context.background}`);
  }

  if (context.instructions) {
    sections.push(`\n## Space Instructions\n\n${context.instructions}`);
  }

  return sections.join('\n');
}
