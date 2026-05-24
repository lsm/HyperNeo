# Caveman essentials evaluation for NeoKai

## Executive summary

Recommendation: implement a NeoKai-native compressed output injection as the first built-in template in a generic prompt injection registry, applying to all agent sessions — user chat, Space tasks, and SDK subagents — then measure before adapting Caveman tools.

Do **not** bundle Caveman wholesale. Caveman's highest-value primitive is a small style contract: terse status, no filler, code/identifier preservation, short failures, and normal-prose escape hatches for safety/approval/clarity. Its hooks, installer, statusline, memory compressor, MCP shrink proxy, and branded slash commands solve Claude Code/plugin distribution problems that do not map cleanly to NeoKai's runtime.

Best first integration point: add a generic prompt injection resolver/composer/renderer in the general session-init/query-options path before the SDK query starts, not only in `packages/daemon/src/lib/space/agents/custom-agent.ts`. Compressed output should be enabled by scoped `prompt_injections` records, not by typed `outputMode` fields on `GlobalSettings`, `SessionConfig`, `AgentSessionInit`, `Space`, or `SpaceAgent`. The same mechanism should apply to every `AgentSession` created by NeoKai.

Target: 50%+ output-token reduction on representative user chat, ad-hoc worker, Space task, and subagent outputs without lower task quality.

## Evidence reviewed

- Local Caveman plugin installation under `~/.claude/plugins/marketplaces/caveman`.
- Existing NeoKai research note: `docs/research/token-efficiency/reports/05-caveman.md`.
- NeoKai general session prompt path:
  - `packages/daemon/src/lib/agent/agent-session.ts`
  - `packages/daemon/src/lib/agent/query-options-builder.ts`
  - `packages/shared/src/types/sdk-config.ts`
  - `packages/shared/src/types/settings.ts`
- NeoKai Space agent prompt path:
  - `packages/daemon/src/lib/space/agents/custom-agent.ts`
  - `packages/daemon/src/lib/space/agents/seed-agents.ts`
  - `packages/shared/src/types/space.ts`
- NeoKai token/context usage surfaces:
  - `packages/daemon/src/lib/agent/context-fetcher.ts`
  - `packages/web/src/components/space/thread/space-task-thread-events.ts`
- Caveman upstream repo metadata and README via GitHub.
- Generic prompt injection spec: `docs/research/token-efficiency/prompt-injection-registry-spec.md`.

## Caveman primitives: essential vs non-essential

| Caveman behavior | Token value | Quality risk | NeoKai recommendation |
|---|---:|---:|---|
| Drop filler, pleasantries, hedging | High | Low | Adopt |
| Prefer terse status updates | High in workflows | Low | Adopt |
| Preserve code blocks, identifiers, paths, URLs, exact errors | Quality-preserving | Low | Adopt |
| Short failure reports with exact blocker and next step | High | Low | Adopt |
| Code-first answers where code/diff is primary artifact | Medium | Low | Adopt as guidance |
| Escape hatch for security, irreversible actions, ambiguous multi-step instructions | Quality/safety critical | Low | Adopt |
| Intensity modes (`lite`, `full`, `ultra`, `wenyan-*`) | Medium | Medium | Skip MVP; start binary `normal`/`compressed` |
| Caveman branding/persona | Low | Medium product fit risk | Skip unless exposed intentionally |
| Hook-based per-turn activation/tracking | Medium for Claude Code | Medium maintenance | Skip; NeoKai owns session prompt assembly |
| Statusline and local transcript stats | Medium | Low | Rebuild natively later using NeoKai session usage |
| Memory-file compressor | Medium input-token savings | Medium correctness/safety | Defer; separate feature |
| MCP shrink proxy | Medium passive input savings | Medium protocol/metadata risk | Defer; consider native metadata compaction later |
| Cavecrew subagent contracts | High for multi-agent workflows | Low | Adapt as native workflow output contracts, not as imported agents |
| Commit/review slash commands | Medium | Low | Adapt specific compact output formats where useful |

## Prompt constraints that likely produce most savings

Highest ROI constraints from Caveman:

1. Remove social wrappers and filler.
   - No "Sure", "happy to", "I can", "basically", "just", "really".
2. Require action-first sentence shape.
   - Pattern: `Thing changed/fails. Reason. Next step.`
3. Avoid prose summaries after tool-heavy work unless they add decisions, blockers, or verification result.
4. Prefer bullet receipts over paragraphs.
5. Keep technical nouns intact.
   - Do not abbreviate function names, API names, config keys, file paths, error strings.
6. Preserve code blocks exactly.
7. Use normal prose for safety/approval/clarity cases.

Candidate NeoKai prompt fragment:

```text
## Output style

When the compressed output injection is active, be terse and action-first.

- Drop filler, pleasantries, hedging, and recap prose.
- Prefer fragments and bullets over paragraphs.
- Report only: result, blocker, changed files, verification, next required action.
- Keep code blocks, identifiers, paths, URLs, commands, and exact errors unchanged.
- Use normal clear prose for security warnings, irreversible actions, approval requests, and multi-step instructions where compression could create ambiguity.
- Do not reduce review thoroughness, test expectations, or tool diligence.
```

This keeps token-saving semantics without Caveman persona or mode complexity.

## Prompt-only vs tools/skills

### MVP: prompt-only

Prompt-only is enough for first adoption because NeoKai centralizes SDK session startup in `AgentSession` and `QueryOptionsBuilder`:

- `AgentSessionInit` is the common creation contract for worker, chat, Space, and task sessions.
- `QueryOptionsBuilder.buildSystemPrompt()` maps session config to SDK `systemPrompt` before the query starts.
- `SettingsManager.prepareSDKOptions()` already writes file-only display settings such as SDK `outputStyle` into `.claude/settings.local.json`.
- Space `buildCustomAgentSystemPrompt()` should supply only Space-agent behavior; generic output compression should sit upstream so user chat and subagents get the same mechanism.

A native output-style fragment should be represented as a built-in `PromptInjection` record, then rendered into the effective session system prompt and scoped subagent prompts by the generic injection renderer.

Benefits:

- No external dependency.
- No plugin/hook compatibility burden.
- One deterministic injection path for future prompt features.
- Data/provenance model for debugging active prompt additions.
- A/B testing using existing SDK usage fields.

This is no longer recommended as a one-off direct append in `QueryOptionsBuilder`; `QueryOptionsBuilder` should call the generic resolver/composer/renderer.

### Later: adapted native skills/tools

Worth adapting later, in priority order:

1. **Compact review output contract**
   - Reviewer comments can use one-line finding format for internal handoffs.
   - Caveat: GitHub PR review body still needs identity block and clear verdict.
2. **Compact subagent result receipts**
   - Especially Research→Review, Coder→Review, QA→Review handoffs.
   - Return stable fields: `files`, `findings`, `verification`, `blockers`, `next`.
3. **Token-savings report**
   - NeoKai already stores SDK result usage (`input_tokens`/`output_tokens`) and context usage (`apiUsage`, `messageBreakdown`). Build savings dashboard from real session messages, not Claude Code JSONL parsing.
4. **MCP metadata compaction**
   - Potential passive input savings, but should be native and opt-in because MCP descriptions can encode important semantics.
5. **Memory/prompt compression**
   - Treat as separate research. Needs strict preservation and backups.

Do not adapt Caveman's installer/hooks/statusline directly; NeoKai has its own daemon/web runtime and Space task UI.

## Where compressed output should live

Compressed output should be a generic prompt injection record, not a typed setting copied across product objects.

Use the registry as the activation mechanism at every scope:

1. **Global/user default**
   - Global `prompt_injections` row enables `neokai.output-mode.compressed` for all new matching sessions.
   - No `GlobalSettings.outputMode` field.
2. **Per-session override**
   - Session-scoped row enables or suppresses `neokai.output-mode.compressed` for one session.
   - No `SessionConfig.outputMode` or `AgentSessionInit.outputMode` field.
3. **Per-space default**
   - Space-scoped row applies to Space chat, Space task agents, and Space agents in that Space unless narrower records suppress or replace it.
   - No `Space.outputMode` column or `spaces.output_mode` migration.
4. **Per-agent default**
   - Space-agent-scoped row applies to reusable Coder/Research/Reviewer/QA agents that should be terse in high-efficiency Spaces.
   - No `SpaceAgent.outputMode` field or `space_agents.output_mode` migration.
5. **Workflow slot override**
   - Workflow-node scoped row targets `(workflowId, workflowNodeId, agentName)` so templates can make Reviewer compressed while Coder remains normal.
   - No `WorkflowNodeAgent.outputMode` field in workflow JSON.
6. **Per-task override**
   - Task-scoped row enables or suppresses compressed output for one task/run.

Avoid a Space-only implementation. Token-efficiency preference varies by chat/session/workflow/task, but the runtime mechanism should be shared by all agent sessions.

## Scope precedence

Use the prompt injection system's scope and priority model. Do not create output-mode-specific precedence code.

Recommended scope order for resolving same-template enable/suppress records:

| Precedence | Scope | Purpose |
|---:|---|---|
| 1 | Task | One-off operator choice for this task/run. |
| 2 | Session | One chat/worker/session override. |
| 3 | Workflow node/slot | Workflow author can make specific node-agent slots terse or normal. |
| 4 | Workflow | Workflow author can set a default for every slot in one workflow. |
| 5 | Space agent | Reusable preference for a specific `SpaceAgent`. |
| 6 | Space | Bulk preference for Space sessions/agents when no narrower record exists. |
| 7 | Global/user | User-level preference for all new matching sessions. |
| 8 | App default | No compressed injection active. |

Narrower scope wins over broader scope for activation conflicts: task wins over session, and workflow-node wins over workflow. Normal mode is represented by absence of the compressed injection or by a narrower suppressing injection record with `record_type = 'suppress'` and `suppresses_template_id = 'neokai.output-mode.compressed'`. Persist provenance in debug metadata so output-style surprises are explainable.

Key inheritance behavior: if a Space-scoped compressed-output record exists and a new SpaceAgent has no Space-agent-scoped record, sessions for that agent inherit the Space record dynamically. If the Space record is later disabled or suppressed, that agent follows the new Space behavior until it gets its own scoped record.

## NeoKai implementation sketch, if approved

Minimal native behavior now depends on the generic prompt injection registry spec.

1. Add generic prompt injection infrastructure:

- `PromptInjectionResolver`
- `PromptInjectionComposer`
- `PromptInjectionRenderer`
- shared `PromptInjection` types and channels
- built-in template provider support

2. Register compressed output through scoped prompt injection records:

- global row for user default
- session row for one chat/worker session
- space row for Space-wide default
- space-agent row for reusable Space agent behavior
- workflow row for workflow-wide default/suppression
- workflow-node row for one workflow slot
- task row for one task/run

Do **not** add `AgentOutputMode`, `GlobalSettings.outputMode`, `SessionConfig.outputMode`, `AgentSessionInit.outputMode`, `Space.outputMode`, `SpaceAgent.outputMode`, or `WorkflowNodeAgent.outputMode`.

3. Store all activation state in `prompt_injections`:

```sql
-- Example scoped activation records; exact columns come from prompt-injection-registry-spec.md.
-- Global default:
(id = 'global.neokai.output-mode.compressed', template_id = 'neokai.output-mode.compressed', scope_type = 'global', scope_id = NULL, enabled = 1)

-- Space default:
(id = 'space.<space-id>.neokai.output-mode.compressed', template_id = 'neokai.output-mode.compressed', scope_type = 'space', scope_id = '<space-id>', enabled = 1)

-- Workflow-wide default:
(id = 'workflow.<workflow-id>.neokai.output-mode.compressed', template_id = 'neokai.output-mode.compressed', scope_type = 'workflow', scope_id = '<workflow-id>', enabled = 1)

-- Workflow-slot override:
(id = 'workflow-node.<workflow-id>.<node-id>.<agent-name>.neokai.output-mode.compressed', template_id = 'neokai.output-mode.compressed', scope_type = 'workflow_node', scope_id = '<workflow-id>:<node-id>:<agent-name>', enabled = 1)
```

No `spaces.output_mode` or `space_agents.output_mode` migration is needed. Workflow templates should preserve scoped prompt-injection records or template metadata that materializes those records during import/instantiation; they should not add `nodes[*].agents[*].outputMode`.

4. Have `BuiltinOutputModeInjectionProvider` emit `neokai.output-mode.compressed` when the registry resolver finds an enabled scoped record that is not suppressed:

- channel: `system.append`
- priority: output-style band
- scope: applies to matching session types; can also render to subagents when `appliesToSubagents` is true
- content: prompt fragment above

5. Render prompt injections in the general query-options path after session-specific options are assembled:

- apply `system.prepend` / `system.append` to top-level `systemPrompt`
- apply scoped `agent.prompt.append` to `queryOptions.agents[*].prompt` because SDK subagents do not inherit parent `systemPrompt.append`

Reason: output style is behavioral and agent-agnostic. Space `buildCustomAgentSystemPrompt()` should not be the primary injection point because user chat, ad-hoc workers, and subagents would be missed.

6. Preserve escape hatch explicitly in the compressed output injection.

7. Add tests around injection record scope resolution, suppression, prompt rendering for custom-string and Claude Code preset prompts, subagent prompt rendering, scoped activation records, and provenance.

8. Add UI only after backend exists:

- Settings UI: global compressed-output injection toggle.
- Session creation / session tools UI: session-scoped compressed-output toggle.
- Space settings: Space-scoped compressed-output toggle.
- Agent editor: Space-agent-scoped compressed-output toggle.
- Workflow editor: workflow-scoped and workflow-node-scoped compressed-output toggles.
- Task-run advanced option later.
- Debug/preview endpoint or panel showing applied/suppressed prompt injections.

## SDK `outputStyle` interaction

The Claude Agent SDK type definitions expose `outputStyle?: string` in settings and runtime result metadata includes `output_style` / `available_output_styles`. NeoKai already has `FileOnlySettings.outputStyle?: string` and `SettingsManager.prepareSDKOptions()` writes it to `.claude/settings.local.json`.

Compressed mode should not blindly reuse SDK `outputStyle` as the only mechanism yet:

- SDK `outputStyle` appears to be a named Claude Code display/response style loaded from settings, not a NeoKai-owned typed contract with guaranteed prompt text.
- `QueryOptionsBuilder` currently does not pass an `outputStyle` option directly; it writes file-only settings before SDK startup.
- NeoKai needs deterministic behavior across user chat, Space tasks, and subagents, including custom system prompts and providers/bridges where SDK style support may vary.

Recommended approach:

1. Do not add NeoKai `outputMode` typed fields.
2. Implement compression via scoped `prompt_injections` records that activate a built-in template rendered by the generic injection registry/composer in the common session prompt path.
3. Optionally map the compressed-output injection to SDK `outputStyle` later only if SDK supports user-defined styles or a built-in concise style with compatible semantics.
4. If both exist, NeoKai prompt injection wins for the safety/clarity contract; SDK `outputStyle` can be treated as additive display preference.

## Measurement plan

### Metrics

Measure per task pair:

- Output tokens: sum `usage.output_tokens` across all SDK result turns in the run, or use equivalent session-level cumulative usage metadata.
- Input tokens: use one source of truth per run: either sum `usage.input_tokens` across all SDK result turns or use equivalent session-level cumulative usage/context metadata. Do not add both together.
- Wall time: session start/end timestamps if needed.
- Quality rubric score:
  - Task completed? yes/no
  - Correct files touched? yes/no
  - Tests/verification adequate? 0–2
  - Review findings actionable? 0–2
  - Safety/approval clarity preserved? yes/no
  - User-facing ambiguity introduced? yes/no

Primary target: >=50% median `output_tokens` reduction with no quality regression.

### Representative task set

Run identical tasks in `normal` and `compressed` modes across session types:

1. User chat: answer architecture/codebase question.
2. User chat: debug failed command output and recommend next step.
3. Ad-hoc worker session: locate code path and summarize integration points.
4. Space Coder task: small bug fix with unit test.
5. Space Coder task: multi-file refactor with verification.
6. Space Reviewer task: review PR diff and post verdict.
7. Space Research task: investigate package/architecture and write doc.
8. Space QA task: run failing test shard and report failure cause.
9. SDK subagent: exploration/review receipt injected back into parent context.
10. Safety/approval case: destructive git/database operation requiring clear warning.

### Method

- Use same model/provider and fresh sessions.
- Run at least one pair each with `thinkingLevel: 'off'` and `thinkingLevel: 'think8k'`; compressed mode may otherwise hide useful visible reasoning when little/no extended thinking is available.
- Disable unrelated prompt changes.
- Capture every SDK result turn plus final assistant text.
- Compare cumulative token counts and rubric scores.
- Record examples where compression harms clarity; refine escape hatch.

## Token-savings expectations

Caveman's upstream claims:

- Product description: ~75% output-token reduction.
- Benchmarks: average 65% output reduction across 10 prompts.
- Example table average: normal 1214 tokens vs Caveman 294 tokens.
- Memory compression: ~46% input-token reduction in examples.
- Subagent outputs: roughly 60% smaller by contract.

Existing NeoKai note (`05-caveman.md`) flags limitations:

- Reasoning/thinking tokens are untouched.
- Small replies can be offset by prompt overhead.
- Benchmarks do not prove correctness preservation.
- Savings depend on verbose output-heavy workflows.

NeoKai target should be more conservative: 50%+ output-token reduction across user chat, ad-hoc worker, Space task, and subagent outputs, quality-neutral.

## Licensing and maintenance

Caveman is MIT licensed (`package.json` and `LICENSE` show MIT, copyright Julius Brussee 2026). Reuse is legally feasible if copyright/license notice is preserved for copied substantial content.

Recommendation: avoid copying full Caveman text. Implement independent NeoKai wording inspired by evaluated behavior. This reduces attribution and drift burden and avoids product coupling to external branding.

If any Caveman prompt text, code, benchmarks, or command formats are copied substantially:

- Include MIT license notice in relevant third-party attribution.
- Track source commit/version.
- Add tests for any adapted behavior.

Maintenance risk of wholesale adoption is high because Caveman includes provider-specific installers, Claude Code hooks, MCP proxy behavior, slash commands, and statusline integration that NeoKai would need to keep compatible without direct runtime need.

## Decision

Adopt minimal native compressed output mode as the first consumer of a generic prompt injection registry.

Do now:

- Generic prompt injection registry/composer/renderer first.
- Built-in compressed output injection template activated by scoped `prompt_injections` records.
- Generic all-session mechanism: global, session, Space, SpaceAgent, workflow, workflow-node, and task scopes all use same registry path.
- Top-level system prompt rendering plus scoped subagent prompt rendering.
- Escape hatch required.
- Measurement harness/report before defaulting any preset or global setting to compressed.

Defer:

- Caveman branding/persona.
- Intensity modes.
- Hooks/statusline/installer.
- Memory compressor.
- MCP shrink proxy.
- Default-on behavior.

## Acceptance criteria mapping

- Caveman reviewed: yes; prompt, hooks, stats, memory compression, MCP shrink, Cavecrew, licensing.
- Recommendation: prompt-only native compressed mode first for all agent sessions, implemented as a built-in prompt injection template; selected tool/skill ideas later.
- Minimal native behavior: recommended; no wholesale bundle; use generic prompt injection registry in common session-init/query-options path rather than Space-only or feature-specific prompt injection.
- Escape hatch: required in prompt fragment and tests.
- Measurement: actual NeoKai measurements deferred to implementation because this research PR does not add runnable output-mode behavior. This document provides a concrete paired-task plan targeting 50%+ output reduction without quality regression; implementation acceptance should require recorded normal-vs-compressed results before enabling defaults.

## Sources

- Caveman GitHub repository: <https://github.com/JuliusBrussee/caveman>
- Local Caveman skill prompt: `~/.claude/plugins/marketplaces/caveman/plugins/caveman/skills/caveman/SKILL.md`
- Local Caveman hooks: `~/.claude/plugins/marketplaces/caveman/src/hooks/`
- Local Caveman reviewer contract: `~/.claude/plugins/marketplaces/caveman/agents/cavecrew-reviewer.md`
- Caveman license: `~/.claude/plugins/marketplaces/caveman/LICENSE`
- NeoKai existing research note: `docs/research/token-efficiency/reports/05-caveman.md`
- NeoKai Space agent prompt builder: `packages/daemon/src/lib/space/agents/custom-agent.ts`
- NeoKai preset agents: `packages/daemon/src/lib/space/agents/seed-agents.ts`
- NeoKai Space agent types: `packages/shared/src/types/space.ts`
- NeoKai generic session config types: `packages/shared/src/types/sdk-config.ts`
- NeoKai settings/output style types: `packages/shared/src/types/settings.ts`
- NeoKai context usage extraction: `packages/daemon/src/lib/agent/context-fetcher.ts`
- NeoKai prompt injection registry spec: `docs/research/token-efficiency/prompt-injection-registry-spec.md`
