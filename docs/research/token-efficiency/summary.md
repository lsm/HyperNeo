# Token Saving & Efficient Harness Engineering — Summary

**Task:** Research token-saving techniques and efficient harness engineering for AI coding agents.  
**Resources:** The Harness Problem, Governor, Context Mode, Headroom, Caveman.  
**Output directory:** `~/focus/tmp/token-efficiency/`  
**HyperNeo focus:** Space agent system, preset agents, custom prompts, sub-session features, tool lists, MessageHub/AgentSession runtime.

## Executive summary

Research shows five complementary token-efficiency families:

1. **Reliability-first harness design** reduces retries and wasted output. Hashline editing from *The Harness Problem* is the clearest example: better edit anchors improved model success and cut retry tokens.
2. **Tool-output isolation** keeps large observations out of transcript. Context Mode shows strongest evidence: hundreds of KB of raw output reduced to a few KB by sandboxed analysis and local indexing.
3. **Provider-request compression** transforms context before model calls. Headroom adds proxy-stage compression, reversible retrieval, cache alignment, and learned compression policy.
4. **Hook-based filtering and governance** intercept noisy outputs, compress repeated instructions, and measure savings. Governor emphasizes quality-preserving compression and valid-context-loss metrics.
5. **Style and metadata compression** reduce passive overhead and generated output. Caveman compresses responses, memory files, MCP tool descriptions, and subagent handoffs.

For HyperNeo, biggest opportunity is not one feature. Best design is layered: compact preset prompts, structured Space handoff contracts, tool-output middleware, artifact-backed retrieval, cache-aware prompt layout, and anchored edit tools.

## Taxonomy of approaches

### 1. Prompt/output style compression

**Seen in:** Caveman, Governor.  
**Mechanism:** Inject terse style rules: drop filler, restatement, hedging, and generic caveats. Keep code, paths, identifiers, error strings, and ordered safety instructions exact.

**Best for:** final answers, subagent receipts, status updates, review summaries.  
**Risk:** ambiguity if used on security warnings, destructive action confirmation, or multi-step instructions.

**HyperNeo fit:** high. Space agents often talk to other agents, not humans. Their outputs can be compact by default.

### 2. Persistent context compression

**Seen in:** Caveman, Governor, Headroom learning.  
**Mechanism:** Compress `CLAUDE.md`, agent memory, rules, instructions, and recurring prompts with backups, protected spans, and validation.

**Best for:** text loaded every session: Space instructions, workflow instructions, preset agent prompts, memory summaries.  
**Risk:** losing subtle constraints. Needs protected spans and rollback.

**HyperNeo fit:** high. `seed-agents.ts` currently seeds verbose prompts; `buildCustomAgentTaskMessage` also injects recurring task/workflow/space context.

### 3. Tool-output filtering

**Seen in:** Governor, Context Mode, Headroom.  
**Mechanism:** Intercept large/noisy tool results, return compact summaries, errors, snippets, head/tail, or structured statistics.

**Best for:** test output, build logs, git output, GitHub issue/PR JSON, package install logs, metrics, API responses.  
**Risk:** filtering can hide one clue. Needs raw artifact retrieval.

**HyperNeo fit:** very high. AgentSession and MessageHub can mediate tool results before transcript insertion.

### 4. Context isolation / sandboxed analysis

**Seen in:** Context Mode.  
**Mechanism:** Run analysis code in isolated subprocesses and return only stdout. Store raw artifacts outside context.

**Best for:** Playwright snapshots, CSVs, logs, API payloads, large repository scans.  
**Risk:** sandbox security, operational complexity, user trust.

**HyperNeo fit:** high for Space tasks. Space workflows often require data gathering and synthesis; raw data can live in artifacts.

### 5. Local indexing and retrieval

**Seen in:** Context Mode, Headroom.  
**Mechanism:** Store raw content in SQLite/FTS/vector-like indexes. Retrieve exact chunks/snippets by query instead of injecting entire documents.

**Best for:** docs, logs, previous task artifacts, session histories, research corpora.  
**Risk:** retrieval misses if indexing/chunking poor.

**HyperNeo fit:** high. Space runtime already has artifacts and workflow state; add searchable per-run artifact store.

### 6. Reversible compression

**Seen in:** Headroom CCR; Context Mode artifact/index pattern.  
**Mechanism:** Compress context but retain original in local store; inject retrieval marker/tool.

**Best for:** high-stakes logs and JSON where details may matter later.  
**Risk:** retrieval tool misuse or missing permissions.

**HyperNeo fit:** high. Space agents can access MCP tools; artifacts can serve as raw-output backing store.

### 7. Tool catalog / MCP metadata compression

**Seen in:** Caveman shrink, Context Mode article discussion of tool-definition burden.  
**Mechanism:** Compress tool descriptions, prompts, and resource metadata before model ingestion.

**Best for:** sessions with many MCP tools.  
**Risk:** over-compressed schemas reduce correct tool selection.

**HyperNeo fit:** medium-high. `mergeRuntimeMcpServers` attaches Space tools; tool descriptions add passive context.

### 8. Provider cache alignment

**Seen in:** Headroom.  
**Mechanism:** Separate stable prefixes from dynamic prompt fragments to increase provider prompt-cache hits.

**Best for:** recurring system prompts, preset agent prompts, Space workflow contract text.  
**Risk:** affects billing/latency more than context occupancy.

**HyperNeo fit:** medium-high. `buildCustomAgentSystemPrompt` and `buildCustomAgentTaskMessage` already separate system vs user content; further stable/dynamic split could improve cache efficiency.

### 9. Anchored editing / harness reliability

**Seen in:** The Harness Problem.  
**Mechanism:** Add content hashes to read/grep lines and edit by line/range anchors, rejecting stale edits.

**Best for:** multi-model coding agents, weak models, concurrent file changes, repeated edit failures.  
**Risk:** needs new edit primitive and migration from exact string replacement.

**HyperNeo fit:** strategic. Reliability gains reduce retries, which reduces tokens.

## Effectiveness comparison

| Approach | Resource | Evidence | Best claim | Confidence |
|---|---|---:|---:|---|
| Sandboxed tool-output analysis | Context Mode | 21 project-authored scenarios | **376 KB → 16.5 KB**, **96% saved**; `ctx_execute_file` **315 KB → 5.5 KB**, **98% saved** | High mechanism confidence; benchmark not independent |
| Structured JSON/log compression | Headroom | project benchmarks/examples | **60–95% fewer tokens**; JSON average **93%**; examples **47–92%** | High for structured data; lower for prose/code |
| Hook-based log filtering | Governor | synthetic fixtures + small pilots | pytest fixture **96.8% blocked**; V2 average **45.5%** with near-zero VCLR | Medium; strong quality metric framing |
| Style/output compression | Caveman | API evals | **65% output reduction** across 10 prompts; memory **46%**; subagents ~**60%** smaller | Medium; fidelity not fully judged |
| Hashline edit harness | Harness Problem | custom benchmark | Grok Code Fast **6.7% → 68.3%**; Grok 4 Fast output tokens **−61%** | High leverage; task-specific benchmark |

Most reliable savings by category:

1. **Large structured/raw outputs:** Context Mode and Headroom dominate. Best raw reduction: 90–98%.
2. **Generated prose:** Caveman/Governor produce 45–65% output reduction when answers are verbose enough.
3. **Repeated passive prompt:** memory/prompt compression around 46–55%.
4. **Retry-loop waste:** hashline-style edit reliability can cut output by 61% in failure-prone edit tasks.

## Applicability to HyperNeo

### License notes

Adoption recommendations must account for license differences:

- **Context Mode:** Elastic License 2.0 in the inspected repo, despite the article summary claiming MIT. This can restrict commercial competing use; borrow patterns cautiously and avoid copying code without legal review.
- **Headroom:** Apache-2.0. More permissive for commercial adaptation, with patent/license notice obligations.
- **Governor:** MIT. Permissive for reuse with attribution/license preservation.
- **Caveman:** MIT. Permissive for reuse with attribution/license preservation.
- **The Harness Problem:** article/research source, not a reusable codebase; treat ideas as design input and verify any linked implementation license separately.

### Current HyperNeo touchpoints

Relevant current architecture from codebase:

- Preset agents are seeded in `packages/daemon/src/lib/space/agents/seed-agents.ts`.
- Preset agents include Coder, General, Planner, Research, Reviewer, QA with tool lists and custom prompts.
- Review prompt is large and verbose; Research prompt is shorter but generic.
- `SUB_SESSION_FEATURES` disables rewind/worktree/coordinator/archive/sessionInfo for sub-session agents.
- `buildCustomAgentSystemPrompt` composes agent custom prompts and slot prompts.
- `buildCustomAgentTaskMessage` injects task, runtime location, linked goal, workflow role, previous summaries, relevant memories, project context, and standing instructions.
- It has `USER_MESSAGE_SOFT_LIMIT_BYTES = 4 * 1024` and logs warnings when workflow user messages exceed this.
- `MEMORY_PROMPT_CONTENT_LIMIT = 500` truncates each relevant memory.
- Space runtime attaches runtime MCP tools via `mergeRuntimeMcpServers`.
- Query options are built centrally by `QueryOptionsBuilder`.

### Preset agents

Caveman/Governor ideas apply immediately:

- Add concise output contracts to Research, Reviewer, QA, and General prompts.
- Convert long reviewer instructions into compact structured checklist plus required output schema.
- Add per-role output size budgets.
- Make subagent delegation prompts specify compact result format.

Current reviewer prompt has many repeated concepts and examples. It is correctness-oriented, but expensive. Compression can preserve constraints while reducing recurring prompt cost.

### Custom prompts and workflow slot prompts

Headroom cache alignment applies here. `buildCustomAgentSystemPrompt` appends slot prompts onto base prompts. Stable base prompt should remain stable across runs; dynamic task/workflow state should stay in user message. Avoid injecting runtime-specific data into system prompt.

Governor-style protected-span compression could be applied to user-edited Space instructions and workflow instructions before use, but only with explicit backups/versions.

### Task message builder

`buildCustomAgentTaskMessage` already has good structure and a 4 KB warning. Improvements:

- Add byte/token accounting per section.
- Store omitted/oversized sections as artifacts and inject retrieval references.
- Summarize previous work with fixed budget.
- Compress standing instructions or project context with protected spans.
- Add section-level cacheability analysis: stable vs dynamic.

### Tool lists and MCP servers

Tool catalogs are passive context. HyperNeo can:

- Keep preset tool lists minimal by role.
- Compress MCP tool descriptions before provider ingestion.
- Disable unused runtime MCP tools for agents that do not need them.
- Use workflow-node tool guards to prevent high-output tools unless routed through artifact/sandbox flow.

### Sub-session features

Sub-session agents are good fit for compact output. Because their outputs feed parent context, their contract should require:

- file:line findings
- evidence snippets capped by bytes
- no raw logs unless requested
- artifact paths for large outputs
- clear “need full output?” retrieval hook

This mirrors Cavecrew and Context Mode.

## Quick wins

1. **Compress preset agent prompts.** Rewrite `seed-agents.ts` custom prompts to shorter structured contracts. Keep semantics, remove repeated prose. Highest immediate passive-token win.
2. **Add compact output mode for Space agents.** Default internal agent-to-agent messages to concise structured output; keep human-facing chat normal.
3. **Add section byte telemetry in `buildCustomAgentTaskMessage`.** Log or store bytes by task description, role section, memories, project context, standing instructions.
4. **Cap previous work and memory injection by total budget.** Existing memory cap is per memory; add aggregate budget.
5. **Require artifact references for large research outputs.** Research agents should write files and send summaries/paths, not paste full reports in messages.
6. **Add compact subagent templates.** Reviewer exploration, research reports, QA output should have one-line finding format where possible.
7. **Compress MCP tool descriptions experimentally.** Start with internal Space tools; compare tool-selection accuracy.
8. **Add token-savings ledger.** Store raw bytes vs returned bytes for tool results and inter-agent messages.

## Strategic investments

### 1. Tool-output middleware with artifact backing

Add runtime middleware around tool results. If output exceeds threshold:

1. store raw output as artifact,
2. classify output type,
3. return compact summary/snippets/errors,
4. include artifact reference and retrieval tool.

This combines Governor filtering, Context Mode artifact isolation, and Headroom reversibility.

### 2. Sandboxed analysis tool

Add HyperNeo-native “analyze artifact” or “execute analysis” tool. Agents provide scripts or queries; server runs them with caps and returns stdout. Use for logs, CSVs, snapshots, GitHub JSON, and test output.

### 3. Searchable workflow artifact store

Index large artifacts and prior task outputs with SQLite FTS. Let agents search exact evidence instead of loading full histories.

### 4. Cache-aware prompt compiler

Create prompt compiler that separates:

- stable system contract
- stable agent role
- stable workflow template
- dynamic task data
- dynamic gate/runtime data

Hash each segment, track cache hit eligibility, and avoid unnecessary churn.

### 5. Hash-anchored edit tools

Prototype read/grep line hashes and edit-by-anchor primitives. Measure edit success, retry count, and output tokens across providers.

### 6. Compression quality metrics

Adopt Governor’s VCLR concept:

- valid signal preserved?
- next action unchanged?
- wrong decision introduced?
- retrieval needed?
- retry count changed?

Use this before rolling out aggressive compression.

## Recommended next steps

### P0 — Instrument first

1. Add per-section byte/token estimates to `buildCustomAgentTaskMessage`.
2. Add per-tool raw/returned byte accounting in AgentSession/MessageHub path.
3. Add Space workflow artifact-size and inter-agent-message-size dashboards.

Reason: pick highest-impact token sinks from real HyperNeo workflows before broad rewrites.

### P1 — Reduce passive prompt overhead

1. Compress preset prompts in `seed-agents.ts`, especially Reviewer.
2. Add compact output contracts for Research, Reviewer, QA, and sub-session agents.
3. Add total budget caps for previous summaries and memories.

Reason: low implementation cost; immediate savings every Space session.

### P1 — Artifact-backed large output handling

1. Store large tool results as artifacts.
2. Return summary + artifact reference.
3. Add retrieval/search tool for raw details.

Reason: biggest savings class, safest when reversible.

### P2 — Context Mode style sandbox

1. Add sandboxed batch execution with strict caps.
2. Encourage agents to compute summaries outside context.
3. Support common data types: logs, JSON, CSV, Playwright snapshots.

Reason: high payoff but more security/ops complexity.

### P2 — Prompt cache alignment

1. Segment prompt compiler output.
2. Keep stable contract text stable.
3. Move dynamic runtime state out of system prompt.
4. Measure provider cache hits/cost/latency.

Reason: lowers cost/latency and avoids hidden prompt churn.

### P3 — Hashline edit experiment

1. Add experimental read/grep hash tags.
2. Add edit-by-anchor tool behind feature flag.
3. Benchmark across Claude, Gemini, GLM, Grok/OpenRouter models if available.

Reason: strategic reliability gain, but touches core edit workflow.

## Source notes

- Reports under `reports/` contain per-resource details and caveats.
- Fetched article markdown saved under `articles/`.
- Repos cloned under `repos/` for local inspection.
