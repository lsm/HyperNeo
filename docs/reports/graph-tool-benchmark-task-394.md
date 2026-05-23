# Graph Tool Benchmark for Task #394

**Date:** 2026-05-22  
**Benchmark task:** #394, "Refactor task event source as Layer-2 anti-stuck mechanism"  
**Corpus:** NeoKai worktree at `space/benchmark-codegraph-code-review-graph-and-graphify-on-task`  
**Model requested:** `glm-5.1`  
**Constraint:** task #394 was used only for exploration/planning; no task #394 implementation was made.

## Executive summary

Graph tools helped most when they could answer exact-symbol questions after the task terms were known. None replaced normal code exploration for this task.

**Recommendation:** prioritize **code-review-graph** before Graphify for NeoKai stock integration, but ship it as optional/disabled with a small default MCP tool subset. Keep Graphify optional but lower priority unless NeoKai wants broader document/code knowledge graphs. Do not prioritize CodeGraph until its task-context retrieval improves for backend/runtime tasks.

## Method

1. Pulled task #394 requirements from the task system.
2. Established an answer key with read-only code exploration for relevant files and line ranges.
3. Built or queried each graph tool locally without running global installers or mutating user-wide agent config.
4. Asked `glm-5.1` to produce the same implementation-plan deliverable from each context bundle.
5. Scored each output against key file recall, extra relevant discovery, usefulness, setup/runtime friction, tool-surface complexity, and config/privacy risk.

`claude -p --model glm-5.1` failed in this harness because the active Claude provider path reported: `The 'glm-5.1' model is not supported when using Codex with a ChatGPT account.` To keep the model constant, the benchmark called the GLM API directly (`model: glm-5.1`) for the final plan-generation step.

## Answer key from direct exploration

Task #394's description named four files. Direct code exploration found those plus additional high-signal files:

| File | Relevant surface |
|---|---|
| `packages/daemon/src/lib/space/runtime/space-runtime.ts` | `SpaceNotificationEvent`, `mapNotificationEventToInternalEvent`, `safeNotify`, `handleStuckAgentRecovery`, `agent_idle_non_terminal`, `attemptBlockedRunRecovery`, `workflow_run_completed` |
| `packages/daemon/src/lib/space/runtime/space-agent-notification-service.ts` | event subscription, `[TASK_EVENT]` injection, idle/retry message formatters |
| `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` | creates `SpaceAgentNotificationService` per space |
| `packages/daemon/src/lib/space/runtime/constants.ts` | existing stuck/retry limits such as `MAX_AGENT_STUCK_NAGS` and `MAX_BLOCKED_RUN_RETRIES` |
| `packages/daemon/src/lib/space/runtime/retry-utils.ts` | generic retry/backoff helper |
| `packages/daemon/src/lib/internal-event-bus.ts` | canonical event surface (`SpaceEvents`, `DaemonInternalEventMap`) |
| `packages/shared/src/types/space.ts` | `SpaceGoalEventSource`, agent timeout fields, shared space/task types |
| `packages/shared/src/space/workflow-autonomy.ts` | autonomy-level helpers |
| `packages/daemon/tests/unit/5-space/runtime/space-runtime-notifications.test.ts` | notification behavior coverage, including `workflow_run_completed` |
| `packages/daemon/tests/unit/5-space/runtime/space-runtime-stalled-recovery.test.ts` | existing stalled/stuck recovery tests |
| `packages/daemon/tests/unit/5-space/other/space-agent-notification-service.test.ts` | notification service formatter/subscriber tests |

## Comparison table

| Setup | Build/query observed | Final GLM plan tokens | Tool/query calls used for context | Key-file recall | Extra relevant files beyond #394 | Usefulness | Friction / reliability | Security and config risk |
|---|---:|---:|---:|---|---|---|---|---|
| Baseline direct exploration | Investigator run took 134.7s, 34 code tools, 46,262 Claude tokens | 6,325 | 34 reads/greps/globs in investigator | Strong: 4/4 named files plus tests/types | Strong: `internal-event-bus.ts`, `types/space.ts`, `workflow-autonomy.ts`, tests | Best practical plan; concrete lines and existing functions | No install; token/tool cost high | Lowest risk; no generated DB |
| CodeGraph | `npx @colbymchenry/codegraph init . -i`; 1,580 files, 21,487 nodes, 19,857 edges, 18.3s internal / 25.8s wall. `context` query 4.35s | 4,324 | 1 context + 4 exact symbol queries | Partial: found `space-runtime.ts`, `space-agent-notification-service.ts`; missed `task-executor.ts`; initial task-context query was mostly wrong/UI-noisy | Weak: little beyond notification/runtime, missed tests/types | Low-to-medium. Exact symbol queries useful; free-form task context poor | Fast local index; `init` creates `.codegraph/`; no `--no-install` flag but did not mutate global config in observed path | Installer can mutate `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, Cursor/Codex config, and optionally auto-allow tools. Keep disabled/manual only |
| code-review-graph | `uvx --from code-review-graph code-review-graph build --repo . --data-dir /tmp/neokai-crg-467`; 1,591 files, 34,381 nodes, 399,977 edges, 893 flows, 10 communities, 61.7s wall | 17,974 | 1 minimal-context query + targeted `file_summary`/structural queries | Good after targeted file summaries: `space-runtime.ts`; structural functions; missed/assumed some paths in first pass | Medium: found `getExternalEventRateLimitState`, `scheduleExternalEventRetry`, `task-agent-manager.ts`, workflow/repository/test adjacency, but still assumed some module paths | Medium-high. Best graph depth/risk signal, but large JSON can overfeed model and concept queries require exact structural patterns | Python install via `uvx`; build reliable. Tool API easy to misuse: `query_graph(pattern, target)` uses fixed patterns, not semantic search. MCP exposes 28 tools unless filtered | Installer mutates assistant configs/hooks/MCP. Daemon uses `~/.code-review-graph/watch.toml`. Local DB can live in project or external data dir. Expose minimal MCP subset only |
| Graphify | Existing CLI. `graphify extract . --out /tmp/neokai-graphify-467 --backend openai --model glm-5.1 --no-cluster`; first semantic chunks failed because `openai` extra missing, but AST graph still wrote 20,316 nodes / 60,564 edges in 26.9s. Generic query 15KB; targeted query 15KB | 6,847 targeted run; 7,925 generic run | 2 graph queries | Poor generic query; decent targeted query found `space-runtime.ts`, `TaskAgentManager`, `SpaceAgentNotificationService`, `InternalEventBus`, `retry-utils` | Medium after exact-term query: `task-agent-manager.ts`, repositories/managers surfaced; missed tests and some exact existing constants unless prompted | Medium. Targeted graph query useful as navigation map; generic task query drifted to schedule/task UI noise. Semantic extraction requires extra deps/API setup | CLI help fast; AST-only extraction reliable. Semantic extraction with GLM via OpenAI-compatible backend needs `openai` extra and env mapping (`OPENAI_API_KEY`, `OPENAI_BASE_URL`). Full `/graphify` skill is heavy for >200 files | Install/hooks/Claude integration can mutate CLAUDE.md, hooks, global graph. `graphify-out/` can be large and repo page recommends committing it; NeoKai should not commit generated graph outputs |

## Findings by tool

### Baseline

Direct read/grep exploration produced the most accurate answer because task #394 already included exact event names and likely files. It found existing recovery code (`handleStuckAgentRecovery`, `attemptBlockedRunRecovery`), notification service formatters, event-bus types, constants, retry helper, autonomy helper, and test coverage.

Cost was high: 34 code-exploration tool calls and 46k Claude tokens before the GLM plan call. For one-off planning this is acceptable; for repeated PR review it is expensive.

### CodeGraph

CodeGraph indexing was fastest and local-only. Its MCP/CLI surface is small and understandable: search, context, callers/callees, impact, files, status.

Weakness: the free-form `context <task>` query over-indexed generic words like `task` and `event`, returning frontend thread-event and test-gateway code rather than daemon anti-stuck code. Exact symbol queries worked better for `SpaceAgentNotificationService` and `safeNotify`, but `agent_idle_non_terminal` and `workflow_run_completed` were weak because string-literal event names are not first-class symbols.

CodeGraph is best as an exact-symbol helper after an agent already knows which names to ask about, not as first-pass task planner for broad backend work.

### code-review-graph

code-review-graph produced the largest and richest structural graph. It captured more nodes/edges than CodeGraph and reported flows, communities, high risk, and test gaps. Targeted `file_summary` queries on answer-key files provided useful function-level maps. It also surfaced rate-limit and retry-related runtime functions not named in task #394.

Weakness: MCP tool naming can mislead. `query_graph(pattern, target)` is not semantic query; `pattern` must be one of `callers_of`, `callees_of`, `imports_of`, `importers_of`, `children_of`, `tests_for`, `inheritors_of`, `file_summary`. Passing concepts returned errors. The raw targeted JSON was huge (335KB), increasing prompt tokens and causing plan output truncation at 4,096 tokens.

Best use in NeoKai: structural review context, impact radius, file summaries, tests-for, semantic search if enabled, and graph stats. Avoid exposing all 28 MCP tools by default.

### Graphify

Graphify's targeted exact-term query found the core runtime spine after the initial generic query failed. It was better than CodeGraph at surfacing neighboring managers/repositories, but worse than code-review-graph for actionable file summaries and worse than baseline for exact test/type surfaces.

Graphify's strength is broader knowledge-graph workflows across code, docs, papers, images, and graph reports. That breadth is not needed for task #394's focused daemon refactor. Its full skill pipeline is heavy for NeoKai's monorepo and warns on >200 files; headless AST extraction was more practical for this benchmark.

Semantic extraction did not fully run because the local Graphify install lacked the `openai` extra. The tool still wrote an AST graph, but this means the benchmark did not measure Graphify's intended semantic extraction quality.

## Integration recommendation

1. **Prioritize task #388 (`code-review-graph`) over task #387 (`Graphify`) for stock optional integration.** It fits NeoKai's code-review/task-planning workflows better: local SQLite, structural graph, review context, impact radius, tests-for, and graph stats.
2. **Keep both integrations optional, disabled by default, and never auto-install or auto-enable MCP servers.** Both projects have install commands that can mutate assistant configs, hooks, or global state.
3. **Do not add CodeGraph as stock integration yet.** Revisit if NeoKai wants a lighter exact-symbol helper, but task #394 showed poor first-pass planning quality.

## Suggested minimal configuration for winner

For code-review-graph, add an MCP template only. Default disabled. Suggested command:

```bash
uvx --from code-review-graph code-review-graph serve --repo ${workspaceFolder} --tools get_minimal_context_tool,get_review_context_tool,get_impact_radius_tool,query_graph_tool,semantic_search_nodes_tool,list_graph_stats_tool,detect_changes_tool
```

Suggested UI/status detection:

- CLI present: `code-review-graph --version` succeeds, or `uvx --from code-review-graph code-review-graph --version` can be offered as install-free check only if user opts in.
- Graph present: `.code-review-graph/` or configured external data dir exists and `code-review-graph status --repo <root>` succeeds.
- Tool count warning: show that full MCP exposes many tools; default template uses filtered subset.
- Help copy: `uv tool install code-review-graph` or `pipx install code-review-graph`; then `code-review-graph build --repo <project>`.
- Do not run `code-review-graph install`; it mutates assistant configs.

Minimal MCP tools rationale:

| Tool | Keep? | Reason |
|---|---|---|
| `get_minimal_context_tool` | Yes | Compact task/PR starting point |
| `get_review_context_tool` | Yes | Directly supports code review workflows |
| `get_impact_radius_tool` | Yes | Main graph value for change planning |
| `query_graph_tool` | Yes | Structural exact-symbol lookup |
| `semantic_search_nodes_tool` | Yes | Needed for concept search when embeddings are available |
| `list_graph_stats_tool` | Yes | Status/debug visibility |
| `detect_changes_tool` | Yes | Incremental review planning |
| daemon/watch/global registry/wiki/export tools | No by default | More surface area and mutation risk |

## Updates needed for tasks #387 and #388

### Task #387 (Graphify)

Keep as optional integration, but lower priority than #388. Update scope based on benchmark:

- Clarify that NeoKai should detect and expose Graphify, not run `/graphify`, `graphify install`, `graphify claude install`, `graphify hook install`, or `graphify global add`.
- Prefer MCP template against an existing graph file only:

```bash
python -m graphify.serve ${workspaceFolder}/graphify-out/graph.json
```

- Status should distinguish:
  - CLI missing
  - CLI installed, no `graphify-out/graph.json`
  - graph exists but MCP disabled
  - graph exists and MCP enabled
- Add `.gitignore` guidance for `graphify-out/` unless user explicitly wants to version graph artifacts.
- Mention Graphify is better for cross-doc/code knowledge maps than focused code-review planning.
- If user wants headless extraction with GLM, document needed OpenAI-compatible env mapping and extras; do not assume semantic extraction works with base install.

### Task #388 (code-review-graph)

Raise priority. Update scope:

- Add `--tools` filtering to MCP template; do not expose full 28-tool surface by default.
- Add optional external data-dir setting so users can keep `.code-review-graph/` out of repo worktrees:

```bash
code-review-graph build --repo ${workspaceFolder} --data-dir <local-cache-dir>
```

- Do not call `code-review-graph install`; provide help text only because installer mutates configs/hooks.
- Detection should check both project-local `.code-review-graph/` and configured external data dir.
- UI should explain fixed-pattern query behavior so users do not treat `query_graph` as semantic search.
- Add status warning if graph is stale relative to current git commit.

## Sources

- CodeGraph repository: https://github.com/colbymchenry/codegraph
- code-review-graph repository: https://github.com/tirth8205/code-review-graph
- Graphify repository: https://github.com/safishamsi/graphify
- Task #394 requirements from NeoKai task system
- Local benchmark command outputs in this worktree and `/tmp/neokai-*-467*` scratch files
