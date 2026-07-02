# Milestone 7: Integration, Regression, and Cleanup

## Milestone Goal

Ensure no regression in existing Skills functionality (the SDK `Skill` tool and slash commands), run the full test suite, fix any issues, and clean up any technical debt introduced during the implementation milestones.

## Tasks

---

### Task 7.1: Regression Testing — Existing Skill Tool Behavior

**Agent type:** coder

**Description:**
Verify that the existing `Skill` tool (SDK slash commands) and `WebSearch`/`WebFetch` tools continue to work correctly in all session types after the Skills registry changes. Update any broken tests.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Run the full daemon unit test suite: `make test-daemon`.
3. Run the full web unit test suite: `make test-web`.
4. Fix any failing tests caused by the new `SkillsManager` dependency in `QueryOptionsBuilderContext`.
5. Verify `query-options-builder.test.ts` still passes for the `Skill` tool in room_chat and coordinator mode tool lists.
6. Verify `context-fetcher.test.ts` and `context-command.test.ts` still pass for skill-related context.
7. Run `bun run check` (lint + typecheck + knip) and fix any new issues.

**Acceptance criteria:**
- `make test-daemon` passes with no regressions
- `make test-web` passes with no regressions
- `bun run check` passes clean
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 3.3: Apply Room Skill Overrides to Session Init", "Task 5.2: Global Skills Registry UI Component", "Task 6.2: Planner Prompt Enhancement for Web Search"]

---

### Task 7.2: Skills Feature Documentation

**Agent type:** general

**Description:**
Write user-facing documentation for the Skills feature, and update the CLAUDE.md with architecture notes.

**Subtasks (ordered):**

1. Create `docs/features/skills.md` covering:
   - What Skills are in HyperNeo (slash commands + plugin extensions + MCP server skills)
   - How to add a skill via Settings > Skills
   - Source types explained: built-in, plugin, MCP server
   - How to enable/disable skills per room
   - The web search MCP skill option
   - Built-in skills that are always available (merge-session, etc.)
2. Update `CLAUDE.md` with a brief "Skills System" section under the Architecture heading, covering:
   - `packages/daemon/src/lib/skills-manager.ts` — SkillsManager
   - `packages/daemon/src/lib/rpc-handlers/skills-handlers.ts` — Skills RPC handlers
   - `packages/shared/src/types/skills.ts` — AppSkill types
   - `packages/web/src/lib/skills-store.ts` — client-side store
   - How skills flow: registry → QueryOptionsBuilder → SDK options

**Acceptance criteria:**
- `docs/features/skills.md` is committed and accurate
- `CLAUDE.md` Skills System section is added
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 7.1: Regression Testing — Existing Skill Tool Behavior"]
