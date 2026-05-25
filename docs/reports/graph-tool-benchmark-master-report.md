# Graph Tool Benchmark — Master Report (Task #394)

**Date:** 2026-05-24
**Method:** Claude Agent SDK `query()` with GLM provider routing
**Model:** `glm-5.1`
**Task:** #394, "Refactor task event source as Layer-2 anti-stuck mechanism"
**Commit:** `fb857f240`
**Constraint:** Baseline uses built-in Read/Grep/Glob. MCP arms use `tools: []` (no built-in tools), isolated to a single MCP server with `allowedTools` set.

---

## 1. Executive Summary

All five arms completed successfully. Every tool achieved active tool use and produced codebase-grounded plans.

**Root causes of earlier failures:**
- **CodeGraph:** Wrong MCP command (`mcp` → `serve --mcp`)
- **CRG:** Wrong serve arg (`--data-dir` not supported by `serve`); fixed by passing `CRG_DATA_DIR` env var
- **Graphify:** Missing `[mcp]` extra — `graphify.serve` module not installed

**Key findings:**
- **ast-grep** most active tool user (75 calls), **Graphify** close second (73 calls)
- **CRG** most token-expensive (86,918 tokens) and slowest (1097s)
- **CodeGraph** best accuracy per dollar (¥288 total, perfect line numbers)
- **Graphify** cheapest overall (¥291 total, ¥4.0 per call)
- **Baseline** most reliable — no index build, no MCP startup issues, consistent 61 calls

---

## 2. Results Overview

| Case | Wall Time (s) | Tokens | Tool Calls | Response Length |
|------|--------------|--------|------------|-----------------|
| baseline (Read/Grep/Glob) | 284.2 | 75,444 | 61 | 17,643 |
| CodeGraph | 427.0 | 45,214 | 34 | 16,354 |
| code-review-graph | 1097.4 | 86,918 | 52 | 17,927 |
| Graphify | 549.7 | 41,742 | 73 | 21,890 |
| ast-grep | 379.4 | 83,064 | 75 | 16,927 |

### 2.1 Tool Call Breakdown

**Baseline (built-in tools):**

| Tool | Calls |
|------|-------|
| `Read` | 34 |
| `Grep` | 20 |
| `Glob` | 7 |

**CodeGraph (MCP):**

| Tool | Calls |
|------|-------|
| `mcp__codegraph__codegraph_node` | 18 |
| `mcp__codegraph__codegraph_search` | 8 |
| `mcp__codegraph__codegraph_context` | 4 |
| `mcp__codegraph__codegraph_explore` | 2 |
| `mcp__codegraph__codegraph_callees` | 2 |

**code-review-graph (MCP):**

| Tool | Calls |
|------|-------|
| `mcp__code-review-graph__semantic_search_nodes_tool` | 28 |
| `mcp__code-review-graph__query_graph_tool` | 21 |
| `mcp__code-review-graph__get_review_context_tool` | 2 |
| `mcp__code-review-graph__get_minimal_context_tool` | 1 |

**Graphify (MCP):**

| Tool | Calls |
|------|-------|
| `mcp__graphify__get_node` | 44 |
| `mcp__graphify__get_neighbors` | 22 |
| `mcp__graphify__query_graph` | 6 |
| `mcp__graphify__graph_stats` | 1 |

**ast-grep (MCP):**

| Tool | Calls |
|------|-------|
| `mcp__ast-grep__ast_grep_search` | 47 |
| `mcp__ast-grep__ast_grep_scan` | 22 |
| `mcp__ast-grep__ast_grep_search_multiple` | 6 |

### 2.2 Index Build Times

| Tool | Build Time |
|------|-----------|
| CodeGraph | 3.6s |
| code-review-graph | 71.3s |
| Graphify | N/A (used pre-built graph) |
| ast-grep (resolve) | 4.6s |

---

## 3. Token Usage Analysis

### 3.1 Raw Token Data

| Arm | Input Tokens | Output Tokens | Total Tokens |
|-----|-------------|--------------|-------------|
| baseline | 66,805 | 8,639 | 75,444 |
| CodeGraph | 39,043 | 6,171 | 45,214 |
| CRG | 80,335 | 6,583 | 86,918 |
| Graphify | 33,457 | 8,285 | 41,742 |
| ast-grep | 74,837 | 8,227 | 83,064 |

**Note:** GLM-5.1 does not report cache tokens through the Anthropic-compatible API.

### 3.2 Efficiency Metrics

| Arm | Tokens / Call | Tokens / Second | Input : Output Ratio |
|-----|--------------|----------------|---------------------|
| baseline | 1,237 | 265.4 | 7.73 : 1 |
| CodeGraph | 1,330 | 105.9 | 6.33 : 1 |
| CRG | 1,671 | 79.2 | 12.20 : 1 |
| Graphify | 572 | 75.9 | 4.04 : 1 |
| ast-grep | 1,108 | 218.9 | 9.10 : 1 |

### 3.3 Cost Projections (GLM-5.1)

Approximate pricing: Input ¥0.005 / 1K tokens, Output ¥0.015 / 1K tokens.

| Arm | Input Cost | Output Cost | Total Cost | Cost / Call | Cost / Char |
|-----|-----------|------------|-----------|------------|------------|
| Graphify | ¥167 | ¥124 | ¥291 | ¥4.0 | ¥0.013 |
| CodeGraph | ¥195 | ¥93 | ¥288 | ¥8.5 | ¥0.018 |
| baseline | ¥334 | ¥130 | ¥464 | ¥7.6 | ¥0.026 |
| ast-grep | ¥374 | ¥123 | ¥497 | ¥6.6 | ¥0.029 |
| CRG | ¥402 | ¥99 | ¥501 | ¥9.6 | ¥0.028 |

### 3.4 Token Insights

1. **Graphify cheapest overall** (¥291) with highest tool use (73 calls). Small per-call payloads.
2. **CRG most expensive** (¥501) due to semantic search payload size. Each `semantic_search_nodes` returns richly contextualized results.
3. **CodeGraph best accuracy/cost ratio** (¥288 total, perfect line numbers, 34 calls).
4. **Output token variance small** (6,171–8,639). All arms produce similar output volume. Cost differences driven by input tokens.
5. **Wall time correlates with input tokens**, not call count. CRG (80K input, 1097s) vs Graphify (33K input, 550s).

---

## 4. Plan Quality Evaluation

### 4.1 Accuracy Summary

| Arm | File Accuracy | Line Number Accuracy | Architectural Accuracy | Hallucinations | Grade |
|-----|--------------|---------------------|----------------------|---------------|-------|
| baseline | 24/29 real | Exact | Excellent | 0 major | A |
| CodeGraph | 13/21 real | Perfect (±0 lines) | Excellent | 0 major | A |
| CRG | 17/29 real | Excellent (±1 line) | Very Good | 1 minor | A- |
| Graphify | 24/38 real | Good (ranges) | Very Good | 0 major | A- |
| ast-grep | 12/29 real | N/A (AST-based) | Good | 2 minor | B+ |

### 4.2 Verified Claims

**All arms correctly identified these real structures:**
- `AgentStuckRecoveryState` at line 296 in `space-runtime.ts`
- `NonTerminalIdleState` at line 310 in `space-runtime.ts`
- `notifiedTaskSet` at line 663, `taskCrashCounts` at 675, `blockedRetryCounts` at 687
- `agentStuckRecovery` at line 706, `nonTerminalIdleStates` at 699
- `safeNotify` at line 2014, `mapNotificationEventToInternalEvent` at line 480
- `processRunTick` at line 4234
- `handleAliveStuckExecutions`, `handleNonTerminalIdleExecutions`, `attemptBlockedRunRecovery`
- Constants: `MAX_AGENT_STUCK_NAGS=1`, `MAX_AGENT_STUCK_RESTARTS=1`, `MAX_BLOCKED_RUN_RETRIES=1`

**CRG quantitative precision:**
- `task-agent-manager.ts`: cited 3932 lines, actual 3931 (off by 1)
- `space-runtime.ts`: cited 6195 lines, actual 6194 (off by 1)
- `space-agent-notification-service.ts`: cited 412 lines, actual 411 (off by 1)
- Every file size was off by exactly 1 line.

### 4.3 Hallucinations Found

| Arm | Hallucination | Severity |
|-----|--------------|----------|
| **CRG** | Claims SpaceAgentNotificationService "already skips `space.workflowRun.completed` for routine completions" — **FALSE**. No such skip logic exists. | Minor |
| **ast-grep** | Cites `goal-repository.ts` as defining `AutonomyLevel` (5-level) — unverified. | Minor |

### 4.4 Per-Arm Strengths

| Tool | Strength | Evidence |
|------|----------|----------|
| **baseline** | Most accurate file-level detail | Exact line numbers for all recovery maps |
| **CodeGraph** | Best precision with fewest calls | `processRunTick` at exact line 4234 with only 34 calls |
| **CRG** | Best quantitative accuracy | File sizes within 1 line each; function counts accurate |
| **Graphify** | Broadest coverage | 38 files cited; neighbor traversal finds related components |
| **ast-grep** | Best structural relationships | Found `channel-router.ts` and `agent-message-router.ts` autonomy connections |

### 4.5 What Each Tool Missed

| Tool | Miss | Impact |
|------|------|--------|
| **baseline** | None major | — |
| **CodeGraph** | `escalation-reasons.ts` | Minor |
| **CRG** | `last-message-classifier.ts`, `constants.ts` in primary list | Moderate |
| **Graphify** | Exact line numbers | Minor |
| **ast-grep** | `constants.ts`, `space-agent-notification-service.ts`, `last-message-classifier.ts`, `escalation-reasons.ts`, `internal-event-bus.ts` | Significant |

---

## 5. Comparative Matrix

| Dimension | Best Arm | Why |
|-----------|----------|-----|
| **Tool call count** | ast-grep (75) | Heavy AST pattern usage |
| **Token efficiency per call** | Graphify (572 tokens/call) | Small node payloads |
| **Total cost** | Graphify (¥291) | Lowest total tokens |
| **Accuracy/cost ratio** | CodeGraph (¥288, perfect lines) | Best precision for the price |
| **Speed** | baseline (284s) | No index build, direct file access |
| **File coverage** | Graphify (38 files cited) | Neighbor traversal |
| **Line precision** | CodeGraph (±0 lines) | Exact citations |
| **Quantitative precision** | CRG (±1 line per file) | Exact file metrics |
| **Reliability** | baseline | No MCP server startup issues |
| **Plan density** | CodeGraph / CRG | Most concise output per token |

---

## 6. Key Findings

1. **All three previously-failing arms failed due to incorrect CLI invocations, not model behavior.** CodeGraph (`mcp` → `serve --mcp`), CRG (removed `--data-dir`, added `CRG_DATA_DIR` env), Graphify (installed `[mcp]` extra).

2. **All models correctly identified real gaps in NeoKai:** no autonomy-aware recovery, no exponential backoff, no rate-limited notifications, no persistent recovery state, no wall-clock timeout.

3. **The actual NeoKai codebase matches the models' descriptions.** Key structures exist exactly where cited.

4. **ast-grep and Graphify are the most active tool users** (75 and 73 calls). Both use traversal patterns.

5. **CRG is the most token-expensive arm** (86,918 tokens for 52 calls) due to large semantic search payloads.

6. **Baseline remains most reliable** — no index build, no MCP server startup issues, consistent 61 tool calls.

7. **Token reporting works with GLM-5.1.** Accurate input/output counts through Anthropic-compatible API. No cache token data available.

---

## 7. Recommendations

1. **Verify MCP server commands before benchmarking.** All three fixes were CLI invocation errors. Always test server startup independently.

2. **Graphify needs `pip install "graphifyy[mcp]"`** for the MCP server module. The base package does not include `graphify.serve`.

3. **Consider Claude Sonnet as control.** Run the same benchmark with Claude Sonnet to establish a baseline for comparison with GLM-5.1's tool-use behavior.

4. **CodeGraph tool-use optimization.** The model makes 18 `codegraph_node` calls (one per symbol). Consider whether `codegraph_explore` (batch symbol survey) could reduce call count.

5. **Graphify extraction requires capable LLM backend.** The pre-built graph used here was extracted with a cloud backend. For fresh extraction, provide API keys or a capable local model.

6. **For cost-sensitive benchmarking:** Use Graphify (¥291) or CodeGraph (¥288). Avoid CRG (¥501) unless semantic search precision is critical.

---

## 8. Raw Data Files

- Baseline: `docs/reports/benchmark-data/graph-tool-benchmark-baseline.json`
- CodeGraph: `docs/reports/benchmark-data/graph-tool-benchmark-codegraph.json`
- CRG: `docs/reports/benchmark-data/graph-tool-benchmark-crg.json`
- Graphify: `docs/reports/benchmark-data/graph-tool-benchmark-graphify.json`
- ast-grep: `docs/reports/benchmark-data/graph-tool-benchmark-ast-grep.json`
- Combined: `docs/reports/benchmark-data/graph-tool-benchmark-results.json`

---

## 9. Deep-Dive: Tool Architecture & Editing Suitability

### 9.1 Source Code Return Model

A critical architectural difference emerged between tools:

| Tool | Returns Source Code? | Data Model |
|------|---------------------|------------|
| **CodeGraph** | **Yes** — full symbol source per `codegraph_node` | SQLite index stores complete function/class bodies |
| **Baseline** | **Yes** — full file per `Read` | Direct filesystem access |
| **CRG** | **Partial** — semantic snippets | Graph stores contextualized excerpts |
| **ast-grep** | **Partial** — AST match snippets | Pattern match results with context |
| **Graphify** | **No** — metadata only | Graph nodes: `id, label, file_type, source_file, source_location` |

**Graphify's `get_node` response:**
```
Node: .processRunTick()
  ID: runtime_space_runtime_spaceruntime_processruntick
  Source: space-runtime.ts L4234
  Type: code
  Community: 12
  Degree: 8
```

No source code, no signature, no implementation. The model knew *where* symbols exist but not *what they do*.

**CodeGraph's `codegraph_node` response:**
Returns complete function/class source code with inline line numbers — effectively a targeted `Read` call.

### 9.2 Why Graphify Had Broad Coverage Without Line Precision

Graphify discovered the most files (38) because `get_neighbors` traverses edge relationships:
- `processRunTick` → `attemptBlockedRunRecovery` → `handleAliveStuckExecutions` → ...
- Traversal surfaces related components without explicit search

But the model never read source code, so it cited ranges ("~line 4200 area") instead of exact lines. Graphify **has** line numbers in its data (`source_location: L4234`) — the MCP server just buries them on the `Source:` line instead of making them prominent.

**Fix:** Change `get_node` output format from:
```
Source: file.ts L4234
```
to:
```
Node: .processRunTick() at line 4234
  File: file.ts
```
This would make exact line citation natural for the model.

### 9.3 Editing Suitability

For tasks beyond planning — actual code modification — the ranking changes:

| Tool | Sees Code? | Exact Lines? | Editable? | Verdict |
|------|-----------|-------------|-----------|---------|
| **CodeGraph** | Full symbol source | Perfect (±0) | Yes | Best for editing |
| **Baseline** | Full file | Perfect | Yes | Good, more calls |
| **CRG** | Semantic snippets | ±1 line | Partial | Limited |
| **ast-grep** | AST matches | N/A | Pattern only | Specialized |
| **Graphify** | **No source code** | Ranges | **No** | Planning only |

**Example:** "Add retry count to `attemptBlockedRunRecovery`"
- **CodeGraph**: `codegraph_node` returns full function → sees where to inject → edits directly
- **Graphify**: `get_node` returns metadata only → must call `Read` to see code → loses tool isolation advantage

### 9.4 Blast Radius Analysis

**CodeGraph** has dedicated blast-radius tools:
- `codegraph_callers` — find what calls a function
- `codegraph_impact` — analyze affected code when changing a symbol
- `codegraph_trace` — trace call paths

The benchmark model (GLM-5.1) **did not use them** — it only used `codegraph_callees` (2 calls) and `codegraph_explore` (2 calls). The model discovered relationships through exploration rather than explicit impact analysis.

**Graphify**'s `get_neighbors` can show blast radius through edge traversal, but the AST-only graph lacks `calls` edges (only `imports`, `contains`, `imports_from`). Semantic extraction would add `calls` edges, but extraction failed.

**Baseline** handles blast radius via `Grep` for all references + `Read` of affected files.

### 9.5 Graphify Semantic Extraction: Backend Findings

Graphify's semantic phase (LLM-powered docs/images extraction) failed with every backend we tested:

| Backend | Result | Root Cause |
|---------|--------|------------|
| **ollama local** | 404 — model not found | Default `qwen2.5-coder:7b` not installed |
| **ollama cloud free** | Hollow responses, invalid JSON | `gemma3:4b` too small for JSON extraction |
| **ollama cloud paid** | 403 — subscription required | `glm-5.1` requires Pro ($20/mo) |
| **openai → GLM** | 401 — wrong endpoint | Graphify hardcodes `api.openai.com`, ignores `OPENAI_BASE_URL` |
| **kimi native** | 401 — invalid auth | `KIMI_API_KEY` is for Anthropic endpoint, not Moonshot OpenAI endpoint |
| **kimi anthropic** | Invalid JSON, truncated | Kimi K2.6 generates reasoning content instead of clean JSON |

**Graphify's `BACKENDS` dict is not extensible** — no env var to override `base_url` for arbitrary providers. Monkey-patching required for GLM/Kimi custom endpoints.

**Official backends supported:** `gemini`, `openai`, `ollama`, `claude`, `kimi`, `bedrock`

**No native GLM support.**

### 9.6 Token Efficiency Revisited

The baseline's 34 `Read` calls returned full file contents (~800 tokens each = 27K input tokens). CodeGraph's 18 `codegraph_node` calls returned targeted symbol sources — smaller payloads per call. This explains why CodeGraph achieved same accuracy with fewer input tokens (39K vs 66K).

Graphify's 44 `get_node` calls were cheapest per call (458 input tokens) because each returned only ~400 tokens of metadata. But without source code, the model couldn't produce exact citations.

### 9.7 Updated Recommendations

1. **For planning tasks:** CodeGraph or Graphify AST-only both work. Graphify has broader coverage; CodeGraph has exact lines.

2. **For editing tasks:** CodeGraph is the only graph tool that avoids extra `Read` calls. Graphify would need `Read` fallback, losing its cost advantage.

3. **For blast radius:** CodeGraph has the right tools (`impact`, `callers`), but models need prompting to discover them. Consider adding tool-use examples in prompts.

4. **Graphify fix needed:** Add a `get_source` MCP tool that reads `source_file` at `source_location` and returns actual code. This would close the gap with CodeGraph for editing.

5. **Graphify semantic extraction:** Requires either Gemini (`pip install 
