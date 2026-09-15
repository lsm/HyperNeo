# Milestone 2: Enhanced Node Agent Prompts

## Goal and Scope

Upgrade the system prompts for planner, coder, reviewer, and QA node agents in the Space system. Prompts must include git workflow, PR management, review posting, and — critically — instructions for interacting with gate data stores via `list_gates`/`read_gate`/`write_gate` MCP tools.

**Dependency note**: M2 depends on both M1 (unified gate with MCP tools) and M3 (V2 workflow template). Prompts reference specific gate IDs from the V2 workflow (e.g., `code-pr-gate`, `review-votes-gate`). **Implement M3 before M2** so the concrete gate IDs exist. The prompts use the gate IDs injected via workflow context (M1 Task 1.3 subtask 5) and reference them by the `description` field from the gate definitions. Since all gates use the same `read_gate`/`write_gate` tools, prompts don't need type-specific instructions — just "write data to gate X".

**Gate discovery pattern**: All prompts include a standard preamble: "At session start, call `list_gates` to discover available gates and their IDs. Your task message also includes a `workflowContext` block with your upstream/downstream gate IDs."

## Tasks

### Task 2.1: Enhance Coder Node Agent System Prompt

**Description**: Update `buildCustomAgentSystemPrompt()` in `packages/daemon/src/lib/agents/custom-agent.ts` to include full git workflow instructions, PR creation, and gate data writing — mirroring the Room system's `buildCoderSystemPrompt()`.

**Subtasks**:
1. Read `packages/daemon/src/lib/room/agents/coder-agent.ts` (`buildCoderSystemPrompt()`) and identify all prompt sections
2. Add bypass markers section (RESEARCH_ONLY, VERIFICATION_COMPLETE, etc.) for role 'coder'
3. Add review feedback handling: how to fetch GitHub reviews, verify feedback, push fixes
4. Add PR creation flow with duplicate prevention (`gh pr list --head`)
5. **Add gate interaction instructions**: After creating a PR, the coder must call `write_gate` on `code-pr-gate` to write PR data (`{ prUrl, prNumber, branch }`). The gate's `check: prUrl exists` condition then passes, unblocking the reviewer channel. Same `write_gate` tool as every other gate — no type-specific API.
6. Add instructions for reading upstream gate data: the coder should call `read_gate` on `plan-pr-gate` to understand the plan before coding

**Acceptance Criteria**:
- Coder agents produce same quality git/PR workflow as Room coder agents
- Coder writes PR data to gate after creating PR (triggers reviewer activation)
- Coder reads plan gate data to understand the plan
- Unit tests pass for updated prompt builder

**Depends on**: Milestone 1 (gate MCP tools) and Milestone 3 (V2 workflow template with concrete gate IDs)

**Agent type**: coder

---

### Task 2.2: Enhance Planner Node Agent System Prompt

**Description**: Create a specialized planner prompt that includes plan document creation, PR management, and gate data writing.

**Subtasks**:
1. Add `buildPlannerNodeAgentPrompt()` in `custom-agent.ts` for role 'planner'
2. Include plan document creation instructions (explore codebase, write plan, create PR)
3. **Add gate interaction instructions**: After creating a plan PR, the planner must call `write_gate` on `plan-pr-gate` to write PR data (`{ prUrl, prNumber, branch }`). The gate's `check: prUrl exists` condition then passes, unblocking the plan review channel.
4. Add instructions for `send_message` to communicate with plan reviewers
5. Ensure the prompt works with `injectWorkflowContext` flag

**Acceptance Criteria**:
- Planner creates plan documents on feature branches with PRs
- Planner writes PR data to `plan-pr-gate` (triggers plan review activation)
- Unit tests cover the new prompt builder

**Depends on**: Milestone 1 (gate MCP tools)

**Agent type**: coder

---

### Task 2.3: Enhance Reviewer Node Agent System Prompt

**Description**: Create a specialized reviewer prompt for posting PR reviews with severity classification and writing votes to the `review-votes-gate`.

**Subtasks**:
1. Add `buildReviewerNodeAgentPrompt()` in `custom-agent.ts` for role 'reviewer'
2. Include PR review process: read changed files, evaluate correctness/completeness/security
3. Add review posting via REST API (`GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews`)
4. Add structured output format: `---REVIEW_POSTED---` block with URL, recommendation, severity counts
5. **Add gate interaction instructions**: Reviewer reads `code-pr-gate` (via `read_gate`) to find the PR URL, then after reviewing, writes its vote to `review-votes-gate` via `write_gate` using its **nodeId** as the vote key: `{ votes: { [nodeId]: 'approve' | 'reject' } }`. Using nodeId (not agentId) prevents collision on re-spawn. The gate's `count: votes.approve >= 3` condition evaluates after each write.
6. When 3 reviewers all write 'approve', the `review-votes-gate` condition passes and QA is activated
7. **Add edge case guidance**: Instruct the reviewer to check current vote state via `read_gate` on `review-votes-gate` before voting. If re-spawned, check if already voted and update/confirm.

**Acceptance Criteria**:
- Reviewer reads PR URL from gate data
- Reviewer posts proper PR reviews with severity classification
- Reviewer writes vote to `review-votes-gate`
- Unit tests cover the prompt builder

**Depends on**: Milestone 1 (gate MCP tools)

**Agent type**: coder

---

### Task 2.4: Create QA Agent System Prompt

**Description**: Build a specialized system prompt for the QA agent that checks test coverage, runs tests, verifies CI status, and writes results to `qa-result-gate`.

**Subtasks**:
1. Add `buildQaNodeAgentPrompt()` in `custom-agent.ts` for role 'qa'
2. Include instructions for:
   - Test command detection (package.json scripts, Makefile targets, fallback commands)
   - Checking CI status via `gh pr checks` or `gh pr view --json statusCheckRollup`
   - Verifying PR mergeability via `gh pr view --json mergeable,mergeStateStatus`
   - Checking for merge conflicts
3. **Add gate interaction instructions**: QA reads `code-pr-gate` to find the PR, then writes result to `qa-result-gate` via `write_gate({ result: 'passed' | 'failed', summary: '...' })`. The gate's `check: result == passed` condition evaluates after the write.
4. Include structured output format for QA results
5. Add `gh` CLI auth verification instructions

**Acceptance Criteria**:
- QA agent has comprehensive verification prompt
- QA reads PR URL from gate data
- QA writes result to `qa-result-gate`
- Unit tests cover the prompt builder

**Depends on**: Milestone 1 (gate MCP tools)

**Agent type**: coder
