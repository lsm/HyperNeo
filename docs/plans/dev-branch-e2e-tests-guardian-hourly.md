# Dev Branch E2E Tests Guardian (Hourly)

## Goal Summary

Set up a recurring hourly mission that monitors E2E test health on the `dev` branch. Each run executes a single discovery task that checks CI results and reports failures. After discovery completes, the Leader agent dynamically creates one fix task per failure found -- no pre-defined fix tasks are needed.

This replaces the previous rigid multi-task plan with a simpler, adaptive approach that trusts the agent to determine the right fix strategy per failure.

## Approach

1. Configure a recurring mission in the HyperNeo room with `@hourly` schedule and `supervised` autonomy.
2. The mission description serves as the discovery task prompt -- it contains the exact CI query commands, failure categorization guidance, and reporting format.
3. On the first execution, the Planner agent expands the discovery prompt into a single concrete task.
4. On subsequent executions, the mission reuses the same plan (task cloning).
5. After the discovery task completes and reports failures, the Leader agent creates one fix task per failure, choosing `general` or `coder` type based on the failure category.
6. Each fix task is assigned to the agent who owns the failing area and linked to this mission.

---

## Mission Configuration

Create a recurring mission with these parameters:

| Parameter | Value |
|-----------|-------|
| `missionType` | `recurring` |
| `schedule.expression` | `@hourly` |
| `autonomyLevel` | `supervised` |
| `title` | `Dev Branch E2E Tests Guardian` |

### Why `supervised` instead of `semi_autonomous`

The `cancel-in-progress: true` concurrency group on CI means that pushing to `dev` (or merging a PR) cancels any in-progress CI run. If the guardian's fix PR is merged while a CI run is in progress, that run gets cancelled -- but the guardian should not re-trigger CI via `workflow_dispatch` (doing so would itself be cancelled by the next push). Using `supervised` autonomy ensures all PRs get human review before merge, which avoids timing-related merge conflicts and keeps a human in the loop for any cascading effects on CI.

### Prerequisites

- **GitHub CLI (`gh`)**: Must be authenticated with a token that has `repo` scope (read access to actions/runs). Set `GH_TOKEN` or `GITHUB_TOKEN` in the environment. For hourly runs this is well within rate limits (~10 API calls per execution).
- **`jq`**: Required for JSON parsing. Pre-installed on GitHub-hosted runners and most Unix systems.

### Mission Description (Discovery Task Prompt)

Use the following as the mission description. This is what the Planner agent sees when creating the first execution's task plan.

<pre>
Run E2E CI checks on recent dev branch commits. For each failing test suite, report: test name, failure message, and relevant commit hash. Output a summary of all failures found.

## Steps

1. Query the latest completed CI runs on dev (include `headSha` for commit hash reporting):
   ```bash
   gh run list --repo lsm/neokai --branch dev --limit 5 --status completed --json databaseId,conclusion,createdAt,headSha
   ```
   Note: `--status completed` filters to runs that have finished (both success and failure conclusions). This excludes `in_progress` and `queued` runs from the initial query. The `conclusion` field distinguishes success/failure/cancelled within completed runs.

2. Pick the most recent non-cancelled run. If the latest completed run has `conclusion` = `"cancelled"`, check the next older run, and so on up to 5 runs. The 5-run limit covers the common case where a burst of commits causes several consecutive cancellations (each push cancels the previous run due to `cancel-in-progress: true`).

   If all recent runs (last 5) are cancelled, report "No completed CI runs available — all recent runs were cancelled" and stop.

   If no completed runs exist at all (CI is currently running), wait up to 10 minutes polling every 2 minutes:
   ```bash
   # Check for any completed runs (cancelled runs still count as completed)
   LATEST=$(gh run list --repo lsm/neokai --branch dev --limit 1 --status completed --json conclusion --jq '.[0]')
   if [ -z "$LATEST" ]; then
     echo "No completed runs yet. Polling for up to 10 minutes (5 attempts x 2 min)..."
     for i in $(seq 1 5); do
       echo "Waiting 2 minutes (attempt $i/5)..."
       sleep 120
       LATEST=$(gh run list --repo lsm/neokai --branch dev --limit 1 --status completed --json conclusion --jq '.[0]')
       if [ -n "$LATEST" ]; then
         break
       fi
     done
     if [ -z "$LATEST" ]; then
       echo "No completed CI runs after 10 minutes of polling. Stopping."
       exit 0
     fi
   fi
   ```

   **Important**: After the polling loop resolves (finds at least one completed run), re-run the full step 1 query with `--limit 5` to get the full list of recent runs for proper cancelled-run skipping. The polling query only used `--limit 1` to detect completion -- it does not provide enough data for step 2's selection logic.

3. **Verify E2E jobs actually ran** before checking for failures. E2E jobs are gated on `build` and `discover` succeeding. If either upstream job fails or is skipped, E2E jobs are skipped -- not failed. A run with zero E2E failures and zero E2E jobs run is NOT "all green"; it means E2E never executed.

   Check for skipped E2E jobs and upstream failures:
   ```bash
   RUN_ID=&lt;run-id&gt;
   # Check if build and discover succeeded (prerequisite for E2E)
   UPSTREAM=$(gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '.jobs[] | select(.name == "Build Binary (linux-x64)" or .name == "Discover Tests") | {name, conclusion, status}')

   echo "Upstream jobs:"
   echo "$UPSTREAM"

   # Check for skipped build (e.g., unit test failure caused build to be skipped)
   # Note: --jq outputs newline-delimited JSON objects, so we must slurp them into an array first
   BUILD_CONCLUSION=$(echo "$UPSTREAM" | jq -rs '.[] | select(.name == "Build Binary (linux-x64)") | .conclusion')
   if [ "$BUILD_CONCLUSION" = "skipped" ]; then
     echo "WARNING: Build was skipped (likely a prerequisite job failed). E2E cannot run."
     echo "Report this as a CI infrastructure issue rather than 'all green'."
     exit 0
   fi

   # Count E2E jobs that actually ran (not skipped)
   E2E_TOTAL=$(gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '[.jobs[] | select(.name | startswith("E2E"))] | length')
   E2E_SKIPPED=$(gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '[.jobs[] | select(.name | startswith("E2E")) | select(.conclusion == "skipped")] | length')
   E2E_RAN=$((E2E_TOTAL - E2E_SKIPPED))

   echo "E2E jobs: $E2E_RAN ran, $E2E_SKIPPED skipped out of $E2E_TOTAL total"

   if [ "$E2E_RAN" -eq 0 ]; then
     echo "WARNING: No E2E jobs actually ran. Upstream job may have failed or been skipped."
     echo "Report this as a CI infrastructure issue rather than 'all green'."
     # Include upstream job status in the report
     exit 0
   fi
   ```

   Note: `exit 0` here means the discovery task succeeds (no failures to report) even though E2E didn't run. This is intentional -- the guardian should not alarm on CI infrastructure issues that prevent E2E from running. The task output will contain the warning text for human visibility.

4. List failed E2E jobs from the chosen run (only jobs that actually ran, not skipped):
   ```bash
   gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '.jobs[] | select(.conclusion == "failure") | select(.name | startswith("E2E")) | {name, databaseId, steps: [.steps[] | select(.conclusion == "failure") | {name, conclusion}]}'
   ```

5. If no E2E jobs failed (and E2E jobs did run), report "All green" and stop.

6. For each failed E2E job, extract the failure message. Use step 6a first (fast, no download). Use step 6b if more detail is needed.

   **6a. Get failure summary from job logs (fast, recommended first)** -- gets the name of the failing step(s):
   ```bash
   # Get the failing step name(s) and summary
   gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '.jobs[] | select(.name == "&lt;job-name&gt;") | .steps[] | select(.conclusion == "failure") | .name'
   ```

   **6b. Download test report artifact (for detailed failure messages)** -- downloads per-test Playwright output:
   ```bash
   # Artifact naming convention (from .github/workflows/main.yml):
   #   No-LLM jobs: e2e-no-llm-results-&lt;test-name&gt;
   #   LLM jobs:    e2e-results-llm-&lt;test-name&gt;
   # where &lt;test-name&gt; matches the matrix.test.name value (e.g., "features-mission-terminology")
   #
   # IMPORTANT: artifacts are only uploaded when the job fails (if: failure() in the workflow).
   # Artifacts expire after 7 days (retention-days: 7).
   mkdir -p /tmp/e2e-guardian
   gh run download $RUN_ID --repo lsm/neokai --name "e2e-no-llm-results-&lt;test-name&gt;" --dir "/tmp/e2e-guardian/&lt;test-name&gt;"
   ```

   **Artifact directory structure** (confirmed from CI workflow `upload-artifact@v4` with `if: failure()`):
   The CI workflow uploads `packages/e2e/test-results/` and `packages/e2e/playwright-report/`. When `gh run download` extracts the artifact, the directory structure is:
   ```
   /tmp/e2e-guardian/&lt;matrix-name&gt;/
   ├── test-results/               # Playwright internal output (per-test directories)
   │   ├── &lt;test-title-dir-1&gt;/     # Named after test titles, NOT the matrix name
   │   │   └── .last-run.json
   │   └── &lt;test-title-dir-N&gt;/     # Multiple test directories may exist
   │       └── .last-run.json
   └── playwright-report/          # HTML reporter output
       └── index.html              # Self-contained HTML report
   ```

   **Reading failure messages from artifacts**:
   The `.last-run.json` file is a simple status file (e.g., `{status: "failed"}`) and does NOT contain structured error data. Do NOT rely on `jq` paths like `.suites[].specs[].tests[].results[].error` -- they will return empty. Instead, use these approaches:
   ```bash
   # Option A: Extract error text from Playwright HTML report (recommended)
   grep -oP '(?&lt;=&lt;pre&gt;).*?(?=&lt;/pre&gt;)' /tmp/e2e-guardian/&lt;matrix-name&gt;/playwright-report/index.html 2&gt;/dev/null | head -50

   # Option B: Check .last-run.json status only (to confirm which tests failed)
   find /tmp/e2e-guardian/&lt;matrix-name&gt;/test-results/ -name ".last-run.json" \
     -exec sh -c 'echo "=== $1 ===" && cat "$1"' _ {} \; 2&gt;/dev/null
   ```

   **Batch download for all failed jobs**:
   ```bash
   FAILED_JOBS=$(gh run view --repo lsm/neokai $RUN_ID --json jobs \
     --jq '.jobs[] | select(.conclusion == "failure") | select(.name | startswith("E2E")) | .name')
   for JOB in $FAILED_JOBS; do
     # Extract test name from job name: "E2E No-LLM (features-foo)" -&gt; "features-foo"
     TEST_NAME=$(echo "$JOB" | sed -n 's/.*(\(.*\)).*/\1/p')
     if [ -z "$TEST_NAME" ]; then
       echo "WARNING: Could not extract test name from job: $JOB"
       continue
     fi
     # Determine artifact name based on job prefix
     if echo "$JOB" | grep -q "No-LLM"; then
       ARTIFACT="e2e-no-llm-results-$TEST_NAME"
     else
       ARTIFACT="e2e-results-llm-$TEST_NAME"
     fi
     echo "Downloading artifact: $ARTIFACT"
     mkdir -p "/tmp/e2e-guardian/$TEST_NAME"
     if ! gh run download $RUN_ID --repo lsm/neokai --name "$ARTIFACT" --dir "/tmp/e2e-guardian/$TEST_NAME" 2&gt;&amp;1; then
       echo "  Artifact download failed (may have expired or upload failed). Use step 6a logs instead."
     fi
   done
   ```

7. For each failure, report:
   - Test file path (e.g., `tests/features/mission-terminology.e2e.ts`)
   - CI job name (e.g., `E2E No-LLM (features-mission-terminology)`)
   - Failure message / error snippet (from step 6a logs or step 6b artifacts)
   - Commit hash from `headSha` (links failure to specific commit)
   - Suspected root cause category: `test-bug` | `product-bug` | `flaky` | `env`
   - Whether it is a pre-existing issue (check `docs/e2e-health-check-log.md` for prior occurrences)

8. Append the results to `docs/e2e-health-check-log.md` following the existing format (see the log file for examples).

## Excluded Tests (do not investigate)
- `features/space-export-import`
- `features/space-workflow-rules`

## Known Pre-existing Issues (check if still failing)
These issues were documented in prior health check runs (see `docs/e2e-health-check-log.md`):
- `features-worktree-isolation`: session deletion race condition
- `features-space-session-groups`: workspace path initialization race
- `features-reference-autocomplete` / `features-task-lifecycle`: E2E temp workspace lacks `.git` directory
- Neo panel doesn't close on Escape key (affects 7 suites, first seen 2026-04-02)
- Space UNIQUE constraint on retry (affects 7 suites, first seen 2026-04-02)
- Ambiguous locators / strict mode violations (affects 5 suites, first seen 2026-04-02)
- AI-dependent tests in No-LLM matrix (1 suite, first seen 2026-04-02)

## CI Notes
- **cancel-in-progress**: CI has `cancel-in-progress: true` with group `ci-${{ github.ref }}`. Pushing to dev while CI is running will cancel the in-progress run. Always check for cancelled runs and skip them (step 2).
- **Read-only guard**: This mission is a read-only observer. Do NOT trigger `workflow_dispatch` or push to dev directly. All fixes must go through PRs with human review.
- E2E test categories: `no-llm` (UI-only, fully parallel) and `llm` (requires LLM API, max 4 parallel).
- The CI `discover` job auto-categorizes tests; artifact names follow `e2e-no-llm-results-&lt;name&gt;` and `e2e-results-llm-&lt;name&gt;`.
- **Artifact naming**: Jobs are `E2E No-LLM (&lt;name&gt;)` and `E2E LLM (&lt;name&gt;)`. Strip the prefix and parentheses to get the artifact name suffix.
- **Job dependency chain** (from workflow YAML):
  - `build` (needs: check, test-daemon-online, test-daemon-shared-unit, test-web, test-cli, discover)
  - `e2e-no-llm` (needs: build, discover) -- only runs if both succeed
  - `e2e-llm` (needs: build, discover) -- only runs if both succeed
  - If any prerequisite of `build` fails, `build` is skipped, which in turn skips all E2E jobs.
- **Artifact upload condition**: `if: failure()` -- artifacts are only uploaded when the job fails, not on success. Artifacts older than 7 days are auto-deleted by GitHub Actions.
- **`exit 0` semantics**: Several steps use `exit 0` when the guardian stops early (no completed runs after polling, no E2E jobs ran, all green). This signals "no failures to report" to the task runner, which is correct -- the guardian only reports failure when it finds actual test failures. Early-exit scenarios produce a text warning in the task output for human visibility.

## Early Exit Semantics

The discovery task uses `exit 0` for all "stop early" scenarios. This is intentional:

| Scenario | Exit code | Meaning |
|----------|-----------|---------|
| All green (E2E ran, no failures) | `exit 0` | No failures to report |
| No E2E ran (build skipped/failed) | `exit 0` | CI infra issue, not a test failure |
| All 5 recent runs cancelled | `exit 0` | No data available |
| No completed runs after polling | `exit 0` | CI still running, try again next hour |
| Test failures found | Normal completion | Report contains failure entries |

The task output text always contains a human-readable summary of what happened, regardless of exit code. The Leader agent should read the output to decide whether to create fix tasks.
</pre>

---

## Subsequent Executions (Plan Reuse)

The mission system uses **plan reuse** for execution 2+:

1. **First execution**: The Planner agent expands the mission description into a concrete task plan (the discovery task). The task runs, reports failures, and the Leader creates fix tasks.
2. **Second execution onwards**: The mission runtime **clones** the discovery task from the first execution (same prompt, fresh run). The cloned task checks the latest CI state at that point in time -- it does not repeat old results.
3. **Fix tasks are NOT cloned** -- each execution's fix tasks are created fresh by the Leader based on what the discovery task finds in that specific run.

This means: if execution #1 finds 3 failures and the Leader creates 3 fix tasks, execution #2 will only create new fix tasks for failures that still exist (or new failures introduced since the last run). Fixed tests should no longer appear in the discovery output.

### Fix Task De-duplication Across Executions

The Leader agent is expected to query existing in-progress tasks before creating new fix tasks. This is **guidance**, not a system-enforced rule -- the Leader uses its judgment to avoid creating duplicate fix tasks for the same failure. Specifically:
- Before creating a fix task, the Leader checks whether a fix task for the same test file and root cause already exists and is still in progress.
- If a matching fix task exists, skip creating a duplicate.
- If a matching fix task was completed but the failure persists (discovered again in a new execution), create a new fix task noting that the previous fix attempt did not resolve the issue.

---

## Fix Task Creation Guidance (For the Leader Agent)

After the discovery task completes, the Leader agent reviews the failure report and creates one task per failure. This section documents the expected behavior.

### How the Leader Receives Discovery Output

The discovery task produces a **structured failure report** as its output text. The Leader agent reads this output to create fix tasks. The data flow is:

```
Discovery task runs -> produces failure report (text output)
    |
Leader agent reads the completed task output
    |
For each failure entry, Leader calls create_task() with fix details
    |
Fix tasks are dispatched to appropriate agents
```

**What the Leader looks for in the discovery output:**

The discovery task must output a machine-parseable failure report. Each failure entry should include these fields (the discovery task prompt above specifies this format):

| Field | Example |
|-------|---------|
| Test file path | `tests/features/mission-terminology.e2e.ts` |
| CI job name | `E2E No-LLM (features-mission-terminology)` |
| Failure message | `Error: Locator.click: Timeout 30000ms exceeded` |
| Commit hash | `9a65475ce` |
| Root cause category | `test-bug` / `product-bug` / `flaky` / `env` |
| Pre-existing | `yes` (with health check log date) or `no` |

**Leader actions after reading the report:**

1. Skip entries where `pre-existing: yes` unless the issue has worsened.
2. Group entries with the same root cause into a single fix task.
3. For each distinct failure, call `create_task()` with:
   - `title`: `"Fix E2E test failure: <test-name>"` or `"Investigate E2E flaky: <test-name>"` for flaky/env categories
   - `description`: Include the failure details, CI run ID, commit hash, and acceptance criteria (test must pass)
   - `agent`: `"coder"` for test-bug/product-bug, `"general"` for flaky/env
   - `priority`: `"high"` for new failures, `"normal"` for pre-existing worsening, `"low"` for flaky tests
4. Excluded tests (`space-export-import`, `space-workflow-rules`) are never investigated -- skip them entirely.

For subsequent hourly executions, the mission system reuses the plan from the first successful execution (task cloning). The cloned discovery task runs again, produces a fresh failure report, and the Leader creates new fix tasks only for failures not already covered by in-progress fix tasks from this or prior executions.

### Autonomy Level and Push Workflow

The mission uses `supervised` autonomy, which means:
- All fix task PRs require human review and approval before merge.
- This prevents timing-related issues: a merged PR cancelling an in-progress CI run, or the guardian triggering `workflow_dispatch` that gets cancelled by a developer push.
- All code changes go through PRs targeting `dev` for traceability and CI verification.

### Task Creation Rules

1. One task per distinct failure (not per test assertion -- group related failures from the same root cause into a single task).
2. Task type is `coder` if source code changes are needed (test fixes, product fixes). Task type is `general` if it is investigation-only, environment issue, or skip-with-reason.
3. Each task should include:
   - The failure details from the discovery report
   - Clear acceptance criteria (the specific test must pass)
   - A reference to the CI run ID and test file path
4. For `flaky` or `env` category failures, the task should document findings and either fix the flakiness or skip with a reason comment. Do not create fix tasks for known pre-existing issues that are already documented in `docs/e2e-health-check-log.md` unless they have worsened.
5. **Cross-reference the health check log** before creating a fix task. If the exact same failure (same test, same root cause) was documented in a prior health check entry, note it as "pre-existing, previously documented on YYYY-MM-DD" and only create a fix task if the issue has worsened (more tests affected, new error messages) or if a previous fix attempt failed.

### Fix Task Description Template

Use indented code blocks (4 spaces) inside the template to avoid nested triple-backtick conflicts:

    Fix E2E test failure: &lt;test-name&gt;

    **CI Run**: &lt;run-id&gt;
    **Commit**: &lt;head-sha&gt;
    **Job**: &lt;job-name&gt;
    **Test file**: packages/e2e/tests/&lt;path&gt;.e2e.ts
    **Error**: &lt;failure message&gt;
    **Root cause**: &lt;category and explanation&gt;
    **Pre-existing**: &lt;yes/no, reference health check log entry if yes&gt;

    Fix the test (or underlying product code) so it passes in CI. Verify locally with:

        NEOKAI_USE_DEV_PROXY=1 make run-e2e TEST=tests/&lt;path&gt;.e2e.ts

    After fixing, commit on a feature branch and create a PR:

        git checkout -b fix/e2e-&lt;test-name&gt;
        git add packages/e2e/tests/&lt;path&gt;.e2e.ts
        git commit -m "fix(e2e): &lt;description&gt;"
        git push origin fix/e2e-&lt;test-name&gt;
        gh pr create --base dev --title "fix(e2e): &lt;description&gt;" --body "Fixes E2E failure from CI run &lt;run-id&gt;"

    Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Reference Material for Fix Procedures

The existing detailed plan at `docs/plans/dev-branch-e2e-tests-health-check.md` contains proven fix procedures for common failure categories. Agents should reference it when determining their approach:

- **Test bugs**: Read the relevant UI component, update selectors/assertions. Common patterns include ambiguous locators, changed UI text, changed navigation flows.
- **Flaky tests**: Replace `waitForTimeout` with auto-retrying assertions. Add explicit waits for async DOM state. If 3+ consecutive failures without progress, flag for disable.
- **Product bugs**: Fix the underlying code. If the fix is large/risky, create a tracking task and apply a minimal `test.skip` workaround.
- **Environment issues**: Document and skip with a TODO comment.

---

## Acceptance Criteria

- Mission is configured as recurring `@hourly` with `supervised` autonomy.
- Discovery task runs each hour and checks the latest completed (non-cancelled) CI run on dev.
- Discovery task verifies that E2E jobs actually ran (not skipped) before reporting "all green". If E2E jobs were skipped due to build/discover failures, this is reported as a CI infrastructure issue.
- If no completed runs exist, the discovery task waits up to 10 minutes polling every 2 minutes before giving up.
- If all recent runs (last 5) are cancelled, the task reports no data and stops.
- Failure report includes test name, failure message, relevant commit hash, and root cause category.
- Leader agent creates one fix task per distinct failure.
- Fix tasks reference the CI run and include clear acceptance criteria.
- Discovery results are appended to `docs/e2e-health-check-log.md`.
- Known pre-existing issues documented in `docs/e2e-health-check-log.md` are not re-investigated unless they have worsened.
- Excluded tests (`space-export-import`, `space-workflow-rules`) are not investigated.
- The guardian does NOT trigger `workflow_dispatch` or push to dev directly -- it is a read-only observer.
- GitHub CLI is authenticated and `jq` is available in the agent environment.

## Per-Execution Task Template

> **Relationship to mission description:** The "Mission Description (Discovery Task Prompt)" section above is the full reference specification. This Per-Execution Task Template is the condensed prompt that the mission system injects as the task description when cloning the task for subsequent executions. Both are authoritative; the template is a self-contained subset of the full description. If the agent needs more detail on any step, it should consult the full mission description.

Each hourly execution produces exactly one task:

**Title:** E2E Discovery: check latest dev CI for failures
**Agent:** general
**Priority:** high

```
Check the latest completed CI run on the dev branch for E2E test failures.

Steps:
1. Run: gh run list --repo lsm/neokai --branch dev --limit 5 --status completed --json databaseId,conclusion,createdAt,headSha
2. Pick the most recent non-cancelled run. If all 5 are cancelled, report "all cancelled" and exit. If no completed runs exist at all, poll every 2 minutes for up to 10 minutes (5 attempts), then give up.
3. Verify E2E jobs actually ran (not skipped). Check upstream jobs (Build Binary, Discover Tests) succeeded. If E2E jobs were all skipped due to upstream failures, report "WARNING: E2E skipped (upstream failure)" and exit -- do NOT report "all green".
4. Run: gh run view --repo lsm/neokai <run-id> --json jobs --jq '.jobs[] | select(.name | startswith("E2E")) | {name: .name, conclusion: .conclusion}'
5. If all E2E jobs passed, report "All green" and stop.
6. For each failed E2E job, extract the failure message from job logs.
7. For each failure, categorize root cause as: test-bug | product-bug | flaky | env. Check docs/e2e-health-check-log.md for pre-existing occurrences.
8. Output a structured summary listing each failure with: test name, failure message, commit hash, root cause category, pre-existing status.
9. Append results to docs/e2e-health-check-log.md following existing format.

Excluded tests (do not investigate): features/space-export-import, features/space-workflow-rules.

Do NOT push commits. Do NOT create PRs. Do NOT modify source code files. Appending to the health check log is the only allowed write. This is otherwise a READ-ONLY discovery task.
```

### Leader Guidance for CI Infrastructure Warnings

If the discovery output contains a CI infrastructure warning (e.g., "Build was skipped", "No E2E jobs actually ran") with no failure entries, do NOT create fix tasks. These are infrastructure issues, not test failures, and should be reported to the team but not tracked as fix tasks.
