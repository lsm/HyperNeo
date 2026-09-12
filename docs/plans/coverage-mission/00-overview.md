# Coverage Mission: Reach 80% Test Coverage

## Goal Summary

Raise project-wide test coverage from its current level (approximately 30% CI gate) to 80%
across all packages: `daemon`, `shared`, and `web`. Coverage is measured and reported via
Coveralls using lcov data from three test runners: Bun (daemon + shared unit), Bun (daemon
online), and Vitest (web).

## Approach

The plan proceeds in three phases:

**Phase 1 — Infrastructure (Milestones 1-2):** Fix broken coverage configuration that causes
Vitest 4 to silently exclude untested files from reports, add coverage thresholds, and
establish a real baseline by running coverage locally. Without this phase, the 80% gate would
be meaningless because untested files are invisible to the reporter.

**Phase 2 — Write Tests (Milestones 3-7):** Add missing tests in order of difficulty: web
utility/lib files first (pure logic, no rendering), then progressively more complex web
components, then daemon repository and logic files that lack direct unit test coverage.

**Phase 3 — Gate Update (Milestone 8):** Raise the CI gate from 30% to 80% once all packages
are confirmed to meet the threshold.

## Milestones

1. **Fix coverage infrastructure** — Add `coverage.include` to web `vitest.config.ts`, add
   80% thresholds, remove any deprecated Vitest 4 config keys, update CI gate to 70% as an
   intermediate step, add Bun `coverageThreshold` to `bunfig.toml`.

2. **Establish baseline** — Run coverage for all packages locally, document the per-package
   line/branch/function percentages, and identify the remaining gap to 80%.

3. **Web lib and utility tests** — Write tests for uncovered web lib files: `errors.ts`,
   `lobby-store.ts`, `parse-group-message.ts`, `recent-paths.ts`, `role-colors.ts`,
   `space-constants.ts`, `task-constants.ts`, `ToolsModal.utils.ts`. These are pure logic
   with no component rendering.

4. **Web component tests (simple)** — Write tests for straightforward, low-dependency web
   components: `EmptyState`, `MobileMenuButton`, `RunningBorder`, `SDKRateLimitEvent`,
   `SDKResumeChoiceMessage`, `MessageInfoButton`, `DaemonStatusIndicator`, `RejectModal`,
   `SpacePageHeader`, `PendingTaskCompletionBanner`.

5. **Web component tests (complex)** — Write tests for signal-coupled components:
   `RoomSettings`, `ChatComposer`, `RoomAgents`, `RoomContext`, `RoomSessions`,
   `GeneralSettings`, `FallbackModelsSettings`, `AddSkillDialog`, `EditSkillDialog`. Use the
   Preact Context Provider pattern for signal injection.

6. **Web hooks tests** — Write tests for `useChatComposerController.ts` and `useSkills.ts`
   hooks using `renderHook` from `@testing-library/preact`.

7. **Daemon repository and logic tests** — Write unit tests for daemon source files without
   direct dedicated test files: `skill-repository.ts`, `space-worktree-repository.ts`,
   `workspace-history-repository.ts`, and the `buildSelectionPrompt` / `cleanIdResponse`
   helper functions in `llm-workflow-selector.ts`.

8. **Raise CI gate to 80%** — Update `MIN_COVERAGE=30` to `MIN_COVERAGE=80` in
   `.github/workflows/main.yml` and confirm all packages pass the threshold in CI.

## Cross-Milestone Dependencies

```
Milestone 1 (infra)
  └─> Milestone 2 (baseline)
        └─> Milestones 3-7 (write tests, can run in parallel after baseline)
              └─> Milestone 8 (raise gate)
```

Milestones 3, 4, 5, 6, and 7 can be executed concurrently once the baseline (Milestone 2)
is established, since they target non-overlapping files. Milestone 8 must wait for all
test-writing milestones to complete and be verified in CI.

## Total Estimated Task Count

Approximately 24 tasks across 8 milestones.

## Key Technical Constraints

- **Vitest 4 requires `coverage.include`**: Without it, untested files are absent from
  reports. Adding it will likely cause reported web coverage to drop before any new tests
  are written. This is expected and intentional.
- **Bun thresholds are `bunfig.toml`-only**: The `--coverage-threshold` flag does not exist;
  thresholds go in `[test] coverageThreshold`.
- **Signal-coupled components**: Preact Signal components must be wrapped in a fresh context
  per test; use `waitFor()` for async signal propagation.
- **Daemon repositories use `bun:sqlite` in-memory databases**: Follow the pattern established
  in `packages/daemon/tests/unit/4-space-storage/storage/space-repository.test.ts` — create
  an in-memory `Database`, run schema setup via the appropriate helper, then exercise the
  repository directly.
