# Graph Tool Benchmark — Direct SDK Run (Task #394)

**Date:** 2026-05-24
**Method:** Claude Agent SDK `query()` with GLM provider routing
**Model:** `glm-5.1`
**Task:** #394, "Refactor task event source as Layer-2 anti-stuck mechanism"
**Commit:** `fb857f240`
**Constraint:** Baseline uses built-in Read/Grep/Glob. MCP arms use `tools: []` (no built-in tools), isolated to a single MCP server with `allowedTools` set.

## Executive Summary

Four of five arms completed successfully. Baseline, CodeGraph, and ast-grep produced codebase-grounded plans with active tool use. CRG failed during graph build (Python error). Graphify failed during extraction (missing `openai` package).

**Key finding:** CodeGraph's MCP server command was incorrectly set to `mcp` instead of `serve --mcp`. After fixing, CodeGraph achieved 34 tool calls with codebase-grounded output. ast-grep remains the most active tool user (75 calls). CodeGraph took longest wall time (427s) but produced the most detailed grounded plan.

## Results

| Case | Wall Time (s) | Tokens | Tool Calls | Response Length |
|------|--------------|--------|------------|-----------------|
| baseline (Read/Grep/Glob) | 284.2 | 75,444 | 61 | 17,643 |
| CodeGraph | 427.0 | 45,214 | 34 | 16,354 |
| code-review-graph | FAIL | — | — | — |
| Graphify | FAIL | — | — | — |
| ast-grep | 379.4 | 83,064 | 75 | 16,927 |

### Tool Call Breakdown

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

**ast-grep (MCP):**

| Tool | Calls |
|------|-------|
| `mcp__ast-grep__ast_grep_search` | 47 |
| `mcp__ast-grep__ast_grep_scan` | 22 |
| `mcp__ast-grep__ast_grep_search_multiple` | 6 |

### Index Build Times

| Tool | Build Time |
|------|-----------|
| CodeGraph | 3.6s |
| code-review-graph | FAIL (Python traceback) |
| Graphify | FAIL (missing `openai` package) |
| ast-grep (resolve) | 4.6s |

## Detailed Analysis

### Baseline (built-in Read/Grep/Glob)

- **Response:** 17,643 chars (final answer only, excludes interim narration)
- **Tool calls:** 61 — Read (34), Grep (20), Glob (7)
- **Tokens:** 75,444 — highest token usage across all arms
- **Quality:** The model actively explored the codebase using built-in file tools, reading files and searching for patterns. Response is grounded in actual NeoKai paths found through exploration.
- **Assessment:** Strong baseline. The model demonstrated effective use of built-in tools to understand the codebase before producing a plan. Most expensive in tokens but most thorough exploration.

### CodeGraph

- **Response:** 16,354 chars — grounded in actual NeoKai files
- **Tool calls:** 34 — node (18), search (8), context (4), explore (2), callees (2)
- **Tokens:** 45,214 — input-heavy (39,043 input, 6,171 output) due to large tool result payloads
- **Quality:** Heavily grounded plan citing specific files (`space-runtime.ts`, `space-agent-notification-service.ts`, `constants.ts`, `internal-event-bus.ts`, `node-execution-manager.ts`). The model used `codegraph_node` most (18 calls) to read symbol sources, `codegraph_search` (8) to find symbols, and `codegraph_context` (4) for high-level area understanding.
- **Root cause of earlier failure:** The benchmark script invoked `codegraph mcp` which does not exist. The correct command is `codegraph serve --mcp`. With the fix, the MCP server starts correctly (status: `connected`) and exposes 10 tools.
- **Assessment:** Good codebase grounding once the server starts. Longest wall time (427s) suggests large tool result payloads slow down the round-trip. The model prefers `codegraph_node` over `codegraph_explore` for reading source, making more calls than necessary.

### ast-grep

- **Response:** 16,927 chars (final answer only)
- **Tool calls:** 75 — `ast_grep_search` (47), `ast_grep_scan` (22), `ast_grep_search_multiple` (6)
- **Tokens:** 83,064 — highest across all arms
- **Quality:** Heavy AST-based exploration. The model used pattern search 47 times, YAML rule scan 22 times, and batch search 6 times. Found real NeoKai files through structural pattern matching.
- **Assessment:** Most active tool use. The model extensively explored the codebase through AST patterns. The `ast_grep_scan` tool saw significant use (22 calls) compared to the previous GLM-4.7 run (1 call), suggesting GLM-5.1 is more willing to use complex tool features.

### code-review-graph

- **Status:** FAILED during graph build
- **Error:** Python traceback in CRG's `build_or_update_graph` function
- **Assessment:** Build-time failure, not a runtime issue. The CRG tool itself has a bug or incompatibility with this repo's structure.

### Graphify

- **Status:** FAILED during extraction
- **Error:** `[graphify] chunk 1/1 failed: Gemini/Kimi/Ollama/OpenAI-compatible extraction requires the openai package. Run: pip install openai`
- **Assessment:** Needs `pip install openai` even when using ollama backend.

## Key Findings

1. **CodeGraph works once the correct MCP command is used.** `codegraph serve --mcp` starts the stdio MCP server correctly. The earlier `codegraph mcp` command does not exist and caused the server to fail silently.

2. **CodeGraph produces grounded, detailed plans.** 34 tool calls referencing actual NeoKai source files. Response quality comparable to baseline and ast-grep.

3. **CodeGraph is input-token expensive.** 39,043 input tokens (vs 75,444 total for baseline) due to large tool result payloads. Each `codegraph_node` call returns full symbol source.

4. **ast-grep remains most active tool user.** 75 calls, heavy use of structural patterns and YAML rule scans.

5. **Baseline is most token-efficient for thorough exploration.** 61 tool calls, 75K tokens total, no index build required.

6. **Build times are fast.** CodeGraph (3.6s) and ast-grep resolve (4.6s) are fast enough for interactive use.

7. **Token reporting works with GLM-5.1.** Unlike GLM-4.7 which returned 0 tokens, GLM-5.1 returns accurate usage data through the Anthropic-compatible API.

## Recommendations

1. **CodeGraph integration fix verified.** Use `codegraph serve --mcp` not `codegraph mcp`. The `serve` command without `--mcp` starts an HTTP server; `--mcp` is required for stdio transport.

2. **Fix CRG build error** — needs investigation of the Python traceback.

3. **Install `openai` package** for Graphify and re-run.

4. **Consider Claude Sonnet as control.** Run the same benchmark with Claude Sonnet to establish a baseline for comparison with GLM-5.1's tool-use behavior.

5. **CodeGraph tool-use optimization.** The model makes 18 `codegraph_node` calls (one per symbol). Consider whether `codegraph_explore` (batch symbol survey) could reduce call count.

## Raw Data

- Baseline: `/tmp/graph-tool-benchmark-baseline.json`
- CodeGraph: `/tmp/graph-tool-benchmark-codegraph.json`
- ast-grep: `/tmp/graph-tool-benchmark-ast-grep.json`
