# Prompt Builder Token Audit

**Audited:** 2026-05-28
**Scope:** Space/task/workflow/session prompt builders listed in Task #496
**Change type:** Research only; no prompt text changed

## Methodology

Token counts are approximate and use `characters / 4`, rounded to nearest useful value. This matches the task requirement and is sufficient for ranking bloat sources. Counts cover prompt text that can be emitted at runtime, not TypeScript comments unless noted.

Dynamic sections vary by task, Space settings, workflow size, goal history, memory hits, and worktree path length. Tables show current builder structure plus typical/observed ranges from code paths.

## Executive Summary

Largest savings are in repeated, long behavioral instructions embedded in workflow slot prompts and Space coordinator system prompt.

1. **Workflow reviewer/QA prompts repeat terminal-action, GitHub review, PR merge, `save_artifact`, and gate-writing rules across many nodes.** Estimated repeated text: **~2,000-3,500 tokens per workflow agent session**.
2. **Space coordinator system prompt is ~2,600 tokens before dynamic Space background/instructions.** It repeats tool descriptions and decision rules that tool schemas or workflow discovery can provide lazily.
3. **Task messages resend large Space context, standing instructions, memories, and previous work every activation.** Typical task message can exceed **~2,000 tokens**, with Space background/instructions dominating.
4. **Preset agent prompts and workflow slot prompts overlap.** Example: Research preset says write markdown, commit, open PR; Research workflow slot says same again. Coder preset and Coding slot also overlap.
5. **Worktree isolation prompt is ~260 tokens in every SDK session using Claude Code preset.** It also overlaps with task-message Runtime Location and standing instructions.

## Token Budget Tables

### Builder: `buildCustomAgentTaskMessage`

Source: `packages/daemon/src/lib/space/agents/custom-agent.ts`

Builds initial user message for task agents. Behavioral persona lives in system prompt, but factual context is resent on each session/activation.

| Section | Est. Tokens | Notes |
|---|---:|---|
| Your Task | ~60-400 | Title, description, priority. This task was ~185 tokens. |
| Runtime Location | ~35-80 | Worktree path + derived PR URL. Overlaps worktree system prompt. |
| Linked Goal | ~0-250 | Present only for goal-backed work. Includes progress, metrics, next steps, update instruction. |
| Relevant Scope Lessons | ~0-250 | Dynamic lessons; can grow with selected lesson count. |
| Your Role in This Workflow | ~40-150 | Workflow, node, peers, outbound channels, writable gates. Current task was ~55 tokens. |
| Previous Work on This Goal | ~0-400+ | Unbounded by count in builder; each summary added verbatim. |
| Core Memories | ~0-500 | Hard cap `CORE_MEMORY_PROMPT_CHAR_LIMIT = 2_000` chars, ~500 tokens. |
| Relevant Memories | ~0-125 per memory | Each content truncated to 500 chars, but count not capped here. |
| Project Context | ~0-1,500+ | `space.backgroundContext` verbatim; often CLAUDE/project context. |
| Standing Instructions | ~0-1,000+ | `space.instructions` + `workflow.instructions` verbatim. Current task instructions were ~360 tokens. |
| **TOTAL typical** | **~700-3,500+** | 4 KB soft warning only for workflow sessions; not a hard cap. |

Observations:

- Section comment order is stale: Standing Instructions comment says `7`, but actual section is after memories/project context.
- `Previous Work on This Goal` has no character or item limit in this builder.
- `Relevant Memories` truncates each memory but not total memory section.
- Project context and standing instructions are per-task user message content even when same worker session already has equivalent repo instructions through Claude Code preset.

### Builder: `buildCustomAgentSystemPrompt` / `resolveCustomAgentPrompt`

Source: `packages/daemon/src/lib/space/agents/custom-agent.ts`

Builds custom agent system prompt by concatenating base SpaceAgent prompt and workflow slot prompt.

| Section | Est. Tokens | Notes |
|---|---:|---|
| Base `SpaceAgent.customPrompt` | ~30-1,900 | Preset Reviewer is largest at ~1,890; simple agents ~35-90. |
| Workflow slot `customPrompt` | ~100-2,000+ | Built-in workflow slots append long role/process/tool rules. |
| Join overhead/provenance | ~0 | Hash/source only; not in prompt. |
| Claude Code preset | external | SDK preset applied separately. |
| **TOTAL typical** | **~150-3,900+** | Reviewer slots can combine ~1,890 base + ~1,000-2,000 slot tokens. |

Key issue: append-only model preserves both preset persona and slot persona. That avoids replacing user-visible agent config, but duplicates instructions when both say same job.

### Builder: preset agents in `seed-agents.ts`

Source: `packages/daemon/src/lib/space/agents/seed-agents.ts`

| Preset agent prompt | Est. Tokens | Notes |
|---|---:|---|
| Coder | ~70 | Implement, test, commit, open PR, do not merge. Duplicated by Coding workflow slot. |
| General | ~45 | Broad assistant role; minimal. |
| Planner | ~45 | Break down, write plan, commit. Duplicated by Plan workflow slot. |
| Research | ~55 | Research, write markdown, commit, open PR. Duplicated by Research workflow slot. |
| Coordinator | ~65 | Long-horizon Space coordination; overlaps long-horizon templates. |
| Reviewer (`REVIEWER_CUSTOM_PROMPT`) | ~1,890 | Full review process, sub-agent delegation, severity, terminal actions, GitHub posting, output format. Duplicated by workflow reviewer slots. |
| QA | ~45 | Run full test suite and report failures. Duplicated by QA workflow slot. |
| **TOTAL library** | **~2,215** | Only selected agent prompt is emitted per session. |

Largest prompt is Reviewer. It includes detailed GitHub posting commands and terminal-action rules; workflow reviewer slots add more GitHub/tool/gate rules.

### Builder: `buildSpaceChatSystemPrompt`

Source: `packages/daemon/src/lib/space/agents/space-chat-agent.ts`

| Section | Est. Tokens | Notes |
|---|---:|---|
| Identity | ~35 | Space Agent coordinator framing. |
| Available Workflows | ~25 + ~20/workflow | Lists IDs, tags, descriptions. Duplicates `list_workflows` capability. |
| Available Agents | ~10 + ~15/agent | Lists agent names/descriptions. |
| Creating Work — Decision Guide | ~1,000 | Task-first flow, workflow discovery, subagents, workflow picking guide, clarification rules. |
| Event Handling | ~250 | `[TASK_EVENT]` format and task_blocked/workflow_run_needs_attention/task_timeout handling. |
| Autonomy Level | ~120 | Varies by level; duplicates runtime gate/autonomy semantics. |
| Escalation | ~200 | Four-part structure plus example. |
| Coordination Tools | ~250 | Tool availability invariant and tool descriptions. Duplicates MCP tool schemas. |
| Task Agent Communication | ~250 | `send_message_to_task`, `list_task_members` descriptions. Duplicates tool schemas. |
| Multi-Session Coordination | ~110 | Shared MCP surface, bidirectional communication. |
| Space Background | variable | Operator-supplied, verbatim. |
| Space Instructions | variable | Operator-supplied, verbatim. |
| **TOTAL before dynamic context** | **~2,250-2,700** | Current prompt literals measure ~2,600 tokens. |

Main bloat: static tool descriptions and workflow-selection prose. Much of this belongs in tool schemas, workflow metadata, or lazy workflow detail calls.

### Builder: workflow node slot prompts in `built-in-workflows.ts`

Source: `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`

| Workflow / node slot | Est. Tokens | Notes |
|---|---:|---|
| Coding Workflow — coder | ~650 | Implementation steps, PR gate, review feedback handling, thread resolution. Duplicates Coder preset. |
| Coding Workflow — reviewer | ~1,350 | Review process, GitHub posting, gate writes, terminal actions, merge handoff. Duplicates Reviewer preset. |
| Research Workflow — research | ~250 | Research steps, PR deliverable, review feedback handling. Duplicates Research preset. |
| Research Workflow — reviewer | ~820 | Research review checklist, terminal actions, save artifact, approval/merge handoff. Duplicates Reviewer preset. |
| Review-Only Workflow — reviewer | ~950 | Terminal action preconditions, PR review requirement, artifact/approval flow. Duplicates Reviewer preset. |
| Plan & Decompose — planner | ~650 | Uses shared planning prompt + expected IO + handoff. Duplicates Planner preset. |
| Plan & Decompose — 4 plan reviewers | ~1,050 each | Shared `PD_PLAN_REVIEW_PROMPT` (~830) + lens (~200). Four parallel sessions pay ~4,200 total. |
| Plan & Decompose — task dispatcher | ~1,500 | Shared dispatcher prompt (~1,350) + expected IO/tool contract. Longest non-reviewer prompt. |
| Coding with QA — coder | ~300 | Shared fullstack coding + expected IO/steps. Duplicates Coder preset. |
| Coding with QA — reviewer | ~500 | Shared review prompt + expected IO/steps. Duplicates Reviewer preset. |
| Coding with QA — QA | ~1,250 | QA policy, trusted base QA instructions, UI validation, artifact schema, terminal rules. Duplicates QA preset. |

Shared constants measured in same file:

| Shared prompt constant | Est. Tokens | Notes |
|---|---:|---|
| `REVIEW_THREAD_RESOLUTION_GUIDANCE` | ~160 | Reused in coder/research feedback loops and task-level standing instruction. |
| `REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE` | ~90 | Reused in approval paths. |
| `PD_PLANNING_PROMPT` | ~370 | Planning role/process. |
| `PD_PLAN_REVIEW_PROMPT` | ~830 | Repeated once per plan-review lens session. |
| `PD_TASK_DISPATCHER_PROMPT` | ~1,350 | Heavy dispatcher instructions. |
| `FULLSTACK_CODING_PROMPT` | ~120 | Small. |
| `FULLSTACK_REVIEW_PROMPT` | ~365 | Moderate. |
| `FULLSTACK_QA_PROMPT` | ~1,060 | Heavy QA policy. |

### Builder: `resolveCurrentNodeAgentInitForExecution` and message composition

Source: `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`

This function does not author new prompt prose. It reloads current workflow node slot prompt on rehydrate and calls `resolveAgentInit`, which uses `createCustomAgentInit`.

| Component | Est. Tokens | Notes |
|---|---:|---|
| Legacy `systemPrompt` + `instructions` compatibility merge | variable | Combines legacy prompt fields with `\n\n`; can duplicate if migration left both. |
| Slot override custom prompt | see workflow table | Passed to custom-agent append path. |
| Runtime system prompt reset on rehydrate | same as original session | Ensures latest slot prompt is reapplied; can reintroduce bloat to old sessions. |
| Node-agent MCP server/tool schema | external | Not measured here; injected separately. |
| **TOTAL new prose** | **0** | Composition path only. |

Risk: legacy fallback can concatenate old `systemPrompt` and `instructions` that were semantically split before migration, preserving historical duplication.

### Builder: long-horizon agent templates

Source: `packages/daemon/src/lib/space/agents/long-horizon-agent-templates.ts`

| Template | Instructions tokens | Other prompt-ish metadata | Notes |
|---|---:|---:|---|
| Coordinator | ~65 | ~80 | Overlaps Coordinator preset. |
| Product Quality Manager | ~75 | ~100 | Event/reminder/ownership metadata also prompt-like if surfaced. |
| Release Manager | ~60 | ~95 | Release readiness, checks, notes. |
| Security Auditor | ~55 | ~90 | Security watch/audit. |
| Marketing | ~60 | ~90 | Positioning/content. |
| Sales | ~60 | ~95 | Pipeline/account follow-ups. |
| Research | ~65 | ~60 | Overlaps Research preset. |
| Family Ops/Chores | ~70 | ~100 | Household coordination. |
| **TOTAL template library** | **~510 instruction tokens** | **~710 metadata tokens** | Per-agent emission depends on template use. |

These are compact. Main redundancy is conceptual overlap with preset Coordinator/Research prompts and Space coordinator system prompt.

### Builder: `QueryOptionsBuilder.buildSystemPrompt`

Source: `packages/daemon/src/lib/agent/query-options-builder.ts`

| Section | Est. Tokens | Notes |
|---|---:|---|
| Claude Code preset selector | external | Uses SDK preset when enabled. |
| Custom `systemPrompt.append` | variable | Includes SpaceAgent custom prompt and workflow slot prompt for workers. |
| Worktree isolation append | ~260 | Added to preset/custom prompt when `session.worktree` exists. |
| Minimal worktree prompt | ~115 | Used only when Claude Code preset disabled. |
| **TOTAL HyperNeo-authored static** | **~260 per worktree SDK session** | Plus large custom append from agent/session config. |

Worktree isolation overlaps task-message Runtime Location and task standing instruction: all mention worktree/root constraints. The merge/push root-repo commands are likely irrelevant to most task agents and add ~60 tokens.

### Builder: `ContextFetcher`

Source: `packages/daemon/src/lib/agent/context-fetcher.ts`

| Section | Est. Tokens | Notes |
|---|---:|---|
| Prompt text emitted | 0 | Fetches context usage from SDK; no user/system prompt construction. |
| Context categories | telemetry only | Reports system prompt/tools/messages/free space. |

No prompt bloat found here.

### Builder: `system-prompt-builder.ts` or equivalent

No `packages/daemon/src/lib/agent/system-prompt-builder.ts` file exists in current tree. Equivalent logic is in `QueryOptionsBuilder.buildSystemPrompt` and `buildCustomSystemPrompt`.

## Redundancy Report

### 1. Preset agent prompt + workflow slot prompt repeat same job

Examples:

- Research preset: investigate, write markdown, commit, open PR.
- Research workflow slot: investigate thoroughly, document findings, commit, open PR.
- Coder preset: write code, tests, commit, open PR, do not merge.
- Coding workflow slot: implement, tests, commit, open PR, do not merge, reviewer handles merge.
- Planner preset: decompose goals, write plan, commit.
- Plan workflow slot: analyze goal, decompose, write `plan.md`, commit/open PR.
- QA preset: run test suite and report failures.
- Fullstack QA slot: detailed QA checks and failure reporting.

Savings: **~40-80 tokens per non-reviewer session**, **larger for Reviewer** if base reviewer prompt is made lean when workflow slot carries detailed process.

### 2. Reviewer instructions duplicated at three layers

Reviewer receives:

1. Reviewer preset prompt (~1,890 tokens): sub-agent delegation, review process, severity levels, terminal preconditions, GitHub posting, required output format.
2. Workflow reviewer slot (~500-1,350 tokens): review checklist, GitHub posting/gate writes, terminal action preconditions, save_artifact/approve/submit rules.
3. Task message role section (~40-150 tokens): channels and writable gates.

Repeated themes:

- Review diff plus surrounding code.
- Post feedback to GitHub, not just internal response.
- Request changes on any P0-P3 finding.
- `approve_task` / `submit_for_approval` are terminal.
- Save artifact before close.
- Do not merge; post-approval handles merge.
- Do not auto-merge.

Savings: **~900-1,800 tokens per reviewer session** by moving generic reviewer policy to one reusable system layer and keeping workflow slot only delta (target node, gate fields, expected artifacts).

### 3. Terminal-action semantics repeated across workflow prompts

Repeated in Coding Review, Research Review, Review-Only, Fullstack QA, and seed Reviewer prompt:

- `approve_task` and `submit_for_approval` close task/loop.
- Do not call them with open findings/failures.
- They must be final action.
- Human approval/autonomy may block self-close.

Savings: **~200-500 tokens per affected node** if tool descriptions or node-agent system contract owns terminal semantics once.

### 4. `save_artifact` schema and `pr_url` nesting repeated

Multiple prompts say `save_artifact({ type: "result", append: true, summary, data: { pr_url: "<url>" } })` and warn top-level `pr_url` is stripped.

Savings: **~80-180 tokens per review/QA node** by improving MCP tool schema/description or central node-agent contract.

### 5. GitHub review posting commands repeated

Reviewer preset includes REST `gh api` review/comment examples. Workflow reviewer slots include `gh pr review` and `gh api` examples again.

Savings: **~250-500 tokens per reviewer session** by keeping one canonical GitHub review procedure, referenced by compact key from workflow slots.

### 6. Space coordinator prompt duplicates tool schemas

`buildSpaceChatSystemPrompt` describes `create_standalone_task`, `get_task_detail`, `retry_task`, `cancel_task`, `reassign_task`, `send_message_to_task`, and `list_task_members`. These are already exposed as MCP tools with schemas/descriptions.

Savings: **~400-600 tokens per Space chat session** by cutting repeated descriptions to tool-selection policy only.

### 7. Workflow catalog in coordinator prompt duplicates workflow discovery tools

Space prompt lists available workflows and includes a long workflow picking guide, while also instructing agent to call `list_workflows`, `suggest_workflow`, and `get_workflow_detail`.

Savings: **~400-700 tokens per Space chat session** by relying on `suggest_workflow`/`get_workflow_detail` for detailed shape and keeping only task-first rule.

### 8. Project context and standing instructions resent per task

`space.backgroundContext`, `space.instructions`, and `workflow.instructions` go into each task message. Agents also receive Claude Code preset context from settings/CLAUDE.md and user global/project instructions in system context. In iterative workflows, reactivated sessions may retain prior context but still get new messages containing repeated instructions.

Savings: **~500-2,000+ tokens per activation** depending on Space configuration by placing stable instructions in session system prompt at creation and sending diffs/summaries on later activations.

### 9. Worktree isolation repeated with runtime location

Worktree isolation system prompt names worktree path, branch, main repo, root repo restrictions. Task message Runtime Location repeats worktree path and PR state.

Savings: **~30-80 tokens per task message** by keeping only PR/worktree ID in user message when system prompt already has full isolation text. Larger **~60 tokens** if root merge/push examples removed from isolation prompt for agents that should not merge.

## Simplification Recommendations Ranked by Savings

### 1. Factor reviewer/terminal-action contract into central node-agent system contract

**Current cost:** ~1,890-token Reviewer preset + ~500-1,350-token workflow slot per reviewer.

**Change:** Put generic reviewer policy and terminal-action semantics in one reusable reviewer system prompt or node-agent contract. Workflow slot contains only:

- workflow role (`Coding→Review`, `Research→Review`, etc.)
- upstream target
- gate fields to write
- artifact data required
- approval/failure branch delta

**Estimated savings:** **~900-1,800 tokens per reviewer session**, **~3,000-6,000 tokens** in Plan & Decompose because four plan reviewers each receive shared review prose.

### 2. Move `approve_task` / `submit_for_approval` semantics into tool descriptions/runtime guard errors

**Current cost:** repeated in every review/QA prompt.

**Change:** Enrich MCP tool descriptions to say terminal/final-action semantics. Prompt slots can say “follow terminal-action tool contract.” Runtime already enforces state transitions; tool error can explain violations.

**Estimated savings:** **~200-500 tokens per review/QA node session**.

### 3. Replace repeated GitHub review command examples with a compact reusable procedure

**Current cost:** reviewer preset + workflow slots duplicate `gh pr review`/`gh api` examples.

**Change:** Keep one canonical GitHub review procedure in Reviewer base prompt or skill; workflow slots reference “post visible GitHub review before gate write.”

**Estimated savings:** **~250-500 tokens per reviewer session**.

### 4. Trim Space coordinator system prompt by lazy-loading workflows/tools

**Current cost:** ~2,600 static tokens before Space background/instructions.

**Change:** Keep only core invariants:

- create tasks with `create_standalone_task`
- ask clarification when vague
- use workflow tools before selecting workflow
- obey autonomy level and escalate when blocked

Move workflow selection details to `suggest_workflow`/`get_workflow_detail` output. Remove tool descriptions covered by schemas.

**Estimated savings:** **~900-1,300 tokens per Space chat session**.

### 5. Cap and summarize dynamic task-message context

**Current cost:** unbounded previous summaries, relevant memories count, background context, instructions.

**Change:** Add total section caps:

- Previous Work: latest N or summarized to ~200 tokens.
- Relevant Memories: total ~500 tokens, not only per-memory cap.
- Project Context: send summary by default; lazy-load full context through file/tool when needed.
- Standing Instructions: stable instructions in system prompt once; task message includes only workflow/task-specific deltas.

**Estimated savings:** **~500-2,000+ tokens per task activation** in large Spaces.

### 6. Split base agent persona from workflow operating procedure

**Current cost:** append-only base + slot duplicates role.

**Change:** Base prompt should define durable skill/persona only. Workflow slot should define run-specific procedure. Avoid both saying deliverables like “commit and open PR.”

**Estimated savings:** **~40-100 tokens per non-reviewer session**, more when base Reviewer is trimmed.

### 7. Shorten worktree isolation prompt for worker agents

**Current cost:** ~260 tokens per worktree SDK session.

**Change:** Keep hard constraints and paths. Remove root merge/push examples from normal worker sessions, especially coder/research agents that must open PRs not merge. Provide merge command only in post-approval merge template.

**Estimated savings:** **~60-100 tokens per worktree session**.

### 8. Compact Plan & Decompose shared reviewer prompt

**Current cost:** `PD_PLAN_REVIEW_PROMPT` ~830 tokens emitted to four reviewers = ~3,320 tokens before lens deltas.

**Change:** Put common plan-review rubric in one shared system/tool contract or shorten to checklist. Lens prompts remain per reviewer.

**Estimated savings:** **~1,500-2,500 tokens per Plan & Decompose run**.

### 9. Compact QA prompt and policy references

**Current cost:** Fullstack QA slot ~1,250 tokens.

**Change:** Move trusted QA instruction loading and artifact schema into QA base/system contract or tool schema. Slot keeps only current workflow gate/output requirements.

**Estimated savings:** **~400-700 tokens per QA session**.

## Architecture Notes: What Belongs Where

### System prompt (sent once per session)

Best for stable, high-priority behavioral contracts:

- Agent identity/persona: coder, reviewer, QA, planner, research.
- Generic safety and tool semantics: terminal actions, no auto-merge, artifact schema expectations.
- Worktree isolation constraints.
- Stable Space instructions that apply to every turn in that session.
- Reviewer severity rubric and GitHub review procedure, if reviewer-specific.

Avoid putting task-specific facts here because rehydrate/session reuse can make them stale.

### Task message (sent per task/activation)

Best for facts that change per run:

- Task title/description/priority.
- Current PR URL or “none yet”.
- Current workflow node, channels, writable gates.
- Current review feedback URLs or gate data.
- Linked goal state summary and latest next steps.
- Small, ranked memory/context excerpts relevant to this task.

Should avoid repeating generic operating procedure already in system prompt.

### Slot prompt (sent per workflow node/session)

Best for workflow-specific deltas:

- Node role in this workflow.
- Expected inputs and outputs.
- Exact gate fields this slot must write.
- Upstream/downstream channel names.
- Workflow-specific stop/continue branches.

Should not restate global reviewer/coder/QA process unless it differs from base persona.

### Lazy-loaded context

Best for large or rarely needed content:

- Full workflow catalog and node graph: use `list_workflows`, `suggest_workflow`, `get_workflow_detail`.
- Full project docs / CLAUDE.md: read only when needed; include compact summary initially.
- Long previous-work history: provide latest summary; fetch artifacts on demand.
- Full memory records: inject top hits only; expose search tool for more.
- GitHub API command recipes: put in skill/tool docs or retrieved procedure, not every prompt.

## Coverage Checklist

- `buildCustomAgentTaskMessage`: covered.
- `seed-agents.ts` slot/preset prompts for coder, reviewer, QA, planner, research: covered.
- `buildSpaceChatSystemPrompt`: covered.
- `built-in-workflows.ts` workflow node prompts for coder, reviewer, QA, planner, research, task dispatcher: covered via current path `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`.
- `resolveCurrentNodeAgentInitForExecution` and message composition: covered.
- `long-horizon-agent-templates.ts`: covered.
- `query-options-builder.ts`: covered.
- `context-fetcher.ts`: covered as no prompt emission.
- `system-prompt-builder.ts` equivalent: covered in `QueryOptionsBuilder`; standalone file not present.

## Concrete Follow-Up Plan

1. Create central node-agent contract for terminal tool semantics and artifact schema.
2. Slim Reviewer base prompt to generic review rubric; slim workflow reviewer slots to gate/workflow deltas.
3. Trim Space coordinator prompt to core rules and rely on workflow/tool calls for detailed catalogs.
4. Add total caps for `Previous Work`, `Relevant Memories`, and `Project Context` in `buildCustomAgentTaskMessage`.
5. Move root merge/push worktree examples into post-approval merge-only prompt path.
6. Add prompt budget tests/snapshots for major builders with fixture contexts and fail on >10% growth.
