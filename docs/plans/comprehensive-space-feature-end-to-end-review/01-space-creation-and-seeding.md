# Milestone 1: Space Creation and Seeding Hardening

## Goal

Ensure space creation flow works end-to-end: creating a space seeds all 6 preset agents and 4 built-in workflows reliably. Handle partial failures gracefully so users never end up with a broken space.

## Scope

Happy paths 1 (Space creation and configuration) and 2 (Pre-seeded space agents and workflows).

## Tasks

### Task 1.1: Audit and harden seed-agents partial failure recovery

**Description:** The `seedPresetAgents` function uses try/catch per agent but the caller (`space.create` handler) does not roll back on partial failure. Audit the creation flow to ensure that if some agents fail to seed, the space is still usable and the user is informed. **Note:** `packages/daemon/tests/unit/space/seed-agents.test.ts` already has ~22 test cases including idempotent re-seed and partial collision scenarios. Start by reading existing tests to identify only the specific gaps (e.g., caller-side rollback behavior, workflow seeding failures) rather than writing duplicate coverage.

**Subtasks:**
1. Read `packages/daemon/tests/unit/space/seed-agents.test.ts` to catalog existing coverage (idempotent re-seed, partial collision, etc.).
2. Read `packages/daemon/src/lib/rpc-handlers/space-handlers.ts` to trace how `seedPresetAgents` result is used after `space.create`.
3. Read `packages/daemon/src/lib/agents/seed-agents.ts` to confirm error isolation per agent.
4. Read `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` to check if `seedBuiltInWorkflows` has similar error handling.
5. If the caller ignores seed errors silently, add logging and/or return partial-success info to the client.
6. Add only the missing unit tests not already covered by the existing test file — focus on: caller-side behavior when seeding partially fails, workflow seeding partial failures.
7. Run `cd packages/daemon && bun test tests/unit/space/seed-agents*` to verify.

**Acceptance Criteria:**
- Partial agent/workflow seed failures are logged and do not break space creation.
- Unit tests cover all-success, partial-failure, and idempotent re-seed scenarios.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** None

**Agent type:** coder

### Task 1.2: Verify space configuration fields persist correctly

**Description:** Verify that all space configuration fields (name, description, workspace path) persist and round-trip through create/read/update. Ensure the SpaceSettings UI reflects saved values.

**Subtasks:**
1. Read `packages/daemon/src/lib/rpc-handlers/space-handlers.ts` for `space.create` and `space.update` handlers.
2. Read `packages/daemon/src/storage/repositories/space-repository.ts` for persistence logic.
3. Write unit tests verifying: create with all fields, update each field individually, read returns updated values.
4. Check existing tests in `packages/daemon/tests/unit/space/space-manager.test.ts` and `space-handlers.test.ts` for coverage gaps.
5. Add any missing field round-trip tests.
6. Run tests to verify.

**Acceptance Criteria:**
- All space fields round-trip correctly through create/update/read.
- Unit tests cover field persistence for name, description, workspace path.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** None

**Agent type:** coder

### Task 1.3: Verify pre-seeded agents have correct tools and prompts

**Description:** Verify each of the 6 preset agents (Coder, General, Planner, Research, Reviewer, QA) is seeded with the correct tool sets, system prompts, and instructions as defined in `seed-agents.ts`. Add only tests for behaviors not already covered.

**Subtasks:**
1. Read `packages/daemon/src/lib/agents/seed-agents.ts` for the PRESET_AGENTS definitions.
2. Read existing tests in `packages/daemon/tests/unit/space/seed-agents.test.ts` and `space-agent-manager.test.ts` — list which specific agent properties are already asserted.
3. Add unit tests only for uncovered behaviors: verifying all 6 agents exist with correct tool sets (CODER_TOOLS, DONE_TOOLS, etc.), correct system prompts and instructions.
4. Verify the ROLE_TOOLS export matches the actual seeded tools.
5. Run tests to verify.

**Acceptance Criteria:**
- Unit tests assert exact tool sets, system prompts, and instructions for all 6 preset agents.
- Tests fail if a preset agent definition is changed without updating the test.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** None

**Agent type:** coder

### Task 1.4: Verify built-in workflows are seeded correctly

**Description:** Verify that the 4 built-in workflow templates are seeded with correct node structures, channels, gates, and agent ID resolution. Add only tests for behaviors not already covered.

**Subtasks:**
1. Read `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` for template definitions.
2. Read existing tests in `packages/daemon/tests/unit/space/space-workflow*` — list which workflow seeding behaviors are already asserted.
3. Add unit tests only for uncovered behaviors: correct number of workflows seeded, each workflow has expected nodes and channels, agent IDs in nodes resolve to actual seeded SpaceAgent IDs.
4. Run tests to verify.

**Acceptance Criteria:**
- Unit tests verify all 4 built-in workflows are seeded with correct structure.
- Agent ID resolution from role names to actual UUIDs is verified.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 1.3

**Agent type:** coder
