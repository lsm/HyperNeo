# Graph Tool Benchmark — Direct SDK Run (Task #394)

**Date:** 2026-05-24
**Method:** Claude Agent SDK `query()` with GLM provider routing
**Model:** `glm-5.1`
**Task:** #394, "Refactor task event source as Layer-2 anti-stuck mechanism"
**Commit:** `af4817ec1`
**Constraint:** Baseline uses built-in Read/Grep/Glob. MCP arms use `tools: []` (no built-in tools), isolated to a single MCP server with `allowedTools` set.

## Executive Summary

Three of five arms completed successfully. Baseline and ast-grep produced codebase-grounded plans with active tool use (61 and 75 calls respectively). CodeGraph completed but the model made **zero tool calls** despite `allowedTools: ["mcp__codegraph__*"]` being set — it produced a 71K char response without using any MCP tools. CRG failed during graph build (Python error). Graphify failed during extraction (missing `openai` package).

**Key finding:** GLM-5.1 with `allowedTools` correctly auto-approves ast-grep MCP tools (75 calls) but does not call CodeGraph tools (0 calls). This suggests the issue is specific to how CodeGraph's MCP server exposes tools, not a general GLM limitation. The baseline with built-in tools works as expected (61 calls: Read 34, Grep 20, Glob 7).

## Results

| Case | Wall Time (s) | Tokens | Tool Calls | Response Length |
|------|--------------|--------|------------|-----------------|
| baseline (Read/Grep/Glob) | 284.2 | 75,444 | 61 | 17,643 |
| CodeGraph | 271.4 | 19,027 | 0 | 71,429 |
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

**ast-grep (MCP):**

| Tool | Calls |
|------|-------|
| `mcp__ast-grep__ast_grep_search` | 47 |
| `mcp__ast-grep__ast_grep_scan` | 22 |
| `mcp__ast-grep__ast_grep_search_multiple` | 6 |

**CodeGraph:** 0 tool calls.

### Index Build Times

| Tool | Build Time |
|------|-----------|
| CodeGraph | 16.2s |
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

- **Response:** 71,429 chars — longest response by far
- **Tool calls:** 0 — model did not use any CodeGraph MCP tools despite `allowedTools: ["mcp__codegraph__*"]`
- **Tokens:** 19,027 — surprisingly low for such a long response
- **Quality:** Produced a massive response without calling any tools. The model may have hallucinated knowledge or produced generic architecture content inflated with boilerplate. The 71K chars with only 19K tokens suggests repetitive/templated output.
- **Assessment:** CodeGraph's MCP server was correctly attached and tools were allowed, but GLM-5.1 chose not to call them. This contrasts with ast-grep where the same model made 75 calls. The issue may be in how CodeGraph presents its tools (descriptions, parameter schemas) or a server startup timing issue.

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

1. **GLM-5.1 tool-use works for ast-grep but not CodeGraph.** Both had `allowedTools` set correctly. ast-grep saw 75 calls; CodeGraph saw 0. The issue is specific to CodeGraph's MCP server, not GLM's general tool-use capability.

2. **Baseline is the most cost-effective grounded option.** Built-in Read/Grep/Glob produced a grounded plan with 61 tool calls and 75K tokens. No index build required.

3. **CodeGraph produces suspiciously long output without tool use.** 71K chars with 19K tokens is unusual — the response length metric counts only the final answer (not interim narration), suggesting the output is highly repetitive.

4. **ast-grep scan usage improved dramatically.** GLM-5.1 used `ast_grep_scan` 22 times vs GLM-4.7's 1 time. The model leverages YAML rule scans for complex structural queries.

5. **Build times are reasonable.** CodeGraph (16s) and ast-grep resolve (5s) are fast enough for interactive use.

6. **Token reporting works with GLM-5.1.** Unlike GLM-4.7 which returned 0 tokens, GLM-5.1 returns accurate usage data through the Anthropic-compatible API.

## Recommendations

1. **Investigate CodeGraph tool visibility.** Debug why GLM-5.1 calls ast-grep tools but not CodeGraph tools. Check tool names, descriptions, and parameter schemas returned by `tools/list`.

2. **Fix CRG build error** — needs investigation of the Python traceback.

3. **Install `openai` package** for Graphify and re-run.

4. **Consider Claude Sonnet as control.** Run the same benchmark with Claude Sonnet to establish a baseline for comparison with GLM-5.1's tool-use behavior.

5. **Reduce response length metric bias.** The 71K CodeGraph response deserves manual inspection — it may contain padding that inflates the metric without adding information.

## Raw Data

- Baseline: `/tmp/graph-tool-benchmark-baseline.json`
- CodeGraph: `/tmp/graph-tool-benchmark-codegraph.json`
- ast-grep: `/tmp/graph-tool-benchmark-ast-grep.json`
