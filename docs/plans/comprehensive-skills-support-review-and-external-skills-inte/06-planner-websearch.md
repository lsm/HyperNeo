# Milestone 6: Planner Web Search Verification and Enhancement

## Milestone Goal

Verify that the Planner and plan-writer agents can actually use `WebSearch` end-to-end. Add explicit prompt guidance in the planner system prompts so agents know when and how to use web search. Write an online test to validate this capability.

## Tasks

---

### Task 6.1: Verify Planner WebSearch Wiring

**Agent type:** coder

**Description:**
Audit the planner agent's tool configuration and confirm `WebSearch` is correctly wired. Investigate whether the SDK's `WebSearch` built-in tool is available in the agent context and works in the current sandbox configuration.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Read `packages/daemon/src/lib/room/agents/planner-agent.ts` — verify both `Planner` and `plan-writer` agent definitions include `WebSearch` in their `tools` arrays.
3. Read `packages/daemon/src/lib/agent/query-options-builder.ts` — check whether `room_chat` session type (which the planner runs as `type: 'planner'`) restricts or allows `WebSearch`.
4. Check `packages/shared/src/types/settings.ts` `DEFAULT_GLOBAL_SETTINGS.sandbox.network.allowedDomains` — verify that search API domains are included.
5. Add missing search API domains to `allowedDomains` if needed.
6. Add an inline comment in `planner-agent.ts` documenting why WebSearch is included for both agents.
7. Run `bun run typecheck`.

**Acceptance criteria:**
- Both `Planner` and `plan-writer` agent defs include `WebSearch`
- Sandbox allowedDomains includes necessary search API domains
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 1.1: Skills and MCP System Audit"]

---

### Task 6.2: Planner Prompt Enhancement for Web Search

**Agent type:** coder

**Description:**
Enhance the plan-writer system prompt in `buildPlanWriterPrompt()` and the planner system prompt in `buildPlannerSystemPrompt()` to include explicit guidance on when and how to use `WebSearch` and `WebFetch`.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. In `buildPlanWriterPrompt()` in `packages/daemon/src/lib/room/agents/planner-agent.ts`, add a section after the codebase exploration step:

   ```
   ## Optional: Web Research

   When the goal involves integrating external technologies, APIs, or libraries that may have recent changes (e.g., after your knowledge cutoff), use `WebSearch` to look up current documentation or changelog entries before planning.

   - Use `WebSearch` for: finding latest API patterns, library versions, breaking changes, or community best practices.
   - Use `WebFetch` for: fetching a specific documentation page or GitHub release notes by URL.
   - Do NOT search for general coding patterns you already know — only search when external, up-to-date information would improve plan accuracy.
   ```

3. In `buildPlannerSystemPrompt()`, add a brief note in the Pre-Planning Setup section that the planner can use `WebSearch` to verify current technology choices before spawning the plan-writer.
4. Run `bun run typecheck`.
5. Update unit tests for prompt builders to check for the web search guidance section.

**Acceptance criteria:**
- Both system prompts include clear web search guidance
- Guidance is concise and action-oriented
- Unit tests for prompt content updated
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 6.1: Verify Planner WebSearch Wiring"]

---

### Task 6.3: Online Test — Planner WebSearch Capability

**Agent type:** coder

**Description:**
Write an online test that verifies the planner agent session can invoke `WebSearch` and receive results. Uses the dev proxy mock infrastructure.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Review existing online tests in `packages/daemon/tests/online/` for patterns on how to set up a planner session.
3. Create `packages/daemon/tests/online/room/planner-websearch.test.ts`:
   - Creates a room and a planner session
   - Sends a goal message that explicitly instructs the planner to search the web for a current technology fact
   - Asserts that the agent's output includes a `WebSearch` tool call (check message history for tool use blocks)
   - Uses `HYPERNEO_USE_DEV_PROXY=1` mock infrastructure
4. Run the test with `cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/room/planner-websearch.test.ts`.
5. Ensure the test fails (not skips) if credentials are absent, per the hard-fail rule.

**Acceptance criteria:**
- Online test verifies WebSearch tool call appears in planner output
- Test uses dev proxy mock (not real API by default)
- Test fails (not skips) when credentials are absent
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 6.2: Planner Prompt Enhancement for Web Search"]
