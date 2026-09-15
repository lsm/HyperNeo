# Comprehensive Space Feature End-to-End Review

## Goal

Full review and hardening of the Space feature happy path. Ensure all 12 core workflows work end-to-end with good test coverage (unit + e2e). Identify gaps, fix them, and add test coverage.

## Happy Paths

1. **Space creation & configuration** — Create a space, set up basic configurations (name, description, worktree, agents, etc.)
2. **Pre-seeded space agents & workflows** — New space should come with space agents and space workflow pre-seeded
3. **Space agent conversation → task creation** — Talk with space agent about a problem/feature, agent creates a task with pre-selected workflow
4. **Task visibility** — Task appears in space context panel and space overview page
5. **Task execution via runtime ticks** — Task triggered by space runtime ticks, task agent starts and spawns workflow (or workflow triggered directly by runtime)
6. **Task view with agent messages** — Click task opens task view showing all agents' messages differentiated by color side rails
7. **Agent overlay chat** — Click individual agent name opens overlay chat container showing all messages for that agent
8. **Canvas mode** — Button to switch to canvas mode showing workflow visualization, active node/agent pulsing, click opens overlay chat
9. **Artifacts side panel** — Button to open artifacts panel from right, showing all changed files with +/- lines, click file opens diff
10. **Blocked task status** — Tasks in blocked status show blocked reason visibly on UI
11. **User interaction in task view** — User can talk to Task Agent directly, or @mention specific agent(s)
12. **Manual task status control** — User can manually change task status, bring stuck tasks back to working

## Approach

The plan is organized into 7 milestones, progressing from foundational backend correctness through UI hardening to comprehensive E2E test coverage. Each milestone targets a coherent set of happy paths and can be worked on sequentially. Bug fixes and missing features are addressed before test coverage is added.

## Milestones

1. **Space Creation and Seeding Hardening** -- Verify space creation, agent/workflow seeding, error recovery. Add unit tests for partial seed failure. (Happy paths 1, 2)
2. **Task Lifecycle and Status Management** -- Harden task creation from agent conversation, manual status control UI (blocked->in_progress), blocked reason visibility. (Happy paths 3, 4, 10, 12)
3. **Runtime Tick and Workflow Execution** -- Verify task execution via runtime ticks, workflow executor correctness, crash recovery. Add missing unit tests for edge cases. (Happy path 5)
4. **Task View and Agent Messages** -- Harden unified thread rendering, agent color differentiation, agent overlay chat (currently full-page navigation). **Note:** Task 4.2 (agent overlay chat) is a new feature on the critical path — it creates a new `AgentOverlayChat.tsx` slide-over component and changes the existing `navigateToSpaceSession` pattern. Tasks 5.1, 5.3, 6.3, 7.3, and 7.6 depend on it. If the overlay proves harder than expected, consider falling back to an improved full-page navigation with a back-to-task button as a simpler alternative. (Happy paths 6, 7)
5. **Canvas Mode and Artifacts Panel** -- Add canvas mode toggle from task view, verify workflow visualization, add artifacts side panel integration. **Note:** Task 5.2 (artifacts panel) is independent of Task 5.1 (canvas toggle) — it depends on Task 3.4 instead. (Happy paths 8, 9)
6. **User Interaction in Task View** -- Verify user messaging to task agent, @mention routing to specific agents. Add unit tests for channel routing. (Happy path 11)
7. **E2E Test Coverage Expansion** -- Add Playwright E2E tests covering gaps: blocked task display, manual status control, canvas mode, artifacts panel, agent overlay, runtime tick progression. (All happy paths)

## Cross-Milestone Dependencies

- Milestone 2 depends on milestone 1 (space must be created correctly before tasks work)
- Milestone 3 depends on milestone 2 (tasks must exist before runtime can execute them)
- Milestone 4 depends on milestone 3 (agent messages appear during/after execution)
- Milestone 5 depends on milestone 3 (canvas shows runtime state)
- Milestone 6 depends on milestone 4 (user interaction builds on message thread)
- Milestone 7 depends on all prior milestones (E2E tests validate the fixed behavior)

## Total Estimated Task Count

27 tasks across 7 milestones.

## Key Files

### Backend
- `packages/daemon/src/lib/space/managers/` -- All space managers
- `packages/daemon/src/lib/space/runtime/` -- Runtime engine
- `packages/daemon/src/lib/agents/seed-agents.ts` -- Agent seeding
- `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` -- Workflow templates
- `packages/daemon/src/lib/rpc-handlers/space-*.ts` -- RPC handlers

### Frontend
- `packages/web/src/islands/SpaceIsland.tsx` -- Main space content
- `packages/web/src/components/space/SpaceTaskPane.tsx` -- Task detail view
- `packages/web/src/components/space/SpaceDashboard.tsx` -- Overview dashboard
- `packages/web/src/components/space/WorkflowCanvas.tsx` -- Canvas visualization
- `packages/web/src/components/space/GateArtifactsView.tsx` -- Artifacts/diff view

### Tests
- `packages/daemon/tests/unit/space/` -- 53 unit test files
- `packages/daemon/tests/online/space/` -- Online integration tests
- `packages/e2e/tests/features/space-*.e2e.ts` -- 17 E2E test files

## Out of Scope

- **Sub-session streaming recovery after daemon restart** — The gap analysis notes that agent sub-sessions are not restarted after daemon restart. While Milestone 3 covers crash recovery for workflow runs and executor rehydration, the deeper problem of resuming node agent streaming sessions is out of scope for this review cycle. This is a known gap that should be tracked separately as a reliability feature.
