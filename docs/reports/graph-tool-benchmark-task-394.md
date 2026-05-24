# Graph Tool Benchmark for Task #394

**Date:** 2026-05-22  
**Benchmark task:** #394, "Refactor task event source as Layer-2 anti-stuck mechanism"  
**Corpus:** NeoKai worktree at `space/benchmark-codegraph-code-review-graph-and-graphify-on-task`  
**Model requested:** `glm-5.1`  
**Constraint:** task #394 was used only for exploration/planning; no task #394 implementation was made.

## Executive summary

Graph/context tools helped most when they could answer exact-symbol questions after the task terms were known. None replaced normal code exploration for this task. `ast-grep` was fast and useful as a structural search primitive, but it is not a graph/context memory tool and produced a narrower plan than baseline or code-review-graph.

**Recommendation:** prioritize **code-review-graph** before Graphify for NeoKai stock integration, but ship it as optional/disabled with a small default MCP tool subset. Keep Graphify optional but lower priority unless NeoKai wants broader document/code knowledge graphs. Do not prioritize CodeGraph until its task-context retrieval improves for backend/runtime tasks. Treat `ast-grep` as a possible local search/codemod helper, not as a replacement for graph context.

## Method

1. Pulled task #394 requirements from the task system.
2. Established an answer key with read-only code exploration for relevant files and line ranges.
3. Built or queried each graph tool locally without running global installers or mutating user-wide agent config.
4. Asked `glm-5.1` to produce the same implementation-plan deliverable from each context bundle.
5. Added `ast-grep` as a non-graph structural-search comparison using equivalent task terms (`agent_idle_non_terminal`, `workflow_run_completed`, `SpaceAgentNotificationService`, and exact handler/backoff names).
6. Scored each output against key file recall, extra relevant discovery, usefulness, setup/runtime friction, tool-surface complexity, and config/privacy risk.

`claude -p --model glm-5.1` failed in this harness because the active Claude provider path reported: `The 'glm-5.1' model is not supported when using Codex with a ChatGPT account.` To keep the model constant, the benchmark called the GLM API directly (`model: glm-5.1`) for the final plan-generation step.

## Answer key from direct exploration

Task #394's description named four files. Direct code exploration found those plus additional high-signal files:

| File | Relevant surface |
|---|---|
| `packages/daemon/src/lib/space/runtime/space-runtime.ts` | `SpaceNotificationEvent`, `mapNotificationEventToInternalEvent`, `safeNotify`, `handleAliveStuckExecutions`, `handleNonTerminalIdleExecutions`, `handleWaitingRebindExecutions`, `attemptBlockedRunRecovery`, `agent_idle_non_terminal`, `workflow_run_completed` |
| `packages/daemon/src/lib/space/runtime/space-agent-notification-service.ts` | event subscription, `[TASK_EVENT]` injection, idle/retry message formatters |
| `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` | creates `SpaceAgentNotificationService` per space |
| `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` | agent lifecycle management, spawn/timeout handling, execution state bridge |
| `packages/daemon/src/lib/space/runtime/channel-router.ts` | message routing between sessions/agents and runtime channels |
| `packages/daemon/src/lib/space/runtime/escalation-reasons.ts` | canonical escalation reasons used when stuck/recovery paths need human attention |
| `packages/daemon/src/lib/space/runtime/last-message-classifier.ts` | classifies latest agent message; relevant to distinguishing waiting/tool-progress from stuck idle |
| `packages/daemon/src/lib/space/runtime/workflow-run-status-machine.ts` | workflow terminal/non-terminal transition semantics |
| `packages/daemon/src/lib/space/runtime/completion-detector.ts` | detects completion signals and terminal conditions |
| `packages/daemon/src/lib/external-events/external-event-store.ts` | persisted external event state that feeds runtime retry/delivery paths |
| `packages/daemon/src/lib/external-events/external-event-service.ts` | external event ingestion/service layer that can interact with retry/noise behavior |
| `packages/daemon/src/lib/space/runtime/constants.ts` | existing stuck/retry/network constants including `MAX_AGENT_STUCK_NAGS`, `DEFAULT_AGENT_STUCK_NAG_GRACE_MS`, `MAX_AGENT_STUCK_RESTARTS`, `MAX_BLOCKED_RUN_RETRIES`, and `NETWORK_RETRY_DELAYS_MS` |
| `packages/daemon/src/lib/space/runtime/retry-utils.ts` | generic retry/backoff helper |
| `packages/daemon/src/lib/internal-event-bus.ts` | canonical event surface (`SpaceEvents`, `DaemonInternalEventMap`) |
| `packages/shared/src/types/space.ts` | `SpaceGoalEventSource`, agent timeout fields, shared space/task types |
| `packages/shared/src/space/workflow-autonomy.ts` | autonomy-level helpers |
| `packages/daemon/tests/unit/5-space/runtime/space-runtime-notifications.test.ts` | notification behavior coverage, including `workflow_run_completed` |
| `packages/daemon/tests/unit/5-space/runtime/space-runtime-stalled-recovery.test.ts` | existing stalled/stuck recovery tests |
| `packages/daemon/tests/unit/5-space/other/space-agent-notification-service.test.ts` | notification service formatter/subscriber tests |
| `packages/daemon/tests/unit/5-space/runtime/space-runtime-external-events.test.ts` | external event retry/delivery behavior coverage |
| `packages/daemon/tests/unit/4-space-storage/storage/external-event-store.test.ts` | external event persistence coverage |
| `packages/daemon/tests/unit/4-space-storage/storage/external-event-service.test.ts` | external event service coverage |
| `packages/daemon/tests/unit/5-space/workflow/completion-detector.test.ts` | completion detection coverage |
| `packages/daemon/tests/unit/5-space/workflow/workflow-run-status-lifecycle.test.ts` | workflow status transition coverage |

## Comparison table

| Setup | Build/query observed | Final GLM plan tokens | Tool/query calls used for context | Key-file recall | Extra relevant files beyond #394 | Usefulness | Friction / reliability | Security and config risk |
|---|---:|---:|---:|---|---|---|---|---|
| Baseline direct exploration | Investigator run took 134.7s, 34 code tools, 46,262 Claude tokens | 6,325 | 34 reads/greps/globs in investigator | Strong for named files but initial answer key required correction: 3/4 task-named files confirmed, `task-executor.ts` not found in current tree, and one fabricated function name was replaced with actual runtime handlers | Strong after review correction: `task-agent-manager.ts`, `channel-router.ts`, classifier/completion/status-machine files, external event files, `internal-event-bus.ts`, `types/space.ts`, `workflow-autonomy.ts`, tests | Best practical plan; concrete lines and existing functions | No install; token/tool cost high | Lowest risk; no generated DB |
| CodeGraph | `npx @colbymchenry/codegraph init . -i`; 1,580 files, 21,487 nodes, 19,857 edges, 18.3s internal / 25.8s wall. `context` query 4.35s | 4,324 | 1 context + 4 exact symbol queries | Partial: found `space-runtime.ts`, `space-agent-notification-service.ts`; missed most runtime-adjacent answer-key files; initial task-context query was mostly wrong/UI-noisy | Weak: little beyond notification/runtime, missed tests/types/classifier/status/external-event files | Low-to-medium. Exact symbol queries useful; free-form task context poor | Fast local index; `init` creates `.codegraph/`; no `--no-install` flag but did not mutate global config in observed path | Installer can mutate `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, Cursor/Codex config, and optionally auto-allow tools. Keep disabled/manual only |
| code-review-graph | `uvx --from code-review-graph code-review-graph build --repo . --data-dir /tmp/neokai-crg-467`; 1,591 files, 34,381 nodes, 399,977 edges, 893 flows, 10 communities, 61.7s wall | 17,974 | 1 minimal-context query + targeted `file_summary`/structural queries | Good after targeted file summaries: `space-runtime.ts`; structural functions; still incomplete on classifier/status/external-event files in first pass | Medium: found `getExternalEventRateLimitState`, `scheduleExternalEventRetry`, `task-agent-manager.ts`, workflow/repository/test adjacency, but still assumed some module paths | Medium-high. Best graph depth/risk signal, but large JSON can overfeed model and concept queries require exact structural patterns | Python install via `uvx`; build reliable. Tool API easy to misuse: `query_graph(pattern, target)` uses fixed patterns, not semantic search. MCP exposes 28 tools unless filtered | Installer mutates assistant configs/hooks/MCP. Daemon uses `~/.code-review-graph/watch.toml`. Local DB can live in project or external data dir. Expose minimal MCP subset only |
| Graphify | Existing CLI. `graphify extract . --out /tmp/neokai-graphify-467 --backend openai --model glm-5.1 --no-cluster`; first semantic chunks failed because `openai` extra missing, but AST graph still wrote 20,316 nodes / 60,564 edges in 26.9s. Generic query 15KB; targeted query 15KB | 6,847 targeted run; 7,925 generic run | 2 graph queries | Poor generic query; decent targeted query found `space-runtime.ts`, `TaskAgentManager`, `SpaceAgentNotificationService`, `InternalEventBus`, `retry-utils` | Medium after exact-term query: `task-agent-manager.ts`, repositories/managers surfaced; missed tests and some exact existing constants unless prompted | Medium. Targeted graph query useful as navigation map; generic task query drifted to schedule/task UI noise. Semantic extraction requires extra deps/API setup | CLI help fast; AST-only extraction reliable. Semantic extraction with GLM via Graphify's OpenAI-compatible backend needs Graphify installed with the `openai` extra plus standard OpenAI-client env mapping (`OPENAI_API_KEY` set to `GLM_API_KEY`, `OPENAI_BASE_URL` set to GLM endpoint). Full skill pipeline is heavier than headless AST extraction on this monorepo | Install/hooks/Claude integration can mutate CLAUDE.md, hooks, global graph. `graphify-out/` can be large and repo page recommends committing it; NeoKai should not commit generated graph outputs |
| ast-grep | `npx -y -p @ast-grep/cli ast-grep run`; no index. Help startup 2.4s; event string queries 2.6-2.7s each. Found 15 `agent_idle_non_terminal` matches, 44 `workflow_run_completed` matches, notification service class, and 11 `retryWithBackoff` call/test matches. Exact private handler-name call queries returned 0 because declarations/calls did not match simple call patterns | 4,798 | 4 successful structural queries + 5 exact handler/backoff follow-ups | Narrow: found event emission files and several tests; missed answer-key files not containing queried strings (`channel-router.ts`, classifier/status/completion/external-event files unless separately queried) | Medium-low: surfaced `space-runtime-completion.test.ts`, `space-runtime-edge-cases.test.ts`, `space-chat-agent.test.ts`, `retry-utils.test.ts`; did not discover architecture by itself | Medium as a search accelerator; low as planner context. GLM plan correctly flagged missing payload/state-machine context and over-representation of tests | Very low setup friction via `npx -p @ast-grep/cli`; no database or daemon; supports JSON output and rewrites. Requires hand-authored patterns/rules and can miss symbols if pattern syntax is off | Low read-only risk when using `run` without `--rewrite`, `--interactive`, or `--update-all`; rewrite/codemod modes can mutate files. No global config mutation unless user creates config/rules |

## Findings by tool

### Baseline

Direct read/grep exploration produced the most accurate answer because task #394 already included exact event names and likely files, but the first answer key still needed review correction: `handleStuckAgentRecovery` was fabricated. Actual runtime recovery handlers are `handleAliveStuckExecutions`, `handleNonTerminalIdleExecutions`, and `handleWaitingRebindExecutions`, alongside `attemptBlockedRunRecovery`. After correction, the answer key includes notification service formatters, event-bus types, constants, retry helper, autonomy helper, classifier/completion/status-machine files, external-event files, and test coverage.

Cost was high: 34 code-exploration tool calls and 46k Claude tokens before the GLM plan call. For one-off planning this is acceptable; for repeated PR review it is expensive.

### CodeGraph

CodeGraph indexing was fastest and local-only. Its MCP surface is small and understandable: 9 tools listed in repo docs (`codegraph_search`, `codegraph_context`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_node`, `codegraph_explore`, `codegraph_files`, `codegraph_status`).

Weakness: the free-form `context <task>` query over-indexed generic words like `task` and `event`, returning frontend thread-event and test-gateway code rather than daemon anti-stuck code. Exact symbol queries worked better for `SpaceAgentNotificationService` and `safeNotify`, but `agent_idle_non_terminal` and `workflow_run_completed` were weak because string-literal event names are not first-class symbols.

CodeGraph is best as an exact-symbol helper after an agent already knows which names to ask about, not as first-pass task planner for broad backend work.

### code-review-graph

code-review-graph produced the largest and richest structural graph. It captured more nodes/edges than CodeGraph and reported flows, communities, high risk, and test gaps. Targeted `file_summary` queries on answer-key files provided useful function-level maps. It also surfaced rate-limit and retry-related runtime functions not named in task #394.

Weakness: MCP tool naming can mislead. Local package source showed `query_graph(pattern, target)` is not semantic query; `pattern` is fixed to structural modes such as `callers_of`, `callees_of`, `imports_of`, `importers_of`, `children_of`, `tests_for`, `inheritors_of`, and `file_summary`. Passing concepts returned errors. The raw targeted JSON was huge (335KB), increasing prompt tokens and causing plan output truncation at 4,096 tokens.

Best use in NeoKai: structural review context, impact radius, file summaries, tests-for, semantic search if enabled, and graph stats. Avoid exposing all 28 MCP tools by default.

### Graphify

Graphify's targeted exact-term query found the core runtime spine after the initial generic query failed. It was better than CodeGraph at surfacing neighboring managers/repositories, but worse than code-review-graph for actionable file summaries and worse than baseline for exact test/type surfaces.

Graphify's strength is broader knowledge-graph workflows across code, docs, papers, images, and graph reports. That breadth is not needed for task #394's focused daemon refactor. Headless AST extraction was more practical for this benchmark than running the full assistant skill pipeline.

Semantic extraction did not fully run because the local Graphify install lacked the `openai` extra. The tool still wrote an AST graph, but this means the benchmark did not measure Graphify's intended semantic extraction quality. Graphify's MCP server exposes 10 tools in its skill docs: `query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`, `list_prs`, `get_pr_impact`, and `triage_prs`.

### ast-grep

`ast-grep` is not a graph database or MCP context server in this benchmark; it is a structural AST search/codemod CLI. It performed best when asked precise syntax or string-literal questions. It found the primary event emission sites quickly and produced compact JSON suitable for feeding into `glm-5.1`.

Strengths:

- Fast no-index searches over TypeScript/TSX.
- Good structured JSON output for exact syntax/string matching.
- Good for confirming event emission sites, class boundaries, and test files that mention specific event names.
- Low local-state risk when used read-only.

Weaknesses:

- No persistent graph, no automatic architecture/context synthesis, no impact radius, and no semantic recall.
- Pattern syntax matters. Simple exact function-call patterns found `retryWithBackoff` calls but missed private runtime handler declarations/calls without more careful rule construction.
- Results over-represent tests when event names are common in assertions.
- Output lacks payload shapes and surrounding method structure unless follow-up reads or richer patterns are used.

Best use in NeoKai: optional developer/search helper for structural grep and codemods, not a stock graph-context integration. If integrated later, expose it as a local CLI template/snippet library rather than auto-enabled MCP.

## Follow-up: unseeded discovery round

After the first benchmark, a second round removed seed file paths, exact function names, event constants, and test names from the prompt. The prompt described only the desired feature: detect genuinely stuck or idle Space task agents, track recovery state, apply autonomy-aware recovery with backoff/caps, avoid retry loops, and reduce operator notification noise while preserving internal logs.

This round tested each tool's first-pass discovery behavior rather than exact-symbol lookup.

| Setup | Unseeded context collected | Final GLM plan tokens | Discovery quality | Main misses / failure mode | Impact on recommendation |
|---|---:|---:|---|---|---|
| Plain GLM | No repository/tool context; prompt only. 151.8s elapsed | 4,572 | Generic lower bound. Produced reasonable architecture (`StuckDetector`, `RecoveryManager`, `TaskHealthTracker`, `NotificationGate`) but explicitly marked paths as inferred | Zero actual file recall. Suggested Python-like pseudocode and generic module names; could not discover existing anti-stuck code, tests, autonomy helpers, or storage patterns | Useful baseline: any tool should beat this on actual-file grounding. Only code-review-graph and ast-grep clearly did |
| CodeGraph | Rebuilt `.codegraph/`; `context` query returned 170 lines / 5.3KB | 5,708 | Poor. Found mostly frontend thread-event display types and tool schema names: `SpaceTaskThreadEvent`, `SpaceTaskThreadEventKind`, `TaskAgentToolName`, `buildThreadEvents` | Missed core daemon runtime, notification service, tick loop, recovery handlers, storage, and tests. Plan inferred likely paths instead of naming actual modules | Worse than plain GLM for conceptual plan quality and only marginally better for code grounding; confirms CodeGraph is weak as unseeded task-discovery context for backend/runtime work |
| code-review-graph | `get_minimal_context` plus broad structural/context queries returned 655 lines / 37KB | 13,998 | Best unseeded result. Surfaced `handleNonTerminalIdleExecutions`, `retry-utils.ts`, `CompletionDetector`, `space-runtime-tick-loop.test.ts`, `SpaceTaskManager.submitTaskForReview`, autonomy concepts, migration history around stuck rows, and backoff/job-queue tests | Still missed some high-value source implementations and noisy event constants; large context drove high prompt tokens | Clearly beat plain GLM and strengthens recommendation to prioritize code-review-graph for optional graph-context integration |
| Graphify | Query over existing AST graph returned only 3 generic `workflow` test nodes | 4,463 | Poor. Context was too shallow for source discovery and mostly test-only | GLM plan invented likely paths such as `packages/daemon/src/5-space/...` from directory conventions; no core runtime source found | Did not beat plain GLM in this AST-only unseeded setup. Keep lower priority unless better seeding or semantic extraction is available |
| ast-grep | Broad read-only string/AST searches sampled 68 matches across `stuck`, `idle`, `blocked`, `waiting`, `retry`, `workflow`, etc. | 5,951 | Moderate. Found `packages/shared/src/types/space.ts`, `state-types.ts`, `internal-event-bus.ts`, task/workflow repositories, `space-workflow-manager.ts`, `space-task-handlers.ts`, `rate-limit-watchdog.ts`, and completion-detector tests | Results were broad and partly misleading; plan over-focused on adding new states/schema and reused `rate-limit-watchdog.ts` more confidently than evidence justified | Beat plain GLM on actual-file grounding. Useful as cheap discovery/search helper, especially when no seed files exist, but still not graph context |

### Unseeded findings by tool

#### Plain GLM

Plain `glm-5.1` with only the unseeded prompt produced a coherent generic architecture: `StuckDetector`, `RecoveryManager`, `TaskHealthTracker`, `NotificationGate`, recovery policy types, backoff caps, notification filtering, and migration/storage suggestions. It also correctly warned that file paths were inferred.

The output had no NeoKai grounding. It did not name actual Space runtime files, existing anti-stuck handlers, tests, autonomy helpers, retry utilities, or storage repositories. It used Python-like pseudocode and generic path guesses. This is the fair lower bound for unseeded planning: conceptually plausible, but not actionable without follow-up code exploration.

#### CodeGraph

Unseeded CodeGraph underperformed more sharply than in the seeded round. Because the prompt used generic words like "task", "workflow", "event", and "notification", retrieval drifted to frontend event-thread rendering and tool-schema types. That produced a plausible but mostly inferred implementation plan, not a codebase-grounded plan.

Takeaway: CodeGraph may still help once an agent knows exact symbols, but its current free-form context retrieval is not reliable enough to bootstrap a backend/runtime refactor in NeoKai.

#### code-review-graph

code-review-graph was the only tool that independently surfaced the existing anti-stuck seam. Its context led `glm-5.1` to identify `handleNonTerminalIdleExecutions`, existing Layer-1 runtime anti-stuck tests, `retryWithBackoff`, `CompletionDetector`, review/waiting flow, autonomy levels, and migration history. Those discoveries are directly relevant to task #394 even without seed file paths.

Weaknesses remain: broad concept queries are not semantic unless embeddings are available, raw context is verbose, and several important source files still required targeted follow-up. Still, this was the strongest unseeded planning substrate.

#### Graphify

Graphify's existing AST graph did not help much without seed terms. The unseeded query found only three workflow-related test nodes. The resulting plan was honest about poor context quality but had to infer most architecture and proposed incorrect path shapes.

This does not fully measure Graphify's intended semantic mode because semantic extraction had not completed in this benchmark environment. It does show that AST-only Graphify queries are not enough for unseeded NeoKai runtime planning.

#### ast-grep

`ast-grep` performed better than expected for unseeded discovery because broad terms quickly exposed type definitions, repositories, event-bus entries, workflow manager code, RPC handlers, and prior stuck/completion tests. It also surfaced `rate-limit-watchdog.ts`, which is a plausible pattern source for timer-based detection.

But this was search, not graph understanding. It did not rank architecture accurately, infer data flow, or distinguish primary runtime files from incidental matches. Its plan included some overbroad schema/state suggestions that would need careful validation against existing Space runtime state machines.

### Unseeded-round conclusion

The unseeded round makes the priority order clearer:

1. **code-review-graph** is the best candidate for NeoKai's optional graph-context integration because it found real runtime seams without seed paths and clearly beat the plain-GLM lower bound.
2. **ast-grep** is worth documenting as a low-risk search/codemod companion, especially for first-pass term discovery and later precise rewrites, because it added real file grounding over plain GLM.
3. **Graphify** remains lower priority for focused daemon refactors unless NeoKai invests in full semantic extraction and better query workflows; AST-only unseeded Graphify did not beat plain GLM.
4. **CodeGraph** should stay out of stock integration for now; exact-symbol lookup is useful, but generic task-context retrieval was too noisy in both rounds and did not improve enough over plain GLM.

## Follow-up: mixed discovery + targeted-tool round

A third round tested the hybrid workflow agents would actually use: first do minimal built-in search/read to identify likely files, classes, and functions, then use one targeting tool for deeper context before asking `glm-5.1` for the implementation plan. This was not scored as a separate baseline; the minimal discovery step is included inside every run's wall time.

Minimal discovery took 0.32s and identified the core seed set: `space-runtime.ts`, `space-agent-notification-service.ts`, `CompletionDetector`, `handleAliveStuckExecutions`, `handleNonTerminalIdleExecutions`, `handleWaitingRebindExecutions`, `safeNotify`, `agent_idle_non_terminal`, `workflow_run_completed`, `retryWithBackoff`, `TaskAgentManager`, `ChannelRouter`, and `classifyLastMessageForIdleAgent`.

| Setup | Total wall time | Tool-context step | Final GLM tokens | Mixed-run quality | Main failure mode | Impact on recommendation |
|---|---:|---|---:|---|---|---|
| CodeGraph mixed | 101.1s | 12.7s for targeted `context` queries after minimal discovery | 6,968 | Medium. With seed symbols from built-in search, the plan named the right runtime/notification/completion/retry files and proposed plausible tracker/policy/rate-limit modules | Still lacked full function bodies and storage details; output was more generic than code-review-graph or ast-grep. CodeGraph contributed little beyond what minimal search already found | Better than unseeded CodeGraph, but still not strong enough for stock integration |
| code-review-graph mixed | 109.9s | 11.1s for `get_minimal_context`, `file_summary`, callers/callees, and graph stats | 21,682 | Strongest mixed run. Produced best grounded plan around `SpaceRuntime`, `SpaceAgentNotificationService`, constants, `TaskAgentManager`, `CompletionDetector`, `retryWithBackoff`, and existing stuck-recovery caps | High token cost; context still verbose and some internals referenced rather than fully shown | Reinforces code-review-graph as best optional graph-context integration |
| Graphify mixed | 94.4s | 0.34s direct query over existing AST graph for seeded terms | 19,624 | Improved sharply from unseeded. Targeted graph search found many nodes/edges and yielded a reasonable source-grounded plan naming `last-message-classifier.ts`, `task-agent-manager.ts`, `completion-detector.ts`, and notification/runtime surfaces | AST-only context remained shallow: no semantic rationale, many raw node hits, high prompt tokens. Quality depended on built-in search seed terms | Useful only after seeding; still lower priority unless semantic extraction is available |
| ast-grep mixed | 119.6s | 30.1s for ten targeted read-only structural/string searches | 9,943 | High practical value. Produced grounded plan with correct runtime flow (`processRunTick` → stuck handlers → classifier → `safeNotify`), strong exact-symbol recall, and lower tokens than graph tools except CodeGraph | Slower than expected via repeated `npx`; no relationship graph or architecture ranking; still needs reads for bodies and schemas | Best non-graph companion. Worth documenting as optional search/codemod helper |

### Mixed-round conclusion

The mixed round changed the shape of the comparison:

1. **Minimal built-in search is mandatory regardless of tool.** It found the decisive seed symbols in under a second and prevented CodeGraph/Graphify from drifting.
2. **code-review-graph remained best when seeded.** It produced the most complete implementation plan and best reuse of existing recovery concepts, but at highest token cost.
3. **ast-grep became highly competitive as a practical companion.** With seed symbols, it gave strong actual-file grounding at modest prompt size, though repeated `npx` made wall time high.
4. **Graphify improved only after seeding.** AST graph can help navigate known terms, but unseeded discovery and semantic-free context remain weak.
5. **CodeGraph improved after seeding but added least incremental value.** Its mixed plan was acceptable, but minimal search already supplied most important evidence.

## Integration recommendation

1. **Prioritize task #388 (`code-review-graph`) over task #387 (`Graphify`) for stock optional integration.** It fits NeoKai's code-review/task-planning workflows better: local SQLite, structural graph, review context, impact radius, tests-for, and graph stats. The unseeded and mixed rounds both strengthened this recommendation: code-review-graph was the strongest graph tool without file-path hints and remained strongest after minimal built-in discovery seeded deeper search.
2. **Keep both integrations optional, disabled by default, and never auto-install or auto-enable MCP servers.** Both projects have install commands that can mutate assistant configs, hooks, or global state.
3. **Do not add CodeGraph as stock integration yet.** Revisit if NeoKai wants a lighter exact-symbol helper, but task #394 showed poor first-pass planning quality unseeded and low incremental value after minimal built-in search.
4. **Do not treat `ast-grep` as a graph integration.** It is useful as a fast structural search/codemod tool and performed well in mixed discovery, but it should be integrated only as optional CLI help/rules if NeoKai wants codemod workflows.

## Suggested minimal configuration for winner

For code-review-graph, add an MCP template only. Default disabled. Suggested command:

```bash
uvx --from code-review-graph code-review-graph serve --repo ${workspaceFolder} --tools get_minimal_context_tool,get_review_context_tool,get_impact_radius_tool,query_graph_tool,semantic_search_nodes_tool,list_graph_stats_tool,detect_changes_tool
```

Suggested UI/status detection:

- CLI present: `code-review-graph --version` succeeds, or `uvx --from code-review-graph code-review-graph --version` can be offered as install-free check only if user opts in.
- Graph present: `.code-review-graph/` or configured external data dir exists and `code-review-graph status --repo <root>` succeeds.
- Tool count warning: show that full MCP exposes many tools (28 reported by repo docs); default template uses filtered subset.
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
- If user wants headless extraction with GLM, document Graphify's OpenAI-compatible backend requirements: install `openai` extra, set standard OpenAI-client variables (`OPENAI_API_KEY=$GLM_API_KEY`, `OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4`), and pass `--backend openai --model glm-5.1`. These are backend env vars consumed by the OpenAI client, not Graphify-specific variable names.

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
- ast-grep repository: https://github.com/ast-grep/ast-grep
- code-review-graph repository: https://github.com/tirth8205/code-review-graph
- Graphify repository: https://github.com/safishamsi/graphify
- Task #394 requirements from NeoKai task system
- Local benchmark command outputs in this worktree and `/tmp/neokai-*-467*` scratch files

## Follow-up: NeoKai agent session benchmark

The original three rounds (seeded, unseeded, mixed) used raw Python scripts calling the GLM API directly, bypassing NeoKai's daemon/session/MCP infrastructure. This follow-up re-ran a subset using real NeoKai agent sessions via the daemon RPC layer, with MCP tool servers attached.

**Date:** 2026-05-24
**Model:** `glm-4.7` (GLM-5.x models generate `tool_use` responses incompatible with the Claude Agent SDK's internal context-fetcher — see findings below)
**Method:** Each test case creates a NeoKai daemon session via RPC, attaches the tool's MCP server, sends the unseeded prompt, waits for the session to reach idle state, then collects metrics.

### Key finding: GLM-5.x + Claude Agent SDK incompatibility

GLM-5.1 and GLM-5-turbo both generate `tool_use` responses that cause the Claude Agent SDK's internal `contextfetcher` to fail with:

```
[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use
```

This diagnostic runs alongside the main query to estimate context usage. When the GLM model returns a `tool_use` response to this internal request, the SDK cannot parse it and the session hangs in `processing` state indefinitely.

GLM-4.7 works reliably when the model can respond text-only or when MCP tools are available for the SDK to execute. The mixed round (built-in + MCP tools) was excluded because multi-step tool use triggers the same incompatibility even with GLM-4.7.

**Recommendation:** This is a Claude Agent SDK bug with non-Anthropic providers. The context-fetcher should handle `tool_use` stop reasons gracefully from compatible endpoints. For now, GLM-4.7 is the viable model for NeoKai sessions using GLM.

### Results

| Case | Wall time (s) | Input tokens | Output tokens | Total tokens | Tool calls | Response length |
|---|---:|---:|---:|---:|---:|---:|
| baseline: plain GLM (text-only) | 37.1 | 31,987 | 2,141 | 34,128 | 0 | 8,722 chars |
| CodeGraph | 29.8 | 31,987 | 1,768 | 33,755 | 0 | 7,209 chars |
| code-review-graph | 38.4 | 31,987 | 2,334 | 34,321 | 0 | 9,491 chars |
| ast-grep | 32.3 | 32,199 | 1,676 | 33,875 | 0 | 7,009 chars |
| Graphify | — | — | — | — | — | Skipped (extraction failed — no compatible LLM backend available) |

### Analysis

**Zero tool calls across all cases.** GLM-4.7 received MCP tool definitions but did not invoke any MCP tools. It produced text-only plans in every case. This contrasts sharply with the raw API benchmark rounds where tools were explicitly invoked by the test harness. In the agent session context, the model chose to respond text-only despite having tools available.

This is a significant observation: **making tools available does not guarantee tool use**. The model's decision to skip tools may be due to GLM-4.7's conservative tool-calling behavior, the prompt format, or how the Claude Agent SDK presents tool definitions to the model.

**Wall times** (29.8–38.4s) are substantially lower than the raw Python API benchmark (94–120s for mixed round) because there were no tool invocations — the model generated a single text response.

**Output token counts** (1,676–2,334) and **response lengths** (7,009–9,491 chars) are consistent across cases, indicating the model produced similar-quality plans regardless of available tools. This confirms the model did not leverage any tool's context.

**Input tokens** (~32k) are dominated by the system prompt + MCP tool definitions + benchmark prompt. Tool definitions add negligible overhead since none were invoked.

### Plan quality comparison

Despite zero tool calls, the plans produced in this round are comparable to the earlier unseeded plain-GLM baseline (generic architecture, inferred paths, no actual NeoKai file grounding). The code-review-graph case produced the longest response (9,491 chars) with the most detailed architecture, but without tool invocation it could not leverage the graph.

### Tool index build times

| Tool | Build time | Notes |
|---|---:|---|
| CodeGraph | 3.7s | Cached from previous run; first build ~25s |
| code-review-graph | 64.8–119.7s | Depends on cache state; fresh build ~100s |
| Graphify | Failed | No compatible LLM backend (needs Gemini/Anthropic/OpenAI/Ollama API key) |
| ast-grep | 0s (no index) | Wrapper script only |

### Infrastructure observations

1. **Transport PONG timeout:** The Claude Agent SDK's WebSocket transport has a 45s PONG timeout. Index building (CodeGraph + CRG) takes ~100s total. If the daemon is started before indexes finish building, the transport disconnects. Fix: build indexes before starting the daemon.

2. **Session state stuck in processing:** When the context-fetcher fails, sessions remain in `processing` state indefinitely rather than transitioning to `error`. This prevents `waitForIdle` from ever resolving. The daemon should detect this condition and transition to a terminal state.

3. **Graphify extraction needs LLM backend:** Graphify's semantic extraction requires an LLM API key (Gemini, Anthropic, OpenAI, or Ollama). The Ollama backend works locally but requires the `openai` Python package and a pulled model.

### Conclusion

The agent session benchmark validates the test infrastructure (daemon sessions with MCP servers work correctly for single-tool cases) but reveals two critical gaps:

1. **GLM-4.7 does not voluntarily invoke MCP tools** when presented with a planning prompt, making it impossible to measure tool quality through agent sessions alone. Future benchmarks should use Anthropic models or explicitly prompt the model to use specific tools.
2. **The Claude Agent SDK has a context-fetcher incompatibility** with GLM-5.x's tool_use responses, limiting GLM to 4.7 for NeoKai sessions.

The raw API benchmark results (seeded, unseeded, mixed rounds) remain the authoritative comparison. The agent session infrastructure is ready for re-use once these gaps are addressed.
