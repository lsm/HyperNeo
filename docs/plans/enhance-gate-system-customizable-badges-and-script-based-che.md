# Plan: Enhance Gate System — Customizable Badges and Script-Based Checks

## Context

The workflow gate system currently uses hardcoded heuristics to derive badge labels and colors on channel edges. Badge text like "Human", "Votes", "Shell" is inferred from field declarations via `resolveSemanticGateType()` and hardcoded maps in `EdgeRenderer.tsx`. Gate evaluation is purely synchronous and declarative — fields are checked against data, but there is no mechanism to run imperative checks (e.g., lint, test, compile) before field evaluation.

This plan adds two capabilities:
1. **Customizable badge label and color** — author-defined `label` and `color` on the Gate entity, with heuristic fallback preserved for backward compatibility
2. **Script-based gate checks** — optional free-form script execution (bash/node/python3) as an imperative pre-check before declarative field evaluation, using `Bun.spawn()` for process isolation

## Approach

### Part A: Customizable Badges (label + color on Gate)

Add optional `label?: string` and `color?: string` fields to the `Gate` interface in `@hyperneo/shared`. When set, these override the heuristic-derived badge text and color on channel edges. When not set, the existing heuristic logic in `resolveSemanticGateType()` and `EdgeRenderer.tsx` continues to work unchanged.

- `color` uses hex-only format (`#rrggbb`), validated via regex at the boundary
- `label` is capped at 20 characters
- `fields` becomes optional on `Gate` (defaults to `[]`), since a gate with only a script check needs no fields

### Part B: Script-Based Gate Checks

Add optional `script?: GateScript` to the Gate interface. When present, the gate evaluator runs the script before evaluating declarative fields. The script's stdout (parsed as JSON) is deep-merged into the gate data before field evaluation. A non-zero exit code or timeout blocks the gate immediately.

Key design decisions:
- `Bun.spawn()` (array form), never `Bun.$` — user-supplied script source must never be interpolated into a shell string, and `Bun.spawn` avoids shell interpretation entirely
- Languages: `bash`, `node`, `python3` only (allowlist)
- Default timeout: 30s, `killSignal: 'SIGKILL'`
- `maxBuffer: 1MB` on stdout — enforced via chunk-by-chunk byte counting during streaming read, not by buffering everything then checking size
- Restricted env (no API keys or credentials) — scripts are **trusted** (workspace-author-configured), but env is restricted as defense-in-depth to prevent accidental credential leakage
- Per-gate evaluation coalescing with re-run-if-dirty pattern: concurrent evaluations for the same gate share one in-flight result (keyed by `${runId}:${gateId}`), but if new gate data arrives during execution, a follow-up re-evaluation is scheduled
- Deep merge of JSON stdout with depth limit (max 5 levels), rejecting `__proto__`/`constructor`/`prototype` keys

### Part C: Async Migration

`evaluateGate()` becomes async to support script execution. A private sync helper (`evaluateFieldsSync`) preserves the pure declarative path for gates without scripts. The **frontend** retains its own independent `evaluateGateStatus()` function in `WorkflowCanvas.tsx` (which is sync and field-only) — it is not affected by the backend async migration, **but** it does access `gate.fields` directly and needs a `?? []` guard (see Task 1.4).

`isChannelOpen()` remains **synchronous** — it is a convenience function for checking gate status from data already in hand, not for triggering script execution. It has no `scriptExecutor` context.

### Part D: Concurrency

Per-gate evaluation coalescing prevents overlapping evaluations for the same gate+run pair (deduplication). Maps are keyed by composite `${runId}:${gateId}` to prevent cross-run state leakage. A global concurrency semaphore (default: 4) caps the total number of simultaneous script processes across all gates to prevent resource exhaustion.

### Part E: Script Error Transport to Frontend

The frontend currently receives gate data changes via `space.gateData.updated` events (payload: `{ runId, gateId, data }`). `GateEvalResult.reason` (backend-only) is not available to the frontend. To surface script errors in the UI, the `write_gate` MCP tool will store the evaluation result (including `reason`) in a special `_scriptResult` key within the gate data itself. The frontend can then read `gateData._scriptResult.reason` to display error information.

### Part F: `fields` Optional Safety

Making `fields` optional on `Gate` introduces `undefined` at every `gate.fields` access site. Task 1.4 provides a comprehensive audit and guard addition across the entire codebase (frontend + backend).

---

## Milestone 1: Shared Type Changes (Gate Interface + Validation + Safety)

### Task 1.1: Extend Gate interface with label, color, script fields

**File:** `packages/shared/src/types/space.ts`

**Subtasks:**
1. Add `GateScript` interface:
   ```ts
   export interface GateScript {
     /** Script interpreter: 'bash', 'node', or 'python3' */
     interpreter: 'bash' | 'node' | 'python3';
     /** Script source code to execute */
     source: string;
     /** Timeout in milliseconds (default: 30000) */
     timeoutMs?: number;
   }
   ```
2. Add `label?: string` and `color?: string` and `script?: GateScript` to the `Gate` interface (lines 580-592)
3. Make `fields` optional on `Gate` (change `fields: GateField[]` to `fields?: GateField[]`)
4. Update `computeGateDefaults()` signature to accept `fields?: GateField[]` — internally treat `undefined` as `[]`
5. Export `GateScript` from the shared module barrel
6. Update all `computeGateDefaults` call sites — since `fields` is now optional, these call sites remain valid because `computeGateDefaults` accepts `undefined`. Verify:
   - `channel-router.ts` lines 594, 728, 741
   - `node-agent-tools.ts` lines 585, 621
   - `gate-data-repository.ts` documentation (line 112)
   - `channel-router.test.ts` (multiple call sites)

**Acceptance criteria:**
- `Gate` type compiles with `label`, `color`, `script` all optional, `fields` optional
- `computeGateDefaults(undefined)` returns `{}`
- `computeGateDefaults([])` returns `{}`
- `computeGateDefaults(someFields)` returns the same result as before
- `GateScript` type is exported from `@hyperneo/shared`

**Dependencies:** None
**Agent type:** coder

---

### Task 1.2: Add gate validation for new fields

**File:** `packages/daemon/src/lib/space/runtime/gate-evaluator.ts`

**Subtasks:**
1. Add `validateGateColor(color: unknown): string[]` — validates hex format `#rrggbb` via `/^#[0-9a-fA-F]{6}$/`
2. Add `validateGateLabel(label: unknown): string[]` — validates string, max 20 chars
3. Add `validateGateScript(script: unknown): string[]` — validates:
   - `interpreter` is one of `'bash' | 'node' | 'python3'`
   - `source` is a non-empty string
   - `timeoutMs` is positive number if present (max 120000)
4. Add `validateGate(gate: unknown): string[]` — top-level validator that:
   - Calls `validateGateFields()` when `fields` is present and non-empty
   - Calls `validateGateColor()`, `validateGateLabel()`, `validateGateScript()`
   - Validates that at least one of `fields` (non-empty) or `script` is present
   - **Important:** This validator is only applied to **new/updated gates** (via `GateEditorPanel` and MCP tool handlers), never to existing gates loaded from storage. Existing gates with `fields: []` remain valid at runtime — the strict rule only gates creation/modification.

**Acceptance criteria:**
- `validateGate({ id: 'g1', fields: [], resetOnCycle: false })` returns errors (empty fields, no script) — this is a **creation-time** validation failure
- `validateGate({ id: 'g1', fields: [{ ... }], resetOnCycle: false })` returns `[]`
- `validateGate({ id: 'g1', script: { interpreter: 'node', source: '...' }, resetOnCycle: false })` returns `[]`
- Invalid color `'red'` produces error
- Valid color `'#ff5500'` passes
- Script with `interpreter: 'ruby'` produces error
- Empty `source` produces error
- `timeoutMs: 200000` produces error (exceeds 120s max)
- Label longer than 20 chars produces error
- Existing gates with `fields: []` in the DB are NOT re-validated on load

**Dependencies:** Task 1.1
**Agent type:** coder

---

### Task 1.3: Unit tests for shared type changes

**File:** `packages/daemon/tests/unit/space/gate-types-and-schema.test.ts`

**Subtasks:**
1. Add tests for `Gate` with `label` and `color` fields persisting through `SpaceWorkflowRepository` round-trip
2. Add tests for `Gate` with `script` field persisting through workflow repository
3. Add tests for `Gate` with `fields` omitted (script-only gate) persisting correctly
4. Add tests for `computeGateDefaults` with `undefined` and `[]` fields
5. Verify backward compatibility: existing gates without `label`/`color`/`script` round-trip unchanged
6. Verify that `validateGate` is a **creation-time** validator, not applied on load — existing gates with `fields: []` deserialize from storage without errors

**Acceptance criteria:**
- All new tests pass
- Existing tests continue to pass
- Gate with label+color+script+fields persists and round-trips correctly
- Gate with only script (no fields) persists and round-trips correctly

**Dependencies:** Task 1.1, Task 1.2
**Agent type:** coder

---

### Task 1.4: Add `?? []` safety guards for optional `gate.fields`

**Rationale:** Making `fields` optional on `Gate` means every bare `gate.fields` access can produce `undefined`. A comprehensive audit is needed to add `?? []` fallback guards at every access site across the entire codebase. This is a **separate task** from Task 1.1 because the scope spans many files in both frontend and backend.

**Files to update (comprehensive list from codebase audit):**

**Frontend:**
- `packages/web/src/components/space/WorkflowCanvas.tsx` — lines 124, 127, 131, 142, 1210, 1212 (`gate.fields.length`, `gate.fields.every()`, `gate.fields.find()`, `for (const field of gate.fields)`, `isHumanApprovalGate(gate.fields)`, `computeVoteCount(gate.fields, gateData)`)
- `packages/web/src/components/space/WorkflowEditor.tsx` — line 606 (`fields: [...gate.fields]` spread)
- `packages/web/src/components/space/visual-editor/GateEditorPanel.tsx` — lines 41, 53, 54, 58, 71, 81, 149, 152 (spread, filter, map, length on `gate.fields`)
- `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx` — lines 124, 1013 (`gate.fields` spread in presets/copy)
- `packages/web/src/components/space/visual-editor/semanticWorkflowGraph.ts` — line 59 (`gate.fields; if (fields.length === 0)`)

**Backend:**
- `packages/daemon/src/lib/space/runtime/gate-evaluator.ts` — line 171 (`for (const field of gate.fields)`)
- `packages/daemon/src/lib/space/agents/task-agent.ts` — line 138 (`gate.fields.map(...)`)
- `packages/daemon/src/lib/space/tools/node-agent-tools.ts` — lines 498, 583, 621, 629, 670, 678

**Subtasks:**
1. For each file listed above, replace every bare `gate.fields` or `gateDef.fields` with `(gate.fields ?? [])` or `(gateDef.fields ?? [])`
2. For iteration patterns (`for...of`, `.map()`, `.filter()`, `.every()`, `.find()`, `.some()`, `.length`), wrap with `?? []` at the point of access
3. For spread patterns (`...gate.fields`), wrap with `...(gate.fields ?? [])`
4. In `evaluateFieldsSync` (extracted in Task 3.1): use `(gate.fields ?? [])` for the field iteration loop
5. In `node-agent-tools.ts` lines 670, 678 specifically: `new Map((gateDef.fields ?? []).map(...))` and `(gateDef.fields ?? []).map(...)` — these crash for script-only gates if unguarded
6. Run full typecheck after changes to verify no `undefined` errors

**Acceptance criteria:**
- `grep -rn 'gate\.fields\b' packages/` returns zero instances of bare `gate.fields` (all accesses guarded with `?? []`)
- `grep -rn 'gateDef\.fields\b' packages/` returns zero instances of bare `gateDef.fields`
- TypeScript compiles with no errors
- Script-only gates (no `fields`) do not crash at any access site
- Field-based gates continue to work as before

**Dependencies:** Task 1.1
**Agent type:** coder

---

## Milestone 2: Backend Script Execution Engine

### Task 2.1: Create gate script executor

**New file:** `packages/daemon/src/lib/space/runtime/gate-script-executor.ts`

**Subtasks:**
1. Define `GateScriptResult` interface:
   ```ts
   export interface GateScriptResult {
     success: boolean;
     data?: Record<string, unknown>;  // parsed JSON stdout
     error?: string;                   // stderr or error message
   }
   ```
2. Define `RESTRICTED_ENV_PATTERNS` — list of env var prefixes/keys to strip. **Threat model:** scripts are trusted (workspace-author-configured) but env is restricted as defense-in-depth:
   - Prefixes: `ANTHROPIC_`, `CLAUDE_`, `GLM_`, `ZHIPU_`, `COPILOT_`, `HYPERNEO_SECRET_`
   - Pattern: any key matching `/SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY/i`
   - Always allow: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TERM`, `TMPDIR`
3. Implement `buildRestrictedEnv(): Record<string, string | undefined>`:
   - Start with `process.env` copy
   - Strip keys matching restricted patterns
   - Preserve allowed keys
4. Implement `deepMergeWithDepthLimit(target, source, maxDepth = 5): Record<string, unknown>`:
   - Recursive merge of source into target
   - Reject keys named `__proto__`, `constructor`, `prototype`
   - Stop recursing at `maxDepth` (return source value as-is at limit)
5. Implement `parseJsonStdout(raw: string): Record<string, unknown> | null`:
   - Trim whitespace, parse as JSON
   - Return null if parse fails or result is not a plain object
6. Implement `executeGateScript(script: GateScript, context: { workspacePath: string; gateId: string; runId: string }): Promise<GateScriptResult>`:
   - Build restricted env; inject `HYPERNEO_GATE_ID`, `HYPERNEO_WORKFLOW_RUN_ID`, `HYPERNEO_WORKSPACE_PATH`
   - Set `cwd` to `context.workspacePath`
   - Determine interpreter binary: `bash` -> `['bash', '-c', script.source]`, `node` -> `['node', '-e', script.source]`, `python3` -> `['python3', '-c', script.source]`
   - Spawn with `Bun.spawn()`, capture stdout + stderr
   - Apply `timeoutMs` (default 30000) — use `setTimeout` + `process.kill(pid, 'SIGKILL')` for deterministic timeout handling
   - **`maxBuffer` enforcement via streaming**: read stdout chunk-by-chunk from `proc.stdout` using a loop (e.g., `proc.stdout.getReader()` or `for await (const chunk of proc.stdout)`), accumulating byte count. If accumulated bytes exceed 1MB, kill the process and return failure. This avoids buffering everything before checking size.
   - On exit code 0: parse stdout as JSON, deep-merge with depth limit into empty object, return `{ success: true, data }`
   - On non-zero exit or timeout: return `{ success: false, error: stderr.trim() || 'exit code N' }`

**Acceptance criteria:**
- `executeGateScript({ interpreter: 'node', source: 'console.log(JSON.stringify({done:true}))' }, context)` returns `{ success: true, data: { done: true } }`
- Script with non-zero exit returns `{ success: false, error: ... }`
- Script exceeding timeout is killed and returns failure
- Restricted env does not leak `ANTHROPIC_API_KEY` or other credential keys
- Deep merge with depth limit stops at max depth
- Prototype pollution keys are rejected
- Empty/non-JSON stdout returns `{ success: true, data: {} }` (no error, just no data)
- `maxBuffer` is enforced during streaming, not after full buffer

**Dependencies:** Task 1.1
**Agent type:** coder

---

### Task 2.2: Unit tests for gate script executor

**New file:** `packages/daemon/tests/unit/space/gate-script-executor.test.ts`

**Subtasks:**
1. Test successful script execution with JSON stdout (all three interpreters: bash, node, python3)
2. Test non-zero exit code handling
3. Test timeout enforcement
4. Test maxBuffer enforcement (script that outputs >1MB)
5. Test restricted env does not leak credentials (including keys matching `API_KEY` pattern, `SECRET` pattern, etc.)
6. Test deep merge with depth limit
7. Test prototype pollution prevention (`__proto__`, `constructor`, `prototype`)
8. Test non-JSON stdout handling (returns empty data, no error)
9. Test `workspacePath` is set as `cwd` and injected as `HYPERNEO_WORKSPACE_PATH`
10. Test `HYPERNEO_GATE_ID` and `HYPERNEO_WORKFLOW_RUN_ID` are injected

**Acceptance criteria:**
- All tests pass with `bun test`
- Tests do not require real API keys or external services
- Coverage of happy path + error paths for all three interpreters

**Dependencies:** Task 2.1
**Agent type:** coder

---

## Milestone 3: Async Gate Evaluation Migration

### Task 3.1: Migrate evaluateGate to async with script pre-check

**File:** `packages/daemon/src/lib/space/runtime/gate-evaluator.ts`

**Subtasks:**
1. Extract sync field evaluation into private helper `evaluateFieldsSync(gate: Gate, data: Record<string, unknown>): GateEvalResult`
   - Use `(gate.fields ?? [])` for the iteration — script-only gates with no fields will immediately return `{ open: true }`
2. Make `evaluateGate()` async: `async evaluateGate(gate: Gate, data: Record<string, unknown>, scriptExecutor?: GateScriptExecutorFn): Promise<GateEvalResult>`
   - `GateScriptExecutorFn` type: `(script: GateScript, context: { workspacePath: string; gateId: string; runId: string }) => Promise<GateScriptResult>`
3. If `gate.script` is defined and `scriptExecutor` is provided:
   - Call `scriptExecutor(gate.script, context)`
   - On failure: return `{ open: false, reason: 'Script check failed: ' + result.error }`
   - On success: deep-merge `result.data` into `data` (via `deepMergeWithDepthLimit`)
4. Then call `evaluateFieldsSync(gate, mergedData)` as before
5. If `gate.script` is undefined or `scriptExecutor` is not provided: call `evaluateFieldsSync` directly (no async overhead for existing gates — just returns a resolved Promise wrapping the sync result)
6. **Keep `isChannelOpen()` synchronous** — it is a convenience function for checking gate status from data already in hand, not for triggering script execution. It does not need a `scriptExecutor` parameter. It continues to call `evaluateFieldsSync` directly.
7. `GateEvalResult` remains a plain synchronous type (the async is only in evaluation, not the result type)

**Frontend note:** `packages/web/src/components/space/WorkflowCanvas.tsx` has its own independent `evaluateGateStatus()` function (line 123) that is sync and field-only. It does **not** import or call the backend `evaluateGate`. However, it accesses `gate.fields` directly (line 124: `gate.fields.length === 0`), which needs a `?? []` guard — this is handled by Task 1.4.

**Acceptance criteria:**
- Existing tests for `evaluateGate` continue to pass (with `await` added since it is now async)
- `isChannelOpen` remains synchronous and unmodified
- Gate without script evaluates synchronously under the hood (returns immediately-resolved Promise)
- Gate with script runs script before field evaluation
- Script failure blocks the gate immediately
- Script success merges stdout data before field checks
- Script-only gate (no fields, script present) with `scriptExecutor` returns based on script result alone

**Dependencies:** Task 1.1, Task 1.4, Task 2.1
**Agent type:** coder

---

### Task 3.2: Update ChannelRouter for async gate evaluation

**File:** `packages/daemon/src/lib/space/runtime/channel-router.ts`

**Subtasks:**
1. Import `executeGateScript` and the `GateScriptExecutorFn` type
2. Add `workspacePath?: string` to `ChannelRouterConfig` — **critical** because `ChannelRouter` currently has no workspace path. Scripts must run from the space workspace directory. Without this, scripts would run from `process.cwd()` (the daemon working directory) and silently break workspace-relative checks.
3. Add `maxConcurrentScripts?: number` to `ChannelRouterConfig` (default: 4) — global concurrency cap for script executions across all gates.
4. Implement a global concurrency semaphore (simple counter-based, not a library):
   ```ts
   private scriptSemaphore: { acquired: number; waiters: Array<() => void> }
   ```
5. Implement per-gate evaluation coalescing **with re-run-if-dirty**, keyed by composite `${runId}:${gateId}`:
   - `gateEvaluations: Map<string, Promise<GateEvalResult>>` — tracks in-flight evaluations, key = `"${runId}:${gateId}"`
   - `gateDirtyFlags: Map<string, boolean>` — marks gates that need re-evaluation after current eval completes, same key format
   - **Important:** Using just `gateId` as the key would cause cross-run state leakage when two concurrent workflow runs share the same gate definition (same workflow template, different run instances)
   - In `evaluateGateById(runId, gateId)`: build `key = "${runId}:${gateId}"`; if an evaluation is in-flight for this key, set the dirty flag and await the in-flight result. After the in-flight result resolves, if dirty flag is set, clear it and start a new evaluation.
6. Update `evaluateGateById()` to async: wrap script execution in semaphore acquire/release, pass `scriptExecutor` to `evaluateGate()`
7. Update `canDeliver()` and `deliverMessage()` to await the async `evaluateGateById()` (these methods are already async)
8. Update `onGateDataChanged()` to await the async `evaluateGateById()` with re-run-if-dirty support

**Acceptance criteria:**
- `canDeliver()`, `deliverMessage()`, `onGateDataChanged()` work correctly with async script evaluation
- Concurrent `onGateDataChanged()` for the same `${runId}:${gateId}` are coalesced, but new data triggers re-evaluation
- Two concurrent runs with the same gateId do NOT share evaluation state
- Different gateIds can evaluate concurrently (up to `maxConcurrentScripts` limit)
- Gates without scripts continue to evaluate without semaphore overhead
- `workspacePath` is available in the config and passed to `executeGateScript`
- Existing ChannelRouter tests pass (updated for async where needed)

**Dependencies:** Task 1.4, Task 2.1, Task 3.1
**Agent type:** coder

---

### Task 3.3: Wire ChannelRouter construction sites with workspacePath and scriptExecutor

**Files:**
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (lines 622, 1440, 1755)
- `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` (line 309)

**Context:** `workspacePath` is not always directly in scope at every `new ChannelRouter(...)` call. This task describes how to obtain it at each site.

**Subtasks:**
1. **`task-agent-manager.ts` line 622** (main task `spawnTaskAgent()`):
   - `workspacePath` is already in scope as a local variable (computed from `space.workspacePath` or worktree path, around line 556-593)
   - Add `workspacePath` to the `ChannelRouterConfig` object
2. **`task-agent-manager.ts` line 1440** (rehydration in `rehydrate()`):
   - `rehydrateWorkspacePath` is computed at lines 1410-1425 from `space.workspacePath` or stored worktree path
   - Add `rehydrateWorkspacePath` to the rehydration `ChannelRouterConfig`
3. **`task-agent-manager.ts` line 1755** (`buildNodeAgentMcpServerForSession()`):
   - **Problem:** The method signature `(taskId, subSessionId, role, spaceId, workflowRunId, stepTaskId, taskManager)` does NOT include `workspacePath` or a space object
   - **Solution:** Compute workspace path using the existing `getTaskWorktreePath(taskId)` public method (line 862) which returns `string | undefined` from the `taskWorktreePaths` map, then fall back to `space.workspacePath`. The lookup chain: `this.getTaskWorktreePath(taskId) ?? this.config.spaceManager.getSpace(spaceId).workspacePath`. Note: `getTaskWorktreePath` does NOT fall back to `space.workspacePath` on its own — it returns `undefined` when no worktree exists. The fallback to `space.workspacePath` must be done explicitly. Since `spaceId` is already a parameter, look up the space object to get the base workspace path.
   - Add `workspacePath` parameter to `buildNodeAgentMcpServerForSession()`, or compute it internally, then pass to `ChannelRouterConfig`
   - This is called from 3 sites (lines 651, 1470, 1561) — all have `taskId` available
4. **`space-runtime-service.ts` line 309** (`notifyGateDataChanged()`):
   - **Problem:** The method signature `(runId: string, gateId: string)` has no space object or workspace path in scope
   - **Solution:** Perform a lookup chain: `runId → workflowRunRepo.getRun(runId) → run.spaceId → spaceManager.getSpace(spaceId) → space.workspacePath`
   - The `SpaceRuntimeService` has both `this.config.spaceManager` and `this.config.workflowRunRepo` available
   - This lookup only runs when a gate evaluation is needed (script present), so the overhead is acceptable
5. At each site, construct a `scriptExecutor` function that wraps `executeGateScript` with the resolved `workspacePath`

**Acceptance criteria:**
- All four `new ChannelRouter(...)` call sites include `workspacePath` in their config
- `buildNodeAgentMcpServerForSession` receives or computes `workspacePath` correctly
- `notifyGateDataChanged` performs the run→space lookup to obtain `workspacePath`
- Node agent MCP server's `write_gate` tool can trigger script evaluation with correct workspace path
- No TypeScript errors at any call site

**Dependencies:** Task 2.1, Task 3.2
**Agent type:** coder

---

### Task 3.4: Update node-agent-tools.ts for async gate evaluation

**File:** `packages/daemon/src/lib/space/tools/node-agent-tools.ts`

**Subtasks:**
1. Update `evaluateGate()` call sites to `await evaluateGate()`:
   - **Line 624** is in `list_gates` — reports gate status. No `scriptExecutor` available → uses sync-only path. **Important note:** for a script-only gate (no fields) with no `scriptExecutor`, `evaluateGate` returns `{ open: true }` because the field loop over `(gate.fields ?? [])` immediately passes. This is a known limitation — `list_gates` shows field-based status only, and script-only gates will appear as "open" in listing even if the script would block. This is acceptable because `list_gates` is a status snapshot, not an evaluation trigger. The actual blocking happens in `write_gate` and `ChannelRouter`.
   - **Line 699** is in `write_gate` — the hot path. This has `scriptExecutor` via ChannelRouter. Update to `await`.
2. **Guard lines 670 and 678 for script-only gates:**
   - Line 670: `new Map(gateDef.fields.map(...))` → `new Map((gateDef.fields ?? []).map(...))`
   - Line 678: `gateDef.fields.map(...)` → `(gateDef.fields ?? []).map(...)`
   - **These are covered by Task 1.4 but listed here as critical verification points** — without these guards, script-only gates crash in `write_gate` before any evaluation can happen
3. **Store script evaluation result in gate data for frontend transport** (addresses script error surfacing):
   - After evaluation in `write_gate`, if `evalResult.reason` exists (script failure), store it in the gate data under a `_scriptResult` key:
     ```ts
     if (evalResult.reason) {
       updated.data._scriptResult = { success: false, reason: evalResult.reason };
     }
     ```
   - This data flows through the existing `space.gateData.updated` event to the frontend, where Task 4.6 reads it
4. Pass `scriptExecutor` if available in the tools config
5. Update `NodeAgentToolsConfig` if needed to carry `scriptExecutor`

**Acceptance criteria:**
- `list_gates` tool works correctly for field-based gates; script-only gates show `{ open: true }` (documented limitation)
- `write_gate` tool correctly triggers async gate evaluation including script execution
- Script-only gates do NOT crash at lines 670/678
- Script evaluation result (`reason`) is stored in gate data under `_scriptResult` key
- `space.gateData.updated` event payload includes `_scriptResult` when script fails
- No breaking changes to existing tool behavior

**Dependencies:** Task 1.4, Task 3.2, Task 3.3
**Agent type:** coder

---

### Task 3.5: Unit tests for async gate evaluation + migration

**Files:** (additions to existing test files)
- `packages/daemon/tests/unit/space/gate-evaluator.test.ts`
- `packages/daemon/tests/unit/space/channel-router.test.ts`

**Subtasks:**
1. Update existing `evaluateGate` tests to use `await` (since it is now async)
2. Add tests for `evaluateGate` with script pre-check:
   - Script passes, fields pass → gate opens
   - Script fails → gate closed immediately
   - Script passes but merges data that satisfies a field check
   - Script passes but field check still fails
   - Script returns non-JSON stdout → field evaluation proceeds with original data
   - No scriptExecutor provided → falls back to sync field evaluation
   - Script-only gate (no fields) with scriptExecutor → gate opens/closes based on script result alone
3. Add tests for per-gate evaluation coalescing in ChannelRouter:
   - Concurrent `onGateDataChanged()` for same `${runId}:${gateId}` shares one in-flight result
   - New data arriving during execution triggers re-evaluation (dirty flag)
   - Different `${runId}:${gateId}` keys evaluate independently
   - Two runs with same gateId do NOT share evaluation state
4. Add tests for global concurrency semaphore:
   - More than `maxConcurrentScripts` gates with scripts → excess gates wait
   - After one completes, next one starts
5. Add tests for backward compatibility: gates without `script` field evaluate as before
6. Verify `isChannelOpen` remains synchronous

**Acceptance criteria:**
- All existing gate evaluator tests pass (updated for async)
- All new async evaluation tests pass
- Per-gate coalescing tests verify shared-result + dirty-flag re-run behavior
- Cross-run isolation tests verify composite key prevents state leakage
- Semaphore tests verify concurrency cap
- `isChannelOpen` tests confirm no async changes

**Dependencies:** Task 3.1, Task 3.2
**Agent type:** coder

---

## Milestone 4: Frontend — Customizable Badge Rendering

### Task 4.1: Update semantic graph to pass gate label/color (bidirectional)

**File:** `packages/web/src/components/space/visual-editor/semanticWorkflowGraph.ts`

**Subtasks:**
1. Add `gateLabel?: string`, `gateColor?: string`, `hasScript?: boolean` to `SemanticWorkflowEdge` interface
2. Add corresponding `reverseGateLabel?: string`, `reverseGateColor?: string`, `reverseHasScript?: boolean` for bidirectional edges
3. Update `PairAggregate` (line 37-48) to add:
   - `lowToHighGateLabel?: string`, `lowToHighGateColor?: string`, `lowToHighHasScript?: boolean`
   - `highToLowGateLabel?: string`, `highToLowGateColor?: string`, `highToLowHasScript?: boolean`
4. Change `resolveSemanticGateType()` return type to `{ type: SemanticWorkflowEdge['gateType']; label?: string; color?: string; hasScript: boolean }`:
   - Continue returning the heuristic `type` as before
   - Additionally return `gate.label`, `gate.color`, and `!!gate.script` when the gate defines them
   - When `gate.label` is not set, return `undefined` for label (caller will use heuristic-based label)
   - When `gate.color` is not set, return `undefined` for color (caller will use heuristic-based color)
5. In `buildSemanticWorkflowEdges()`: update the aggregate logic (lines 164-186) and collapse logic (lines 193-210) to propagate `label`, `color`, and `hasScript` alongside `gateType`:
   - For bidirectional edges: `lowToHighGateLabel`/`highToLowGateLabel` and `lowToHighGateColor`/`highToLowGateColor` each track their respective direction's gate label/color
   - In the collapse (lines 193-210): set `gateLabel`/`gateColor`/`hasScript` from `lowToHigh*` fields, and `reverseGateLabel`/`reverseGateColor`/`reverseHasScript` from `highToLow*` fields
6. Use `(gate.fields ?? [])` for the fields access in `resolveSemanticGateType()` (line 59) — covered by Task 1.4 but verified here

**Acceptance criteria:**
- `SemanticWorkflowEdge` includes `gateLabel`, `gateColor`, `hasScript` and their `reverse*` counterparts
- Gates with `label` set propagate the label to the correct edge direction
- Gates without `label` return `undefined` (heuristic fallback applied in EdgeRenderer)
- Bidirectional edges with different gates on each direction correctly track both label/color pairs
- `PairAggregate` intermediate type fully tracks label/color/hasScript per direction
- Existing semantic graph tests pass (updated for new return type)

**Dependencies:** Task 1.1, Task 1.4
**Agent type:** coder

---

### Task 4.2: Update EdgeRenderer to use gate label/color

**File:** `packages/web/src/components/space/visual-editor/EdgeRenderer.tsx`

**Subtasks:**
1. Add `gateLabel?: string`, `gateColor?: string`, `hasScript?: boolean` to `ResolvedWorkflowChannel` interface
2. Also add `reverseGateLabel?`, `reverseGateColor?`, `reverseHasScript?` for bidirectional edges
3. In the channel edge rendering section (around lines 749-756), update badge rendering:
   - Use `channel.gateColor ?? CHANNEL_GATE_BADGE_COLORS[effectiveGateType]` for the badge color
   - Use `channel.gateLabel ?? CHANNEL_GATE_BADGE_LABELS[effectiveGateType]` for the badge label
   - When `channel.hasScript` is true, add a small script icon (e.g., `</>` or terminal icon) next to the badge
4. Apply gate color to arrow polygon fills as well
5. No change to the loop badge (it is independent of gate configuration)

**Acceptance criteria:**
- Badge renders with custom label when `gateLabel` is set
- Badge renders with custom color when `gateColor` is set
- Heuristic labels/colors still work when custom ones are not set
- Arrow fills match the badge color (custom or heuristic)
- Script icon appears when `hasScript` is true
- Selected state (white) still works correctly

**Dependencies:** Task 4.1
**Agent type:** coder

---

### Task 4.3: Update GateEditorPanel with label/color inputs

**File:** `packages/web/src/components/space/visual-editor/GateEditorPanel.tsx`

**Subtasks:**
1. Add "Badge Label" text input field (max 20 chars) — placed between "Description" and "Reset on cycle":
   - `data-testid="gate-editor-label"`
   - Value bound to `gate.label ?? ''`
   - On change: `updateGate({ label: value || undefined })`
   - Show character count indicator (e.g., "3/20")
2. Add "Badge Color" color picker — placed next to label input or below it:
   - Use `<input type="color">` for hex color selection (natively produces `#rrggbb`)
   - `data-testid="gate-editor-color"`
   - Value bound to `gate.color ?? '#3b82f6'` (blue default)
   - On change: `updateGate({ color: value })`
   - Add a "Reset" button to clear the custom color and revert to heuristic
3. Show a preview of the badge with the current label and color next to the inputs
4. Apply `validateGate()` (from Task 1.2) to gate changes before accepting — show validation errors inline

**Acceptance criteria:**
- Label input accepts up to 20 characters with count indicator
- Color picker works and updates badge preview
- Clearing label falls back to heuristic display
- Reset button clears custom color
- Badge preview updates in real-time
- `gate.label` and `gate.color` are correctly propagated to parent via `onChange`
- Validation errors shown inline (e.g., "Label must be 20 characters or less")

**Dependencies:** Task 1.1, Task 1.2
**Agent type:** coder

---

### Task 4.4: Update GateEditorPanel with script editor

**File:** `packages/web/src/components/space/visual-editor/GateEditorPanel.tsx`

**Subtasks:**
1. Add "Script Check" section below "Fields":
   - Toggle switch to enable/disable script check (`data-testid="gate-editor-script-enabled"`)
   - When enabled, show:
     - Interpreter dropdown: `bash` | `node` | `python3` (`data-testid="gate-editor-script-interpreter"`)
     - Source code textarea with monospace font (`data-testid="gate-editor-script-source"`)
     - Timeout input (number, seconds, default 30, max 120) (`data-testid="gate-editor-script-timeout"`)
   - When disabled, clear `gate.script`
2. Provide simple presets for common scripts:
   - "Lint Check" — `bash` with: `npm run lint 2>/dev/null && echo '{"passed":true}' || echo '{"passed":false}'`
   - "Type Check" — `node` with `console.log(JSON.stringify({passed: true}))`
   - Presets output valid JSON to stdout and rely on exit code for pass/fail semantics
3. Apply `validateGate()` to ensure script-only gates (no fields) pass validation

**Acceptance criteria:**
- Script section can be toggled on/off
- Interpreter dropdown shows three options
- Source textarea accepts multiline script code
- Timeout defaults to 30 and maxes at 120
- Preset buttons populate the form correctly with valid JSON-outputting scripts
- Gate with script-only (no fields) works in the editor and passes validation
- `gate.script` is correctly propagated to parent via `onChange`

**Dependencies:** Task 1.1, Task 1.2, Task 4.3
**Agent type:** coder

---

### Task 4.5: Update ChannelEdgeConfigPanel to show gate label/color

**File:** `packages/web/src/components/space/visual-editor/ChannelEdgeConfigPanel.tsx`

**Subtasks:**
1. In the gate summary section, show the custom badge label and color when set on the gate
2. Display a small colored dot or badge preview next to the gate ID when custom label/color is set
3. Show a script indicator icon when the gate has a script check configured
4. No functional changes — just visual display of the gate's `label`, `color`, and `script` in the summary

**Acceptance criteria:**
- Gate summary shows custom label when set
- Gate summary shows color indicator when set
- Gate summary shows script icon when script is configured
- Gate summary falls back to standard display when not set

**Dependencies:** Task 4.3
**Agent type:** coder

---

### Task 4.6: Surface script error reason in frontend gate status UI

**Data transport mechanism:** Script evaluation results are transported to the frontend via the existing `space.gateData.updated` event. When a script fails, the `write_gate` MCP tool (Task 3.4) stores the evaluation result under a `_scriptResult` key in the gate data. The frontend reads `gateData._scriptResult.reason` to display error information.

**File:** `packages/web/src/components/space/visual-editor/ChannelEdgeConfigPanel.tsx`

**Subtasks:**
1. When gate data updates (via `space.gateData.updated`), check if `gateData._scriptResult` exists
2. If `_scriptResult.success === false`, extract `_scriptResult.reason` and display it in the gate summary
3. Style the error reason distinctively (red text, warning icon) so users can see why their script check failed
4. For field-check failures without script involvement, continue showing the existing behavior (no change)
5. In `WorkflowCanvas.tsx`, similarly check `gateData._scriptResult` when computing gate status display — show a "Script failed" indicator alongside the gate status

**Acceptance criteria:**
- Script failure reason is visible in the gate status UI
- Error reason is styled distinctively from normal gate status text
- `_scriptResult` is read from gate data (not from a separate event)
- Field-check failures are unaffected
- Reason updates in real-time as gate evaluations complete

**Dependencies:** Task 3.4 (for `_scriptResult` data), Task 4.5
**Agent type:** coder

---

### Task 4.7: Update visual editor tests for badge customization

**Files:** (additions to existing test file)
- `packages/web/src/components/space/visual-editor/__tests__/semanticWorkflowGraph.test.ts`

**Subtasks:**
1. Update `semanticWorkflowGraph.test.ts`:
   - Add tests for gates with `label` set — verify `gateLabel` on semantic edge
   - Add tests for gates with `color` set — verify `gateColor` on semantic edge
   - Add tests for gates with `script` set — verify `hasScript` on semantic edge
   - Add tests for bidirectional edges where each direction has different gate label/color — verify both `gateLabel`/`reverseGateLabel` and `gateColor`/`reverseGateColor`
   - Add tests for gates without `label`/`color` — verify heuristic fallback (`gateLabel` is `undefined`, `gateColor` is `undefined`)
2. Verify backward compatibility in all tests

**Acceptance criteria:**
- All semantic graph tests pass including new label/color/hasScript tests
- Bidirectional edge tests cover both directions independently
- No regressions in existing tests

**Dependencies:** Task 4.1
**Agent type:** coder

---

## Milestone 5: End-to-End Testing

### Task 5.1: E2E test for customizable gate badges

**New file:** `packages/e2e/tests/features/space-gate-custom-badges.e2e.ts`

**Subtasks:**
1. Create a space with a workflow that has a gated channel
2. Open the gate editor panel
3. Set a custom label on the gate
4. Verify the badge on the channel edge shows the custom label
5. Set a custom color on the gate
6. Verify the badge on the channel edge shows the custom color
7. Remove the custom label and verify heuristic fallback
8. Test script-only gate (no fields) — verify gate can be created and the editor works

**Acceptance criteria:**
- E2E test passes against dev server
- All interactions go through the UI (no direct API calls)
- Assertions verify visible DOM state (badge text, color)
- Test runs with `make run-e2e TEST=tests/features/space-gate-custom-badges.e2e.ts`

**Dependencies:** Task 4.3, Task 4.4
**Agent type:** coder

---

### Task 5.2: E2E test for script-based gate evaluation

**New file:** `packages/e2e/tests/features/space-gate-script-check.e2e.ts`

**Subtasks:**
1. Create a space with a workflow containing a gate with a script check
2. Configure a simple `node` script (e.g., `console.log(JSON.stringify({ done: true }))`) — **use `node` interpreter only**, not `python3` or `bash`, to avoid CI environment dependency issues (`python3` may not be on PATH in all CI environments)
3. Trigger the gate evaluation (by sending a message through the gated channel)
4. Verify the gate opens when the script succeeds
5. Configure a failing script (e.g., `process.exit(1)`)
6. Verify the gate blocks when the script fails
7. Verify error message (from `stderr` or exit code) is shown in the frontend gate status UI (via `_scriptResult.reason`)

**Acceptance criteria:**
- E2E test passes against dev server
- Script execution result correctly opens/blocks the gate
- Error feedback is visible in the UI (leveraging Task 4.6)
- Test runs with `make run-e2e TEST=tests/features/space-gate-script-check.e2e.ts`
- Test only uses `node` interpreter (no `python3` dependency)

**Dependencies:** Task 3.2, Task 3.3, Task 3.4, Task 4.4, Task 4.6
**Agent type:** coder

---

## Summary

| Milestone | Tasks | Key Deliverable |
|-----------|-------|-----------------|
| 1. Shared Type Changes + Safety | 1.1, 1.2, 1.3, 1.4 | Gate interface with label, color, script; validation; `?? []` guards across codebase |
| 2. Script Execution Engine | 2.1, 2.2 | `gate-script-executor.ts` with Bun.spawn(), restricted env, deep merge |
| 3. Async Gate Evaluation | 3.1, 3.2, 3.3, 3.4, 3.5 | Async evaluateGate, per-gate coalescing+dirty-flag, ChannelRouter migration, workspacePath wiring, script result transport |
| 4. Frontend Badge/Editor | 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7 | Custom badge rendering (bidirectional), label/color picker, script editor UI, error surfacing |
| 5. E2E Testing | 5.1, 5.2 | End-to-end tests for badge customization and script checks |

**Total tasks:** 18
**Critical path:** 1.1 → 1.4 → 2.1 → 3.1 → 3.2 → 3.3 → 3.4 (backend) and 1.1 → 4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6 (frontend), converging at 5.1 + 5.2

## Changes from v2 (reviewer feedback)

### P1 fixes
- **New Task 1.4**: Comprehensive audit of ALL `gate.fields` access sites across frontend and backend, adding `?? []` guards. Verified against codebase: 5 frontend files (WorkflowCanvas lines 124/127/131/142/1210/1212, WorkflowEditor line 606, GateEditorPanel, VisualWorkflowEditor, semanticWorkflowGraph) and 3 backend files (gate-evaluator, task-agent, node-agent-tools). Without this, making `fields` optional would cause `TypeError` crashes at runtime for script-only gates.
- **Task 3.3 subtask 3**: Described how `workspacePath` reaches `buildNodeAgentMcpServerForSession` — it is NOT in scope; solution is to use `this.getTaskWorktreePath(taskId)` (line 862, returns `string | undefined`) then fall back to `space.workspacePath` via `spaceId` parameter lookup.
- **Task 3.3 subtask 4**: Described the full lookup chain for `notifyGateDataChanged`: `runId → workflowRunRepo.getRun() → run.spaceId → spaceManager.getSpace() → space.workspacePath`.
- **Task 3.4 subtask 2**: Explicitly guarded `node-agent-tools.ts` lines 670 and 678 (`gateDef.fields.map(...)`) for script-only gates.
- **Task 1.2**: Clarified that `validateGate()` is only applied to new/updated gates, not on load. Existing gates with `fields: []` remain valid at runtime.

### P2 fixes
- **Task 3.2 subtask 5**: Maps now keyed by composite `"${runId}:${gateId}"` to prevent cross-run state leakage.
- **Task 4.6**: Specified data transport mechanism — script results stored in `_scriptResult` key within gate data, flowing through existing `space.gateData.updated` event. No new event type needed.
- **Task 3.4 subtask 1**: Documented that `list_gates` returns `{ open: true }` for script-only gates (known limitation — `list_gates` shows field-based status only).
- **Task 1.3**: Added test verifying `validateGate` is NOT applied on load.

### P3 fixes
- **Task 4.3**: Added inline validation using `validateGate()` to gate editor.

## Changes from v3 (reviewer feedback)

### P1 fixes
- **Task 1.4**: Added `WorkflowEditor.tsx` line 606 (`fields: [...gate.fields]` spread) and `WorkflowCanvas.tsx` lines 1210, 1212 (`isHumanApprovalGate(gate.fields)`, `computeVoteCount(gate.fields, gateData)`) to the guard list. Removed phantom `ChannelEdgeConfigPanel.tsx` entry (no `gate.fields` accesses exist in that file).

### P3 fixes
- **Task 3.3 subtask 3**: Fixed incorrect method name — `getWorkspacePathForTask` does not exist. Correct method is `getTaskWorktreePath(taskId)` (line 862, public, returns `string | undefined`). Documented that it does NOT fall back to `space.workspacePath` automatically; the fallback must be done explicitly via `spaceId` lookup.
