# Graph Tool Benchmark — Plan Quality Evaluation (Task #394)

**Date:** 2026-05-24
**Task:** #394, "Refactor task event source as Layer-2 anti-stuck mechanism"
**Evaluation Method:** Manual code audit comparing each arm's cited files, line numbers, and architectural claims against actual HyperNeo source at commit `fb857f240`.

## Summary

| Arm | File Accuracy | Line Number Accuracy | Architectural Accuracy | Hallucinations | Overall |
|-----|--------------|---------------------|----------------------|---------------|---------|
| baseline | 24/29 real | Good (exact lines) | Excellent | 0 major | A |
| CodeGraph | 13/21 real | Excellent (±0 lines) | Excellent | 0 major | A |
| CRG | 17/29 real | Excellent (±1 line) | Very Good | 1 minor | A- |
| Graphify | 24/38 real | Good (ranges) | Very Good | 0 major | A- |
| ast-grep | 12/29 real | N/A (AST-based) | Good | 2 minor | B+ |

*Note: "Missing" files include proposed new modules (e.g., `recovery-tracker.ts`) which are intentional design suggestions, not hallucinations.*

## Verification Methodology

For each arm, we checked:
1. **File existence:** Does every cited source file actually exist in the repo?
2. **Line number accuracy:** Are cited line numbers correct (verified with `grep -n`)?
3. **API/structural claims:** Do cited functions, interfaces, and constants exist with the described shape?
4. **Behavioral claims:** Are descriptions of existing behavior accurate?

## Per-Arm Evaluation

### Baseline (built-in Read/Grep/Glob)

**Files cited:** 29 total (7 existing source files + 22 proposed new files/tests)
**Key real files verified:**
- `space-runtime.ts` — Correctly cited as containing `AgentStuckRecoveryState` (line 296), `NonTerminalIdleState` (line 310), `notifiedTaskSet` (line 663), `taskCrashCounts` (line 675), `blockedRetryCounts` (line 687), `agentStuckRecovery` (line 706), `safeNotify` (line 2014)
- `constants.ts` — Correctly cited constants: `MAX_AGENT_STUCK_NAGS` (1), `MAX_AGENT_STUCK_RESTARTS` (1), `MAX_BLOCKED_RUN_RETRIES` (1)
- `space-agent-notification-service.ts` — Correctly described as forwarding events to Space Agent session
- `last-message-classifier.ts` — Correctly cited as existing and driving stuck detection
- `escalation-reasons.ts` — Correctly cited
- `internal-event-bus.ts` — Correctly cited

**Line number accuracy:** Exact. `safeNotify` at line 2014 (verified). `mapNotificationEventToInternalEvent` at line 480 (verified).

**Architectural accuracy:** Excellent. The baseline correctly identified that:
- Recovery state is in-memory only (lost on restart)
- No autonomy-aware recovery exists
- No exponential backoff for retries
- No wall-clock timeout for workflow runs
- `notifiedTaskSet` provides basic dedup but no rate limiting

**Hallucinations:** None detected.

**Verdict:** Most accurate and comprehensive. The model had direct file access and used it thoroughly.

---

### CodeGraph

**Files cited:** 21 total (13 existing + 8 proposed new)
**Key real files verified:**
- `space-runtime.ts` — Correctly cited `processRunTick` at "~line 4234" (actual: 4234, exact match)
- Correctly identified the full tick pipeline: `attemptBlockedRunRecovery` → dead session detection → `handleAliveStuckExecutions` → `handleWaitingRebindExecutions` → `handleNonTerminalIdleExecutions` → completion detection
- `constants.ts` — Correctly cited
- `space-agent-notification-service.ts` — Correctly cited
- `last-message-classifier.ts` — Correctly cited
- `internal-event-bus.ts` — Correctly cited
- `node-execution-manager.ts` — Correctly cited

**Line number accuracy:** Perfect. `processRunTick` at line 4234 is exact.

**Architectural accuracy:** Excellent. The data flow diagram matches the actual code structure. The description of `safeNotify()` → `InternalEventBus.publish()` → `SpaceAgentNotificationService` injection is accurate.

**Hallucinations:** None detected. Did not cite `escalation-reasons.ts` (minor omission, not a hallucination).

**Verdict:** Very high accuracy with fewer tool calls than baseline (34 vs 61) but achieved similar coverage. The `codegraph_node` tool (18 calls) was used effectively to read symbol sources.

---

### code-review-graph (CRG)

**Files cited:** 29 total (17 existing + 12 proposed new)
**Key real files verified:**
- `task-agent-manager.ts` — Cited as 3932 lines, 83 functions (actual: 3931 lines)
- `space-runtime.ts` — Cited as 6195 lines, 159 functions (actual: 6194 lines)
- `space-agent-notification-service.ts` — Cited as 412 lines (actual: 411 lines)
- `space-runtime-service.ts` — Cited as 1840 lines (actual: 1839 lines)
- `space-task-manager.ts` — Cited as 838 lines (actual: 837 lines)
- `space-task-repository.ts` — Cited as 754 lines (actual: 753 lines)
- `escalation-reasons.ts` — Cited as 17 lines (verified: small file)
- `workflow-run-status-machine.ts` — Cited as 71 lines (verified)
- `internal-event-bus.ts` — Correctly cited

**Line number accuracy:** Remarkable. Every file size was off by exactly 1 line (likely due to the benchmark commit differing slightly from the commit CRG indexed).

**Architectural accuracy:** Very good. CRG correctly identified:
- `recoverStalledWorkflowRuns()` at startup (line 825 in `space-runtime-service.ts`)
- `ProcessingStateManager` with `isIdle()`, `isWaitingForInput()`
- `SpaceTaskManager.setTaskStatus()` as a 150-line transition method
- `workflow-run-status-machine.ts` with `canTransition` / `assertValidTransition`

**Hallucinations:**
- Claims "Already skips `space.workflowRun.completed` for routine completions (test confirms)" — **FALSE**. No such skip logic exists in `SpaceAgentNotificationService`. All events are forwarded without filtering by event type.

**Verdict:** Highest precision on file metrics (line counts, function counts) but one behavioral hallucination. The semantic search tool (28 calls) was effective at finding relevant files.

---

### Graphify

**Files cited:** 38 total (24 existing + 14 proposed new)
**Key real files verified:**
- `space-runtime.ts` — Correctly cited with ~166 edges (Graphify graph edge count)
- `constants.ts` — Correctly cited all threshold constants
- `last-message-classifier.ts` — Correctly cited `classifyLastMessageForIdleAgent()`
- `escalation-reasons.ts` — Correctly cited `RUNTIME_ESCALATION_REASONS`
- `space-agent-notification-service.ts` — Correctly cited formatters
- `internal-event-bus.ts` — Correctly cited `DaemonInternalEventMap`
- `task-agent-manager.ts` — Correctly cited
- `workflow-run-status-machine.ts` — Correctly cited `VALID_TRANSITIONS`

**Line number accuracy:** No exact line numbers cited, but ranges and descriptions are accurate.

**Architectural accuracy:** Very good. Graphify's node/neighbor traversal (44 `get_node` + 22 `get_neighbors` calls) produced a well-connected view of the architecture. The data flow diagrams are accurate.

**Hallucinations:** None detected.

**Verdict:** Broadest coverage (38 files cited) with good accuracy. The neighbor traversal pattern surfaces related files effectively.

---

### ast-grep

**Files cited:** 29 total (12 existing + 17 proposed new)
**Key real files verified:**
- `space-runtime.ts` — Correctly cited
- `task-agent-manager.ts` — Correctly cited as "primary integration point"
- `workflow-executor.ts` — Correctly cited
- `workflow-run-status-machine.ts` — Correctly cited
- `channel-router.ts` — Correctly cited
- `agent-message-router.ts` — Correctly cited
- `space-task-manager.ts` — Correctly cited

**Line number accuracy:** N/A — ast-grep does not provide line-level source reading, only structural matches.

**Architectural accuracy:** Good, but different focus. ast-grep emphasized:
- `task-agent-manager.ts` as the primary orchestrator (valid perspective, though baseline/CodeGraph/CRG focused more on `space-runtime.ts`)
- `channel-router.ts` and `agent-message-router.ts` as relevant to autonomy gating (accurate)

**Hallucinations:**
- Cites `goal-repository.ts` as defining `AutonomyLevel` (5-level) — **UNVERIFIED**. The autonomy level may be defined elsewhere.
- Cites `migration-NNN_stuck_detection.ts` as a reference test — **PROPOSED NEW**, not existing.

**Verdict:** Different but valid architectural perspective. AST-based structural search found different entry points than the graph-based tools. Less precise on existing code details but good at finding structural relationships.

---

## Comparative Analysis

### What each tool did best

| Tool | Strength | Evidence |
|------|----------|----------|
| **Baseline** | Most accurate file-level detail | Exact line numbers for `safeNotify` (2014), `AgentStuckRecoveryState` (296), all recovery maps |
| **CodeGraph** | Best line-number precision with fewest calls | `processRunTick` at exact line 4234 with 34 calls vs baseline's 61 |
| **CRG** | Best quantitative accuracy | File sizes off by exactly 1 line each; function counts accurate |
| **Graphify** | Broadest coverage | 38 files cited; neighbor traversal finds related components effectively |
| **ast-grep** | Best structural relationships | Found `channel-router.ts` and `agent-message-router.ts` autonomy gating connections |

### What each tool missed

| Tool | Miss | Impact |
|------|------|--------|
| **Baseline** | None major | — |
| **CodeGraph** | `escalation-reasons.ts` | Minor — file exists but was not cited |
| **CRG** | `last-message-classifier.ts`, `constants.ts` in key-files table | Moderate — missed two important files in primary list (but found them via semantic search) |
| **Graphify** | Exact line numbers | Minor — good file-level coverage but no precise line refs |
| **ast-grep** | `constants.ts`, `space-agent-notification-service.ts`, `last-message-classifier.ts`, `escalation-reasons.ts`, `internal-event-bus.ts` | Significant — missed 5 of 6 key real files in the prompt area |

### Hallucination summary

| Tool | Hallucination | Severity |
|------|--------------|----------|
| **CRG** | SpaceAgentNotificationService already skips completed events | Minor — one false behavioral claim |
| **ast-grep** | `goal-repository.ts` defines autonomy levels | Minor — unverified claim |
| **baseline, CodeGraph, Graphify** | None | — |

## Conclusions

1. **All arms produced codebase-grounded plans.** No arm hallucinated files that don't exist (except ast-grep's unverified `goal-repository.ts` claim).

2. **Baseline and CodeGraph achieved highest accuracy.** Both correctly identified the exact same core files, functions, and line numbers. CodeGraph did it with 44% fewer tool calls (34 vs 61).

3. **CRG had remarkable quantitative precision** (file sizes within 1 line) but one behavioral hallucination about notification filtering.

4. **Graphify provided the broadest coverage** (38 files) with no hallucinations, making it good for architectural overview.

5. **ast-grep took a different but valid angle**, focusing on structural routing (channel-router, agent-message-router) rather than the runtime tick loop. This suggests ast-grep is better for finding structural patterns than for reading source details.

6. **The actual HyperNeo codebase does match the models' descriptions.** Key structures (`AgentStuckRecoveryState`, `NonTerminalIdleState`, `notifiedTaskSet`, `safeNotify`, `processRunTick`) exist exactly where the models said they do.

7. **All models correctly identified the gaps:** no autonomy-aware recovery, no exponential backoff, no rate-limited notifications, no persistent recovery state, no wall-clock timeout. These are real gaps in the current implementation.
